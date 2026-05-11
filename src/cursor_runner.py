"""Run ``cursor-agent`` once per invocation (headless print mode)."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

_CURSOR_CLI_PERMISSIONS = {
    "permissions": {
        "allow": [
            "Shell(*)",
            "Read(**)",
            "Write(**)",
            "WebFetch(*)",
            "Mcp(fuzzer:*)",
            "Mcp(gdb:*)",
            "Mcp(workflow:*)",
            "Mcp(build:*)",
        ],
        "deny": [],
    }
}


def cursor_agent_model() -> str:
    """Match ``pbfuzz_env.build_launcher_dict`` precedence so launcher metadata and CLI agree."""
    return (os.environ.get("PBFUZZ_LLM_MODEL") or os.environ.get("CURSOR_MODEL") or "").strip()


def ensure_cursor_cli_permissions(workspace: Path) -> Path:
    """Write ``<workspace>/.cursor/cli.json`` so MCP + shell tools do not stall on approval prompts.

    ``cursor-agent --workspace`` treats this directory as the project root; permissions are
    read from ``.cursor/cli.json`` there (global fallback: ``~/.cursor/cli-config.json``).
    """
    root = Path(workspace).resolve()
    cursor_dir = root / ".cursor"
    cursor_dir.mkdir(parents=True, exist_ok=True)
    path = cursor_dir / "cli.json"
    path.write_text(json.dumps(_CURSOR_CLI_PERMISSIONS, indent=2), encoding="utf-8")
    return path


async def run_iteration(workspace: Path, prompt: str, timeout: int = 3600) -> str:
    """Execute one ``cursor-agent -p`` pass; persist combined output to ``cursor.log``."""
    if os.environ.get("SKIP_CURSOR_CLI_PERMISSION_SEED", "").lower() not in (
        "1",
        "true",
        "yes",
    ):
        ensure_cursor_cli_permissions(workspace)
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
    if model := cursor_agent_model():
        cmd += ["--model", model]
    cmd.append(prompt)
    root = Path(workspace).resolve()
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(root),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await _communicate_with_timeout(proc, timeout)
    text = out.decode(errors="replace")
    (workspace / "cursor.log").write_text(text)
    return text


async def run_iteration_source_only(prompt_file: Path, workspace: Path, timeout: int = 7200) -> str:
    """Run cursor-agent with prompt body read from ``prompt_file`` (full fuzzing prompt)."""
    prompt = prompt_file.read_text(encoding="utf-8", errors="replace")
    return await run_iteration(workspace, prompt, timeout=timeout)


async def _communicate_with_timeout(
    proc: asyncio.subprocess.Process, timeout: int
) -> tuple[bytes, bytes | None]:
    """Collect output with timeout; on timeout or cancel, kill process (timeout raises with tail)."""
    try:
        return await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as e:
        proc.kill()
        out, err = await proc.communicate()
        tail = out.decode(errors="replace")[-2000:]
        raise TimeoutError(
            f"cursor-agent timed out after {timeout}s (partial_output_tail={tail!r})"
        ) from e
    except asyncio.CancelledError:
        if proc.returncode is None:
            proc.kill()
            try:
                await asyncio.wait_for(proc.wait(), timeout=10)
            except (TimeoutError, asyncio.CancelledError):
                pass
        raise
