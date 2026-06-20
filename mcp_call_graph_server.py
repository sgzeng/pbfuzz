#!/usr/bin/env python3
"""
MCP (Model Context Protocol) Server for CallGraph Analysis

This server exposes CallGraph functionality as MCP tools, allowing LLM agents
to query function call relationships in analyzed C/C++ programs.

Available tools:
- get_callers: Find all functions that call a given function
- get_callees: Find all functions called by a given function
"""
import argparse
import asyncio
import collections
import logging
import os
import re
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

try:
    import mcp.server.stdio
    import mcp.types as types
    from mcp.server import Server
except ImportError:
    print("Error: MCP package not installed. Please run: pip install mcp", file=sys.stderr)
    sys.exit(1)

try:
    import cxxfilt
except ImportError:
    cxxfilt = None

from utils import read_workflow_state, check_tool_permission

class CallGraph:
    
    def __init__(self, config):
        """
        Initialize the SourceCodeFinder with a given configuration.
        
        Loads function information, BID-location mappings, and caller-callee relationships
        from static analysis result files. Sets up caches for efficient lookups.

        :param config: Configuration object containing paths like cmd, 
                      static_result_folder, and optional settings like max_calling_context_depth.
        """
        self.config = config
        self.logger = logging.getLogger(self.__class__.__qualname__)

        # A dictionary for caching function info: {fn_guid -> (function_name, filepath, start_line_number, end_line_number)}
        self.function_infos = self._load_function_info(os.path.join(config.static_result_folder, "function_info.txt"))
        # Map filename -> [full_path, ...]
        self.fp_fn_map = collections.defaultdict(list)
        for _guid, info in self.function_infos.items():
            fp = info[1]
            if not fp:
                continue
            name = os.path.basename(fp)
            if fp not in self.fp_fn_map[name]:
                self.fp_fn_map[name].append(fp)
        # A dictionary for caching source code location: {bid -> (fn_guid, filepath:line_number)}
        self.loc_bid_cache, self.bid_loc_cache = self._load_loc_bid_mapping(os.path.join(self.config.static_result_folder, "bid_loc_mapping.txt"))
        # A dictionary for caching source code location: {addr -> (function_name, filepath:line_number)}
        self.loc_addr_cache = {}
        # caller -> [callee, ...]
        self.caller_callee_map = self.load_caller_calle_mapping(os.path.join(config.static_result_folder, "caller-callee.txt"))
        # callee -> [caller, ...]
        self.callee_caller_map = self.load_calle_caller_mapping(os.path.join(config.static_result_folder, "callee-caller.txt"))
        # A dictionary for caching function source code: {guid -> source_code}
        self.func_code_storage = {}

    def _load_function_info(self, fp):
        """
        Load function information from the specified file.

        File format: Each line should contain 5 comma-separated columns:
          1) Function GUID (integer)
          2) Function name (string)
          3) Source filepath (string)
          4) Start line number (integer)
          5) End line number (integer)

        :param fp: The path to the 'function_info.txt' file.
        :return: A dictionary mapping function GUID to a tuple:
                 (function_name, filepath, start_line, end_line).
        """
        d = {}
        if not os.path.isfile(fp):
            self.logger.warning(f"function info file {fp} does not exist. Function info will not be available.")
            return d
        with open(fp, 'r') as file:
            for l in file:
                if not l.strip():
                    continue
                items = l.strip().split(',')
                if len(items) < 5:
                    self.logger.warning(f"Invalid line in function info file: {l.strip()}")
                    continue
                fn_guid = int(items[0])
                function_name = items[1]
                if function_name.startswith("dfs$"):
                    function_name = function_name[4:]
                filepath = items[2]
                start_line_number = int(items[3])
                end_line_number = int(items[4])
                if fn_guid in d:
                    start_line_number_old, end_line_number_old = d[fn_guid][2], d[fn_guid][3]
                    if end_line_number_old - start_line_number_old > end_line_number - start_line_number:
                        continue
                d[fn_guid] = (function_name, filepath, start_line_number, end_line_number)
        self.logger.debug(f"function_info loaded from {fp}, size: {len(d)}")
        return d

    def _load_loc_bid_mapping(self, fp):
        """
        Load the mapping of BIDs to function GUID and source location from the given file.

        File format: Each line should have 3 comma-separated columns:
          1) Basic block ID (integer)
          2) Basic block hash (integer)
          3) Function GUID (integer)
          4) Location string (e.g., filepath:line_number)

        :param fp: The path to the 'bid_loc_mapping.txt' file.
        :return: A dictionary with BID as the key and a tuple (fn_guid, loc) as the value.
        """
        d = {}
        inverse_d = collections.defaultdict(list)
        if not os.path.isfile(fp):
            self.logger.warning(f"bid mapping file {fp} does not exist. BID mapping will not be available.")
            return d, inverse_d
        with open(fp, 'r') as file:
            for l in file:
                if not l.strip():
                    continue
                items = l.strip().split(',')
                if len(items) != 4:
                    self.logger.warning(f"Invalid line in bid mapping file: {l.strip()}")
                    continue
                bid = int(items[1])
                if items[0]:
                    bid = int(items[0])
                fn_guid = int(items[2])
                loc = items[3]
                if bid in d:
                    self.logger.warning(f"Duplicate BID {bid} in bid mapping file.")
                    continue
                d[bid] = (fn_guid, loc)
                inverse_d[os.path.basename(loc)].append(bid)
        self.logger.debug(f"bid_loc_mapping loaded from {fp}, size: {len(d)}")
        return d, inverse_d

    def load_caller_calle_mapping(self, fp: str) -> Dict[int, List[int]]:
        """
        Load caller -> callee mapping from a file.

        File format: each non-empty line is a comma-separated list where the first
        value is the caller GUID and the following values are callee GUIDs.

        :param fp: path to the caller-callee mapping file
        :return: dict mapping caller_guid (int) -> list of callee_guid (int)
        """
        d = {}
        if not os.path.isfile(fp):
            self.logger.warning(f"caller-callee mapping file {fp} does not exist. Caller-callee mapping will not be available.")
            return d
        try:
            with open(fp, 'r') as file:
                for l in file:
                    if not l.strip():
                        continue
                    items = [it for it in l.strip().split(',') if it]
                    if not items:
                        continue
                    try:
                        caller = int(items[0])
                    except ValueError:
                        self.logger.warning(f"Skipping invalid caller id in line: {l.strip()}")
                        continue
                    callees = []
                    for it in items[1:]:
                        try:
                            callees.append(int(it))
                        except ValueError:
                            self.logger.warning(f"Skipping invalid callee id '{it}' in line: {l.strip()}")
                    d[caller] = callees
        except Exception as e:
            self.logger.error(f"Error reading caller-callee mapping {fp}: {e}")
            return {}
        self.logger.debug(f"caller-callee mapping loaded from {fp}, size: {len(d)}")
        return d

    def load_calle_caller_mapping(self, fp: str) -> Dict[int, List[int]]:
        """
        Load callee -> caller mapping from a file.

        File format: each non-empty line is a comma-separated list where the first
        value is the callee GUID and the following values are caller GUIDs.

        :param fp: path to the callee-caller mapping file
        :return: dict mapping callee_guid (int) -> list of caller_guid (int)
        """
        d = {}
        if not os.path.isfile(fp):
            self.logger.warning(f"callee-caller mapping file {fp} does not exist. Callee-caller mapping will not be available.")
            return d
        try:
            with open(fp, 'r') as file:
                for l in file:
                    if not l.strip():
                        continue
                    items = [it for it in l.strip().split(',') if it]
                    if not items:
                        continue
                    try:
                        callee = int(items[0])
                    except ValueError:
                        self.logger.warning(f"Skipping invalid callee id in line: {l.strip()}")
                        continue
                    callers = []
                    for it in items[1:]:
                        try:
                            callers.append(int(it))
                        except ValueError:
                            self.logger.warning(f"Skipping invalid caller id '{it}' in line: {l.strip()}")
                    d[callee] = callers
        except Exception as e:
            self.logger.error(f"Error reading callee-caller mapping {fp}: {e}")
            return {}
        self.logger.debug(f"callee-caller mapping loaded from {fp}, size: {len(d)}")
        return d

    # Function info accessors

    def get_func_name_from_func_id(self, guid: int) -> str:
        """
        Retrieve the function name from the given GUID.

        :param guid: The unique GUID of the function as generated by LLVM.
        :return: The function name as a string, or an empty string if not found.
        """
        return self.function_infos.get(guid, ("", ""))[0]
    
    def get_fp_from_func_id(self, guid: int) -> str:
        """
        Retrieve the file path from the given GUID.

        :param guid: The unique GUID of the function as generated by LLVM.
        :return: The file path as a string, or an empty string if not found.
        """
        return self.function_infos.get(guid, ("", ""))[1]
    
    def get_fp_from_bid(self, bid: int) -> str:
        """
        Retrieve the file path from the given BID.

        :param bid: The unique BID of the basic block.
        :return: The file path as a string, or an empty string if not found.
        """
        full_loc = self.loc_bid_cache.get(bid, (None, None))[1]
        return full_loc.split(":")[0] if full_loc else ""

    def get_func_range_from_func_id(self, guid: int) -> Tuple[int, int]:
        """
        Retrieve the start and end line numbers from the given GUID.

        :param guid: The unique GUID of the function as generated by LLVM.
        :return: A tuple (start_line, end_line) as integers. Raises KeyError if GUID not found.
        """
        start_line_number = self.function_infos[guid][2]
        end_line_number = self.function_infos[guid][3]
        return start_line_number, end_line_number
    
    def get_func_id_from_bid(self, bid: int) -> Optional[int]:
        """
        Retrieve the function GUID from the given BID.

        :param bid: The unique BID of the basic block.
        :return: The function GUID as an integer, or None if not found.
        """
        return self.loc_bid_cache.get(bid, (None, None))[0]
    
    def get_func_ids_from_loc(self, loc: str) -> List[int]:
        """
        Retrieve the function GUIDs from the given filename:line_number.
        
        :param loc: Location string in format "filename:line_number" (filename is basename, not full path)
        :return: List of function GUIDs that contain the specified line, or empty list if none found
        """
        if not loc or ':' not in loc:
            self.logger.warning(f"Invalid location string: '{loc}'")
            return []
        
        parts = loc.rsplit(':', 1)
        if len(parts) != 2:
            self.logger.warning(f"Invalid location string format: '{loc}'")
            return []
        
        filename, lineno_s = parts[0], parts[1]
        try:
            lineno = int(lineno_s)
        except ValueError:
            self.logger.warning(f"Invalid line number in location: '{loc}'")
            return []
        
        # Check if we have file paths for this filename
        if filename not in self.fp_fn_map or not self.fp_fn_map[filename]:
            self.logger.warning(f"No full path available for filename '{filename}'")
            return []
        
        # Find all functions that contain this line
        matching_guids = []
        
        # Get all possible full paths for this filename
        filepaths = self.fp_fn_map[filename]
        
        # Search through all function infos to find matches
        for guid, info in self.function_infos.items():
            func_name, filepath, start_line, end_line = info
            
            # Check if this function is in one of the matching files
            if filepath in filepaths:
                # Check if the line number falls within the function's range
                if start_line <= lineno <= end_line:
                    matching_guids.append(guid)
        
        # Sort by start line for consistent ordering
        matching_guids.sort(key=lambda guid: self.function_infos[guid][2])
        
        return matching_guids

    # Caller/callee queries

    def get_callers(self, callee_func_name: str) -> Union[List[str], Dict[str, str]]:
        """
        Given a callee function name substring, return a list of caller function names.
        Matches all function names that contain the substring.
        Returns empty list and logs a warning if nothing found.
        """
        # Check if call graph data is available
        if not self.function_infos or not self.callee_caller_map:
            return {"error": "no_callgraph_data", "message": "Call graph info is not available"}
        
        candidates = self._find_all_matching_func_guids(callee_func_name)
        if not candidates:
            self.logger.warning(f"No function matches callee name substring '{callee_func_name}'")
            return []
        # Merge callers from all candidate GUIDs (deduplicated, deterministic order)
        merged_callers = []
        seen = set()
        for _, guid in candidates:
            callers_ids = self.callee_caller_map.get(guid, [])
            for cid in callers_ids:
                name = self.get_func_name_from_func_id(cid)
                if name and name not in seen:
                    seen.add(name)
                    if self._is_mangled_name(name):
                        name = self._demangle_name(name)
                    merged_callers.append(name)
        if not merged_callers:
            self.logger.warning(f"No callers found for function '{callee_func_name}'")
        return merged_callers

    def get_callees(self, caller_func_name: str) -> Union[List[str], Dict[str, str]]:
        """
        Given a caller function name substring, return a list of callee function names.
        Matches all function names that contain the substring.
        Returns empty list and logs a warning if nothing found.
        """
        # Check if call graph data is available
        if not self.function_infos or not self.caller_callee_map:
            return {"error": "no_callgraph_data", "message": "Call graph info is not available"}
        
        candidates = self._find_all_matching_func_guids(caller_func_name)
        if not candidates:
            self.logger.warning(f"No function matches caller name substring '{caller_func_name}'")
            return []
        # Merge callees from all candidate GUIDs (deduplicated, deterministic order)
        merged_callees = []
        seen = set()
        for _, guid in candidates:
            callees_ids = self.caller_callee_map.get(guid, [])
            for cid in callees_ids:
                name = self.get_func_name_from_func_id(cid)
                if name and name not in seen:
                    seen.add(name)
                    if self._is_mangled_name(name):
                        name = self._demangle_name(name)
                    merged_callees.append(name)
        if not merged_callees:
            self.logger.warning(f"No callees found for function '{caller_func_name}'")
        return merged_callees

    # Internal helpers for name resolution

    def _is_mangled_name(self, name: str) -> bool:
        """
        Check if a function name appears to be a C++ mangled name.
        Uses cxxfilt library for accurate detection, with fallback heuristics.
        """
        if not name:
            return False
        
        # Use cxxfilt for accurate detection if available
        if cxxfilt is not None:
            try:
                demangled = cxxfilt.demangle(name)
                # If demangling succeeds and result is different, it was mangled
                return demangled != name and demangled is not None and len(demangled.strip()) > 0
            except Exception:
                # Fall back to heuristics if cxxfilt fails
                pass
        
        # Fallback heuristics for when cxxfilt is unavailable
        # Itanium ABI mangled names start with _Z
        if name.startswith('_Z'):
            return True
        # Other heuristics for mangled names
        if len(name) > 10 and any(c.isdigit() for c in name) and not "::" in name:
            # Contains digits and no :: (likely mangled)
            return True
        return False
    
    def _demangle_name(self, name: str) -> str:
        """
        Demangle a C++ function name if it's mangled, otherwise return as-is.
        Examples:
        - '_ZN11ImageStreamC2EP6Streamiii' -> 'ImageStream::ImageStream'
        - 'ImageStream' -> 'ImageStream'
        
        :param name: The function name (potentially mangled)
        :return: Demangled function name, or original name if demangling fails
        """
        if not name or not self._is_mangled_name(name):
            return name
        
        # Use cxxfilt library if available
        if cxxfilt is not None:
            try:
                demangled = cxxfilt.demangle(name)
                if demangled and demangled != name:
                    # Extract just the class/function name from full signature
                    # For example: 'ImageStream::ImageStream(Stream*, int, int, int)' -> 'ImageStream'
                    if '::' in demangled:
                        # Get class name from constructor/method
                        parts = demangled.split('::')
                        if len(parts) >= 2:
                            class_name = parts[0]
                            method_name = parts[1].split('(')[0]  # Remove parameters
                            # If it's a constructor, return class name
                            if class_name == method_name:
                                return class_name
                            # Otherwise return the method name
                            return method_name
                    else:
                        # Simple function name, remove parameters if present
                        return demangled.split('(')[0]
                return demangled
            except Exception as e:
                self.logger.debug(f"Failed to demangle '{name}' using cxxfilt: {e}")
        
        # Fallback: try using c++filt command if cxxfilt library fails
        try:
            result = subprocess.run(['c++filt', name], capture_output=True, text=True, timeout=5)
            if result.returncode == 0 and result.stdout.strip():
                demangled = result.stdout.strip()
                if demangled != name:
                    # Apply same extraction logic as above
                    if '::' in demangled:
                        parts = demangled.split('::')
                        if len(parts) >= 2:
                            class_name = parts[0]
                            method_name = parts[1].split('(')[0]
                            if class_name == method_name:
                                return class_name
                            return method_name
                    else:
                        return demangled.split('(')[0]
                return demangled
        except (subprocess.SubprocessError, FileNotFoundError, subprocess.TimeoutExpired) as e:
            self.logger.debug(f"Failed to demangle '{name}' using c++filt: {e}")
        
        # If all methods fail, return original name
        return name
    
    def _mangled_name_matches(self, mangled_name: str, search_term: str) -> bool:
        """
        Match a search term against a possibly mangled name.
        Supports functions, destructors, operator overloads, templates.
        """

        def _extract_func_name(sig: str) -> str:
            if not sig:
                return ""
            # remove namespace
            last = sig.split("::")[-1]
            # remove parameters list
            last = re.sub(r'\(.*\)$', '', last)
            # remove destructor symbol (~) and operator symbol (+)
            return last.strip()

        if not mangled_name or not search_term:
            return False

        if not self._is_mangled_name(mangled_name):
            return _extract_func_name(mangled_name) == _extract_func_name(search_term)

        demangled = self._demangle_name(mangled_name)
        if not demangled or demangled == mangled_name:
            return False

        return _extract_func_name(demangled) == _extract_func_name(search_term)
    
    def _find_all_matching_func_guids(self, name_substr: str) -> List[Tuple[str, int]]:
        """
        Find all function GUIDs whose names match the given substring.
        Handles both mangled names (from C++ compilation) and original function names.
        Enhanced with powerful fuzzy matching as fallback.
        Returns a list of (func_name, guid) tuples.
        """
        candidates = []
        for guid, info in self.function_infos.items():
            func_name = info[0]
            
            # Direct substring match (for normal names or exact mangled name queries)
            if name_substr == func_name:
                candidates.append((func_name, guid))
                continue
            
            # For mangled names, try to match against the original pattern
            # Try to extract meaningful parts from mangled name for matching
            if self._mangled_name_matches(func_name, name_substr):
                candidates.append((func_name, guid))
                continue

        return candidates

class MCPCallGraphServer:
    """MCP Server wrapper for CallGraph functionality"""
    
    def __init__(self, source_code_dir: Optional[str] = None):
        self.server = Server("callgraph")
        self.call_graph: Optional[CallGraph] = None
        self.logger = logging.getLogger(__name__)
        # Workflow state management for gatekeeper - fixed path in .cursor directory
        self.source_code_dir = Path(source_code_dir) if source_code_dir else Path.cwd()
        self.state_file_path = self.source_code_dir / ".cursor" / "workflow_state.md"
        
    def _check_workflow_gatekeeper(self, tool_name: str) -> Optional[str]:
        """Check workflow gatekeeper rules for tool access."""
        if not self.state_file_path or not self.state_file_path.exists():
            return f"🚫 **Workflow State Required**: No workflow state file found. Please ensure workflow_state.md exists at {self.state_file_path}"
        
        try:
            # Read current workflow state
            memory = read_workflow_state(self.state_file_path)
            current_phase = memory.state.phase
            
            # Check tool permission for ANALYZE phase tools
            if not check_tool_permission(current_phase, tool_name):
                return f"🚫 **Phase Gatekeeper**: Tool '{tool_name}' not allowed in {current_phase} phase. Must be in ANALYZE phase."
            
            return None  # Gatekeeper check passed
            
        except Exception as e:
            return f"🚫 **Workflow Error**: Failed to read workflow state: {e}"
        
        
    async def initialize_call_graph(self, static_result_folder: str) -> bool:
        """Initialize CallGraph with the provided configuration"""
        try:
            # Create a minimal config object for CallGraph
            config = type('Config', (), {
                'static_result_folder': static_result_folder
            })()
            
            self.call_graph = CallGraph(config)
            self.logger.info("CallGraph initialized with static results from: %s", static_result_folder)
            
            # Log some statistics
            if hasattr(self.call_graph, 'function_infos'):
                func_count = len(self.call_graph.function_infos)
                self.logger.info("Loaded %d functions", func_count)
            
            return True
        except Exception as e:
            self.logger.error("Failed to initialize CallGraph: %s", str(e))
            return False
    
    def get_available_tools(self) -> List[types.Tool]:
        """Get list of available tools for testing purposes"""
        return [
            types.Tool(
                name="get_callers",
                description=(
                    "Find all functions that call the specified function. "
                    "The function name can be a substring - it will match all functions "
                    "containing that substring. For C++ code, both mangled and demangled "
                    "names are supported."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "function_name": {
                            "type": "string",
                            "description": "Function name or substring to search for (e.g., 'main', 'ImageStream', 'process')"
                        }
                    },
                    "required": ["function_name"]
                }
            ),
            types.Tool(
                name="get_callees",
                description=(
                    "Find all functions called by the specified function. "
                    "The function name can be a substring - it will match all functions "
                    "containing that substring. For C++ code, both mangled and demangled "
                    "names are supported."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "function_name": {
                            "type": "string",
                            "description": "Function name or substring to search for (e.g., 'main', 'ImageStream', 'process')"
                        }
                    },
                    "required": ["function_name"]
                }
            )
        ]
    
    def setup_handlers(self):
        """Setup MCP request handlers"""

        @self.server.list_tools()
        async def handle_list_tools() -> List[types.Tool]:
            """List available tools"""
            return self.get_available_tools()
        
        @self.server.call_tool()
        async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> List[types.TextContent]:
            """Handle tool calls with gatekeeper enforcement"""
            
            # Gatekeeper check for all call graph tools (ANALYZE phase only)
            gatekeeper_error = self._check_workflow_gatekeeper(name)
            if gatekeeper_error:
                return [types.TextContent(
                    type="text",
                    text=gatekeeper_error + "\n\n**Required Actions:**\n"
                         "1. Read workflow_state.md to check current phase\n"
                         "2. Use transition_phase tool to transition to ANALYZE phase\n"
                         "3. Ensure all ANALYZE phase prerequisites are met\n"
                         "4. Then retry this tool"
                )]
            
            if not self.call_graph:
                return [types.TextContent(
                    type="text", 
                    text="Error: CallGraph not initialized. Please run with --static-folder argument."
                )]
            
            try:
                if name == "get_callers":
                    function_name = arguments.get("function_name", "")
                    if not function_name:
                        return [types.TextContent(
                            type="text",
                            text="Error: function_name parameter is required"
                        )]
                    
                    callers = self.call_graph.get_callers(function_name)
                    
                    if isinstance(callers, dict) and callers.get("error") == "no_callgraph_data":
                        result_text = f"ℹ️ {callers['message']}"
                    elif not callers:
                        result_text = f"No callers found for function '{function_name}'"
                    else:
                        result_text = f"Functions that call '{function_name}' ({len(callers)} found):\n"
                        for i, caller in enumerate(callers, 1):
                            result_text += f"{i}. {caller}\n"
                    
                    return [types.TextContent(type="text", text=result_text)]
                
                elif name == "get_callees":
                    function_name = arguments.get("function_name", "")
                    if not function_name:
                        return [types.TextContent(
                            type="text",
                            text="Error: function_name parameter is required"
                        )]
                    
                    callees = self.call_graph.get_callees(function_name)
                    
                    if isinstance(callees, dict) and callees.get("error") == "no_callgraph_data":
                        result_text = f"ℹ️ {callees['message']}"
                    elif not callees:
                        result_text = f"No callees found for function '{function_name}'"
                    else:
                        result_text = f"Functions called by '{function_name}' ({len(callees)} found):\n"
                        for i, callee in enumerate(callees, 1):
                            result_text += f"{i}. {callee}\n"
                    
                    return [types.TextContent(type="text", text=result_text)]
                
                else:
                    return [types.TextContent(
                        type="text",
                        text=f"Error: Unknown tool '{name}'"
                    )]
                    
            except Exception as e:
                self.logger.error("Error handling tool '%s': %s", name, str(e))
                return [types.TextContent(
                    type="text",
                    text=f"Error: {str(e)}"
                )]

    async def run(self, static_folder: str):
        """Run the MCP server"""
        # Initialize CallGraph
        if not await self.initialize_call_graph(static_folder):
            self.logger.error("Failed to initialize CallGraph")
            return False
        
        # Setup handlers
        self.setup_handlers()
        
        # Run server using the standard MCP pattern
        async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
            self.logger.info("MCP CallGraph Server started")
            await self.server.run(
                read_stream, 
                write_stream, 
                self.server.create_initialization_options()
            )


def setup_signal_handlers():
    """Setup signal handlers for immediate shutdown"""
    def signal_handler(signum, frame):
        print(f"\nReceived signal {signum}, shutting down immediately...")
        os._exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

def main():
    
    parser = argparse.ArgumentParser(
        description="MCP Server for CallGraph Analysis",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Start MCP server with static analysis results
  python mcp_call_graph.py --static-folder ./static_results

  # With custom paths
  python mcp_call_graph.py --static-folder /path/to/static
        """
    )
    
    parser.add_argument(
        "--static-folder", 
        required=True,
        help="Path to folder containing static analysis results (function_info.txt, caller-callee.txt, etc.)"
    )
    parser.add_argument(
        "--source-code-dir",
        required=False,
        help="Source code directory containing .cursor/workflow_state.md (default: current directory)"
    )
    
    args = parser.parse_args()
    
    # Set log level
    logging.basicConfig(
        level='ERROR',
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )

    # Create static folder if it doesn't exist
    if not os.path.exists(args.static_folder):
        print(f"Warning: Static folder '{args.static_folder}' does not exist, creating it...")
        os.makedirs(args.static_folder, exist_ok=True)
    
    # Setup signal handlers early
    setup_signal_handlers()
    # Create and run server
    server = MCPCallGraphServer(source_code_dir=args.source_code_dir)
    
    try:
        asyncio.run(server.run(args.static_folder))
    except KeyboardInterrupt:
        print("\nShutting down MCP CallGraph Server...")
        os._exit(0)
    except Exception as e:
        print(f"Error running server: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
