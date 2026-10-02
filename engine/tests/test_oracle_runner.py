"""The stderr oracle and the @@/stdin target adapter."""

from __future__ import annotations

import os
import sys
import time

import pytest
from conftest import assert_error_shape

from pbfuzz_engine.campaign import Entry
from pbfuzz_engine.errors import TARGET_FAILED, EngineError
from pbfuzz_engine.oracle import StderrOracle
from pbfuzz_engine.runner import TIMEOUT_EXIT_CODE, prepare_cmd_and_stdin, run_target

ORACLE = StderrOracle(r"PBFUZZ_REACHED:\s*(\S+)", r"PBFUZZ_TRIGGERED:\s*(\S+)")


@pytest.mark.parametrize("stderr, reached, triggered", [
    ("", False, False),
    ("noise\n", False, False),
    ("PBFUZZ_REACHED: bug1\n", True, False),
    ("PBFUZZ_REACHED: bug1\nPBFUZZ_TRIGGERED: bug1\n", True, True),
    ("PBFUZZ_TRIGGERED: x", False, True),
])
def test_oracle_verdicts(stderr, reached, triggered):
    v = ORACLE.judge(stderr)
    assert (v.reached, v.triggered) == (reached, triggered)
    assert v.reached_count == int(reached) and v.triggered_count == int(triggered)


def test_timed_out_runs_never_count():
    v = ORACLE.judge("PBFUZZ_REACHED: a\nPBFUZZ_TRIGGERED: a", timed_out=True)
    assert not v.reached and not v.triggered


def test_oracle_reports_match_text_and_handles_magma_and_unicode():
    v = StderrOracle(r"MAGMA_LOG: \w+ reached", r"MAGMA_LOG: \w+ triggered").judge("ü MAGMA_LOG: PNG003 reached\n")
    assert v.reached and v.reached_match == "MAGMA_LOG: PNG003 reached"


def test_prepare_cmd_and_stdin():
    assert prepare_cmd_and_stdin("prog -a @@ -b", "/in", b"x") == (["prog", "-a", "/in", "-b"], None)
    assert prepare_cmd_and_stdin("prog -a", "/in", b"x", input_channel="stdin") == (["prog", "-a"], b"x")
    assert prepare_cmd_and_stdin("'my prog' @@", "/p q", b"") == (["my prog", "/p q"], None)


def _entry(target_script, channel="file", **kw):
    cmd = f"{sys.executable} {target_script}" + (" @@" if channel == "file" else "")
    return Entry(kind="executable", run_cmd=cmd, input_channel=channel, **kw)


@pytest.mark.parametrize("channel", ["file", "stdin"])
def test_run_target_both_channels(target_script, tmp_path, channel):
    inp = tmp_path / "in"
    inp.write_bytes(b"RT")
    res = run_target(_entry(target_script, channel), inp, b"RT", timeout_sec=10)
    v = ORACLE.judge(res.stderr)
    assert v.reached and v.triggered and res.exit_code == 0 and not res.timed_out


def test_run_target_reports_signal(target_script, tmp_path):
    inp = tmp_path / "in"
    inp.write_bytes(b"RA")
    res = run_target(_entry(target_script), inp, b"RA", timeout_sec=10)
    assert res.signal_name == "SIGABRT" and ORACLE.judge(res.stderr).reached


def test_run_target_env_and_cwd(tmp_path):
    script = tmp_path / "envtarget.py"
    script.write_text("import os, sys\nsys.stderr.write(os.environ['PBX'] + ' ' + os.getcwd())\n")
    work = tmp_path / "work"
    work.mkdir()
    entry = Entry(kind="executable", run_cmd=f"{sys.executable} {script} @@", input_channel="file", env={"PBX": "hello"}, cwd=str(work))
    inp = tmp_path / "in"
    inp.write_bytes(b"")
    res = run_target(entry, inp, b"", timeout_sec=10)
    assert res.stderr.startswith("hello ") and res.stderr.endswith("work")


def test_missing_binary_is_an_actionable_error(tmp_path):
    entry = Entry(kind="executable", run_cmd="/definitely/not/here @@", input_channel="file")
    inp = tmp_path / "in"
    inp.write_bytes(b"")
    with pytest.raises(EngineError) as info:
        run_target(entry, inp, b"", timeout_sec=1)
    assert info.value.code == TARGET_FAILED
    assert_error_shape(info.value)


def test_non_executable_target(tmp_path):
    prog = tmp_path / "prog"
    prog.write_text("#!/bin/sh\n")
    inp = tmp_path / "in"
    inp.write_bytes(b"")
    with pytest.raises(EngineError) as info:
        run_target(Entry(kind="executable", run_cmd=f"{prog} @@", input_channel="file"), inp, b"", timeout_sec=1)
    assert "not executable" in info.value.message


def test_run_target_timeout_kills_process_group(tmp_path):
    """F9 regression: a `run_target` timeout must kill the target's whole process group, not
    just the direct child.

    Promoted from `acceptance-run/work/codequality-kanalyzer-engine/test_leak2.py`
    (`hang.c` / `wrapper.sh` / `hang`), rewritten here as a self-contained fixture (a Python
    "hang" script instead of a compiled binary) so the permanent test doesn't depend on files
    living outside this test module.

    `wrapper.sh` mirrors a harness that forks a background helper and then blocks waiting on
    it -- exactly the shape that leaked before this fix: a plain `subprocess.run(timeout=...)`
    (no `start_new_session`) only kills `wrapper.sh` itself on timeout, leaving the backgrounded
    grandchild running as an orphan. `pgrep -af '[h]ang.py'` against the manual repro shows the
    same survivor; here it is checked with `os.kill(pid, 0)` instead so the test needs no
    external tools.
    """
    hang_pid_file = tmp_path / "hang.pid"
    hang_script = tmp_path / "hang.py"
    hang_script.write_text("import time\nwhile True:\n    time.sleep(1)\n")
    wrapper = tmp_path / "wrapper.sh"
    wrapper.write_text(
        "#!/bin/bash\n"
        f"{sys.executable} {hang_script} &\n"
        f"echo $! > {hang_pid_file}\n"
        "wait\n"
    )
    wrapper.chmod(0o755)

    entry = Entry(kind="executable", run_cmd=str(wrapper), input_channel="file")
    inp = tmp_path / "in"
    inp.write_bytes(b"")

    res = run_target(entry, inp, b"", timeout_sec=1)
    assert res.timed_out and res.exit_code == TIMEOUT_EXIT_CODE

    hang_pid = int(hang_pid_file.read_text().strip())
    try:
        survived = True
        for _ in range(30):
            try:
                os.kill(hang_pid, 0)
            except ProcessLookupError:
                survived = False
                break
            time.sleep(0.1)
        assert not survived, f"grandchild pid {hang_pid} survived run_target's timeout (process-group leak)"
    finally:
        try:
            os.kill(hang_pid, 9)
        except ProcessLookupError:
            pass
