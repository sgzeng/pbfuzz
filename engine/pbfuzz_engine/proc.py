"""Run a subprocess with a timeout that kills its whole session, not just the direct child.

`subprocess.run(timeout=...)` (and a bare `Popen.communicate(timeout=...)`) only ever signals
the one process it started. If that process forks something else before it is killed -- a
wrapper script that backgrounds a helper and then hangs waiting on it, or a debugger that
launches its inferior -- the fork survives the timeout as an orphan. `sandbox.py` already
avoids this for the generator sandbox (`start_new_session=True` + `os.killpg()`), and this
module generalises that pattern for reuse by `runner.run_target()` and (later) the tracers.

Why not just `os.killpg()`: `killpg` reaches every process still in the leader's original
process group, but a process can call `setpgid()` to move itself into a *different* group
while staying in the same *session* -- which is exactly what lldb does when it launches its
inferior via `lldb-server`. Walking `/proc` for session id instead of process group id catches
those too, since nothing short of `setsid()` (which would detach it entirely, and which none of
these targets do) can leave the session.
"""

from __future__ import annotations

import os
import resource
import signal
import subprocess
from dataclasses import dataclass

#: How many SIGKILL sweeps to make once a timeout fires. One sweep can miss a process that is
#: mid-fork at that instant; a few repeats close that race without looping forever (there is
#: nothing left to wait for once a sweep finds no more session members).
_KILL_SWEEPS = 5

#: Upper bound on the drain `communicate()` after the kill sweeps, so a grandchild that somehow
#: kept a copy of the pipe's write end open (and so escaped the session, e.g. via `setsid`)
#: cannot hang the caller forever.
_DRAIN_TIMEOUT_SEC = 5.0


def _disable_core_dumps() -> None:
    """`preexec_fn` for the spawned child: set `RLIMIT_CORE` to 0 before `exec`.

    Runs after `fork()` but before the target's own `exec()`, in the child -- the same point
    `_generator_child.py`'s `_apply_limits` sets it for the generator sandbox. Without this, a
    crashing target (e.g. an `abort()` canary) pays the OS's core-dump-writing cost on every
    single crashing iteration, which dwarfs the run itself for a small input. Failure to apply
    the limit (an unusual sandboxed environment where even `setrlimit` is refused) must not
    crash the call -- fuzzing a target that cannot be prevented from dumping core is still
    better than not fuzzing it at all, so this swallows the error exactly like
    `_apply_limits` does.

    CAVEAT -- this does NOT help on every system, and this box is one where it does not:
    `core(5)` documents that "RLIMIT_CORE will be ignored if the system is configured to pipe
    core dumps to a program" (verbatim, `man 5 core`). This box's
    `/proc/sys/kernel/core_pattern` is exactly such a pipe --
    `|/usr/share/apport/apport -p%p -s%s ...` -- so apport still intercepts every crash and
    still writes a full `/var/crash/*.crash` regardless of this limit. Measured: `os.abort()`
    under a plain `ulimit -c 0` here still costs ~2.5s, statistically the same as under no
    limit at all; systemd-coredump-based distros have the same pipe-handler exception. On a
    system where `core_pattern` is instead a plain file path (still the default on some
    distros/containers), this call is the whole fix and is unaffected by any of the above.

    A real fix would need to act before `core_pattern` is even consulted -- the kernel checks
    the process's "dumpable" flag (`prctl(2)`'s `PR_SET_DUMPABLE`) ahead of that, and a
    non-dumpable process produces no core dump and never invokes a pipe handler. This was
    tried here and does NOT work for this function's actual use: `PR_SET_DUMPABLE` is stored on
    the process's `mm_struct`, and `execve()` allocates a *fresh* `mm_struct` for the new
    program image, resetting the flag back to 1 for an ordinary (non-privileged) exec --
    verified empirically: a `preexec_fn` that calls `prctl(PR_SET_DUMPABLE, 0)` right before
    `subprocess.Popen`'s implicit `exec()`, with the *exec'd* child immediately reading its own
    state back via `prctl(PR_GET_DUMPABLE)`, still observes `1` every time. Since this function
    exists specifically to wrap a `fork()` + `exec(argv)` (the whole point of `preexec_fn` is
    to run code in that gap), there is no point in this call graph where `PR_SET_DUMPABLE`
    could be set and survive to matter. (It WOULD work for a sandbox that never execs a new
    program -- e.g. `_generator_child.py`'s own crash path, which imports and runs
    model-written code in the same process -- but that is a different module, outside this
    file, and not something this function can fix.) No further attempt is made here; disabling
    apport itself is a system-level config change (`/etc/default/apport`,
    `/proc/sys/kernel/core_pattern`) outside this repo's scope.
    """
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (ValueError, OSError):
        pass


@dataclass
class GroupKillResult:
    """The outcome of `run_with_group_kill`."""

    stdout: bytes
    stderr: bytes
    returncode: int
    timed_out: bool


def _session_id(pid: int) -> int | None:
    """The session id of `pid` (field 6 of `/proc/<pid>/stat`), or None if unreadable.

    The `comm` field (field 2) is parenthesised and may itself contain spaces or parentheses,
    so the fields are located from the *last* `)` rather than by splitting naively.
    """
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            raw = f.read()
    except OSError:
        return None
    end = raw.rfind(b")")
    if end == -1:
        return None
    # After "pid (comm)", the remaining fields are: state, ppid, pgrp, session, ...
    fields = raw[end + 1:].split()
    if len(fields) < 4:
        return None
    try:
        return int(fields[3])
    except ValueError:
        return None


def _pids_in_session(sid: int) -> list[int]:
    try:
        names = os.listdir("/proc")
    except OSError:
        return []
    return [pid for pid in (int(n) for n in names if n.isdigit()) if _session_id(pid) == sid]


def kill_session(leader_pid: int, *, sweeps: int = _KILL_SWEEPS) -> None:
    """SIGKILL every process in the session led by `leader_pid`.

    Repeats the `/proc` scan-and-kill up to `sweeps` times, stopping early once a scan finds
    nothing left. `leader_pid` is expected to itself be a session leader (started with
    `start_new_session=True`), so its session id equals its own pid.
    """
    for _ in range(sweeps):
        pids = _pids_in_session(leader_pid)
        if not pids:
            return
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def run_with_group_kill(
    argv: list[str],
    *,
    input: bytes | None = None,
    stdout: int = subprocess.PIPE,
    stderr: int = subprocess.PIPE,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    timeout_sec: float,
) -> GroupKillResult:
    """Run `argv` like `subprocess.run(argv, timeout=timeout_sec)`, but kill the whole session.

    The child is launched with `start_new_session=True`, making it both a new process group
    leader and a new session leader. On timeout, every process in that session is SIGKILLed
    (see `kill_session`) before the result is assembled, so nothing the target forked is left
    running. It also runs with `RLIMIT_CORE=0` (`_disable_core_dumps`, a `preexec_fn` that
    combines fine with `start_new_session=True` -- both run in the child between `fork()` and
    `exec()`), which avoids an extra OS core-dump write on a crashing target ON SYSTEMS WHERE
    `core_pattern` NAMES A PLAIN FILE -- see that function's docstring for a documented
    exception (pipe `core_pattern` handlers, e.g. apport) where this limit is silently
    ignored and does not help.

    Returns:
        A `GroupKillResult`. `returncode` is the direct child's exit status (or a negative
        signal number if it died to a signal); on a timeout it reflects the SIGKILL.
    """
    proc = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE if input is not None else None,
        stdout=stdout,
        stderr=stderr,
        cwd=cwd,
        env=env,
        start_new_session=True,
        preexec_fn=_disable_core_dumps,
    )
    timed_out = False
    try:
        out, err = proc.communicate(input, timeout=timeout_sec)
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        kill_session(proc.pid)
        try:
            out, err = proc.communicate(timeout=_DRAIN_TIMEOUT_SEC)
        except subprocess.TimeoutExpired:
            # Something still has a pipe end open despite the whole session being dead. Fall
            # back to whatever partial output the first communicate() already captured rather
            # than hang the caller.
            out, err = exc.stdout, exc.stderr

    return GroupKillResult(
        stdout=out or b"",
        stderr=err or b"",
        returncode=proc.returncode if proc.returncode is not None else -signal.SIGKILL,
        timed_out=timed_out,
    )
