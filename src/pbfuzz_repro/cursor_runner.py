"""Run ``cursor-agent`` once per invocation (headless print mode)."""

from __future__ import annotations

import asyncio
import json
import os
import signal
from pathlib import Path

_active_cursor_procs: list[asyncio.subprocess.Process] = []

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
    return (os.environ.get("PBFUZZ_LLM_MODEL") or os.environ.get("CURSOR_MODEL") or "").strip()


def _register_cursor_proc(proc: asyncio.subprocess.Process) -> None:
    _active_cursor_procs.append(proc)


def kill_registered_cursor_procs() -> int:
    """Kill cursor-agent subprocesses started by this driver (returns count attempted)."""
    killed = 0
    for proc in list(_active_cursor_procs):
        if proc.returncode is not None:
            continue
        killed += 1
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    _active_cursor_procs.clear()
    return killed


def ensure_cursor_cli_permissions(workspace: Path) -> Path:
    root = Path(workspace).resolve()
    cursor_dir = root / ".cursor"
    cursor_dir.mkdir(parents=True, exist_ok=True)
    path = cursor_dir / "cli.json"
    path.write_text(json.dumps(_CURSOR_CLI_PERMISSIONS, indent=2), encoding="utf-8")
    return path


async def run_iteration(workspace: Path, prompt: str, timeout: int = 3600) -> str:
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
        start_new_session=True,
    )
    _register_cursor_proc(proc)
    out, _ = await _communicate_with_timeout(proc, timeout)
    text = out.decode(errors="replace")
    (workspace / "cursor.log").write_text(text)
    return text


async def run_iteration_source_only(prompt_file: Path, workspace: Path, timeout: int = 7200) -> str:
    prompt = prompt_file.read_text(encoding="utf-8", errors="replace")
    return await run_iteration(workspace, prompt, timeout=timeout)


async def _communicate_with_timeout(
    proc: asyncio.subprocess.Process, timeout: int
) -> tuple[bytes, bytes | None]:
    try:
        return await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as e:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            proc.kill()
        out, err = await proc.communicate()
        tail = out.decode(errors="replace")[-2000:]
        raise TimeoutError(
            f"cursor-agent timed out after {timeout}s (partial_output_tail={tail!r})"
        ) from e
    except asyncio.CancelledError:
        if proc.returncode is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                proc.kill()
            try:
                await asyncio.wait_for(proc.wait(), timeout=10)
            except (TimeoutError, asyncio.CancelledError):
                pass
        raise
