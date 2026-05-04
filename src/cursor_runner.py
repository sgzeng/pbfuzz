"""Run ``cursor-agent`` once per refinement iteration against a workspace directory.

State across iterations lives in workspace files (notably ``feedback.json``), matching the CLI's
single-shot print mode."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path


async def run_iteration(workspace: Path, prompt: str, timeout: int = 900) -> str:
    """Execute one ``cursor-agent -p`` pass; persist combined output to ``cursor.log`` for debugging."""
    cmd = [
        "cursor-agent",
        "-p",
        "--force",
        "--trust",
        "--workspace",
        str(workspace),
        "--output-format",
        "text",
    ]
    if model := os.environ.get("CURSOR_MODEL"):
        cmd += ["--model", model]
    cmd.append(prompt)
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    text = out.decode(errors="replace")
    (workspace / "cursor.log").write_text(text)
    return text
