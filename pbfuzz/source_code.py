import collections
from functools import lru_cache
import logging
import os
import subprocess
import linecache
import re
from typing import Dict, List, Tuple, Optional, Union, Any

import ts

try:
    import cxxfilt
except ImportError:
    cxxfilt = None


class SourceCodeFinder:

    # Initialization and data loading
    
    def __init__(self, config):
        """
        Initialize the SourceCodeFinder with a given configuration.
        
        Loads function information, BID-location mappings, and caller-callee relationships
        from static analysis result files. Sets up caches for efficient lookups.

        :param config: Configuration object containing paths like static_result_folder.
        """
        self.config = config
        self.logger = logging.getLogger(self.__class__.__qualname__)
        
        # A dictionary for caching source code location: {addr -> (function_name, filepath:line_number)}
        self.loc_addr_cache = {}
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
            self.logger.error(f"function info file {fp} does not exist.")
            return d
        with open(fp, 'r') as file:
            for l in file:
                if not l.strip():
                    continue
                items = l.strip().split(',')
                assert len(items) >= 5, f"Invalid line in function info file: {l.strip()}"
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

        File format: Each line has four comma-separated fields (split only on the first three commas
        so the location may contain commas). Optional legacy lines omit the GUID field (three fields).

          1) Primary basic block ID (integer; if empty, column 2 is the BID)
          2) Alternate / hash BID (integer)
          3) Function GUID (integer), or omitted in legacy three-field lines (then treated as 0)
          4) Location string (e.g., filepath:line_number)

        :param fp: The path to the 'bid_loc_mapping.txt' file.
        :return: A dictionary with BID as the key and a tuple (fn_guid, loc) as the value.
        """
        d = {}
        if not os.path.isfile(fp):
            self.logger.error(f"bid mapping file {fp} does not exist.")
            return d, d
        with open(fp, 'r') as file:
            for l in file:
                raw = l.strip()
                if not raw:
                    continue
                # Four logical fields: optional primary BID, alternate/hash BID, function GUID,
                # location (may contain commas — only split first three commas).
                # Legacy mistake (INIT / hand-written stubs): three fields "bid,hash,path:line"
                # without function GUID — treat GUID as 0.
                parts = raw.split(",", 3)
                if len(parts) == 4:
                    bid_s, hash_s, guid_s, loc = parts
                elif len(parts) == 3:
                    bid_s, hash_s, loc = parts
                    guid_s = "0"
                else:
                    raise AssertionError(f"Invalid line in bid mapping file: {raw}")
                bid = int(hash_s)
                if bid_s:
                    bid = int(bid_s)
                fn_guid = int(guid_s)
                if bid in d:
                    self.logger.warning(
                        "Duplicate BID %s in %s; keeping last occurrence.", bid, fp
                    )
                d[bid] = (fn_guid, loc)
        inverse_d = collections.defaultdict(list)
        for bid, (_fn_guid, loc) in d.items():
            inverse_d[os.path.basename(loc)].append(bid)
        self.logger.debug(f"bid_loc_mapping loaded from {fp}, size: {len(d)}")
        return d, inverse_d


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
        
        if not matching_guids:
            self.logger.debug(f"No functions found containing line {lineno} in file '{filename}' using static analysis")
            
            # Fallback: Use Tree-sitter to find the enclosing function
            matching_guids = self._get_func_ids_from_loc_ts_fallback(filename, lineno, filepaths)
            if matching_guids:
                self.logger.info(f"Tree-sitter fallback found {len(matching_guids)} functions for line {lineno} in '{filename}'")
        
        # Sort by start line for consistent ordering
        matching_guids.sort(key=lambda guid: self.function_infos[guid][2])
        
        return matching_guids

    def _get_func_ids_from_loc_ts_fallback(self, filename: str, lineno: int, filepaths: List[str]) -> List[int]:
        """
        Fallback mechanism to find function GUIDs when static analysis fails.
        Uses multiple strategies: Tree-sitter, proximity search, and regex parsing.
        
        :param filename: Base filename (e.g., 'parser.c')
        :param lineno: Line number
        :param filepaths: List of full paths for this filename
        :return: List of function GUIDs that contain the specified line
        """
        matching_guids = []
        
        # Strategy 1: Try Tree-sitter if available
        matching_guids = self._try_tree_sitter_fallback(filepaths, lineno)
        if matching_guids:
            return matching_guids
        
        # Strategy 2: Find closest function by proximity
        matching_guids = self._try_proximity_fallback(filename, lineno, filepaths)
        if matching_guids:
            return matching_guids
            
        # Strategy 3: Simple regex-based function detection
        matching_guids = self._try_regex_fallback(filepaths, lineno)
        
        return matching_guids
    
    def _try_tree_sitter_fallback(self, filepaths: List[str], lineno: int) -> List[int]:
        """Try Tree-sitter based function detection"""
        matching_guids = []
        
        for filepath in filepaths:
            if not os.path.isfile(filepath):
                continue
                
            try:
                # Use Tree-sitter to find the enclosing function name
                func_name = ts.find_enclosing_function_name_ts(filepath, lineno)
                if not func_name:
                    continue
                    
                self.logger.debug(f"Tree-sitter found function '{func_name}' at line {lineno} in {filepath}")
                
                # Find the GUID for this function name in this file
                for guid, info in self.function_infos.items():
                    stored_func_name, stored_filepath, start_line, end_line = info
                    
                    # Match by function name and filepath
                    if stored_filepath == filepath and stored_func_name == func_name:
                        matching_guids.append(guid)
                        self.logger.info(f"Tree-sitter matched function '{func_name}' to GUID {guid}")
                        break
                
                if matching_guids:
                    break
                    
            except Exception as e:
                self.logger.debug(f"Tree-sitter fallback failed for {filepath}:{lineno}: {e}")
                continue
        
        return matching_guids
    
    def _try_proximity_fallback(self, filename: str, lineno: int, filepaths: List[str]) -> List[int]:
        """Find the closest function by proximity when line is between functions"""
        closest_guid = None
        min_distance = float('inf')
        
        # Find functions in the same file
        for guid, info in self.function_infos.items():
            func_name, filepath, start_line, end_line = info
            
            if filepath in filepaths:
                # Calculate distance to the function
                if start_line <= lineno <= end_line:
                    # Line is actually within function (shouldn't happen if we reach here)
                    return [guid]
                else:
                    # Calculate minimum distance to function boundaries
                    distance = min(abs(lineno - start_line), abs(lineno - end_line))
                    
                    if distance < min_distance:
                        min_distance = distance
                        closest_guid = guid
        
        if closest_guid and min_distance <= 50:  # Within 50 lines
            self.logger.info(f"Proximity fallback: using closest function (distance: {min_distance} lines) for line {lineno} in '{filename}'")
            return [closest_guid]
        
        return []
    
    def _try_regex_fallback(self, filepaths: List[str], lineno: int) -> List[int]:
        """Simple regex-based function detection as last resort"""
        matching_guids = []
        
        for filepath in filepaths:
            if not os.path.isfile(filepath):
                continue
                
            try:
                # Read the file and look for function definitions around the target line
                with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                    lines = f.readlines()
                
                if lineno > len(lines):
                    continue
                
                # Look backwards from target line to find function start
                func_start_pattern = re.compile(r'^[a-zA-Z_][a-zA-Z0-9_]*\s*\**\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*\{?\s*$')
                
                for i in range(min(lineno - 1, len(lines) - 1), max(0, lineno - 100), -1):
                    line = lines[i].strip()
                    match = func_start_pattern.match(line)
                    if match:
                        func_name = match.group(1)
                        
                        # Find matching GUID
                        for guid, info in self.function_infos.items():
                            stored_func_name, stored_filepath, start_line, end_line = info
                            if stored_filepath == filepath and stored_func_name == func_name:
                                matching_guids.append(guid)
                                self.logger.info(f"Regex fallback found function '{func_name}' for line {lineno}")
                                return matching_guids
                        break
                        
            except Exception as e:
                self.logger.debug(f"Regex fallback failed for {filepath}:{lineno}: {e}")
                continue
        
        return matching_guids

    def get_code_line(self, file_path: str, line_number: int) -> str:
        """
        Internal helper to retrieve a single line from a loaded file.

        :param file_path: Absolute path to the source file.
        :param line_number: 1-based index of the line to retrieve.
        :return: The line content without the trailing newline, or an empty string if invalid.
        """
        if not os.path.isfile(file_path):
            self.logger.warning(f"source code file {file_path} does not exist.")
            return ""
        try:
            line = linecache.getline(file_path, line_number)
        except Exception as e:
            self.logger.warning(f"Error reading line {line_number} from {file_path}: {e}")
            return ""
        return line.rstrip("\n")

    # Source code retrieval
    def get_source_code_fun_list_legacy(self, functionName_list: List[Tuple[str, int]]) -> str:
        """
        Return source code for multiple functions, grouped by filename.
        
        :param functionName_list: List of (function_name, func_GUID) pairs
        :return: String with format:
                 /* inside file=filename1 */
                 lineNum funcA source code
                 ...
                 /* inside file=filename2 */
                 lineNum funcB source code
                 ...
        """
        if not functionName_list:
            return ""
        
        # Convert (function_name, func_GUID) pairs to candidates for formatting
        candidates = []
        
        for func_name, func_guid in functionName_list:
            if not func_guid:
                continue
            fp = self.get_fp_from_func_id(func_guid)
            if not fp:
                continue
            actual_name = self.get_func_name_from_func_id(func_guid)
            # avoid duplicates
            if not any(c[1] == func_guid for c in candidates):
                candidates.append((actual_name, func_guid))
        
        if not candidates:
            return ""
        
        # Use the unified formatting function
        return self._format_multiple_functions_source_code(candidates)

    def get_source_code_fun_list(self, functionName_list: List[str], return_individual_status: bool = False) -> Union[str, Dict[str, str]]:
        """
        Get source code for multiple functions with improved reliability and content validation.
        
        :param functionName_list: List of function name substrings to match
        :param return_individual_status: If True, return dict with individual function status
        :return: String with formatted source code grouped by filename, or dict if return_individual_status=True
        """
        if not functionName_list:
            return {} if return_individual_status else ""
        
        # Store individual function results for status tracking, keyed by original query name
        individual_results = {}
        
        # Process each query function name individually
        func_guid_pairs = []
        query_to_matches = {}  # Track which query led to which matches
        
        for query_name in functionName_list:
            matches = self._find_all_matching_func_guids(query_name)
            if not matches:
                self.logger.warning(f"No function matches name substring '{query_name}'")
                individual_results[query_name] = 'not found'
                continue
            
            # Store all matches for this query (to support overloaded functions)
            valid_matches = []
            for match in matches:
                cand_name, cand_guid = match
                fp = self.get_fp_from_func_id(cand_guid)
                if fp:
                    valid_matches.append(match)
            
            if not valid_matches:
                individual_results[query_name] = 'not found'
                continue
                
            # Track which query led to these matches
            query_to_matches[query_name] = valid_matches
            
            # Add all valid matches to processing list (avoid duplicates by GUID)
            for cand_name, cand_guid in valid_matches:
                if not any(pair[1] == cand_guid for pair in func_guid_pairs):
                    func_guid_pairs.append((cand_name, cand_guid))
        
        if not func_guid_pairs:
            return individual_results if return_individual_status else ""
        
        # Get source code for each function and map back to original queries
        valid_pairs = []
        processed_guids = {}  # Track GUID -> source code mapping
        
        for func_name, func_guid in func_guid_pairs:
            if func_guid in processed_guids:
                continue  # Already processed this function
                
            try:
                source_code = self.get_function_source_code(func_guid)
                processed_guids[func_guid] = source_code
                
                if source_code and source_code.strip():
                    # Check if source contains actual code content
                    has_actual_code = self._has_actual_code_content(source_code)
                    if has_actual_code:
                        valid_pairs.append((func_name, func_guid))
                    
            except Exception as e:
                self.logger.warning(f"Error getting source for function {func_name}: {e}")
                processed_guids[func_guid] = None
        
        # Map results back to original query names
        for query_name, matches in query_to_matches.items():
            # For individual status, we report success if any match was found with code
            found_any_code = False
            combined_sources = []
            
            for cand_name, cand_guid in matches:
                source_code = processed_guids.get(cand_guid)
                
                if source_code and source_code.strip():
                    has_actual_code = self._has_actual_code_content(source_code)
                    if has_actual_code:
                        found_any_code = True
                        combined_sources.append(source_code)
            
            if found_any_code:
                # If individual status requested, return the combined result
                if return_individual_status:
                    individual_results[query_name] = {
                        'status': 'found',
                        'source': '\n\n'.join(combined_sources) if len(combined_sources) > 1 else combined_sources[0]
                    }
            else:
                individual_results[query_name] = {
                    'status': 'not found',
                    'source': ''
                }
                if matches:  # Had matches but no actual code
                    self.logger.info(f"Function {query_name}: found headers but no actual code content")
        
        # Return individual status with source code if requested
        if return_individual_status:
            return individual_results
        
        # If no valid functions found, return empty
        if not valid_pairs:
            return ""
        
        # Format the source code of valid functions
        return self._format_multiple_functions_source_code(valid_pairs)

    def _has_actual_code_content(self, source_code: str) -> bool:
        """
        Check if source code contains actual code, not just headers/comments
        
        :param source_code: Source code string to check
        :return: True if contains actual code content
        """
        if not source_code or not source_code.strip():
            return False
        
        lines = source_code.split('\n')
        for line in lines:
            stripped = line.strip()
            # Skip empty lines and comments
            if not stripped or stripped.startswith('/*') or stripped.startswith('//'):
                continue
            # Skip file/function headers that are part of our format
            if stripped.startswith('/* inside ') and stripped.endswith(' */'):
                continue
            # If we find any other content, it's likely actual code
            if stripped:
                return True
        
        return False

    @lru_cache(maxsize=4096)
    def find_loc_info(self, bid: int = 0) -> Tuple[str, str]:
        """
        Retrieve function/location info based on a basic block ID.

        :param bid: Basic block ID (integer).
        :return: A tuple (function_name, location_string) or ("", "") if not found.
        """
        func_name = ""
        loc = ""
        if bid in self.loc_bid_cache:
            fn_guid, full_loc = self.loc_bid_cache[bid]
            func_name = self.get_func_name_from_func_id(fn_guid)
            fp = full_loc.split(":")[0]
            linenum = int(full_loc.split(":")[1])
            # Return full path instead of just basename for debugging/breakpoints
            loc = f"{fp}:{linenum}"
            return (func_name, loc)
        return (func_name, loc)

    def get_function_source_code(self, guid: int) -> str:
        """
        Return the source code of the function identified by the given GUID.
        Uses multiple strategies and returns the one with the largest function range:
        1. Tree-sitter (most accurate)
        2. Function_info.txt line ranges 
        3. Intelligent range expansion for single-line entries

        :param guid: The unique GUID of the function as generated by LLVM.
        :return: The full source code of the function as a string, or an empty string if unavailable.
        """
        # Check cache first
        if guid in self.func_code_storage:
            return self.func_code_storage[guid]
        fp = self.get_fp_from_func_id(guid)
        func_name = self.get_func_name_from_func_id(guid)
        # Demangle function name if it's a C++ mangled name
        demangled_func_name = self._demangle_name(func_name)
        start_line_number, end_line_number = self.get_func_range_from_func_id(guid)
        
        if not os.path.isfile(fp):
            # Cache empty result
            self.func_code_storage[guid] = ""
            return ""
        
        # Collect results from different strategies
        strategy_results = []
        
        # Strategy 1: Tree-sitter approach
        try:
            search_lines = [start_line_number]
            # For single-line entries, also try nearby lines
            if start_line_number == end_line_number:
                search_lines.extend([start_line_number - 1, start_line_number - 2, start_line_number + 1])
            
            best_ts_result = ""
            for line_num in search_lines:
                if line_num < 1:
                    continue
                # Try with demangled name first, fallback to original name
                ts_result = ts.find_function_ts(demangled_func_name, fp, line_num)
                if not ts_result and demangled_func_name != func_name:
                    ts_result = ts.find_function_ts(func_name, fp, line_num)
                if ts_result and len(ts_result.strip()) > len(best_ts_result.strip()):
                    best_ts_result = ts_result
                        
            if best_ts_result and self._has_actual_code_content(best_ts_result):
                strategy_results.append(("tree-sitter", best_ts_result, self._count_function_lines(best_ts_result)))
                self.logger.debug(f"[TREE-SITTER] Found function {func_name} with {self._count_function_lines(best_ts_result)} lines")
                
        except Exception as e:
            self.logger.debug(f"[TREE-SITTER] Failed for {func_name}: {e}")
        
        # Strategy 2: Function_info.txt ranges with intelligent expansion
        try:
            lines = linecache.getlines(fp)
            
            # Handle single-line function entries (likely incomplete range in function_info.txt)
            func_start, func_end = start_line_number, end_line_number
            if start_line_number == end_line_number:
                func_start, func_end = self._expand_single_line_function(lines, start_line_number)
            
            snippet = lines[func_start - 1:func_end]
            func_info_result = "\n".join(
                f"[{func_start + idx}]: {line.rstrip()}"
                for idx, line in enumerate(snippet)
            )
            
            if func_info_result and self._has_actual_code_content(func_info_result):
                strategy_results.append(("function_info", func_info_result, self._count_function_lines(func_info_result)))
                self.logger.debug(f"[FUNCTION-INFO] Found function {func_name} with {self._count_function_lines(func_info_result)} lines")
                
        except Exception as e:
            self.logger.debug(f"[FUNCTION-INFO] Strategy failed for {func_name}: {e}")
        
        # If no strategies worked, return empty
        if not strategy_results:
            self.logger.warning(f"❌ All strategies failed for function {func_name} (GUID: {guid})")
            # Cache empty result
            self.func_code_storage[guid] = ""
            return ""
        
        # Choose the strategy with the most lines (indicating most complete function)
        best_strategy = max(strategy_results, key=lambda x: x[2])
        strategy_name, result, line_count = best_strategy
        
        self.logger.info(f"✅ SUCCESS: Selected {strategy_name.upper()} strategy for function '{func_name}' ({line_count} lines)")
        
        # Cache the result before returning
        self.func_code_storage[guid] = result
        return result

    def _expand_single_line_function(self, lines: List[str], start_line_number: int) -> Tuple[int, int]:
        """
        Expand single-line function entries by looking for function signature and body.
        
        :param lines: All lines from the file
        :param start_line_number: Starting line number (1-based)
        :return: Tuple of (expanded_start, expanded_end)
        """
        expanded_start = start_line_number
        expanded_end = start_line_number
        
        if start_line_number > len(lines):
            return expanded_start, expanded_end
            
        target_line = lines[start_line_number - 1]
        
        # If the line contains function signature but no opening brace, look for the body
        if "(" in target_line and ")" in target_line and "{" not in target_line:
            # Search forward for opening brace and function body
            brace_count = 0
            found_opening_brace = False
            
            # Search within reasonable range (up to 10 lines forward)
            for i in range(start_line_number, min(len(lines) + 1, start_line_number + 10)):
                if i <= len(lines):
                    line = lines[i - 1]
                    if "{" in line:
                        found_opening_brace = True
                        brace_count += line.count("{") - line.count("}")
                    elif found_opening_brace:
                        brace_count += line.count("{") - line.count("}")
                    
                    if found_opening_brace:
                        expanded_end = i
                        if brace_count <= 0 and "}" in line:
                            break
            
            # Also search backwards for function return type (common pattern: type on previous line)
            for i in range(start_line_number - 1, max(0, start_line_number - 5), -1):
                if i >= 1:
                    prev_line = lines[i - 1].strip()
                    # Common return types: int, void, const char *, etc.
                    if prev_line and not prev_line.startswith("//") and not prev_line.startswith("/*"):
                        if any(prev_line.startswith(t) for t in ["int", "void", "const", "static", "inline"]):
                            expanded_start = i
                            break
        
        return expanded_start, expanded_end

    def _count_function_lines(self, source_code: str) -> int:
        """
        Count the number of actual code lines in the source code.
        Ignores line numbers, comments, and empty lines.
        
        :param source_code: Source code string
        :return: Number of code lines
        """
        if not source_code:
            return 0
            
        lines = source_code.split('\n')
        code_lines = 0
        
        for line in lines:
            stripped = line.strip()
            # Skip empty lines
            if not stripped:
                continue
            # Skip line numbers (format: "[123]: actual_code")
            if re.match(r'^\s*\[\d+\]:\s', line):
                # Extract the part after line number
                code_part = re.sub(r'^\s*\[\d+\]:\s*', '', line).strip()
                if code_part and not code_part.startswith('//') and not code_part.startswith('/*'):
                    code_lines += 1
            # Skip comments and headers
            elif not stripped.startswith('//') and not stripped.startswith('/*') and not (stripped.startswith('/* inside ') and stripped.endswith(' */')):
                code_lines += 1
                
        return code_lines

    def _format_multiple_functions_source_code(self, candidates: List[Tuple[str, int]]) -> str:
        """
        Format the source code of multiple functions.
        Groups functions by their file path, sorts files alphabetically,
        and then sorts functions within each file by their starting line number.
        
        Args:
            candidates: List of (func_name, guid) tuples
            
        Returns:
            String with formatted source code, with /* inside file=filename */ headers
        """
        if not candidates:
            return ""
        
        file_functions = collections.defaultdict(list)
        for func_name, guid in candidates:
            fp = self.get_fp_from_func_id(guid)
            if not fp:
                continue
            start_line, _ = self.get_func_range_from_func_id(guid)
            file_functions[fp].append((func_name, guid, start_line))
        
        if not file_functions:
            return ""
        
        parts = []
        for filepath in sorted(file_functions.keys()):
            filename = os.path.basename(filepath)
            funcs_with_lines = file_functions[filepath]
            funcs_with_lines.sort(key=lambda x: x[2])
            
            parts.append(f"/* inside file={filename} */")
            
            for _, guid, _ in funcs_with_lines:
                source_code = self.get_function_source_code(guid)
                if source_code:
                    parts.append(source_code)
                    if len(funcs_with_lines) > 1:
                        parts.append("")
        
        return "\n".join(parts).rstrip()

    # Internal helpers for name resolution

    def _find_guid_by_func_name_ts(self, function_name: str) -> Optional[int]:
        """
        Use Tree-sitter to find a function by exact identifier name across the
        known function files and return its GUID if found. Returns None otherwise.
        """
        return ts.find_guid_by_func_name_ts(function_name, self.function_infos)

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
            if name_substr in func_name:
                candidates.append((func_name, guid))
                continue
            
            # For mangled names, try to match against the original pattern
            if self._is_mangled_name(func_name):
                # Try to extract meaningful parts from mangled name for matching
                if self._mangled_name_matches(func_name, name_substr):
                    candidates.append((func_name, guid))
                    continue
            
            # For original names that might match mangled patterns
            # If user searches for "parser::read_header", it might match a mangled name
            if "::" in name_substr and self._is_mangled_name(func_name):
                if self._original_name_matches_mangled(name_substr, func_name):
                    candidates.append((func_name, guid))
                    continue

        return candidates

    
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
            result = subprocess.run(['c++filt', name], 
                                  capture_output=True, text=True, timeout=5)
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
        Try to match a search term against a mangled name.
        This is a heuristic approach since full demangling is complex.
        """
        # Simple heuristic: look for patterns that might indicate the original name
        # This is not perfect but handles common cases
        
        # If search term contains ::, try to find class/namespace patterns
        if "::" in search_term:
            parts = search_term.split("::")
            # Look for these parts in some form within the mangled name
            for part in parts:
                if len(part) >= 3:  # Only consider meaningful parts
                    # Look for the part length followed by the part name (common in mangling)
                    pattern = f"{len(part)}{part}"
                    if pattern in mangled_name:
                        return True
        else:
            # For simple function names, look for length + name pattern
            if len(search_term) >= 3:
                pattern = f"{len(search_term)}{search_term}"
                if pattern in mangled_name:
                    return True
        
        return False
    
    def _original_name_matches_mangled(self, original_name: str, mangled_name: str) -> bool:
        """
        Check if an original name pattern (like parser::read_header) matches a mangled name.
        """
        return self._mangled_name_matches(mangled_name, original_name)
