"""W3 integration tests against REAL tracers. Each skips cleanly when its tool is absent.

* gdb: ``linux_only`` + skipped without gdb (the deployment target is Linux x86-64).
* lldb: runs wherever lldb and a C compiler exist.
* jdb: runs wherever javac/java/jdb (a JDK, not just a JRE) exist.
* pymon: runs anywhere (pure Python).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from pbfuzz_engine.tracers import (
    GdbBatchTracer,
    JdbTracer,
    LldbBatchTracer,
    PymonTracer,
    trace_run,
)
from pbfuzz_engine.deviation import deviation_run

TOY_C = textwrap.dedent("""\
    #include <stdio.h>
    #include <string.h>

    static int parse_header(const char *buf, size_t n) {
        if (n < 4) {
            fprintf(stderr, "short input\\n");
            return -1;
        }
        if (memcmp(buf, "PBFZ", 4) != 0) {
            fprintf(stderr, "bad magic\\n");
            return -2;
        }
        return 0;
    }

    static void target(int v) {
        fprintf(stderr, "REACHED target v=%d\\n", v);
        if (v == 42) {
            fprintf(stderr, "TRIGGERED\\n");
        }
    }

    int main(int argc, char **argv) {
        if (argc < 2) return 1;
        FILE *f = fopen(argv[1], "rb");
        if (!f) return 1;
        char buf[64];
        size_t n = fread(buf, 1, sizeof buf, f);
        fclose(f);
        if (parse_header(buf, n) != 0) return 2;
        target(n >= 5 ? (int)(unsigned char)buf[4] : 0);
        return 0;
    }
    """)
TARGET_LINE = 17  # fprintf(stderr, "REACHED ...")
SHORT_LINE = 6    # fprintf(stderr, "short input")
MAGIC_LINE = 10   # fprintf(stderr, "bad magic")

# N3 fixture: a breakpoint requested on a line with no code (a comment-only
# line) gets silently rebound by gdb/lldb to the next line that does have
# code. Line 5 below has no line-table entry at -O0; line 6 does.
REBIND_C = textwrap.dedent("""\
    #include <stdio.h>

    int compute(int x) {
        int result = x * 2;
        /* comment-only line: no code, breakpoint here must rebind forward */
        return result;
    }

    int main(int argc, char **argv) {
        int v = argc > 1 ? argc : 3;
        int r = compute(v);
        fprintf(stderr, "result=%d\\n", r);
        return 0;
    }
    """)
REBIND_NO_CODE_LINE = 5   # requested: the comment-only line
REBIND_RESOLVED_LINE = 6  # gdb/lldb actually bind here: `return result;`


@pytest.fixture(scope="module")
def rebind_toy(tmp_path_factory):
    cc = shutil.which("cc") or shutil.which("clang") or shutil.which("gcc")
    if not cc:
        pytest.skip("no C compiler")
    d = tmp_path_factory.mktemp("rebind")
    (d / "rebind.c").write_text(REBIND_C)
    subprocess.run([cc, "-g", "-O0", "-o", str(d / "rebind"), str(d / "rebind.c")], check=True)
    return d


def _exercise_rebind(d: Path, tracer_name: str):
    """N3: the requested no-code line must stay in `breakpoints[].location`
    (the request), while the hit(s) report gdb/lldb's *actual* resolved
    location — proving the misattribution from the L1 evidence
    (`resolved: true` reported entirely under the originally requested,
    never-executed location string) is fixed without dropping that field.
    """
    src = d / "rebind.c"
    campaign = {
        "version": 1, "id": "rebind", "tracer": tracer_name,
        "target": {"repo": str(d), "language": "c"},
        "entry": {"kind": "executable", "run_cmd": f"{d / 'rebind'}", "input_channel": "stdin"},
        "oracle": {"mode": "canary", "reached_pattern": "result=", "triggered_pattern": "never"},
    }
    out = trace_run({"campaign": campaign, "input": "/dev/null", "timeoutSec": 30, "breakpoints": [
        {"location": f"{src}:{REBIND_NO_CODE_LINE}"},
    ]})
    bp = out["breakpoints"][0]
    # The requested field is untouched: still the line the caller asked for.
    assert bp["location"] == f"{src}:{REBIND_NO_CODE_LINE}"
    assert bp["resolved"] is True and bp["hitTimes"] == 1
    # The resolved field reveals where the debugger actually bound/hit it.
    assert bp["hits"][0]["location"] == f"{src}:{REBIND_RESOLVED_LINE}"


@pytest.fixture(scope="module")
def toy(tmp_path_factory):
    cc = shutil.which("cc") or shutil.which("clang") or shutil.which("gcc")
    if not cc:
        pytest.skip("no C compiler")
    d = tmp_path_factory.mktemp("toy")
    (d / "toy.c").write_text(TOY_C)
    subprocess.run([cc, "-g", "-O0", "-o", str(d / "toy"), str(d / "toy.c")], check=True)
    (d / "reach.bin").write_bytes(b"PBFZ*")
    (d / "magic.bin").write_bytes(b"XXXXX")
    return d


def _c_campaign(d: Path, tracer: str) -> dict:
    return {
        "version": 1, "id": "toy", "tracer": tracer,
        "target": {"repo": str(d), "language": "c"},
        "bug": {"kind": "trigger_condition", "targets": [{"location": f"{d / 'toy.c'}:{TARGET_LINE}"}]},
        "entry": {"kind": "executable", "run_cmd": f"{d / 'toy'} @@", "input_channel": "file"},
        "oracle": {"mode": "canary", "reached_pattern": "REACHED", "triggered_pattern": "TRIGGERED"},
        "output": {"dir": str(d / "out")},
    }


def _exercise_native(d: Path, tracer_name: str):
    campaign = _c_campaign(d, tracer_name)
    src = d / "toy.c"
    out = trace_run({"campaign": campaign, "input": str(d / "reach.bin"), "timeoutSec": 60, "breakpoints": [
        {"location": f"{src}:{TARGET_LINE}", "inline_expr": ["v"], "print_call_stack": True},
        {"location": f"{d / 'nosuch.c'}:10"},
    ]})
    reach, missing = out["breakpoints"]
    assert reach["resolved"] is True and reach["hitTimes"] == 1 and reach["function"].startswith("target")
    assert reach["hits"][0]["inlineExpr"][0]["value"].strip() == "42"
    assert "main" in reach["hits"][0]["callstack"]
    assert missing["resolved"] is False and missing["hitTimes"] == 0
    assert out["exitCode"] == 0 and out["reached"] is True and out["triggered"] is True

    dev = deviation_run({"campaign": campaign, "input": str(d / "magic.bin"), "timeoutSec": 60,
                         "criticalLocations": [{"location": f"{src}:{SHORT_LINE}", "distance": 5},
                                               {"location": f"{src}:{MAGIC_LINE}", "distance": 4}]})
    assert dev["mode"] == "critical_bb" and dev["deviationPoint"] == f"{src}:{MAGIC_LINE}"



@pytest.mark.linux_only
@pytest.mark.skipif(not GdbBatchTracer().available()[0], reason="gdb not installed (needs Linux x86-64 deployment host)")
def test_gdb_batch_real(toy):
    _exercise_native(toy, "gdb")


@pytest.mark.linux_only
@pytest.mark.skipif(not GdbBatchTracer().available()[0], reason="gdb not installed (needs Linux x86-64 deployment host)")
def test_gdb_reports_resolved_location_for_rebound_breakpoint(rebind_toy):
    """N3 regression: gdb silently rebinds a no-code line to the next line
    with code; the report used to only ever show the originally requested
    location, with nothing revealing the rebind.
    """
    _exercise_rebind(rebind_toy, "gdb")


def _lldb_can_launch() -> bool:
    """lldb may be installed yet unable to launch (macOS with Developer mode off)."""
    lldb, true = shutil.which("lldb"), shutil.which("true")
    if not lldb or not true:
        return False
    try:
        proc = subprocess.run([lldb, "--batch", "--no-lldbinit", "-o", "run", "--", true],
                              capture_output=True, timeout=20)
    except subprocess.TimeoutExpired:
        return False
    return b"exited with status = 0" in proc.stdout


@pytest.mark.skipif(not LldbBatchTracer().available()[0], reason="lldb not installed")
def test_lldb_batch_real(toy):
    if not _lldb_can_launch():
        pytest.skip("lldb is installed but cannot launch processes here (e.g. macOS Developer mode off)")
    _exercise_native(toy, "lldb")


@pytest.mark.skipif(not LldbBatchTracer().available()[0], reason="lldb not installed")
def test_lldb_reports_resolved_location_for_rebound_breakpoint(rebind_toy):
    """N3 regression, lldb side: same rebind behavior as gdb, reported through
    the same shared `parse_trace_report`.
    """
    if not _lldb_can_launch():
        pytest.skip("lldb is installed but cannot launch processes here (e.g. macOS Developer mode off)")
    _exercise_rebind(rebind_toy, "lldb")


JAVA_TOY = textwrap.dedent("""\
    import java.nio.file.Files;
    import java.nio.file.Paths;

    public class JdbToy {
        public static void main(String[] args) throws Exception {
            byte[] data = Files.readAllBytes(Paths.get(args[0]));
            parse(data);
        }

        static void parse(byte[] data) {
            if (data.length >= 4 && data[0] == 'P' && data[1] == 'B' && data[2] == 'F' && data[3] == 'Z') {
                System.err.println("REACHED");
            }
        }
    }
    """)
JAVA_TARGET_LINE = 12  # System.err.println("REACHED");


@pytest.fixture(scope="module")
def java_toy(tmp_path_factory):
    javac, java = shutil.which("javac"), shutil.which("java")
    if not javac or not java:
        pytest.skip("no JDK (javac/java) on PATH")
    d = tmp_path_factory.mktemp("jdbtoy")
    (d / "JdbToy.java").write_text(JAVA_TOY)
    subprocess.run([javac, "-g", "JdbToy.java"], cwd=d, check=True)
    (d / "reach.bin").write_bytes(b"PBFZxyz")
    (d / "miss.bin").write_bytes(b"nope!")
    return d


@pytest.mark.skipif(not JdbTracer().available()[0], reason="jdb not installed (ships with a JDK, not a JRE)")
def test_jdb_real(java_toy):
    """Regression test for the jdb feed-timing bug: a naive one-shot piped
    session loses the race against the JVM booting (jdb's `run` is
    asynchronous), so `exit` used to kill the VM before the class loaded and
    every breakpoint came back `resolved: None, hits: 0`. This exercises the
    real interactive feed end to end, which the canned-transcript unit test
    (test_jdb_session_and_transcript_parsing) cannot: it never touches a real
    jdb process, so it could not have caught this.
    """
    d = java_toy
    src = d / "JdbToy.java"
    campaign = {
        "version": 1, "id": "jdbtoy", "tracer": "jdb",
        "target": {"repo": str(d), "language": "java"},
        "bug": {"kind": "trigger_condition", "targets": [{"location": f"{src}:{JAVA_TARGET_LINE}"}]},
        "entry": {"kind": "api", "run_cmd": f"java -classpath {d} JdbToy @@", "input_channel": "file"},
        "oracle": {"mode": "canary", "reached_pattern": "REACHED", "triggered_pattern": "REACHED"},
        "output": {"dir": str(d / "out")},
    }
    out = trace_run({"campaign": campaign, "input": str(d / "reach.bin"), "timeoutSec": 40, "breakpoints": [
        {"location": f"{src}:{JAVA_TARGET_LINE}"},
    ]})
    hit = out["breakpoints"][0]
    assert hit["resolved"] is True and hit["hitTimes"] == 1
    assert hit["function"] == "JdbToy.parse"
    assert out["reached"] is True  # jdb never reports the debuggee's exit code, unlike gdb/lldb


    out = trace_run({"campaign": campaign, "input": str(d / "miss.bin"), "timeoutSec": 40, "breakpoints": [
        {"location": f"{src}:{JAVA_TARGET_LINE}"},
    ]})
    miss = out["breakpoints"][0]
    assert miss["resolved"] is True and miss["hitTimes"] == 0


HARNESS = textwrap.dedent("""\
    import sys


    def check(data):
        n = len(data)
        # a comment line: breakpoints here must not bind
        if data[:4] != b"PBFZ":
            return False
        return True


    def main():
        data = open(sys.argv[1], "rb").read() if len(sys.argv) > 1 else sys.stdin.buffer.read()
        if check(data):
            sys.stderr.write("REACHED\\n")
        return 0


    if __name__ == "__main__":
        sys.exit(main())
    """)


def test_pymon_real(tmp_path):
    (tmp_path / "harness.py").write_text(HARNESS)
    (tmp_path / "in.bin").write_bytes(b"PBFZxyz")
    h = tmp_path / "harness.py"
    campaign = {
        "target": {"repo": str(tmp_path), "language": "python"},
        "bug": {"kind": "trigger_condition", "targets": [{"location": f"{h}:9"}]},
        "entry": {"kind": "api", "run_cmd": f"{sys.executable} {h} @@", "input_channel": "file"},
        "oracle": {"mode": "canary", "reached_pattern": "REACHED", "triggered_pattern": "TRIGGERED"},
    }
    out = trace_run({"campaign": campaign, "input": str(tmp_path / "in.bin"), "pythonPath": sys.executable,
                     "breakpoints": [{"location": f"{h}:7", "inline_expr": ["n", "nope"], "print_call_stack": True},
                                     {"location": f"{h}:6"}, {"location": f"{h}:9"}]})
    hit, comment, target = out["breakpoints"]
    assert hit["resolved"] is True and hit["hitTimes"] == 1 and hit["function"] == "check"
    assert hit["hits"][0]["inlineExpr"][0] == {"name": "n", "value": "7"}
    assert hit["hits"][0]["inlineExpr"][1]["value"].startswith("<error:")
    assert "main" in hit["hits"][0]["callstack"]
    assert comment == {"location": f"{h}:6", "resolved": False, "hitTimes": 0}
    assert target["hitTimes"] == 1 and out["reached"] is True and out["exitCode"] == 0

    stdin_campaign = dict(campaign, entry=dict(campaign["entry"], run_cmd=f"{sys.executable} {h}", input_channel="stdin"))
    out = trace_run({"campaign": stdin_campaign, "input": str(tmp_path / "in.bin"),
                     "breakpoints": [{"location": f"{h}:9"}]})
    assert out["breakpoints"][0]["hitTimes"] == 1 and out["reached"] is True
    assert PymonTracer().available()[0]
