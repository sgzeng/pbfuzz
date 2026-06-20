#!/usr/bin/env python3
"""
MCP (Model Context Protocol) Server for Deviation Detection

This server provides deviation detection functionality to help LLM agents understand
why their generated inputs didn't reach the target by analyzing execution flow 
against critical branches identified by static analysis.

Available tools:
- detect_deviation: Analyze input execution and detect where it deviates from expected path to target
"""

import argparse
import asyncio
import logging
import os
import collections
import signal
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
from debugger import RuntimeDebugger
import utils

try:
    import mcp.server.stdio
    import mcp.types as types
    from mcp.server import Server
except ImportError:
    print("Error: MCP package not installed. Please run: pip install mcp", file=sys.stderr)
    sys.exit(1)

from config import Config
import schemas
from utils import read_workflow_state, check_tool_permission


"""
Deserialize a critical branches from a text file to the list of unreachable branch IDs.
    critical_BB_file: each line "bid,fid1,fid2,…"

Returns:
    dict mapping critical branches bid to a list of unreachable BIDs:
"""
def deserialize_critical_BBs_from_txt(critical_BB_file):
    critical_branch_info = collections.defaultdict(list)
    # load critical branches from critical branches file
    if os.path.isfile(critical_BB_file):
        with open(critical_BB_file, 'r') as file:
            for l in file:
                l = l.strip()
                if not l:
                    continue
                items = l.split(',')
                assert len(items) >= 2, f"Invalid critical branches line: {l}"
                bid = int(items[0])
                fids = items[1:]
                critical_branch_info[bid].extend(int(fid) for fid in fids if fid.isdigit())
    return critical_branch_info

def serialize_critical_BBs_to_txt(critical_BBs, file_path):
    with open(file_path, 'w') as f:
        for bid, fids in critical_BBs.items():
            if not fids:
                continue
            f.write(f"{bid},{','.join(str(fid) for fid in fids)}\n")

class ReachingPreconditionInferrer:
    """
    Automatically infer reaching preconditions from static analysis results.
    
    Uses critical_BBs.txt to identify boundary basic blocks and generate:
    1. Reaching preconditions for LLM agent
    2. Runtime breakpoints to detect execution flow deviations
    """
    
    def __init__(self, config, critical_branch_fp):
        self.config = config
        self.logger = logging.getLogger(self.__class__.__qualname__)
        
        # Cache for source code finder (lazy initialization)
        self._source_finder = None
        self.critical_branch_info = {}
        self.unreachable_bid_locations = {}
        self.breakpoints = []
        try:
            self.critical_branch_info = deserialize_critical_BBs_from_txt(critical_branch_fp)
            # Build mapping: unreachable_bid -> list of program locations
            self.unreachable_bid_locations = self._build_unreachable_bid_mapping()
            self.breakpoints = self._generate_static_breakpoint()
        except Exception:
            pass
    
    @property
    def source_finder(self):
        """Lazy initialization of source code finder."""
        if self._source_finder is None:
            from source_code import SourceCodeFinder
            self._source_finder = SourceCodeFinder(self.config)
        return self._source_finder
    
    def _build_unreachable_bid_mapping(self):
        """
        Build mapping from unreachable BID to list of program locations.
        
        Returns:
            Dict mapping unreachable_bid -> list of location strings
        """
        bid_locations = collections.defaultdict(list)
        
        if not self.critical_branch_info:
            self.logger.warning("No critical_branch_info found")
            return bid_locations
        
        # Collect all unreachable BIDs
        unreachable_bids = []
        for reachable_bid, unreachable_bid_list in self.critical_branch_info.items():
            unreachable_bids.extend(unreachable_bid_list)
        
        # Remove duplicates
        unreachable_bids = list(set(unreachable_bids))
        
        # Map each unreachable BID to its program locations
        for bid in unreachable_bids:
            try:
                result = self.source_finder.find_loc_info(bid=bid)
                if result and len(result) >= 2:
                    func_name, loc = result
                    if loc:
                        bid_locations[bid].append(loc)
            except Exception as e:
                self.logger.warning(f"Error getting location info for unreachable BID {bid}: {e}")
                continue
        
        self.logger.info(f"Built mapping for {len(bid_locations)} unreachable BIDs")
        return bid_locations
    
    def _generate_static_breakpoint(self):
        """
        Generate breakpoint requests for R0 static precondition monitoring.
        
        Returns:
            List of breakpoint request dictionaries for the unreachable BIDs
        """
        if not self.unreachable_bid_locations:
            return []
        
        breakpoints = []
        
        # Create breakpoint requests (limit to avoid overwhelming the debugger)
        max_breakpoints = 20
        count = 0
        
        for bid, locations in self.unreachable_bid_locations.items():
            if count >= max_breakpoints:
                break
                
            for location in locations:
                if count >= max_breakpoints:
                    break
                    
                breakpoint = {
                    "for_precond_id": "R0",
                    "locations": [location],
                    "print_call_stack": False
                }
                
                breakpoints.append(breakpoint)
                count += 1
        return breakpoints
    

class MCPDeviationDetectorServer:
    """MCP Server wrapper for deviation detection functionality"""
    
    def __init__(self, static_folder: str, cmd: List[str], 
                 reached_pattern: str, exec_timeout_sec: int = 3,
                 source_code_dir: Optional[str] = None):
        self.server = Server("deviation-detector-server")
        self.static_folder = Path(static_folder)
        self.critical_bb_file = self.static_folder / "critical_BBs.txt"
        self.cmd = cmd
        self.reached_pattern = reached_pattern
        self.exec_timeout_sec = exec_timeout_sec
        self.logger = logging.getLogger(__name__)
        
        # Initialize configuration and error logging
        self.config = self._create_config()
        self.fuzz_results_dir = self.static_folder.parent / "output" / "fuzzing_results"
        self.fuzz_results_dir.mkdir(parents=True, exist_ok=True)
        self.error_log_file = self.fuzz_results_dir / "deviation_detector_error.log"
        
        # Workflow state management for gatekeeper - fixed path in .cursor directory
        self.source_code_dir = Path(source_code_dir) if source_code_dir else Path.cwd()
        self.state_file_path = self.source_code_dir / ".cursor" / "workflow_state.md"
        
        # Initialize deviation detection components
        self.inferrer: Optional[ReachingPreconditionInferrer] = None
        
        # Register MCP tools
        self._register_tools()
        
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

    def _create_config(self) -> Config:
        """Create a config object from provided parameters"""
        config = Config()
        config.static_result_folder = self.static_folder
        config.cmd = self.cmd
        config.reached_pattern = self.reached_pattern
        config.exec_timeout_sec = self.exec_timeout_sec
        # Enable debugger for deviation detection
        config.enable_debugger_for_all = True
        return config

    def _log_error_to_file(self, message: str, stage: str = "unknown") -> None:
        """
        Log error/warning messages to error.log file for later retrieval by agent.
        
        Args:
            message: Error message to log
            stage: Stage where error occurred (e.g., 'initialization', 'execution', etc.)
        """
        utils.log_error_to_file(self.error_log_file, message, stage, "deviation_detector", self.logger)

    def _initialize_components(self):
        """Lazy initialization of heavy components"""
        if self.inferrer is None:
            # Check if critical_BBs.txt exists
            if not self.critical_bb_file.exists():
                self._log_error_to_file(f"Critical BBs file not found: {self.critical_bb_file}", "initialization")
                self._log_error_to_file("Creating empty ReachingPreconditionInferrer (no critical branches)", "initialization")
                # Create empty critical BBs file to allow initialization
                self.critical_bb_file.touch()                
            # Check if file is empty
            if self.critical_bb_file.stat().st_size == 0:
                self._log_error_to_file("Critical BBs file is empty, no critical breakpoints will be set", "initialization")                
            self.inferrer = ReachingPreconditionInferrer(
                self.config, 
                str(self.critical_bb_file)
            )
            breakpoint_count = len(self.inferrer.breakpoints) if self.inferrer.breakpoints else 0
            self.logger.info(f"Initialized ReachingPreconditionInferrer with {breakpoint_count} critical breakpoints")
            if breakpoint_count == 0:
                self._log_error_to_file("No critical breakpoints were generated from static analysis", "initialization")

    def _register_tools(self):
        """Register MCP tools"""
        
        @self.server.list_tools()
        async def handle_list_tools() -> List[types.Tool]:
            """List available tools"""
            return [
                types.Tool(
                    name="detect_deviation",
                    description=(
                        "Analyze input execution to detect where it deviates from expected path to target. "
                        "Use this when your generated input fails to reach the target location - it will show "
                        "exactly where execution deviated and provide callstack information to help you understand "
                        "why the input didn't reach the target. Essential for debugging failed test generation strategies.\n\n"
                        "**Breakpoint Behavior:**\n"
                        "- If extra_bp is provided, only agent breakpoints are used\n"
                        "- If extra_bp is empty, only static analysis breakpoints are used\n"
                        "- All breakpoints automatically have print_call_stack enabled\n\n"
                        "**LLDB Breakpoint Rules:**\n"
                        "- LLDB breakpoints fire BEFORE the line runs\n"
                        "- If you stop on an assignment line, the variable still shows the OLD value\n"
                        "- To see the updated value, set the breakpoint after the assignment, not on it\n"
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "input_file_path": {
                                "description": "Path to file containing input data to test",
                                "type": "string"
                            },
                            "extra_bp": {
                                "type": "array", 
                                "description": "Additional breakpoints from agent for focused analysis (optional)",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "location": {
                                            "type": "string",
                                            "description": "Breakpoint location (full_file_path:line_number)"
                                        },
                                        "hit_limit": {
                                            "type": "integer",
                                            "description": "Maximum hits for this breakpoint",
                                            "default": 10
                                        },
                                        "inline_expr": {
                                            "type": "array",
                                            "description": "Variable expressions to evaluate at breakpoint",
                                            "items": {"type": "string"},
                                            "default": []
                                        }
                                    },
                                    "required": ["location"]
                                },
                                "default": []
                            }
                        },
                        "required": ["input_file_path"]
                    }
                )
            ]
        
        @self.server.call_tool()
        async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> List[types.TextContent]:
            """Handle tool calls with gatekeeper enforcement"""
            
            # Gatekeeper check for deviation detection tools (ANALYZE phase only)
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
            
            try:
                if name == "detect_deviation":
                    return await self._handle_detect_deviation(arguments)
                else:
                    return [types.TextContent(
                        type="text",
                        text=f"Error: Unknown tool '{name}'"
                    )]
                    
            except Exception as e:
                error_msg = f"Error handling tool '{name}': {e}"
                self._log_error_to_file(error_msg, f"tool_{name}")
                return [types.TextContent(
                    type="text",
                    text=f"Error: {str(e)}"
                )]

    async def _handle_detect_deviation(self, arguments: Dict[str, Any]) -> List[types.TextContent]:
        """
        Handle detect_deviation tool call.
        
        Args:
            arguments: Tool arguments containing input_file_path and optional extra_bp
            
        Returns:
            Analysis message about deviation or success
        """
        try:
            # Validate required parameters
            if 'input_file_path' not in arguments:
                return [types.TextContent(
                    type="text",
                    text="Error: 'input_file_path' parameter is required"
                )]
            
            input_file_path = arguments['input_file_path']
            extra_bp = arguments.get('extra_bp', [])
            
            # Validate extra_bp breakpoints
            try:
                for i, bp in enumerate(extra_bp):
                    if not isinstance(bp, dict):
                        return [types.TextContent(
                            type="text",
                            text=f"Error: extra_bp[{i}] must be an object/dictionary"
                        )]
                    
                    if 'location' not in bp:
                        return [types.TextContent(
                            type="text",
                            text=f"Error: extra_bp[{i}] missing required 'location' field"
                        )]
                    
                    # Validate breakpoint using Breakpoint schema
                    try:
                        # Create a Breakpoint instance to trigger validation
                        schemas.Breakpoint(
                            location=bp['location'],
                            hit_limit=bp.get('hit_limit', 10),
                            inline_expr=bp.get('inline_expr', []),
                            print_call_stack=bp.get('print_call_stack', False)
                        )
                    except ValueError as ve:
                        return [types.TextContent(
                            type="text",
                            text=f"Error: Invalid breakpoint extra_bp[{i}]: {str(ve)}."
                        )]
                    except Exception as e:
                        return [types.TextContent(
                            type="text",
                            text=f"Error: Failed to validate extra_bp[{i}]: {str(e)}"
                        )]
                        
            except Exception as e:
                return [types.TextContent(
                    type="text",
                    text=f"Error: Failed to validate extra_bp parameter: {str(e)}"
                )]
            
            # Validate file exists and read input data
            try:
                if not os.path.exists(input_file_path):
                    return [types.TextContent(
                        type="text",
                        text=f"Error: Input file not found: {input_file_path}"
                    )]
                
                if not os.path.isfile(input_file_path):
                    return [types.TextContent(
                        type="text",
                        text=f"Error: Path is not a file: {input_file_path}"
                    )]
                
                # Read file content as bytes
                with open(input_file_path, 'rb') as f:
                    input_data = f.read()
                
                # Check if file is empty
                if len(input_data) == 0:
                    return [types.TextContent(
                        type="text",
                        text=f"Error: Input file is empty: {input_file_path}"
                    )]
                    
            except Exception as e:
                return [types.TextContent(
                    type="text",
                    text=f"Error: Failed to read input file '{input_file_path}': {e}"
                )]
            
            # Initialize components if needed
            self._initialize_components()
            
            # Prepare breakpoints from inferrer and agent
            merged_breakpoints = self._prepare_breakpoints(extra_bp)
            
            # Execute with debugger
            result_message = await self._execute_and_analyze(input_file_path, merged_breakpoints)
            
            return [types.TextContent(
                type="text", 
                text=result_message
            )]
            
        except Exception as e:
            error_msg = f"Error in detect_deviation: {e}"
            self._log_error_to_file(error_msg, "detect_deviation")
            return [types.TextContent(
                type="text",
                text=f"Error: {str(e)}"
            )]

    def _prepare_breakpoints(self, extra_bp: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Prepare breakpoints for deviation detection.
        If extra_bp is empty, fallback to using inferrer breakpoints only.
        Set print_call_stack to True for all breakpoints.
        
        Args:
            extra_bp: Additional breakpoints from agent (optional)
            
        Returns:
            List of breakpoint dictionaries for debugger
        """
        result = []
        
        # Helper to convert inferrer breakpoint format to debugger format
        def convert_inferrer_bp(bp: Dict[str, Any]) -> List[Dict[str, Any]]:
            if not isinstance(bp, dict) or 'locations' not in bp:
                return []
            return [
                {
                    'location': loc,
                    'hit_limit': bp.get('hit_limit', 10),
                    'inline_expr': bp.get('inline_expr', []),
                    'print_call_stack': True
                }
                for loc in bp['locations']
            ]
        
        # Add agent breakpoints (ensure print_call_stack is enabled)
        if extra_bp:
            for bp in extra_bp:
                if isinstance(bp, dict):
                    agent_bp = bp.copy()
                    agent_bp['print_call_stack'] = True
                    result.append(agent_bp)
        else:
            # Add inferrer breakpoints
            inferrer_bps = self.inferrer.breakpoints if self.inferrer and self.inferrer.breakpoints else []
            for bp in inferrer_bps:
                result.extend(convert_inferrer_bp(bp))
        
        return result

    async def _execute_and_analyze(self, input_file_path: str, breakpoints: List[Dict[str, Any]]) -> str:
        """
        Execute target program with input file and analyze results for deviation.
        
        Args:
            input_file_path: Path to file containing input data
            breakpoints: Merged breakpoints list
            
        Returns:
            Analysis message string
        """
        debugger_instance = None
        try:
            debugger_instance = RuntimeDebugger(self.config)
        except Exception as e:
            error_msg = f"Error initializing debugger: {e}"
            self._log_error_to_file(error_msg, "execution")
            return f"Error initializing debugger: {str(e)}"
        
        try:
            # Prepare command with input file
            with open(input_file_path, "rb") as f:
                file_content = f.read()
            
            # Convert cmd list to template string for prepare_cmd_and_stdin
            cmd_template = " ".join(self.cmd)
            cmd_args, stdin_data = utils.prepare_cmd_and_stdin(cmd_template, input_file_path, file_content)
            
            result = debugger_instance.run_sync(
                cmd=cmd_args,
                stdin=stdin_data,
                exec_timeout_sec=self.exec_timeout_sec,
                breakpoints=breakpoints
            )
            
            # Analyze results (use file_content that was already read)
            return self._analyze_execution_result(result, file_content)
                    
        except Exception as e:
            error_msg = f"Error in execution and analysis: {e}"
            self._log_error_to_file(error_msg, "execution")
            return f"Error during execution: {str(e)}"
        finally:
            if debugger_instance:
                debugger_instance.close()

    def _analyze_execution_result(self, result, input_data: bytes) -> str:
        """
        Analyze debugger execution result to determine deviation.
        
        Args:
            result: RuntimeFeedbackV2 object from debugger
            input_data: Original input data (for context)
            
        Returns:
            Deviation analysis message
        """
        try:
            # Check if target was reached by looking for reached pattern in stderr
            stderr_output = result.stderr if hasattr(result, 'stderr') else ""
            target_reached = self.reached_pattern in stderr_output if self.reached_pattern and stderr_output else False
            
            if target_reached:
                return "Reached, No deviation."
            
            # Target not reached, analyze breakpoint hits for deviation information
            if not hasattr(result, 'breakpoints') or not result.breakpoints:
                return "Target not reached. No breakpoints were hit. Please explore the codebase and set more breakpoints."
            
            # Collect callstack information from breakpoint hits
            deviation_info = []
            hit_breakpoints = [bp for bp in result.breakpoints if bp.hit_times > 0]
            
            if not hit_breakpoints:
                return "Target not reached. No breakpoints were hit. Please explore the codebase and set more breakpoints."
            
            # Build deviation message with callstack info
            deviation_info.append(f"Target not reached. Execution deviated at {len(hit_breakpoints)} breakpoint(s):")
            
            for bp in hit_breakpoints:
                location = f"{bp.file_path}:{bp.line}"
                function = bp.function_name if bp.function_name else "unknown"
                hit_count = bp.hit_times
                
                deviation_info.append(f"\n• {function} at {location} (hit {hit_count} times)")
                
                # Add callstack information if available
                if bp.hits_info:
                    for hit_info in bp.hits_info[:3]:  # Show first 3 hits to avoid too much output
                        if hasattr(hit_info, 'callstack') and hit_info.callstack:
                            # Format callstack nicely
                            callstack_lines = hit_info.callstack.strip().split('\n')
                            if callstack_lines:
                                deviation_info.append("  Call stack:")
                                for stack_line in callstack_lines[:5]:  # Limit to 5 stack frames
                                    deviation_info.append(f"    {stack_line}")
                                if len(callstack_lines) > 5:
                                    deviation_info.append(f"    ... ({len(callstack_lines) - 5} more frames)")
                        break  # Only show callstack from first hit
            
            # Add summary with suggestion
            deviation_info.append(f"\nConsider:")
            deviation_info.append("1. Analyzing why execution deviated from the expected path to target at these locations")  
            deviation_info.append("2. Refining reaching preconditions and adjusting input generation to avoid these code paths")
            deviation_info.append("3. (Optional) Use gdb.sh to manually interact with the program to understand the deviation")
            
            return "".join(deviation_info)
            
        except Exception as e:
            error_msg = f"Error analyzing execution result: {e}"
            self._log_error_to_file(error_msg, "analysis")
            return f"Error analyzing execution result: {str(e)}"

def setup_logging():
    """Setup logging configuration"""
    logging.basicConfig(
        level=logging.ERROR,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )

async def main():
    """Main entry point for the MCP server"""
    parser = argparse.ArgumentParser(description="MCP Deviation Detector Server")
    parser.add_argument(
        "--static-folder",
        required=True,
        help="Path to static analysis results folder"
    )
    parser.add_argument(
        "--reached-pattern",
        required=True,
        help="Pattern to match for reached target"
    )
    parser.add_argument(
        "--exec-timeout-sec",
        type=int,
        default=3,
        help="Timeout in seconds for each execution (default: 3)"
    )
    parser.add_argument(
        "cmd",
        nargs="+",
        help="Command line for target program (use @@ for input file placeholder)"
    )
    parser.add_argument(
        "--source-code-dir",
        required=False,
        help="Source code directory containing .cursor/workflow_state.md (default: current directory)"
    )
    
    args = parser.parse_args()
    
    # Validate arguments
    if not args.cmd:
        print("Error: Command line is required", file=sys.stderr)
        sys.exit(1)
        
    if not os.path.isdir(args.static_folder):
        print(f"Error: Static folder {args.static_folder} does not exist", file=sys.stderr)
        sys.exit(1)

    setup_logging()
    
    # Create and run server
    server_instance = MCPDeviationDetectorServer(
        static_folder=args.static_folder,
        cmd=args.cmd,
        reached_pattern=args.reached_pattern,
        exec_timeout_sec=args.exec_timeout_sec,
        source_code_dir=args.source_code_dir
    )
    
    # Setup signal handlers for graceful shutdown
    def signal_handler(signum, frame):
        print(f"\nReceived signal {signum}, shutting down...", file=sys.stderr)
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Run the server
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server_instance.server.run(
            read_stream,
            write_stream,
            server_instance.server.create_initialization_options()
        )


if __name__ == "__main__":
    asyncio.run(main())