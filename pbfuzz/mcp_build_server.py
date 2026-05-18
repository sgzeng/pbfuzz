#!/usr/bin/env python3
"""
MCP server for oracle instrumentation and project rebuild.

Implements stdio tools insert_oracle and rebuild_project; logic lives in mcp_build_core.py.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import List, Optional

try:
    import mcp.server.stdio
    import mcp.types as types
    from mcp.server import Server
except ImportError:
    print("Error: MCP package not installed. Please run: pip install mcp", file=sys.stderr)
    sys.exit(1)

from mcp_build_core import (
    insert_oracle_into_file,
    read_phase,
    run_rebuild,
    workflow_path,
    workspace_root,
)
from mcp_workflow_server import parse_json_block, replace_json_block

logger = logging.getLogger(__name__)


class MCPBuildServer:
    """stdio MCP server exposing insert_oracle and rebuild_project."""

    def __init__(
        self,
        source_code_dir: Optional[str] = None,
        workspace_root_arg: Optional[str] = None,
        cybergym_root_arg: Optional[str] = None,
    ):
        self.source_code_dir = Path(source_code_dir).resolve() if source_code_dir else Path.cwd()
        wr_arg = workspace_root_arg or cybergym_root_arg
        self.workspace_root_p = (
            Path(wr_arg).resolve()
            if wr_arg
            else workspace_root(self.source_code_dir, None)
        )
        self.workflow_file = workflow_path(self.source_code_dir)
        self.log_path = self.workspace_root_p / "output" / "last_build.log"
        self.server = Server("build-server")
        self._setup_handlers()

    def _setup_handlers(self) -> None:
        src = self.source_code_dir
        wf = self.workflow_file
        root = self.workspace_root_p
        log_path = self.log_path

        @self.server.list_tools()
        async def list_tools() -> List[types.Tool]:
            return [
                types.Tool(
                    name="insert_oracle",
                    description=(
                        "Insert oracle prints before a source line. PLAN phase only. "
                        "Removes prior PBFUZZ_ORACLE blocks in the same file."
                    ),
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "file": {"type": "string"},
                            "line": {"type": "integer"},
                            "condition_expr": {"type": "string"},
                            "task_id": {"type": "string"},
                        },
                        "required": ["file", "line", "condition_expr", "task_id"],
                    },
                ),
                types.Tool(
                    name="rebuild_project",
                    description="Run build_info.json build_cmd; updates BuildInfo. PLAN or EXECUTE only.",
                    inputSchema={"type": "object", "properties": {}},
                ),
            ]

        @self.server.call_tool()
        async def call_tool(name: str, arguments: dict) -> List[types.TextContent]:
            phase = read_phase(wf)
            if name == "insert_oracle":
                if phase != "PLAN":
                    return [
                        types.TextContent(
                            type="text",
                            text=f"insert_oracle only allowed in PLAN phase (current={phase})",
                        )
                    ]
                args = arguments or {}
                result = insert_oracle_into_file(
                    src,
                    str(args.get("file", "")),
                    int(args.get("line", 0)),
                    str(args.get("condition_expr", "0")),
                    str(args.get("task_id", "")),
                    bbtargets_root=root,
                )
                if result.get("ok") and wf.exists():
                    content = wf.read_text(encoding="utf-8")
                    bi = parse_json_block(content, "BuildInfo")
                    if not isinstance(bi, dict):
                        bi = {}
                    bi["dirty"] = True
                    content = replace_json_block(content, "BuildInfo", bi)
                    wf.write_text(content, encoding="utf-8")
                return [types.TextContent(type="text", text=json.dumps(result, indent=2))]

            if name == "rebuild_project":
                if phase not in ("PLAN", "EXECUTE"):
                    return [
                        types.TextContent(
                            type="text",
                            text=f"rebuild_project only allowed in PLAN or EXECUTE (current={phase})",
                        )
                    ]
                out = run_rebuild(root, src, wf, log_path)
                return [types.TextContent(type="text", text=json.dumps(out, indent=2))]

            return [types.TextContent(type="text", text=f"unknown tool {name}")]

    async def run_stdio(self) -> None:
        async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
            await self.server.run(
                read_stream,
                write_stream,
                self.server.create_initialization_options(),
            )


def main() -> None:
    import argparse

    logging.basicConfig(level=logging.INFO)
    p = argparse.ArgumentParser(description="MCP build / oracle server")
    p.add_argument("--source-code-dir", required=True)
    p.add_argument("--workspace-root", default=None)
    p.add_argument("--cybergym-root", default=None, help=argparse.SUPPRESS)
    args = p.parse_args()
    srv = MCPBuildServer(
        source_code_dir=args.source_code_dir,
        workspace_root_arg=args.workspace_root or args.cybergym_root,
    )
    asyncio.run(srv.run_stdio())


if __name__ == "__main__":
    main()
