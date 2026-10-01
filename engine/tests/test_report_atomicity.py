"""Regression tests for F8: atomic report-flush across gdb, lldb and pymon.

``gdb_batch.py``, ``lldb_batch.py`` and ``_pymon_runner.py`` each flush their
trace report to disk after *every* breakpoint hit, specifically so a
``SIGKILL`` mid-run still leaves the evidence collected up to that point. The
pre-fix flush was a non-atomic ``open(path, "w")`` (truncate + write): a
``SIGKILL`` landing between the truncate and the completed write leaves a
corrupted/truncated file on disk, which the caller then silently swallowed
(``JSONDecodeError`` -> ``{}``), discarding real partial evidence the design
exists to preserve.

These tests bypass each tracer's own ``run()`` (which deletes its temp
directory and, pre-fix, silently swallowed decode errors) and drive the
report-writing subprocess directly, so the raw bytes on disk at the moment of
the kill can be inspected. The invariant under test: after repeated SIGKILLs
against a hot breakpoint, the report file is always either

* fully present, on-disk, and valid JSON with a ``"breakpoints"`` key, or
* cleanly absent (no flush had completed yet)

and never an *existing* file that is empty or truncated/corrupted garbage.

Fixture: reuses the real hot-breakpoint repro from
``acceptance-run/work/L1-tracers/csrc/bigoutput.c`` (built at ``-g -O0``), the
exact toy binary ``evidence/L1/tracers-deviation.md`` used to reproduce the
race 3 of 4 trials against ``bigoutput.c:3`` (``step()``'s hot
``return i * 2;`` line, called 200,000 times). Falls back to rebuilding the
same source if that scratch fixture is unavailable in this environment.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path

import pytest

from pbfuzz_engine.tracers import gdb_batch, lldb_batch
from pbfuzz_engine.tracers import pymon as pymon_mod
from pbfuzz_engine.tracers.base import Breakpoint, build_command, which

_ACCEPTANCE_BIGOUTPUT_C = Path(
    "/mnt/work/pbfuzz/acceptance-run/work/L1-tracers/csrc/bigoutput.c"
)
_ACCEPTANCE_BIGOUTPUT_BIN = Path(
    "/mnt/work/pbfuzz/acceptance-run/work/L1-tracers/csrc/bigoutput"
)

HOT_BREAKPOINT = "bigoutput.c:3"  # step()'s `return i * 2;` -- called 200,000 times
N_KILL_TRIALS = 20  # the acceptance criterion in fix_plan.md: 20/20 trials


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _kill_delays(n: int, lo: float = 0.005, hi: float = 0.12) -> list[float]:
    """``n`` delays spread across a window that spans many report flushes."""
    span = hi - lo
    return [lo + span * i / max(1, n - 1) for i in range(n)]


def _kill_mid_run(argv, cwd, env, kill_after: float) -> None:
    proc = subprocess.Popen(
        argv, cwd=cwd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    time.sleep(kill_after)
    proc.kill()  # SIGKILL
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:  # pragma: no cover - defensive
        proc.kill()
        proc.wait(timeout=15)


def _check_report(out_path: Path, trial: int, kill_after: float, corrupted: list) -> None:
    """Record a failure in ``corrupted`` unless the file is complete-JSON-or-absent."""
    if not out_path.exists():
        return  # cleanly absent: fine, no flush had completed yet
    raw = out_path.read_bytes()
    try:
        if not raw:
            raise json.JSONDecodeError("file exists but is empty", "", 0)
        report = json.loads(raw)
        if not (isinstance(report, dict) and "breakpoints" in report):
            raise json.JSONDecodeError(
                "valid JSON but not a well-formed report", raw.decode("utf-8", "replace"), 0
            )
    except json.JSONDecodeError as exc:
        corrupted.append((trial, round(kill_after, 4), str(exc), raw[:200]))


@pytest.fixture(scope="module")
def hot_binary(tmp_path_factory):
    """The hot-loop toy binary the F8 evidence report reproduced the race against."""
    if _ACCEPTANCE_BIGOUTPUT_BIN.exists() and os.access(_ACCEPTANCE_BIGOUTPUT_BIN, os.X_OK):
        try:
            subprocess.run(
                [str(_ACCEPTANCE_BIGOUTPUT_BIN)], timeout=10, capture_output=True, check=True
            )
            return _ACCEPTANCE_BIGOUTPUT_BIN
        except Exception:
            pass  # fixture unusable in this environment; rebuild below

    cc = shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
    if not cc:
        pytest.skip("no C compiler available and the acceptance-run fixture is unusable")
    src_text = (
        _ACCEPTANCE_BIGOUTPUT_C.read_text()
        if _ACCEPTANCE_BIGOUTPUT_C.exists()
        else textwrap.dedent(
            """\
            #include <stdio.h>
            int step(int i) {
                return i * 2;            /* line 3: breakpoint hit many times */
            }
            int main(void) {
                long total = 0;
                for (int i = 0; i < 200000; i++) {
                    total += step(i);
                    if (i % 500 == 0) {
                        fprintf(stdout, "progress %d total=%ld\\n", i, total);
                        fprintf(stderr, "stderr-progress %d\\n", i);
                    }
                }
                printf("done total=%ld\\n", total);
                return 0;
            }
            """
        )
    )
    d = tmp_path_factory.mktemp("f8-bigoutput")
    src = d / "bigoutput.c"
    src.write_text(src_text)
    binary = d / "bigoutput"
    subprocess.run([cc, "-g", "-O0", "-o", str(binary), str(src)], check=True)
    return binary


# ---------------------------------------------------------------------------
# gdb_batch.py -- the primary, flagship repro (evidence: 3-of-4 trials).
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not which("gdb"), reason="gdb not installed")
def test_gdb_report_never_corrupted_across_kill_trials(hot_binary):
    gdb_bin = which("gdb")
    bps = [Breakpoint(location=HOT_BREAKPOINT, hit_limit=200_000)]
    corrupted: list = []

    # Calibrated against this exact fixture: shorter delays mostly land before
    # gdb's first flush; delays much past ~1.5s make each trial slow without
    # improving the hit rate. 0.3-1.2s reliably lands mid-write pre-fix.
    for trial, kill_after in enumerate(_kill_delays(N_KILL_TRIALS, lo=0.3, hi=1.2)):
        with tempfile.TemporaryDirectory(prefix="pbfuzz-f8-gdb-") as tmp:
            tmpdir = Path(tmp)
            campaign = {
                "target": {"language": "c"},
                "entry": {
                    "run_cmd": str(hot_binary),
                    "input_channel": "stdin",
                    "cwd": str(hot_binary.parent),
                },
            }
            cmd = build_command(campaign, "/dev/null")
            spec_path = tmpdir / "spec.json"
            out_path = tmpdir / "report.json"
            stderr_path = tmpdir / "target-stderr.txt"
            stderr_path.touch()
            spec = {
                "program": cmd.program,
                "breakpoints": [b.to_spec() for b in bps],
                "run_command": gdb_batch.build_run_command(cmd, str(stderr_path)),
                "backtrace_limit": 16,
            }
            spec_path.write_text(json.dumps(spec), encoding="utf-8")
            script_path = tmpdir / "pbfuzz_gdb_batch.py"
            script_path.write_text(
                gdb_batch.build_gdb_script(str(spec_path), str(out_path)), encoding="utf-8"
            )
            argv = [gdb_bin, "-q", "-nx", "-batch", "-x", str(script_path), cmd.program]
            _kill_mid_run(argv, cmd.cwd, cmd.env, kill_after)
            _check_report(out_path, trial, kill_after, corrupted)

    assert not corrupted, (
        f"{len(corrupted)}/{N_KILL_TRIALS} gdb kill-mid-flush trials produced a "
        f"corrupted/truncated report file (must be cleanly-absent-or-complete): {corrupted}"
    )


# ---------------------------------------------------------------------------
# lldb_batch.py -- same race, lldb's own hook script.
# ---------------------------------------------------------------------------


def _lldb_can_launch(lldb_bin: str | None) -> bool:
    """lldb may be installed yet unable to launch (e.g. ptrace restrictions)."""
    true = shutil.which("true")
    if not lldb_bin or not true:
        return False
    try:
        proc = subprocess.run(
            [lldb_bin, "--batch", "--no-lldbinit", "-o", "run", "--", true],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return proc.returncode == 0


@pytest.mark.skipif(
    not _lldb_can_launch(which("lldb")), reason="lldb not usable in this environment"
)
def test_lldb_report_never_corrupted_across_kill_trials(hot_binary):
    lldb_bin = which("lldb")
    bps = [Breakpoint(location=HOT_BREAKPOINT, hit_limit=200_000)]
    corrupted: list = []
    n = 10  # lighter than the gdb trial count: lldb's own Python startup is slower

    for trial, kill_after in enumerate(_kill_delays(n, lo=0.5, hi=1.9)):
        with tempfile.TemporaryDirectory(prefix="pbfuzz-f8-lldb-") as tmp:
            tmpdir = Path(tmp)
            campaign = {
                "target": {"language": "c"},
                "entry": {
                    "run_cmd": str(hot_binary),
                    "input_channel": "stdin",
                    "cwd": str(hot_binary.parent),
                },
            }
            cmd = build_command(campaign, "/dev/null")
            spec_path = tmpdir / "spec.json"
            out_path = tmpdir / "report.json"
            stderr_path = tmpdir / "target-stderr.txt"
            stderr_path.touch()
            pre_run = [
                "settings set target.error-path " + str(stderr_path),
                "settings set target.output-path " + str(tmpdir / "target-stdout.txt"),
            ]
            spec_path.write_text(
                json.dumps(
                    {"breakpoints": [b.to_spec() for b in bps], "pre_run_commands": pre_run}
                ),
                encoding="utf-8",
            )
            hook_path = tmpdir / "pbfuzz_lldb_hook.py"
            hook_path.write_text(
                lldb_batch.build_lldb_hook(str(spec_path), str(out_path)), encoding="utf-8"
            )
            argv = lldb_batch.build_lldb_argv(lldb_bin, str(hook_path), cmd.program, [])
            env = lldb_batch.lldb_env(lldb_bin, cmd.env)
            _kill_mid_run(argv, cmd.cwd, env, kill_after)
            _check_report(out_path, trial, kill_after, corrupted)

    assert not corrupted, (
        f"{len(corrupted)}/{n} lldb kill-mid-flush trials produced a corrupted "
        f"report file (must be cleanly-absent-or-complete): {corrupted}"
    )


# ---------------------------------------------------------------------------
# _pymon_runner.py -- runs inside the traced (possibly forking) target process.
# ---------------------------------------------------------------------------

HOT_PYTHON_LOOP = textwrap.dedent(
    """\
    def step(i):
        return i * 2          # line 2: hot breakpoint
    def main():
        total = 0
        for i in range(2_000_000):
            total += step(i)
        print("done", total)
    if __name__ == "__main__":
        main()
    """
)


def test_pymon_report_never_corrupted_across_kill_trials(tmp_path_factory):
    python_bin = sys.executable
    runner = Path(pymon_mod.__file__).with_name("_pymon_runner.py")
    src_dir = tmp_path_factory.mktemp("f8-pymon-src")
    script_path = src_dir / "hotloop.py"
    script_path.write_text(HOT_PYTHON_LOOP)
    bps = [Breakpoint(location=f"{script_path}:2", hit_limit=2_000_000)]
    corrupted: list = []
    n = 15

    for trial, kill_after in enumerate(_kill_delays(n, lo=0.005, hi=0.08)):
        with tempfile.TemporaryDirectory(prefix="pbfuzz-f8-pymon-") as tmp:
            tmpdir = Path(tmp)
            campaign = {
                "target": {"language": "python"},
                "entry": {
                    "run_cmd": f"{python_bin} {script_path}",
                    "input_channel": "stdin",
                    "cwd": str(src_dir),
                },
            }
            cmd = build_command(campaign, "/dev/null")
            spec_path = tmpdir / "spec.json"
            out_path = tmpdir / "report.json"
            spec_path.write_text(
                json.dumps({"breakpoints": [b.to_spec() for b in bps]}), encoding="utf-8"
            )
            argv = pymon_mod.build_pymon_argv(
                python_bin, str(runner), str(spec_path), str(out_path), cmd.argv
            )
            _kill_mid_run(argv, cmd.cwd, cmd.env, kill_after)
            _check_report(out_path, trial, kill_after, corrupted)

    assert not corrupted, (
        f"{len(corrupted)}/{n} pymon kill-mid-flush trials produced a corrupted "
        f"report file (must be cleanly-absent-or-complete): {corrupted}"
    )
