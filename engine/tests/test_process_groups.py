"""F6+F7 regression: a timed-out lldb or pymon trace must not leak the traced process (or
anything it forked) as an orphan.

`Tracer._run_process` (`tracers/base.py`) used to call plain `subprocess.run(argv,
timeout=timeout_sec)` with no `start_new_session`. On timeout that only signals the direct
child:

* **lldb** launches its inferior via `lldb-server`, which can `setpgid` the inferior into its
  *own* process group while staying in the same session as lldb -- so the hung target survived
  indefinitely after `lldb_batch.py`'s trace "completed" (timed out). A bare `os.killpg` on
  lldb's own group would still miss it for the same reason; the fix has to walk `/proc` by
  *session* id (see `pbfuzz_engine.proc.kill_session`), not process group.
* **pymon** runs the target in-process (via `runpy`) inside a child Python interpreter
  (`_pymon_runner.py`). If the target itself shells out to a subprocess, that subprocess is a
  *grandchild* of the direct child `_run_process` starts -- so a plain `subprocess.run` timeout
  kills only the runner, leaving the grandchild running.

Both toys below write the survivor's pid to a marker file before hanging, so the test can check
liveness directly with `os.kill(pid, 0)` instead of scanning `/proc` for names.
"""

from __future__ import annotations

import json
import os
import resource
import shutil
import signal
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

from pbfuzz_engine.proc import run_with_group_kill
from pbfuzz_engine.tracers.lldb_batch import LldbBatchTracer
from pbfuzz_engine.tracers.pymon import PymonTracer

SHORT_TIMEOUT_SEC = 3.0
_POLL_ROUNDS = 40
_POLL_INTERVAL_SEC = 0.1


def _wait_for_file(path: Path, *, timeout_sec: float = 10.0) -> None:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        if path.exists() and path.stat().st_size > 0:
            return
        time.sleep(0.05)
    raise AssertionError(f"{path} was never written (target never started?)")


def _assert_pid_eventually_dies(pid: int, *, what: str) -> None:
    """Poll for up to `_POLL_ROUNDS * _POLL_INTERVAL_SEC` seconds, then fail if `pid` is alive."""
    survived = True
    for _ in range(_POLL_ROUNDS):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            survived = False
            break
        except PermissionError:
            # Exists but owned by someone else -- can't happen for a child of this test, but
            # treat as "still alive" rather than silently passing.
            pass
        time.sleep(_POLL_INTERVAL_SEC)
    if survived:
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass
        pytest.fail(f"{what} (pid {pid}) survived the timed-out trace (process-group/session leak)")


# -- lldb: the traced inferior itself, launched via lldb-server ------------------------------

LOOP_C = textwrap.dedent(
    """\
    #include <stdio.h>
    #include <unistd.h>

    int main(void) {{
        FILE *f = fopen("{pid_file}", "w");
        if (f) {{
            fprintf(f, "%d", (int)getpid());
            fflush(f);
            fclose(f);
        }}
        volatile int i = 0;
        while (1) {{ i++; }}
        return 0;
    }}
    """
)


@pytest.fixture
def loop_binary(tmp_path: Path) -> tuple[Path, Path]:
    cc = shutil.which("cc") or shutil.which("clang") or shutil.which("gcc")
    if not cc:
        pytest.skip("no C compiler")
    pid_file = tmp_path / "loop.pid"
    src = tmp_path / "loop.c"
    src.write_text(LOOP_C.format(pid_file=pid_file))
    binary = tmp_path / "loop"
    subprocess.run([cc, "-g", "-O0", "-o", str(binary), str(src)], check=True)
    return binary, pid_file


@pytest.mark.skipif(not LldbBatchTracer().available()[0], reason="lldb not installed")
def test_lldb_timeout_does_not_leak_the_traced_inferior(tmp_path, loop_binary):
    binary, pid_file = loop_binary
    campaign = {
        "target": {"repo": str(tmp_path), "language": "c"},
        "entry": {"kind": "executable", "run_cmd": f"{binary} @@", "input_channel": "file"},
        "oracle": {"mode": "canary", "reached_pattern": "REACHED", "triggered_pattern": "TRIGGERED"},
    }
    input_path = tmp_path / "in"
    input_path.write_bytes(b"")

    result = LldbBatchTracer().run(campaign, str(input_path), [], timeout_sec=SHORT_TIMEOUT_SEC)
    assert result.timed_out is True

    _wait_for_file(pid_file)
    pid = int(pid_file.read_text().strip())
    _assert_pid_eventually_dies(pid, what="the lldb-traced `loop` inferior")


# -- pymon: a grandchild the *target itself* spawns -------------------------------------------

GRANDCHILD_HARNESS = textwrap.dedent(
    """\
    import subprocess
    import sys
    import time

    # Spawn a grandchild that would be orphaned if only the direct child (this runner) were
    # killed on timeout, without any session-wide cleanup.
    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    with open({pid_file!r}, "w") as f:
        f.write(str(p.pid))
    while True:
        time.sleep(0.1)
    """
)


@pytest.fixture
def grandchild_harness(tmp_path: Path) -> tuple[Path, Path]:
    pid_file = tmp_path / "grandchild.pid"
    harness = tmp_path / "harness.py"
    harness.write_text(GRANDCHILD_HARNESS.format(pid_file=str(pid_file)))
    return harness, pid_file


def test_pymon_timeout_does_not_leak_a_grandchild_the_target_spawned(tmp_path, grandchild_harness):
    harness, pid_file = grandchild_harness
    campaign = {
        "target": {"repo": str(tmp_path), "language": "python"},
        "entry": {"kind": "api", "run_cmd": f"{sys.executable} {harness} @@", "input_channel": "file"},
        "oracle": {"mode": "canary", "reached_pattern": "REACHED", "triggered_pattern": "TRIGGERED"},
    }
    input_path = tmp_path / "in"
    input_path.write_bytes(b"")

    result = PymonTracer().run(campaign, str(input_path), [], timeout_sec=SHORT_TIMEOUT_SEC)
    assert result.timed_out is True

    _wait_for_file(pid_file)
    pid = int(pid_file.read_text().strip())
    _assert_pid_eventually_dies(pid, what="the grandchild the pymon-traced target spawned")


# -- F2/task-1: `run_with_group_kill` must force RLIMIT_CORE=0 on the target -------------------


def test_target_core_dumps_are_disabled_even_when_the_environment_allows_them(tmp_path):
    """A crashing target must not pay the OS's core-dump-writing cost on every iteration.

    `run_with_group_kill` (`proc.py`) is the one function every target execution funnels
    through (`runner.run_target`, `corpus.analyze`, `selfcheck.oracle`), so fixing RLIMIT_CORE
    there once covers all three. The check raises this test process's own soft `RLIMIT_CORE`
    *before* spawning, so a pass cannot be an accident of the ambient environment already
    disabling core dumps (as most shells/CI already do by default) -- the spawned child must
    see `(0, 0)` because `proc.py`'s `preexec_fn` actively lowers it after `fork()`, not
    because it inherited a zero limit for free. It also aborts the child and confirms no core
    file lands under its cwd, matching the actual failure mode the fix targets.
    """
    original = resource.getrlimit(resource.RLIMIT_CORE)
    hard = original[1]
    raise_to = 8 * 1024 * 1024
    if hard != resource.RLIM_INFINITY:
        raise_to = min(raise_to, hard)
    if raise_to == 0:
        pytest.skip("RLIMIT_CORE hard limit is 0 in this environment; cannot exercise the override")
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (raise_to, hard))
        script = (
            "import json, os, resource, signal\n"
            "print(json.dumps(list(resource.getrlimit(resource.RLIMIT_CORE))), flush=True)\n"
            "os.kill(os.getpid(), signal.SIGABRT)\n"
        )
        result = run_with_group_kill(
            [sys.executable, "-c", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=str(tmp_path), timeout_sec=25.0,
        )
    finally:
        resource.setrlimit(resource.RLIMIT_CORE, original)

    seen_limit = json.loads(result.stdout.decode().strip())
    assert seen_limit == [0, 0], "the spawned child did not have RLIMIT_CORE forced to (0, 0)"
    assert result.returncode == -signal.SIGABRT
    assert not list(tmp_path.glob("core*")), "a core file was left behind under the target's cwd"
