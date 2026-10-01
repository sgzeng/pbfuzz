"""Regression test for N2: batch tracer report flushes instead of flushing
on every single hit.

``fix_plan.md``'s N2 finding: gdb/lldb/pymon's ``_flush()``/``flush()`` wrote
a fresh report to disk (via the F8 atomic temp-file + ``os.replace``
sequence) after *every* breakpoint hit, capping a hot breakpoint's
throughput at roughly one ``os.replace()`` syscall per hit (~120 hits/sec on
the original evidence host; re-measured at ~120.6 hits/sec at HEAD before
this fix, see ``evidence/fixverify/G4.md``). The fix batches hits into a
periodic flush (:data:`pbfuzz_engine.tracers.gdb_batch.FLUSH_INTERVAL_SEC`,
0.25s) and only forces an immediate flush on process exit, a fatal signal,
or teardown, so a run killed by the outer timeout never loses more than one
interval's worth of evidence.

This test proves batching actually happened -- not just that a
``flush_count`` field exists -- by running each backend against a hot
breakpoint for a short, fixed wall-clock window and checking that far more
hits accumulate than flushes occur. This is deliberately host-speed
independent: whatever the hit rate on a given machine, an *unbatched*
implementation flushes once per hit (``flush_count == hit_times``, always),
while a *batched* one is bounded above by ``window / FLUSH_INTERVAL_SEC``
regardless of hit rate. It also re-confirms F8's atomicity invariant is
untouched by the new cadence: the report file is still always either
cleanly absent or complete, valid JSON with a ``"breakpoints"`` key -- never
present-but-corrupted -- across every sample taken during the run.

Fixture: reuses the same hot-loop repro as ``test_report_atomicity.py``
(``acceptance-run/work/L1-tracers/csrc/bigoutput.c``, `step()`'s hot
``return i * 2;`` line), falling back to rebuilding the same source if that
scratch fixture is unavailable in this environment.
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
from pbfuzz_engine.tracers._pymon_runner import FLUSH_INTERVAL_SEC as PYMON_FLUSH_INTERVAL_SEC
from pbfuzz_engine.tracers.base import Breakpoint, build_command, which
from pbfuzz_engine.tracers.gdb_batch import FLUSH_INTERVAL_SEC

_ACCEPTANCE_BIGOUTPUT_C = Path(
    "/mnt/work/pbfuzz/acceptance-run/work/L1-tracers/csrc/bigoutput.c"
)
_ACCEPTANCE_BIGOUTPUT_BIN = Path(
    "/mnt/work/pbfuzz/acceptance-run/work/L1-tracers/csrc/bigoutput"
)

HOT_BREAKPOINT = "bigoutput.c:3"  # step()'s `return i * 2;` -- hit every iteration
WINDOW_SEC = 4.0  # fixed wall-clock window the hot breakpoint runs under
# An unbatched flush-per-hit implementation would leave flush_count == hit_times, which
# for any real hot breakpoint vastly exceeds this. A batched one is bounded above by
# window/interval plus slack for the forced init/exit/signal flushes -- generous slack
# because scheduling jitter under a loaded or emulated host can shift flush boundaries.
MAX_EXPECTED_FLUSHES = int(WINDOW_SEC / FLUSH_INTERVAL_SEC) + 8
MIN_HITS_FOR_MEANINGFUL_TEST = 20  # else the window was too short to prove anything


def test_flush_interval_constant_is_shared_by_construction():
    """The three backends duplicate the interval (they don't cross-import -- see each
    module's docstring), but it must be the same value everywhere or the batching
    behaviour would silently differ by tracer."""
    assert FLUSH_INTERVAL_SEC == PYMON_FLUSH_INTERVAL_SEC
    assert FLUSH_INTERVAL_SEC > 0


def _check_report(out_path: Path, corrupted: list, samples: list) -> None:
    """Record a failure in ``corrupted`` unless the file is complete-JSON-or-absent
    (F8's invariant); append ``(hit_times, flush_count)`` to ``samples`` when readable."""
    if not out_path.exists():
        return
    raw = out_path.read_bytes()
    if not raw:
        return  # a flush was mid-`open()`+truncate at the instant we sampled; rare, not corruption evidence by itself
    try:
        report = json.loads(raw)
        if not (isinstance(report, dict) and "breakpoints" in report):
            raise json.JSONDecodeError("valid JSON but not a well-formed report", raw.decode("utf-8", "replace"), 0)
    except json.JSONDecodeError as exc:
        corrupted.append((str(exc), raw[:200]))
        return
    hits = report.get("breakpoints", [{}])[0].get("hit_times", 0)
    flush_count = report.get("flush_count")
    if isinstance(flush_count, int):
        samples.append((hits, flush_count))


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
                for (int i = 0; i < 20000000; i++) {
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
    d = tmp_path_factory.mktemp("n2-bigoutput")
    src = d / "bigoutput.c"
    src.write_text(src_text)
    binary = d / "bigoutput"
    subprocess.run([cc, "-g", "-O0", "-o", str(binary), str(src)], check=True)
    return binary


# ---------------------------------------------------------------------------
# gdb_batch.py -- the primary backend.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not which("gdb"), reason="gdb not installed")
def test_gdb_batches_flushes_under_a_hot_breakpoint(hot_binary):
    gdb_bin = which("gdb")
    bp = Breakpoint(location=HOT_BREAKPOINT, hit_limit=10_000_000)
    corrupted: list = []
    samples: list = []

    with tempfile.TemporaryDirectory(prefix="pbfuzz-n2-gdb-") as tmp:
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
            "breakpoints": [bp.to_spec()],
            "run_command": gdb_batch.build_run_command(cmd, str(stderr_path)),
            "backtrace_limit": 16,
        }
        spec_path.write_text(json.dumps(spec), encoding="utf-8")
        script_path = tmpdir / "pbfuzz_gdb_batch.py"
        script_path.write_text(
            gdb_batch.build_gdb_script(str(spec_path), str(out_path)), encoding="utf-8"
        )
        argv = [gdb_bin, "-q", "-nx", "-batch", "-x", str(script_path), cmd.program]

        proc = subprocess.Popen(
            argv, cwd=cmd.cwd, env=cmd.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        deadline = time.monotonic() + WINDOW_SEC
        while time.monotonic() < deadline:
            _check_report(out_path, corrupted, samples)
            time.sleep(0.02)
        proc.kill()
        proc.wait(timeout=15)
        _check_report(out_path, corrupted, samples)  # final read, after teardown's forced flush

    assert not corrupted, f"report corrupted during batched flushing: {corrupted}"
    assert samples, "never observed a readable report during the window -- test is inconclusive, not passing"
    final_hits, final_flushes = samples[-1]
    if final_hits < MIN_HITS_FOR_MEANINGFUL_TEST:
        pytest.skip(
            f"only {final_hits} hits in {WINDOW_SEC}s on this host -- too slow to prove batching either way"
        )
    assert final_flushes <= MAX_EXPECTED_FLUSHES, (
        f"{final_flushes} flushes for a {WINDOW_SEC}s run (interval={FLUSH_INTERVAL_SEC}s) with "
        f"{final_hits} hits exceeds the {MAX_EXPECTED_FLUSHES} expected under wall-clock-based batching "
        f"-- looks like every hit is still flushing"
    )


# ---------------------------------------------------------------------------
# lldb_batch.py -- same race, lldb's own hook script.
# ---------------------------------------------------------------------------


def _lldb_can_launch(lldb_bin: str | None) -> bool:
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
def test_lldb_batches_flushes_under_a_hot_breakpoint(hot_binary):
    lldb_bin = which("lldb")
    bp = Breakpoint(location=HOT_BREAKPOINT, hit_limit=10_000_000)
    corrupted: list = []
    samples: list = []

    with tempfile.TemporaryDirectory(prefix="pbfuzz-n2-lldb-") as tmp:
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
            json.dumps({"breakpoints": [bp.to_spec()], "pre_run_commands": pre_run}),
            encoding="utf-8",
        )
        hook_path = tmpdir / "pbfuzz_lldb_hook.py"
        hook_path.write_text(
            lldb_batch.build_lldb_hook(str(spec_path), str(out_path)), encoding="utf-8"
        )
        argv = lldb_batch.build_lldb_argv(lldb_bin, str(hook_path), cmd.program, [])
        env = lldb_batch.lldb_env(lldb_bin, cmd.env)

        proc = subprocess.Popen(
            argv, cwd=cmd.cwd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        deadline = time.monotonic() + WINDOW_SEC
        while time.monotonic() < deadline:
            _check_report(out_path, corrupted, samples)
            time.sleep(0.02)
        proc.kill()
        proc.wait(timeout=15)
        _check_report(out_path, corrupted, samples)

    assert not corrupted, f"report corrupted during batched flushing: {corrupted}"
    assert samples, "never observed a readable report during the window -- test is inconclusive, not passing"
    final_hits, final_flushes = samples[-1]
    if final_hits < MIN_HITS_FOR_MEANINGFUL_TEST:
        pytest.skip(
            f"only {final_hits} hits in {WINDOW_SEC}s on this host -- too slow to prove batching either way"
        )
    assert final_flushes <= MAX_EXPECTED_FLUSHES, (
        f"{final_flushes} flushes for a {WINDOW_SEC}s run with {final_hits} hits exceeds the "
        f"{MAX_EXPECTED_FLUSHES} expected under wall-clock-based batching -- looks like every hit is "
        f"still flushing"
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
        i = 0
        while True:
            total += step(i)
            i += 1
        return total
    if __name__ == "__main__":
        main()
    """
)


def test_pymon_batches_flushes_under_a_hot_breakpoint(tmp_path_factory):
    python_bin = sys.executable
    runner = Path(pymon_mod.__file__).with_name("_pymon_runner.py")
    src_dir = tmp_path_factory.mktemp("n2-pymon-src")
    script_path = src_dir / "hotloop.py"
    script_path.write_text(HOT_PYTHON_LOOP)
    bp = Breakpoint(location=f"{script_path}:2", hit_limit=10_000_000)
    corrupted: list = []
    samples: list = []

    with tempfile.TemporaryDirectory(prefix="pbfuzz-n2-pymon-") as tmp:
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
        spec_path.write_text(json.dumps({"breakpoints": [bp.to_spec()]}), encoding="utf-8")
        argv = pymon_mod.build_pymon_argv(python_bin, str(runner), str(spec_path), str(out_path), cmd.argv)

        proc = subprocess.Popen(
            argv, cwd=cmd.cwd, env=cmd.env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        deadline = time.monotonic() + WINDOW_SEC
        while time.monotonic() < deadline:
            _check_report(out_path, corrupted, samples)
            time.sleep(0.02)
        proc.kill()
        proc.wait(timeout=15)
        _check_report(out_path, corrupted, samples)

    assert not corrupted, f"report corrupted during batched flushing: {corrupted}"
    assert samples, "never observed a readable report during the window -- test is inconclusive, not passing"
    final_hits, final_flushes = samples[-1]
    if final_hits < MIN_HITS_FOR_MEANINGFUL_TEST:
        pytest.skip(
            f"only {final_hits} hits in {WINDOW_SEC}s on this host -- too slow to prove batching either way"
        )
    assert final_flushes <= MAX_EXPECTED_FLUSHES, (
        f"{final_flushes} flushes for a {WINDOW_SEC}s run with {final_hits} hits exceeds the "
        f"{MAX_EXPECTED_FLUSHES} expected under wall-clock-based batching -- looks like every hit is "
        f"still flushing"
    )
