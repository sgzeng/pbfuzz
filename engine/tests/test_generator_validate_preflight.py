"""Task-3 preflight: `generator.validate` running the real target once per `next_batch_plan`
entry when a `campaignPath` is given, so a plan whose breakpoint/entry address never actually
reaches the bug is caught here instead of after a whole `fuzz.run` iteration budget is spent
re-discovering the same thing.

Calls `EngineService.generator_validate` directly (in-process) rather than through the
subprocess sidecar `test_rpc.py` uses — the RPC framing itself is untouched by this change, so
exercising the handler function is the more direct test of the new behaviour.
"""

from __future__ import annotations

from pbfuzz_engine.rpc import RequestContext
from pbfuzz_engine.server import EngineService

PAYLOAD_SPACE = {"n": {"type": "int_range", "min": 0, "max": 5}}


def _ctx() -> RequestContext:
    return RequestContext(id=1, method="generator.validate", notify=lambda *a, **k: None, server=None)  # type: ignore[arg-type]


def _batch_plan_path(write_plan, entries):
    return write_plan({"parameter_space": PAYLOAD_SPACE, "next_batch_plan": entries})


def test_preflight_reports_reach_for_a_correct_plan(make_campaign, write_plan, write_generator):
    gen = write_generator("def generate(**p):\n    return b'R'\n")
    plan_path = _batch_plan_path(write_plan, [{"plan_description": "hits", "n": 1}])
    result = EngineService().generator_validate(
        {"generatorPath": str(gen), "planPath": str(plan_path), "campaignPath": str(make_campaign()), "samples": 0},
        _ctx(),
    )
    assert result["ok"] is True
    entry = result["samples"][0]
    assert entry["reach"]["ranTarget"] is True
    assert entry["reach"]["reached"] is True
    assert entry["reach"]["triggered"] is False


def test_preflight_catches_a_plan_that_never_reaches(make_campaign, write_plan, write_generator):
    """The incident this guards against: a generator/plan that produces well-formed input and a
    generator.validate `ok: true` today, but the real target never actually reaches the bug
    location — previously only discoverable after burning the whole fuzz.run budget."""
    gen = write_generator("def generate(**p):\n    return b'nothing interesting here'\n")
    plan_path = _batch_plan_path(write_plan, [{"plan_description": "miss1", "n": 1}, {"plan_description": "miss2", "n": 2}])
    result = EngineService().generator_validate(
        {"generatorPath": str(gen), "planPath": str(plan_path), "campaignPath": str(make_campaign()), "samples": 0},
        _ctx(),
    )
    assert result["ok"] is False, "a batch plan where NO entry reaches the target must fail validation"
    for entry in result["samples"]:
        assert entry.get("error") is None, "the generator itself succeeded; only the real run failed to reach"
        assert entry["reach"]["ranTarget"] is True
        assert entry["reach"]["reached"] is False


def test_preflight_is_skipped_without_a_campaign_path(write_plan, write_generator):
    """Backward compatibility: no `campaignPath` means no reach check at all -- `ok` reflects
    only the generator's own success, exactly as before this preflight existed."""
    gen = write_generator("def generate(**p):\n    return b'nothing interesting here'\n")
    plan_path = _batch_plan_path(write_plan, [{"plan_description": "miss", "n": 1}])
    result = EngineService().generator_validate({"generatorPath": str(gen), "planPath": str(plan_path), "samples": 0}, _ctx())
    assert result["ok"] is True
    assert "reach" not in result["samples"][0]


def test_preflight_reports_target_failed_cleanly_without_crashing_the_rpc(make_campaign, write_plan, write_generator):
    gen = write_generator("def generate(**p):\n    return b'R'\n")
    plan_path = _batch_plan_path(write_plan, [{"plan_description": "x", "n": 1}])
    campaign_path = make_campaign(entry={"run_cmd": "/no/such/binary-xyz @@"})
    result = EngineService().generator_validate(
        {"generatorPath": str(gen), "planPath": str(plan_path), "campaignPath": str(campaign_path), "samples": 0},
        _ctx(),
    )
    assert result["ok"] is False
    reach = result["samples"][0]["reach"]
    assert reach["ranTarget"] is False
    assert "error" in reach and "diagnosis" in reach


def test_preflight_never_runs_the_target_for_plain_samples(make_campaign, write_generator):
    """`sample(seed=...)` draws smoke-test the generator over the space; they are not a specific
    hypothesis, so they must never trigger a real target run even when `campaignPath` is set."""
    gen = write_generator("def generate(**p):\n    return b'nothing interesting here'\n")
    result = EngineService().generator_validate(
        {"generatorPath": str(gen), "parameterSpace": PAYLOAD_SPACE, "campaignPath": str(make_campaign()), "samples": 3},
        _ctx(),
    )
    assert result["ok"] is True
    assert len(result["samples"]) == 3
    for entry in result["samples"]:
        assert "reach" not in entry
