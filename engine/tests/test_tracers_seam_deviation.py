"""W3 seam, selection, self-check and deviation tests, using a scripted fake tracer.

The fake stands in for a debugger so the decision logic (honest resolution,
remedies, never fabricating a deviation) is tested deterministically; the real
backends are covered in ``test_tracers_integration.py``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pbfuzz_engine.deviation import CriticalLocation, detect_deviation, deviation_run, plan_breakpoints
from pbfuzz_engine.tracers import Tracer, TracerError, TracerPaths, select_tracer, trace_run
from pbfuzz_engine.tracers.base import BreakpointReport, HitRecord, TraceResult

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"


def _campaign(**over) -> dict:
    base = {
        "version": 1, "id": "toy",
        "target": {"repo": "/repo", "language": "c"},
        "bug": {"kind": "trigger_condition", "targets": [{"location": "toy.c:18"}]},
        "entry": {"kind": "executable", "run_cmd": "/bin/true @@", "input_channel": "file"},
        "oracle": {"mode": "canary", "reached_pattern": "REACHED", "triggered_pattern": "TRIGGERED"},
        "output": {"dir": "/tmp/out"},
    }
    base.update(over)
    return base


class FakeTracer(Tracer):
    name = "gdb"

    def __init__(self, result=None, ok=True, error=None):
        self.result, self.ok, self.error, self.calls = result, ok, error, []

    def available(self):
        return self.ok, "fake-gdb 15.1" if self.ok else "`gdb` not found on PATH"

    def run(self, campaign, input_path, breakpoints, timeout_sec=None):
        self.calls.append(list(breakpoints))
        if self.error:
            raise self.error
        if callable(self.result):
            return self.result(breakpoints)
        return self.result


def factory_for(tracer):
    return lambda name, paths: tracer


def _hit(order, loc, stack=""):
    return HitRecord(order=order, callstack=stack, location=loc)


# -- contract shape ----------------------------------------------------------

def _defs(name):
    return json.loads((CONTRACTS / name).read_text())


def test_trace_run_output_matches_contract_keys():
    result = TraceResult(
        breakpoints=[BreakpointReport("toy.c:18", "target", True, 1, [_hit(1, "toy.c:18", "#0 target")]),
                     BreakpointReport("x.c:1", None, False, 0)],
        exit_code=0, stderr="REACHED\n")
    out = trace_run({"campaign": _campaign(), "input": "/tmp/in",
                     "breakpoints": [{"location": "toy.c:18"}, {"location": "x.c:1"}]},
                    factory_for(FakeTracer(result)))
    schema = _defs("engine-rpc.schema.json")["$defs"]["TraceRunResult"]
    assert set(out) <= set(schema["properties"])
    item_props = set(schema["properties"]["breakpoints"]["items"]["properties"])
    for bp in out["breakpoints"]:
        assert set(bp) <= item_props and {"location", "hitTimes"} <= set(bp)
    assert out["reached"] is True and out["triggered"] is False  # judged by W2's StderrOracle
    assert out["breakpoints"][1]["resolved"] is False


def test_trace_run_missing_input_is_a_tracer_error():
    with pytest.raises(TracerError):
        trace_run({"campaign": _campaign(), "breakpoints": []}, factory_for(FakeTracer()))


# -- selection ---------------------------------------------------------------

@pytest.mark.parametrize("language,expected", [("python", "pymon"), ("java", "jdb"), ("c", "gdb"), (None, "gdb")])
def test_auto_selection_by_language(language, expected):
    made = []

    def factory(name, paths):
        made.append(name)
        return FakeTracer()

    select_tracer(_campaign(target={"repo": "/r", "language": language}), None, TracerPaths(), factory)
    assert made[0] == expected


def test_precedence_request_over_campaign_and_off_raises():
    names = []
    factory = lambda name, paths: names.append(name) or FakeTracer()  # noqa: E731
    select_tracer(_campaign(tracer="lldb"), "gdb", TracerPaths(), factory)
    select_tracer(_campaign(tracer="lldb"), "auto", TracerPaths(), factory)
    assert names == ["gdb", "lldb"]
    with pytest.raises(TracerError):
        select_tracer(_campaign(tracer="off"), None, TracerPaths(), factory)


def test_auto_falls_back_to_lldb_only_when_gdb_unavailable():
    class Named(FakeTracer):
        def __init__(self, name, ok):
            super().__init__(ok=ok)
            self.name = name

    pick = select_tracer(_campaign(), None, TracerPaths(),
                         lambda n, p: Named(n, ok=(n == "lldb")))
    assert pick.tracer.name == "lldb" and "gdb unavailable" in pick.reason


# -- deviation ---------------------------------------------------------------

CRIT = [CriticalLocation("toy.c:12", "parse_header", 3.0), CriticalLocation("toy.c:8", "parse_header", 4.0)]


def test_plan_breakpoints_dedupes_caps_and_forces_callstacks():
    from pbfuzz_engine.tracers import Breakpoint
    many = [CriticalLocation(f"c.c:{i}") for i in range(1, 60)]
    bps, dropped = plan_breakpoints(many + [CriticalLocation("toy.c:18")], ["toy.c:18"],
                                    [Breakpoint("e.c:1", hit_limit=4)], limit=50)
    assert bps[0].location == "toy.c:18" and bps[1].location == "e.c:1" and bps[1].hit_limit == 4
    assert len(bps) == 52 and dropped == 9 and all(b.print_call_stack for b in bps)


def test_first_critical_hit_in_execution_order_is_the_deviation():
    result = TraceResult([
        BreakpointReport("toy.c:18", None, True, 0),
        BreakpointReport("toy.c:12", "parse_header", True, 1, [_hit(3, "toy.c:12", "#0 parse_header")]),
        BreakpointReport("toy.c:8", "parse_header", True, 1, [_hit(2, "toy.c:8", "#0 early")]),
        BreakpointReport("e.c:1", "main", True, 1, [_hit(1, "e.c:1")]),
    ], exit_code=2)
    out = detect_deviation(result, CRIT, ["toy.c:18"]).to_rpc()
    assert out["mode"] == "critical_bb"
    assert out["deviationPoint"] == "toy.c:8" and out["distanceRemaining"] == 4.0
    assert out["lastReachedLocation"] == "e.c:1" and out["callstack"] == "#0 early"
    assert set(out) <= set(_defs("engine-rpc.schema.json")["$defs"]["DeviationRunResult"]["properties"])


def test_no_critical_hit_never_fabricates_a_deviation_point():
    result = TraceResult([BreakpointReport("toy.c:18", None, True, 0),
                          BreakpointReport("toy.c:12", None, False, 0),
                          BreakpointReport("toy.c:8", None, True, 0)], exit_code=0)
    out = detect_deviation(result, CRIT, ["toy.c:18"]).to_rpc()
    assert "deviationPoint" not in out and out["mode"] == "critical_bb"
    assert "could not bind" in out["explanation"] and "No breakpoint was hit" in out["explanation"]


def test_target_only_reports_progress_without_deviation_point():
    result = TraceResult([BreakpointReport("toy.c:18", None, True, 0),
                          BreakpointReport("a.c:5", "f", True, 1, [_hit(1, "a.c:5")]),
                          BreakpointReport("a.c:9", "g", True, 1, [_hit(2, "a.c:9", "#0 g")])],
                         signal="SIGSEGV")
    out = detect_deviation(result, [], ["toy.c:18"]).to_rpc()
    assert out["mode"] == "target_only" and "deviationPoint" not in out
    assert out["lastReachedLocation"] == "a.c:9" and "SIGSEGV" in out["explanation"]


def test_reached_means_no_deviation():
    result = TraceResult([BreakpointReport("toy.c:18", "target", True, 1, [_hit(1, "toy.c:18")])])
    out = detect_deviation(result, CRIT, ["toy.c:18"]).to_rpc()
    assert "deviationPoint" not in out and out["distanceRemaining"] == 0
    oracle_only = TraceResult([], reached=True)
    assert "no deviation" in detect_deviation(oracle_only, [], ["toy.c:18"]).explanation


def test_deviation_run_end_to_end_through_the_seam():
    def respond(bps):
        locs = [b.location for b in bps]
        assert locs[:2] == ["toy.c:18", "extra.c:4"] and set(locs[2:]) == {"toy.c:12", "toy.c:8"}
        return TraceResult([BreakpointReport(b.location, None, True,
                                             1 if b.location == "toy.c:12" else 0,
                                             [_hit(1, b.location)] if b.location == "toy.c:12" else [])
                            for b in bps], exit_code=2, stderr="bad magic\n")

    tracer = FakeTracer(respond)
    out = deviation_run({"campaign": _campaign(), "input": "/tmp/in",
                         "criticalLocations": [{"location": "toy.c:12", "function": "parse_header", "distance": 3},
                                               {"location": "toy.c:8"}],
                         "extraBreakpoints": [{"location": "extra.c:4"}]}, factory_for(tracer))
    assert out["mode"] == "critical_bb" and out["deviationPoint"] == "toy.c:12"
    assert out["distanceRemaining"] == 3.0
    no_provider = deviation_run({"campaign": _campaign(), "input": "/tmp/in"},
                                factory_for(FakeTracer(lambda bps: TraceResult([BreakpointReport(b.location, None, True, 0) for b in bps]))))
    assert no_provider["mode"] == "target_only" and "deviationPoint" not in no_provider
