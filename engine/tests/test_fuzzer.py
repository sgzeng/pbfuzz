"""The two-stage PBT loop (ported from test_property_based_fuzzer.py where it still applies)."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest
from conftest import assert_error_shape, assert_only_declared_keys, contract_def

from pbfuzz_engine.campaign import load_campaign
from pbfuzz_engine.errors import CANCELLED, GENERATOR_FAILED, PLAN_INVALID, EngineError
from pbfuzz_engine.fuzzer import FuzzSession, load_plan
from pbfuzz_engine.metrics import MetricsStore

RESULT_SCHEMA = contract_def("engine-rpc.schema.json", "FuzzRunResult")
FAST = {"maxIters": 8, "execTimeoutSec": 5, "fuzzTimeoutSec": 60, "generatorTimeoutSec": 10, "stage1MinConcreteParams": 0}
PAYLOAD_SPACE = {"payload": {"type": "categorical", "values": ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]}, "n": {"type": "int_range", "min": 0, "max": 1000}}


def _session(make_campaign, write_plan, write_generator, plan, gen=None, runtime=None, **kw):
    campaign = load_campaign(make_campaign())
    events: list[tuple[str, dict]] = []
    session = FuzzSession(campaign, load_plan(write_plan(plan)), gen or write_generator(), runtime={**FAST, **(runtime or {})},
                          notify=lambda m, p: events.append((m, p)), **kw)
    return session, events, campaign


def _records(result):
    return [json.loads(line) for line in Path(result["iterationsPath"]).read_text().splitlines()]


def test_plain_run_completes(make_campaign, write_plan, write_generator):
    session, events, campaign = _session(make_campaign, write_plan, write_generator, {"parameter_space": PAYLOAD_SPACE})
    result = session.run()
    assert_only_declared_keys(result, RESULT_SCHEMA)
    s = result["summary"]
    assert s == {**s, "totalIterations": 8, "reachedCount": 0, "triggeredCount": 0, "errorCount": 0, "stoppedBy": "completed"}
    assert len(_records(result)) == 8
    metrics = MetricsStore(campaign.state_dir).read()
    assert metrics["total_iterations"] == 8 and metrics["pier_round"] == 0
    assert any(m == "progress" for m, _ in events)


def test_stage1_runs_batch_plan_in_order_then_samples(make_campaign, write_plan, write_generator):
    plan = {"parameter_space": PAYLOAD_SPACE, "next_batch_plan": [
        {"plan_description": "hyp A", "payload": "a"}, {"plan_description": "hyp B", "payload": "b", "seed": 99}]}
    session, events, _ = _session(make_campaign, write_plan, write_generator, plan)
    result = session.run()
    recs = _records(result)
    assert [r["stage"] for r in recs[:3]] == [1, 1, 2]
    assert recs[0]["plan_description"] == "hyp A" and recs[0]["parameters"] == {"payload": "a", "seed": 1}
    assert recs[1]["parameters"]["seed"] == 99
    assert Path(recs[0]["testcase_file"]).read_bytes() == b"a|1"
    assert result["stage1"]["entries"] == 2 and result["stage1"]["tracedEntries"] == 0
    assert sum(1 for m, p in events if m == "iteration" and p["stage"] == 1) == 2


def test_reach_detection_and_best_reaching_inputs(make_campaign, write_plan, write_generator):
    gen = write_generator("def generate(**p):\n    return b'R' + b'.' * p['n']\n")
    session, _, campaign = _session(make_campaign, write_plan, write_generator, {"parameter_space": {"n": {"type": "int_range", "min": 0, "max": 50}}}, gen=gen, runtime={"maxIters": 6})
    result = session.run()
    assert result["summary"]["reachedCount"] == result["summary"]["totalIterations"] > 0
    sizes = [Path(p).stat().st_size for p in result["bestReachingInputs"]]
    assert sizes == sorted(sizes) and all(p.endswith("_reached") for p in result["bestReachingInputs"])
    m = MetricsStore(campaign.state_dir).read()
    assert m["last_reached_count"] == result["summary"]["reachedCount"]
    assert m["last_session"]["best_reaching_input"] == result["bestReachingInputs"][0]


def test_trigger_stops_the_run_and_saves_poc(make_campaign, write_plan, write_generator):
    gen = write_generator("def generate(**p):\n    return b'RT' if p['n'] == 3 else b'R'\n")
    plan = {"parameter_space": {"n": {"type": "int_range", "min": 0, "max": 5}},
            "next_batch_plan": [{"plan_description": "miss", "n": 1}, {"plan_description": "hit", "n": 3}, {"plan_description": "never", "n": 4}]}
    session, _, campaign = _session(make_campaign, write_plan, write_generator, plan, gen=gen)
    result = session.run()
    assert result["summary"]["stoppedBy"] == "trigger" and result["summary"]["totalIterations"] == 2
    assert Path(result["firstTriggeringInput"]).read_bytes() == b"RT"
    m = MetricsStore(campaign.state_dir).read()
    assert m["triggered_count"] == 1 and m["last_session"]["first_triggering_input"] == result["firstTriggeringInput"]


def test_exec_timeouts_are_counted_not_reached(make_campaign, write_plan, write_generator):
    gen = write_generator("def generate(**p):\n    return b'RH'\n")
    session, _, _ = _session(make_campaign, write_plan, write_generator, {"parameter_space": {}}, gen=gen, runtime={"maxIters": 2, "execTimeoutSec": 0.3})
    s = session.run()["summary"]
    assert s["timeoutCount"] == 2 and s["reachedCount"] == 0


def test_fuzz_timeout_interrupts_a_slow_generation_sub_batch(make_campaign, write_plan, write_generator):
    """F-batch-cancel-timeout: `generate_many()` batches up to `GENERATE_BATCH_SIZE` (32)
    generator calls into one sandbox round trip, and the fuzz timeout used to only be checked
    before/after that whole round trip, not during it. Against a slow (or persistently broken)
    generator, that let a run blow its timeout budget by a whole sub-batch's worth of calls
    (verified live: 3.0s budget, actual stop at 22.68s). With a 0.3s-per-call generator and a
    32-item stage-2 sub-batch, an uninterrupted batch would take ~9.6s; the 0.5s fuzz timeout
    must cut it off close to that budget instead.
    """
    gen = write_generator("import time\ndef generate(**p):\n    time.sleep(0.3)\n    return b'x'\n")
    session, _, campaign = _session(
        make_campaign, write_plan, write_generator, {"parameter_space": PAYLOAD_SPACE}, gen=gen,
        runtime={"maxIters": 10_000, "fuzzTimeoutSec": 0.5},
    )
    started = time.monotonic()
    result = session.run()
    elapsed = time.monotonic() - started
    assert result["summary"]["stoppedBy"] == "timeout"
    assert MetricsStore(campaign.state_dir).read()["last_session"]["stopped_by"] == "timeout"
    # Without the fix this takes ~9.6s+ (32 * 0.3s, uninterruptible); with it, close to the 0.5s
    # budget plus one in-flight call and a worker boot.
    assert elapsed < 5.0, f"took {elapsed:.1f}s -- the generation sub-batch was not interrupted by the fuzz timeout"


def test_broken_generator_fails_fast_but_metrics_are_still_written(make_campaign, write_plan, write_generator):
    gen = write_generator("def generate(**p):\n    raise ValueError('bad width')\n")
    session, _, campaign = _session(make_campaign, write_plan, write_generator, {"parameter_space": PAYLOAD_SPACE}, gen=gen)
    with pytest.raises(EngineError) as info:
        session.run()
    assert info.value.code == GENERATOR_FAILED and "bad width" in info.value.diagnosis
    assert_error_shape(info.value)
    m = MetricsStore(campaign.state_dir).read()
    assert m["error_count"] == 1 and m["last_session"]["stopped_by"] == "error"


def test_mid_run_generator_error_stops_with_partial_result(make_campaign, write_plan, write_generator):
    gen = write_generator("def generate(**p):\n    if p['n'] == 2: raise KeyError('x')\n    return b'R'\n")
    plan = {"parameter_space": {"n": {"type": "int_range", "min": 0, "max": 9}},
            "next_batch_plan": [{"plan_description": "ok", "n": 1}, {"plan_description": "boom", "n": 2}]}
    session, _, _ = _session(make_campaign, write_plan, write_generator, plan, gen=gen)
    result = session.run()
    assert_only_declared_keys(result, RESULT_SCHEMA)
    assert result["summary"]["stoppedBy"] == "error" and result["summary"]["errorCount"] == 1
    assert _records(result)[-1]["type"] == "error"
    # F20-engine: the diagnosis computed for the mid-run error (visible on the "iteration"
    # notification and in iterations.jsonl) must also reach the top-level FuzzRunResult a
    # caller inspects after the fact, not just the intermediate structures.
    last_record = _records(result)[-1]
    assert result["summary"]["errorMessage"] == last_record["message"]
    assert result["summary"]["errorDiagnosis"] == last_record["diagnosis"]
    assert "KeyError" in result["summary"]["errorDiagnosis"] or "x" in result["summary"]["errorDiagnosis"]


def test_cancel(make_campaign, write_plan, write_generator):
    cancel = threading.Event()
    cancel.set()
    session, _, campaign = _session(make_campaign, write_plan, write_generator, {"parameter_space": PAYLOAD_SPACE}, cancel=cancel)
    with pytest.raises(EngineError) as info:
        session.run()
    assert info.value.code == CANCELLED
    assert MetricsStore(campaign.state_dir).read()["total_iterations"] == 0
    assert MetricsStore(campaign.state_dir).read()["last_session"]["stopped_by"] == "cancelled"


def test_cancel_mid_flight_records_cancelled_not_completed(make_campaign, write_plan, write_generator):
    """A cancel that lands after some iterations already ran must not be written as `completed`."""
    cancel = threading.Event()
    campaign = load_campaign(make_campaign("file"))
    events: list[tuple[str, dict]] = []

    def notify(method: str, params: dict) -> None:
        events.append((method, params))
        if method == "iteration":
            # Simulate `fuzz.cancel` arriving while the loop is still running.
            cancel.set()

    # Stage-1 entries always notify "iteration" (regardless of reach/trigger), so a batch plan
    # longer than one entry guarantees the cancel lands after some iterations but before the end.
    plan = {"parameter_space": PAYLOAD_SPACE, "next_batch_plan": [
        {"plan_description": f"p{i}", "payload": "a"} for i in range(8)
    ]}
    session = FuzzSession(
        campaign, load_plan(write_plan(plan)), write_generator(),
        runtime={**FAST, "maxIters": 8}, notify=notify, cancel=cancel,
    )
    with pytest.raises(EngineError) as info:
        session.run()
    assert info.value.code == CANCELLED
    m = MetricsStore(campaign.state_dir).read()
    assert 0 < m["total_iterations"] < 8, "the cancel must land after at least one but not all iterations"
    assert m["last_session"]["stopped_by"] == "cancelled"


def test_batch_plan_longer_than_max_iters_is_truncated(make_campaign, write_plan, write_generator):
    plan = {"parameter_space": PAYLOAD_SPACE, "next_batch_plan": [{"plan_description": str(i), "n": i} for i in range(20)]}
    session, _, _ = _session(make_campaign, write_plan, write_generator, plan, runtime={"maxIters": 5})
    assert session.run()["summary"]["totalIterations"] == 5


def test_small_space_dedups_and_empty_space_still_runs(make_campaign, write_plan, write_generator):
    session, _, _ = _session(make_campaign, write_plan, write_generator, {"parameter_space": {"flag": {"type": "bool"}}}, runtime={"maxIters": 20})
    assert session.run()["summary"]["totalIterations"] == 2
    session, _, _ = _session(make_campaign, write_plan, write_generator, {"parameter_space": {}}, runtime={"maxIters": 3})
    assert session.run()["summary"]["totalIterations"] == 3


def test_all_parameter_types_reach_the_generator(make_campaign, write_plan, write_generator, tmp_path):
    seed = tmp_path / "seed.bin"
    seed.write_bytes(b"SEED")
    gen = write_generator("import json\ndef generate(**p):\n    return json.dumps(p, sort_keys=True).encode()\n")
    space = {"i": {"type": "int_range", "min": 1, "max": 3}, "f": {"type": "float_range", "min": 0, "max": 1},
             "c": {"type": "categorical", "values": ["x"]}, "b": {"type": "bool"}, "base": {"type": "base_seed", "seed_file_path": str(seed)},
             "segs": {"type": "segments", "count_range": {"min": 2, "max": 2}, "segment_params": {"v": {"type": "int_range", "min": 0, "max": 1}}}}
    session, _, _ = _session(make_campaign, write_plan, write_generator, {"parameter_space": space}, gen=gen, runtime={"maxIters": 3})
    rec = _records(session.run())[0]
    produced = json.loads(Path(rec["testcase_file"]).read_bytes())
    assert produced["base"] == str(seed) and len(produced["segs"]) == 2 and produced["c"] == "x"


def test_sessions_accumulate_and_do_not_overwrite(make_campaign, write_plan, write_generator):
    campaign = load_campaign(make_campaign())
    plan = load_plan(write_plan({"parameter_space": PAYLOAD_SPACE}))
    gen = write_generator()
    r1 = FuzzSession(campaign, plan, gen, runtime={**FAST, "maxIters": 3}, pier_round=0).run()
    r2 = FuzzSession(campaign, plan, gen, runtime={**FAST, "maxIters": 4}, pier_round=1).run()
    assert r1["iterationsPath"] != r2["iterationsPath"]
    m = MetricsStore(campaign.state_dir).read()
    assert m["total_iterations"] == 7 and m["pier_round"] == 1


class FakeTracer:
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def run(self, campaign, input_path, breakpoints, timeout_sec=None):
        self.calls.append((input_path, breakpoints))
        if self.fail:
            raise RuntimeError("gdb exploded")

        class R:
            def to_rpc(self_inner):
                return {"breakpoints": [{"location": breakpoints[0]["location"], "hitTimes": 1, "resolved": True}]}
        return R()


def test_stage1_tracing_collects_observations(make_campaign, write_plan, write_generator):
    tracer = FakeTracer()
    plan = {"parameter_space": PAYLOAD_SPACE, "breakpoints": [{"location": "target.py:9"}],
            "next_batch_plan": [{"plan_description": "p1", "payload": "a"}, {"plan_description": "p2", "payload": "b"}]}
    session, _, _ = _session(make_campaign, write_plan, write_generator, plan, tracer=tracer)
    result = session.run()
    assert len(tracer.calls) == 2  # stage 1 only, since enableDebuggerForAll is false
    obs = result["stage1"]["observations"]
    assert result["stage1"]["tracedEntries"] == 2 and obs[0]["plan_description"] == "p1" and obs[0]["breakpoints"][0]["hitTimes"] == 1


def test_tracer_failure_degrades_with_a_warning(make_campaign, write_plan, write_generator):
    plan = {"parameter_space": PAYLOAD_SPACE, "breakpoints": [{"location": "target.py:9"}], "next_batch_plan": [{"plan_description": "p", "payload": "a"}]}
    session, events, _ = _session(make_campaign, write_plan, write_generator, plan, tracer=FakeTracer(fail=True))
    result = session.run()
    assert result["summary"]["stoppedBy"] == "completed" and result["stage1"]["tracedEntries"] == 0
    assert any(m == "log" and "gdb exploded" in p["message"] for m, p in events)


def test_short_batch_plan_warns(make_campaign, write_plan, write_generator):
    session, events, _ = _session(make_campaign, write_plan, write_generator, {"parameter_space": PAYLOAD_SPACE}, runtime={"stage1MinConcreteParams": 5, "maxIters": 1})
    session.run()
    assert any(m == "log" and p["level"] == "warn" for m, p in events)


@pytest.mark.parametrize("plan", [
    {"next_batch_plan": []},
    {"parameter_space": {"x": {"type": "int_range", "min": 0, "max": 1}}, "next_batch_plan": [{"plan_description": "d", "x": 5}]},
    {"parameter_space": {}, "next_batch_plan": [{"plan_description": "d", "undeclared": 1}]},
    {"parameter_space": {}, "surprise": 1},
    {"parameter_space": {}, "breakpoints": [{"location": "nofile"}]},
])
def test_invalid_plans(write_plan, plan):
    with pytest.raises(EngineError) as info:
        load_plan(write_plan(plan))
    assert info.value.code == PLAN_INVALID
    assert_error_shape(info.value)


def test_unparseable_and_missing_plan(tmp_path):
    bad = tmp_path / "p.json"
    bad.write_text("{")
    for path in (bad, tmp_path / "missing.json"):
        with pytest.raises(EngineError) as info:
            load_plan(path)
        assert info.value.code == PLAN_INVALID
