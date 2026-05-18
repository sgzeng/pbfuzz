"""Global reproduction timeout and cursor-agent cleanup."""

from __future__ import annotations

import asyncio
import os
import signal
import subprocess
from pathlib import Path
from typing import Awaitable, Callable, TypeVar

from pbfuzz_repro import logs

T = TypeVar("T")

DEFAULT_RUN_TIMEOUT_SEC = 30 * 60  # 30 minutes


class RunTimeoutError(TimeoutError):
    """Raised when the full reproduction run exceeds the configured wall-clock limit."""


def _kill_pid(pid: int, sig: int = signal.SIGTERM) -> bool:
    try:
        os.kill(pid, sig)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return False


def _kill_pid_tree(pid: int) -> None:
    """Best-effort kill of a process and its children."""
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
        return
    except (ProcessLookupError, PermissionError, OSError):
        pass
    if _kill_pid(pid, signal.SIGTERM):
        try:
            subprocess.run(
                ["pkill", "-TERM", "-P", str(pid)],
                capture_output=True,
                timeout=5,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
    _kill_pid(pid, signal.SIGKILL)


def kill_cursor_agents_for_run(run_root: Path) -> int:
    """Terminate cursor-agent (and related node workers) tied to a run directory."""
    from pbfuzz_repro import cursor_runner

    killed = cursor_runner.kill_registered_cursor_procs()
    run_s = str(run_root.resolve())
    needles = (run_s, f"{run_s}/env/init_ws", f"{run_s}/source")

    try:
        proc = subprocess.run(
            ["pgrep", "-af", "cursor-agent"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except FileNotFoundError:
        return killed

    seen: set[int] = set()
    for line in (proc.stdout or "").splitlines():
        if not any(n in line for n in needles):
            continue
        try:
            pid = int(line.split(None, 1)[0])
        except (ValueError, IndexError):
            continue
        if pid in seen or pid == os.getpid():
            continue
        seen.add(pid)
        _kill_pid_tree(pid)
        killed += 1

    # cursor-agent spawns node worker-server children under the same workspace path
    try:
        proc = subprocess.run(
            ["pgrep", "-af", "worker-server"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except FileNotFoundError:
        return killed

    for line in (proc.stdout or "").splitlines():
        if run_s not in line:
            continue
        try:
            pid = int(line.split(None, 1)[0])
        except (ValueError, IndexError):
            continue
        if pid in seen or pid == os.getpid():
            continue
        seen.add(pid)
        _kill_pid_tree(pid)
        killed += 1

    return killed


def _sync_run_logs(run_root: Path) -> None:
    """Preserve partial agent logs after an abrupt stop."""
    run_root.mkdir(parents=True, exist_ok=True)
    findings = run_root / "findings"
    findings.mkdir(parents=True, exist_ok=True)
    src_log = run_root / "source" / "cursor.log"
    if src_log.is_file():
        dst = findings / "agent.log"
        try:
            dst.write_text(src_log.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
        except OSError:
            pass
    init_log = run_root / "env" / "init_ws" / "cursor.log"
    if init_log.is_file():
        dst = run_root / "env" / "init_agent_timeout.log"
        try:
            dst.write_text(init_log.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
        except OSError:
            pass


async def run_with_timeout(
    coro: Awaitable[T],
    *,
    timeout_sec: int,
    run_root: Path,
    on_timeout: Callable[[], None] | None = None,
) -> T:
    """Run *coro* with a wall-clock limit; clean up cursor-agent on expiry."""
    try:
        return await asyncio.wait_for(coro, timeout=timeout_sec)
    except asyncio.TimeoutError as e:
        if on_timeout:
            on_timeout()
        n = kill_cursor_agents_for_run(run_root)
        _sync_run_logs(run_root)
        logs.append_runtime(
            run_root,
            f"[timeout] reproduction exceeded {timeout_sec}s wall-clock limit; "
            f"killed {n} cursor-agent process(es)",
        )
        raise RunTimeoutError(
            f"Reproduction timed out after {timeout_sec}s ({timeout_sec // 60} min). "
            f"Logs saved under {run_root}. Killed {n} cursor-agent process(es)."
        ) from e
