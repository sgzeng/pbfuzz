"""W3 pure-logic tests: base types, command building, gdb/lldb/jdb script + parsing.

Everything here runs without a debugger. Parsers are exercised against the
fixtures in ``tests/fixtures/tracers`` (each fixture states its provenance).
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest

from pbfuzz_engine.tracers import Breakpoint, TracerError, build_command
from pbfuzz_engine.tracers.base import BreakpointReport, TraceResult, parse_location
from pbfuzz_engine.tracers.gdb_batch import (
    build_gdb_script,
    build_run_command,
    parse_trace_report,
    program_exists,
)
from pbfuzz_engine.tracers.jdb import JdbTracer, _drive_jdb, parse_jdb_transcript
from pbfuzz_engine.tracers.lldb_batch import build_lldb_argv, build_lldb_hook
from pbfuzz_engine.tracers.pymon import find_python_script

FIXTURES = Path(__file__).parent / "fixtures" / "tracers"


def _campaign(run_cmd: str, channel: str = "file", **entry) -> dict:
    return {
        "target": {"repo": "/repo", "language": "c"},
        "entry": {"kind": "executable", "run_cmd": run_cmd, "input_channel": channel, **entry},
        "bug": {"kind": "trigger_condition", "targets": [{"location": "toy.c:18"}]},
        "oracle": {"mode": "canary", "reached_pattern": "REACHED", "triggered_pattern": "TRIGGERED"},
    }


# -- base ------------------------------------------------------------------

def test_breakpoint_accepts_contract_and_camel_keys():
    bp = Breakpoint.from_obj({"location": "a/b.c:12", "hit_limit": 3, "inline_expr": ["x"], "print_call_stack": True})
    assert (bp.file_path, bp.line_no, bp.hit_limit, bp.inline_expr, bp.print_call_stack) == ("a/b.c", 12, 3, ("x",), True)
    camel = Breakpoint.from_obj({"location": "b.c:1", "hitLimit": 2, "inlineExpr": ["y"], "printCallStack": True})
    assert camel.hit_limit == 2 and camel.inline_expr == ("y",) and camel.print_call_stack
    assert Breakpoint.from_obj({"location": "c.c:5"}).hit_limit == 10  # schema default


@pytest.mark.parametrize("bad", ["nocolon", "file.c:abc", ":12"])
def test_bad_locations_raise_with_remedies(bad):
    with pytest.raises(TracerError) as info:
        Breakpoint.from_obj({"location": bad})
    assert info.value.remedies


def test_windows_like_and_colon_paths_split_on_last_colon():
    assert parse_location("/a:b/c.c:9") == ("/a:b/c.c", 9)


def test_build_command_file_channel_substitutes_at_file():
    cmd = build_command(_campaign("./bin/readelf -a @@", cwd="/work", env={"ASAN_OPTIONS": "x=1"}), "/tmp/in")
    assert cmd.argv == ["./bin/readelf", "-a", "/tmp/in"]
    assert cmd.stdin_path is None and cmd.cwd == "/work" and cmd.env["ASAN_OPTIONS"] == "x=1"


def test_build_command_stdin_channel_pipes_input_and_defaults_cwd_to_repo():
    cmd = build_command(_campaign("./prog --flag", channel="stdin"), "/tmp/in")
    assert cmd.argv == ["./prog", "--flag"] and cmd.stdin_path == "/tmp/in" and cmd.cwd == "/repo"


@pytest.mark.parametrize("run_cmd,channel", [("./prog", "file"), ("./prog @@", "stdin"), ("", "file")])
def test_build_command_rejects_inconsistent_entries(run_cmd, channel):
    with pytest.raises(TracerError) as info:
        build_command(_campaign(run_cmd, channel), "/tmp/in")
    assert any(r.effect == "edit_campaign" for r in info.value.remedies)


def test_to_rpc_omits_unknown_resolution_and_empty_fields():
    result = TraceResult(breakpoints=[BreakpointReport(location="a.c:1")], exit_code=0)
    assert result.to_rpc() == {"breakpoints": [{"location": "a.c:1", "hitTimes": 0}], "exitCode": 0}


# -- gdb -------------------------------------------------------------------

def test_gdb_run_command_quotes_args_and_redirects_program_stdio():
    cmd = build_command(_campaign("/bin/prog 'a b' @@", channel="file"), "/tmp/my in")
    assert build_run_command(cmd, "/tmp/err") == "run 'a b' '/tmp/my in' 2> /tmp/err"
    cmd = build_command(_campaign("/bin/prog", channel="stdin"), "/tmp/in")
    assert build_run_command(cmd, "/tmp/err") == "run < /tmp/in 2> /tmp/err"


def test_program_exists_resolves_a_relative_run_cmd_against_entry_cwd(tmp_path):
    """Found live in V1 (readelf-c): `entry.run_cmd: ./readelf @@` with `entry.cwd` set to the
    target's own directory built and ran fine by hand, but `GdbBatchTracer.run()` reported
    "The program to run does not exist: ./readelf" — its pre-flight check was a bare
    `Path(program).exists()`, which resolves against the *engine sidecar's* cwd (wherever it
    happened to start), never the campaign's `entry.cwd` that the actual subprocess launch
    correctly uses `cwd=` for.
    """
    (tmp_path / "readelf").write_text("#!/bin/sh\n")
    assert program_exists("./readelf", str(tmp_path)) is True
    # No cwd, or the wrong one: a relative path has nothing else to resolve against.
    assert program_exists("./readelf", None) is False
    assert program_exists("./readelf", str(tmp_path / "not-here")) is False
    # An absolute path or one on PATH is unaffected by cwd either way.
    assert program_exists(str(tmp_path / "readelf"), None) is True
    assert program_exists("sh", None) is True


def test_gdb_script_is_valid_python_and_uses_pending_breakpoints():
    source = build_gdb_script("/tmp/spec \"q\".json", "/tmp/out.json")
    compile(source, "pbfuzz_gdb_batch.py", "exec")
    assert "set breakpoint pending on" in source
    assert "return False" in source  # auto-continue, never an interactive stop
    assert json.dumps("/tmp/spec \"q\".json") in source


def test_parse_reach_fixture_reports_hits_and_honest_unresolved():
    report = json.loads((FIXTURES / "gdb_report_reach.json").read_text())
    bps = [Breakpoint("toy.c:17", inline_expr=("v", "nosuch"), print_call_stack=True), Breakpoint("nosuch.c:10")]
    result = parse_trace_report(report, bps, stderr="REACHED target v=42\n")
    hit, pending = result.breakpoints
    assert (hit.resolved, hit.hit_times, hit.function) == (True, 1, "target")
    assert hit.hits[0].inline_expr[0].value == "42"
    assert hit.hits[0].inline_expr[1].value.startswith("<error:")
    assert "toy.c:31" in hit.hits[0].callstack
    # the crucial distinction: unbound is resolved=False, not a silent zero
    assert pending.resolved is False and pending.hit_times == 0
    rpc = result.to_rpc()
    assert rpc["breakpoints"][1] == {"location": "nosuch.c:10", "resolved": False, "hitTimes": 0}
    assert rpc["exitCode"] == 0 and "signal" not in rpc


def test_old_gdb_falls_back_to_info_breakpoints():
    report = json.loads((FIXTURES / "gdb_report_old_gdb.json").read_text())
    bps = [Breakpoint("toy.c:7"), Breakpoint("gone.c:3"), Breakpoint("inl.h:5")]
    result = parse_trace_report(report, bps)
    assert [b.resolved for b in result.breakpoints] == [True, False, True]
    assert result.exit_code == 2


def test_segv_fixture_keeps_signal_and_global_hit_order():
    report = json.loads((FIXTURES / "gdb_report_segv_partial.json").read_text())
    result = parse_trace_report(report, [Breakpoint("toy.c:5"), Breakpoint("toy.c:17")])
    assert result.signal == "SIGSEGV" and result.exit_code is None
    assert [(h.order, b.location) for h, b in result.hits_in_order()] == [
        (1, "toy.c:5"), (2, "toy.c:17"), (3, "toy.c:5")]


def test_missing_rows_after_timeout_stay_unknown():
    result = parse_trace_report({}, [Breakpoint("a.c:1")], timed_out=True)
    assert result.timed_out and result.breakpoints[0].resolved is None
    assert "resolved" not in result.to_rpc()["breakpoints"][0]


# -- lldb ------------------------------------------------------------------

def test_lldb_hook_is_valid_python_and_argv_runs_then_finishes():
    compile(build_lldb_hook("/tmp/s.json", "/tmp/o.json"), "hook.py", "exec")
    argv = build_lldb_argv("/usr/bin/lldb", "/tmp/x/pbfuzz_lldb_hook.py", "/bin/prog", ["a", "/in"])
    assert argv[:3] == ["/usr/bin/lldb", "--batch", "--no-lldbinit"]
    assert "command script import /tmp/x/pbfuzz_lldb_hook.py" in argv
    assert argv.index("run") < argv.index("script import pbfuzz_lldb_hook; pbfuzz_lldb_hook.finish()")
    assert argv[-4:] == ["--", "/bin/prog", "a", "/in"]


# -- pymon / jdb -----------------------------------------------------------

def test_find_python_script():
    assert find_python_script(["python3", "fuzz/harness.py", "@@"]) == "fuzz/harness.py"
    assert find_python_script(["python3", "-m", "pkg.harness"]) is None


def test_jdb_transcript_parsing():
    text = (FIXTURES / "jdb_transcript.txt").read_text()
    bps = [Breakpoint("src/Toy.java:12", print_call_stack=True, inline_expr=("n",)), Breakpoint("src/Toy.java:99")]
    result = parse_jdb_transcript(text, bps, ["Toy", "Toy"])
    hit, bad = result.breakpoints
    assert (hit.resolved, hit.hit_times, hit.function) == (True, 2, "Toy.parse")
    assert hit.hits[0].callstack.splitlines() == ["[1] Toy.parse (Toy.java:12)", "[2] Toy.main (Toy.java:30)"]
    assert hit.hits[0].inline_expr[0].value.startswith("<unsupported")
    assert bad.resolved is False and bad.hit_times == 0
    assert result.signal == "java.lang.ArrayIndexOutOfBoundsException"


def test_jdb_remedy_recommends_the_classpath_flag_jdb_actually_accepts():
    """Regression: real jdb rejects the short `-cp` form outright
    (`invalid option: -cp`) and only accepts the long `-classpath` flag, but
    this remedy used to tell users to write `java -cp ... Main @@` -- advice
    jdb itself refuses. `jdb_path=sys.executable` sidesteps any dependency on
    a real jdb being installed: this only needs `which()` to succeed so the
    tracer gets past its "jdb not found" check and reaches the remedy this
    test is about.
    """
    campaign = {
        "target": {"repo": "/repo", "language": "java"},
        "entry": {"kind": "executable", "run_cmd": "not-java -cp /x Main @@", "input_channel": "file"},
        "bug": {"kind": "trigger_condition", "targets": [{"location": "Main.java:5"}]},
        "oracle": {"mode": "canary", "reached_pattern": "R", "triggered_pattern": "T"},
    }
    with pytest.raises(TracerError) as info:
        JdbTracer(jdb_path=sys.executable).run(campaign, "/tmp/in", [Breakpoint("Main.java:5")])
    remedy_text = " ".join(r.label for r in info.value.remedies)
    assert "-classpath" in remedy_text
    # The remedy must not tell the user to write the run command with the
    # short `-cp` form jdb rejects (mentioning that `-cp` is *not* accepted
    # is fine -- recommending it as the fix is the bug).
    assert "java -cp" not in remedy_text


def test_drive_jdb_fails_fast_on_unresolvable_breakpoint(tmp_path):
    """Regression for the jdb.py timeout-burning bug: when jdb reports
    'Stopping due to deferred breakpoint errors.' (its terminal response to
    an unresolvable deferred breakpoint), the driver used to just keep
    waiting for a hit or app-exit line that will never come, burning the
    *entire* configured timeout even though jdb itself reports the failure
    in a fraction of a second. This fakes jdb's stdin/stdout protocol (no
    real JDK needed, so the test stays fast and host-independent) rather
    than driving a real `jdb`.
    """
    fake_jdb = tmp_path / "fake_jdb.py"
    fake_jdb.write_text(
        "import sys\n"
        "for raw in sys.stdin:\n"
        "    cmd = raw.strip()\n"
        "    if cmd == 'run':\n"
        "        print('VM Started: Unable to set deferred breakpoint Fake:999 "
        ": No code at line 999 in Fake', flush=True)\n"
        "        print('Stopping due to deferred breakpoint errors.', flush=True)\n"
        "    elif cmd == 'exit':\n"
        "        break\n"
    )
    start = time.monotonic()
    transcript, timed_out = _drive_jdb(
        [sys.executable, str(fake_jdb)], None, {}, ["stop at Fake:999"], max_stops=1, timeout_sec=20.0,
    )
    elapsed = time.monotonic() - start
    assert "Stopping due to deferred breakpoint errors" in transcript
    assert timed_out is False
    # The old code blocked on `_wait_for` until the deadline; the fix should
    # notice jdb's own terminal message and return in well under a second,
    # so 5s (a quarter of the configured 20s budget) is a generous margin.
    assert elapsed < 5.0
