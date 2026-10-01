"""Parameter space validation and sampling (ported from test_parameter_sampling & friends)."""

from __future__ import annotations

import random

import pytest
from conftest import assert_error_shape

from pbfuzz_engine.errors import PLAN_INVALID, EngineError
from pbfuzz_engine.params import (
    HEURISTIC_CAP, INT64_MAX, INT64_MIN, heuristic_probability, merge_parameter_spaces,
    sample_from_space, validate_batch_entry, validate_space, value_in_domain,
)

SPACE = {
    "len": {"type": "int_range", "min": 0, "max": 100},
    "ratio": {"type": "float_range", "min": -1.5, "max": 2.5},
    "fmt": {"type": "categorical", "values": ["xml", "bin", "", "A" * 256]},
    "flag": {"type": "bool"},
    "base": {"type": "base_seed", "seed_file_path": "/seeds/a.png"},
    "chunks": {"type": "segments", "count_range": {"min": 1, "max": 4},
               "segment_params": {"kind": {"type": "categorical", "values": ["IHDR", "IDAT"]}, "size": {"type": "int_range", "min": 0, "max": 16}}},
}


def test_every_variant_samples_inside_its_domain():
    validate_space(SPACE)
    for seed in range(1, 400):
        params = sample_from_space(SPACE, seed)
        assert params["seed"] == seed
        for name, spec in SPACE.items():
            assert value_in_domain(spec, params[name]), (name, params[name])


def test_sampling_is_deterministic_and_ignores_global_random():
    random.seed(1)
    a = sample_from_space(SPACE, 42)
    random.seed(999)
    b = sample_from_space(SPACE, 42)
    assert a == b
    assert sample_from_space(SPACE, 43) != a


def test_space_can_override_seed_parameter():
    params = sample_from_space({"seed": {"type": "int_range", "min": 5, "max": 5}}, 77)
    assert params["seed"] == 5


def test_segments_and_base_seed_are_sampled_not_passed_through():
    params = sample_from_space(SPACE, 3)
    assert isinstance(params["chunks"], list) and 1 <= len(params["chunks"]) <= 4
    assert all(set(seg) == {"kind", "size"} for seg in params["chunks"])
    assert params["base"] == "/seeds/a.png"


def test_heuristic_probability_is_capped():
    assert heuristic_probability(0) == 0.0
    assert heuristic_probability(10) == pytest.approx(0.1)
    assert heuristic_probability(10_000) == HEURISTIC_CAP


def test_extreme_int_ranges_hit_boundaries():
    space = {"x": {"type": "int_range", "min": INT64_MIN, "max": INT64_MAX}}
    seen = {sample_from_space(space, s)["x"] for s in range(1, 300)}
    assert INT64_MIN in seen or INT64_MAX in seen
    assert all(INT64_MIN <= v <= INT64_MAX for v in seen)


def test_degenerate_ranges():
    assert sample_from_space({"x": {"type": "int_range", "min": 7, "max": 7}}, 9)["x"] == 7
    assert sample_from_space({"x": {"type": "float_range", "min": 0.5, "max": 0.5}}, 9)["x"] == 0.5
    assert sample_from_space({}, 3) == {"seed": 3}


def test_categorical_heuristic_never_invents_values():
    spec = {"type": "categorical", "values": ["a", "bb", 1, 2.5, None, True]}
    for s in range(1, 300):
        assert sample_from_space({"c": spec}, s)["c"] in spec["values"]


@pytest.mark.parametrize("spec", [
    {"type": "nope"},
    {"type": "int_range", "min": 5, "max": 1},
    {"type": "int_range", "min": 0.5, "max": 1},
    {"type": "int_range", "min": 0},
    {"type": "int_range", "min": 0, "max": 1, "step": 2},
    {"type": "float_range", "min": 0, "max": float("inf")},
    {"type": "categorical", "values": []},
    {"type": "segments", "count_range": {"min": 3, "max": 1}, "segment_params": {}},
    {"type": "segments", "count_range": {"min": 0, "max": 1}, "segment_params": {"x": {"type": "bad"}}},
    {"type": "base_seed", "seed_file_path": ""},
    "not-a-dict",
])
def test_invalid_specs_are_rejected_with_remedies(spec):
    with pytest.raises(EngineError) as info:
        validate_space({"p": spec})
    assert info.value.code == PLAN_INVALID
    assert_error_shape(info.value)


def test_batch_entry_validation():
    space = {"len": {"type": "int_range", "min": 0, "max": 10}}
    assert validate_batch_entry(0, {"plan_description": "d", "len": 3, "seed": 9}, space) == {"len": 3, "seed": 9}
    for bad in ({"len": 3}, {"plan_description": "d", "len": 11}, {"plan_description": "d", "other": 1}, [1]):
        with pytest.raises(EngineError) as info:
            validate_batch_entry(0, bad, space)
        assert info.value.code == PLAN_INVALID
        assert_error_shape(info.value)


def test_bool_is_not_an_int_for_int_range():
    assert not value_in_domain({"type": "int_range", "min": 0, "max": 1}, True)
    assert value_in_domain({"type": "bool"}, False)


def test_merge_parameter_spaces():
    merged = merge_parameter_spaces([
        {"w": {"type": "int_range", "min": 1, "max": 10}, "f": {"type": "categorical", "values": ["a"]}, "b": {"type": "bool"}, "x": {"type": "int_range", "min": 0, "max": 1}},
        {"w": {"type": "int_range", "min": -5, "max": 3}, "f": {"type": "categorical", "values": ["b", "a"]}, "b": {"type": "int_range", "min": 0, "max": 3}, "x": {"type": "float_range", "min": 0.5, "max": 2.0}},
        {"junk": "not-a-spec"},
    ])
    assert merged["w"] == {"type": "int_range", "min": -5, "max": 10}
    assert merged["f"]["values"] == ["a", "b"]
    assert merged["b"]["type"] == "int_range"
    assert merged["x"] == {"type": "categorical", "values": [0, 1, 0.5, 2.0]}
    assert "junk" not in merged
    validate_space(merged)
