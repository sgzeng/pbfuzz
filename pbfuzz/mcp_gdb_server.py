#!/usr/bin/env python3
"""
MCP (Model Context Protocol) Server for GDB Interactive Debugging

This server wraps gdb.sh to provide interactive GDB debugging capabilities to LLM agents.
Agents can launch GDB sessions and interact with them via named pipes.

Available tools:
- launch_interactive_gdb: Launch an interactive GDB session with a program
"""

import asyncio
import subprocess
import sys
import signal
import os
from pathlib import Path
from typing import List, Optional

try:
    import mcp.server.stdio
    import mcp.types as types
    from mcp.server import Server
except ImportError:
    print("Error: MCP package not installed. Please run: pip install mcp", file=sys.stderr)
    sys.exit(1)

from utils import read_workflow_state, check_tool_permission

# Create the MCP server
server = Server("gdb-server")

# Defaults to current directory for testing gatekeeper, can be overridden in main()
state_file_path = Path.cwd() / ".cursor" / "workflow_state.md"

def _check_workflow_gatekeeper(tool_name: str) -> Optional[str]:
    """Check workflow gatekeeper rules for tool access."""
    if not state_file_path or not state_file_path.exists():
        return f"🚫 **Workflow State Required**: No workflow state file found at {state_file_path}"
    
    try:
        memory = read_workflow_state(state_file_path)
        current_phase = memory.state.phase
        
        # GDB is allowed in REFLECT phase
        if not check_tool_permission(current_phase, tool_name):
            return f"🚫 **Phase Gatekeeper**: Tool '{tool_name}' not allowed in {current_phase} phase. Must be in REFLECT phase."
        
        return None
        
    except Exception as e:
        return f"🚫 **Workflow Error**: Failed to read workflow state: {e}"

@server.list_tools()
async def handle_list_tools() -> List[types.Tool]:
    """List available tools"""
    return [
        types.Tool(
            name="launch_interactive_gdb",
            description=(
                "Launch an interactive GDB debugging session. "
                "Returns instructions for sending commands and reading output via named pipes. "
                "Use this for manual precondition verification, root cause analysis, and TriggerPlan verification."
                "CRITICAL: Session cannot be reused. One gdb session per input file."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "cmd": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Command to debug as array (e.g., ['./target', 'input.txt'])"
                    },
                    "timeout": {
                        "type": "string",
                        "description": "Session timeout (e.g., '2m', '180s', '5m'). Default: 2m",
                        "default": "2m"
                    }
                },
                "required": ["cmd"]
            }
        )
    ]

@server.call_tool()
async def handle_call_tool(name: str, arguments: dict) -> List[types.TextContent]:
    """Handle tool calls with gatekeeper enforcement"""
    
    # Gatekeeper check
    gatekeeper_error = _check_workflow_gatekeeper(name)
    if gatekeeper_error:
        return [types.TextContent(
            type="text",
            text=gatekeeper_error + "\n\n**Required Actions:**\n"
                 "1. Read workflow_state.md to check current phase\n"
                 "2. Use transition_phase tool to transition to REFLECT phase\n"
                 "3. Then retry this tool"
        )]
    
    if name == "launch_interactive_gdb":
        return await _handle_launch_gdb(arguments)
    
    raise ValueError(f"Unknown tool: {name}")

async def _handle_launch_gdb(arguments: dict) -> List[types.TextContent]:
    """Launch GDB session via gdb.sh wrapper"""
    cmd = arguments.get("cmd", [])
    timeout = arguments.get("timeout", "2m")
    
    if not cmd:
        return [types.TextContent(
            type="text",
            text="Error: cmd parameter is required (array of strings)"
        )]
    
    # Find gdb.sh script
    script_dir = Path(__file__).parent.absolute()
    gdb_script = script_dir / "gdb.sh"
    
    if not gdb_script.exists():
        return [types.TextContent(
            type="text",
            text=f"Error: gdb.sh not found at {gdb_script}"
        )]
    
    # Build command
    gdb_cmd = [str(gdb_script), "-t", timeout, "--"] + cmd
    
    # Launch gdb.sh in background
    try:
        process = subprocess.Popen(
            gdb_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True
        )
        
        # Read the initial output (instructions)
        output_lines = []
        if not process.stdout:
            return [types.TextContent(
                type="text",
                text="Error: Failed to capture gdb.sh output"
            )]
        
        try:
            for _ in range(20):  # Read first ~20 lines of instructions
                line = process.stdout.readline()
                if not line:
                    break
                output_lines.append(line.rstrip())
        except Exception as e:
            return [types.TextContent(
                type="text",
                text=f"Error reading gdb.sh output: {e}"
            )]
        
        instruction_text = "\n".join(output_lines)
        
        return [types.TextContent(
            type="text",
            text=f"✅ **GDB Session Launched** (PID: {process.pid})\n\n{instruction_text}"
        )]
        
    except Exception as e:
        return [types.TextContent(
            type="text",
            text=f"Error launching GDB session: {e}"
        )]

def setup_signal_handlers():
    """Setup signal handlers for graceful shutdown"""
    def signal_handler(signum, frame):
        print(f"\nReceived signal {signum}, shutting down...", file=sys.stderr)
        os._exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

async def main():
    """Run the MCP server"""
    import argparse
    
    parser = argparse.ArgumentParser(description="MCP GDB Interactive Debugging Server")
    parser.add_argument(
        "--source-code-dir",
        required=False,
        help="Source code directory containing .cursor/workflow_state.md (default: current directory)"
    )
    args = parser.parse_args()
    
    # Set the global state_file_path based on source_code_dir
    global state_file_path
    source_code_dir = Path(args.source_code_dir) if args.source_code_dir else Path.cwd()
    state_file_path = source_code_dir / ".cursor" / "workflow_state.md"
    
    setup_signal_handlers()
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options()
        )

if __name__ == "__main__":
    asyncio.run(main())

