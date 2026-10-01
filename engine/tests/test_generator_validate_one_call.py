"""`generator.validate` names every problem in ONE call.

Recorded in session ea916c42: three rejections in three separate `pbfuzz_fuzz` calls, each costing
the model a full resubmission of a ~200-line generator (8,490 output tokens between them), because
each check stopped the ones after it from running:

1. a batch value outside its declared domain stopped everything before the engine was called;
2. the engine's own `seed` raised `TypeError` in a generator with explicit keyword parameters,
   once per batch entry, so no entry produced bytes to preflight;
3. only then did the preflight run, and it reported the stderr but not the input size — which was
   the actual bug (56 bytes where the target reads 64).
"""

from __future__ import annotations

from pbfuzz_engine.rpc import RequestContext
from pbfuzz_engine.server import EngineService


def _ctx() -> RequestContext:
    return RequestContext(id=1, method="generator.validate", notify=lambda *a, **k: None, server=None)  # type: ignore[arg-type]


SPACE = {"n": {"type": "categorical", "values": [1, 2, 3]}}


def test_the_recorded_incident_is_one_rejection_that_carries_the_evidence(make_campaign, write_generator):
    # Explicit keywords, no `seed`, no `**kwargs` — exactly the recorded generator's shape.
    gen = write_generator("def generate(n=1):\n    return b'x' * n\n")
    result = EngineService().generator_validate({
        "generatorPath": str(gen),
        # `n: 9` is outside the declared domain: the caller reports that; it must not stop this call.
        "plan": {"parameter_space": SPACE, "next_batch_plan": [
            {"plan_description": "in domain", "n": 2},
            {"plan_description": "out of domain", "n": 9},
        ]},
        "campaignPath": str(make_campaign()),
        "samples": 0,
    }, _ctx())
    assert result["ok"] is False
    first = result["samples"][0]
    # (2) no `seed` TypeError: the engine only passes `seed` to a generator that can take it.
    assert first.get("error") is None
    assert "seed" not in first["params"]
    # (3) the generator ran AND the target ran, in this same call — with the size on the record.
    assert first["size"] == 2
    assert first["reach"]["ranTarget"] is True and first["reach"]["reached"] is False
    assert result["issues"] == []


def test_a_parameter_generate_cannot_take_is_named_and_the_rest_still_runs(make_campaign, write_generator):
    gen = write_generator("def generate(n=1):\n    return b'R'\n")
    result = EngineService().generator_validate({
        "generatorPath": str(gen),
        "plan": {"parameter_space": {**SPACE, "width": {"type": "int_range", "min": 0, "max": 9}},
                 "next_batch_plan": [{"plan_description": "x", "n": 1, "width": 4}]},
        "campaignPath": str(make_campaign()),
        "samples": 0,
    }, _ctx())
    assert result["ok"] is False
    assert result["issues"] == ["`generate` cannot take width, which the plan supplies; add it as keyword parameter(s) or accept `**kwargs`"]
    # ...and the same response still says what happened downstream.
    entry = result["samples"][0]
    assert entry.get("error") is None
    assert entry["reach"]["reached"] is True


def test_a_generator_that_takes_seed_still_gets_it(write_generator):
    gen = write_generator("def generate(n=1, seed=None):\n    assert seed is not None\n    return b'x'\n")
    result = EngineService().generator_validate({
        "generatorPath": str(gen),
        "plan": {"parameter_space": SPACE, "next_batch_plan": [{"plan_description": "x", "n": 1}]},
        "samples": 1,
    }, _ctx())
    assert result["ok"] is True, result
    assert all(s["params"].get("seed") is not None for s in result["samples"])
