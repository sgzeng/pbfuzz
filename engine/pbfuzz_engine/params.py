"""Parameter spaces: validation and sampling.

A parameter space (contracts/common.schema.json `ParameterSpace`) maps each keyword argument of
the generator's `generate(**params) -> bytes` to a `ParameterSpec`. Stage 1 of a fuzz run uses
the concrete assignments in the batch plan; stage 2 draws from the space with
`sample_from_space`.

Sampling is ported from the CCS'26 engine, including its bias toward bug-prone edge values
(boundaries, integer-width extremes, tricky floats and strings). Two deliberate changes:

* The heuristic probability `0.01 * seed` is clamped at `HEURISTIC_CAP`. Unclamped it reached
  1.0 at iteration 100, after which every draw came from the fixed edge-value lists and the
  sampler stopped exploring the interior of the space at all.
* `segments` and `base_seed` are sampled for real. Previously the raw spec dict was handed to
  the generator, leaving it to re-implement sampling itself.
"""

from __future__ import annotations

import math
import random
from typing import Any

from .errors import PLAN_INVALID, EngineError, remedy

HEURISTIC_CAP = 0.5

SPEC_TYPES = ("int_range", "float_range", "categorical", "bool", "segments", "base_seed")

#: Batch-plan keys that are not generator parameters.
RESERVED_BATCH_KEYS = ("plan_description",)

INT32_MIN, INT32_MAX = -(2**31), 2**31 - 1
INT64_MIN, INT64_MAX = -(2**63), 2**63 - 1
UINT32_MAX, UINT64_MAX = 2**32 - 1, 2**64 - 1
HUGE_POS, HUGE_NEG = 1e308, -1e308
TINY_POS, TINY_NEG = 1e-308, -1e-308
MACHINE_EPS = 2.220446049250313e-16

_STRING_EDGES = [
    "", " ", "\t", "\n", "\r", "\x00", "\x01", "null", "NULL", "nil", "undefined",
    "NaN", "nan", "inf", "-inf", "A" * 256, "A" * 1000, "A" * 4096, "A" * 65536,
    "..", "../", "../../../etc/passwd", "%s", "%x", "%n", "%p", "%s%s%s%s%s",
    "\x89PNG\r\n\x1a\n", "II*\x00", "MM\x00*", "<?xml version='1.0'?>", "RIFF", "OggS", "fLaC",
]
_INT_EDGES = [
    INT32_MIN, INT32_MAX, INT64_MIN, INT64_MAX, UINT32_MAX, UINT64_MAX,
    -1, 0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 63, 64, 127, 128, 255, 256, 511, 512,
    1023, 1024, 4095, 4096, 32767, 32768, 65535, 65536, 8000, 44100, 48000,
]
_FLOAT_EDGES = [
    HUGE_POS, HUGE_NEG, TINY_POS, TINY_NEG, MACHINE_EPS, 0.0, -0.0, 1.0, -1.0, 0.5,
    1e-10, 1e10, 1e-100, 1e100,
]


def _plan_error(message: str, diagnosis: str, detail: str) -> EngineError:
    return EngineError(
        PLAN_INVALID, message, diagnosis=diagnosis,
        remedies=[
            remedy("fix_plan", "Fix fuzz_plan.json", detail=detail, effect="manual"),
            remedy("extract", "Derive the space from reaching seeds", detail="params.extract builds a space from what reaching inputs actually contain.", effect="retry"),
        ],
    )


def validate_spec(name: str, spec: Any, *, path: str = "parameter_space") -> None:
    """Validate one `ParameterSpec` against common.schema.json. Raises `EngineError`."""
    where = f"{path}.{name}"
    if not isinstance(spec, dict) or spec.get("type") not in SPEC_TYPES:
        raise _plan_error(
            f"{where} is not a valid ParameterSpec",
            f"`{where}` = {spec!r}; a spec is an object whose `type` is one of {list(SPEC_TYPES)}.",
            f"Give `{where}` a `type` from {list(SPEC_TYPES)} and the fields that type requires.",
        )
    kind = spec["type"]
    allowed = {
        "int_range": {"type", "min", "max"}, "float_range": {"type", "min", "max"},
        "categorical": {"type", "values"}, "bool": {"type"},
        "segments": {"type", "count_range", "segment_params"}, "base_seed": {"type", "seed_file_path"},
    }[kind]
    extra = set(spec) - allowed
    if extra:
        raise _plan_error(
            f"{where} has unknown fields {sorted(extra)}",
            f"A `{kind}` spec allows only {sorted(allowed)}; `{where}` also has {sorted(extra)}.",
            f"Remove {sorted(extra)} from `{where}`.",
        )
    missing = (allowed - {"type"}) - set(spec)
    if missing:
        raise _plan_error(
            f"{where} is missing {sorted(missing)}",
            f"A `{kind}` spec requires {sorted(allowed - {'type'})}.",
            f"Add {sorted(missing)} to `{where}`.",
        )
    if kind == "int_range":
        if not all(isinstance(spec[k], int) and not isinstance(spec[k], bool) for k in ("min", "max")):
            raise _plan_error(f"{where} bounds must be integers", f"`{where}` = {spec!r}.", "Use integer `min`/`max`, or a float_range.")
        if spec["min"] > spec["max"]:
            raise _plan_error(f"{where} has min > max", f"`{where}` = {spec!r}; the range is empty.", "Swap or fix `min`/`max`.")
    elif kind == "float_range":
        if not all(isinstance(spec[k], (int, float)) and not isinstance(spec[k], bool) and math.isfinite(spec[k]) for k in ("min", "max")):
            raise _plan_error(f"{where} bounds must be finite numbers", f"`{where}` = {spec!r}.", "Use finite numeric `min`/`max`.")
        if spec["min"] > spec["max"]:
            raise _plan_error(f"{where} has min > max", f"`{where}` = {spec!r}; the range is empty.", "Swap or fix `min`/`max`.")
    elif kind == "categorical":
        if not isinstance(spec["values"], list) or not spec["values"]:
            raise _plan_error(f"{where}.values must be a non-empty list", f"`{where}` = {spec!r}.", "List at least one value.")
    elif kind == "segments":
        cr = spec["count_range"]
        if not isinstance(cr, dict) or set(cr) != {"min", "max"} or not all(isinstance(cr[k], int) and cr[k] >= 0 for k in ("min", "max")) or cr["min"] > cr["max"]:
            raise _plan_error(f"{where}.count_range is invalid", f"`{where}.count_range` = {cr!r}; it must be {{min, max}} with 0 <= min <= max.", "Fix `count_range`.")
        if not isinstance(spec["segment_params"], dict):
            raise _plan_error(f"{where}.segment_params must be an object", f"`{where}.segment_params` = {spec['segment_params']!r}.", "Make it a mapping of name to ParameterSpec.")
        for sub_name, sub in spec["segment_params"].items():
            validate_spec(sub_name, sub, path=f"{where}.segment_params")
    elif kind == "base_seed":
        if not isinstance(spec["seed_file_path"], str) or not spec["seed_file_path"]:
            raise _plan_error(f"{where}.seed_file_path must be a path", f"`{where}` = {spec!r}.", "Point `seed_file_path` at a reaching seed.")


def validate_space(space: Any) -> dict[str, Any]:
    """Validate a whole `ParameterSpace`; returns it unchanged."""
    if not isinstance(space, dict):
        raise _plan_error("parameter_space must be an object", f"Got {type(space).__name__}.", "Make `parameter_space` a mapping of name to ParameterSpec.")
    for name, spec in space.items():
        validate_spec(name, spec)
    return space


def value_in_domain(spec: dict[str, Any], value: Any) -> bool:
    """Whether a concrete batch-plan value lies inside a spec's domain."""
    kind = spec["type"]
    if kind == "int_range":
        return isinstance(value, int) and not isinstance(value, bool) and spec["min"] <= value <= spec["max"]
    if kind == "float_range":
        return isinstance(value, (int, float)) and not isinstance(value, bool) and spec["min"] <= value <= spec["max"]
    if kind == "categorical":
        return value in spec["values"]
    if kind == "bool":
        return isinstance(value, bool)
    if kind == "base_seed":
        return isinstance(value, str)
    if kind == "segments":
        if not isinstance(value, list):
            return False
        cr = spec["count_range"]
        if not cr["min"] <= len(value) <= cr["max"]:
            return False
        return all(
            isinstance(seg, dict) and all(k in spec["segment_params"] and value_in_domain(spec["segment_params"][k], v) for k, v in seg.items())
            for seg in value
        )
    return False


def validate_batch_entry(index: int, entry: Any, space: dict[str, Any]) -> dict[str, Any]:
    """Validate one `BatchPlanEntry` and return the generator kwargs it pins.

    Every key other than `plan_description` must be a parameter of the space with a value in
    its domain (state/blocks.schema.json `BatchPlanEntry`). `seed` is additionally accepted
    because the engine injects it into every call.
    """
    where = f"next_batch_plan[{index}]"
    if not isinstance(entry, dict):
        raise _plan_error(f"{where} must be an object", f"Got {type(entry).__name__}.", "Each batch entry is an object of parameter values.")
    if not isinstance(entry.get("plan_description"), str):
        raise _plan_error(f"{where}.plan_description is required", "Each concrete case must say which hypothesis it tests.", f"Add `plan_description` to `{where}`.")
    params: dict[str, Any] = {}
    for key, value in entry.items():
        if key in RESERVED_BATCH_KEYS:
            continue
        if key == "seed" and key not in space:
            params[key] = value
            continue
        if key not in space:
            raise _plan_error(
                f"{where}.{key} is not in the parameter space",
                f"`{key}` is pinned in `{where}` but `parameter_space` declares only {sorted(space)}. The generator would receive an argument the sampler never produces.",
                f"Add `{key}` to `parameter_space`, or drop it from `{where}`.",
            )
        if not value_in_domain(space[key], value):
            raise _plan_error(
                f"{where}.{key} = {value!r} is outside its domain",
                f"`{key}` is declared as {space[key]!r}, and {value!r} is not in that domain.",
                f"Widen `parameter_space.{key}` or change the value in `{where}`.",
            )
        params[key] = value
    return params


def _pick_int(rng: random.Random, spec: dict[str, Any], hprob: float) -> int:
    lo, hi = int(spec["min"]), int(spec["max"])
    if rng.random() < hprob:
        edges = [c for c in [lo, hi, lo + 1, hi - 1, *_INT_EDGES] if lo <= c <= hi]
        if edges:
            return rng.choice(edges)
    return rng.randint(lo, hi)


def _pick_float(rng: random.Random, spec: dict[str, Any], hprob: float) -> float:
    lo, hi = float(spec["min"]), float(spec["max"])
    if rng.random() < hprob:
        span = hi - lo
        near = [lo + max(span * 1e-12, MACHINE_EPS), hi - max(span * 1e-12, MACHINE_EPS)] if span > 0 else []
        edges = [c for c in [lo, hi, *near, *_FLOAT_EDGES] if lo <= c <= hi]
        if edges:
            return rng.choice(edges)
    return rng.uniform(lo, hi)


def _pick_categorical(rng: random.Random, spec: dict[str, Any], hprob: float) -> Any:
    values = spec["values"]
    if rng.random() < hprob:
        # Only ever edge values that are themselves among the declared values: a categorical
        # domain is closed, so the heuristic may reorder preference but never add values.
        edges: list[Any] = [v for v in values if (isinstance(v, str) and v in _STRING_EDGES) or (isinstance(v, (int, float)) and not isinstance(v, bool) and v in _INT_EDGES + _FLOAT_EDGES)]
        strs = [v for v in values if isinstance(v, str)]
        if strs:
            edges += [min(strs, key=len), max(strs, key=len)]
        nums = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]
        if nums:
            edges += [min(nums), max(nums)]
        if edges:
            return rng.choice(edges)
    return rng.choice(values)


def _pick(rng: random.Random, spec: dict[str, Any], hprob: float) -> Any:
    kind = spec["type"]
    if kind == "int_range":
        return _pick_int(rng, spec, hprob)
    if kind == "float_range":
        return _pick_float(rng, spec, hprob)
    if kind == "categorical":
        return _pick_categorical(rng, spec, hprob)
    if kind == "bool":
        return rng.choice([True, False])
    if kind == "base_seed":
        # The path, not the bytes: the generator opens the template itself, and the iteration
        # record stays small and readable.
        return spec["seed_file_path"]
    if kind == "segments":
        cr = spec["count_range"]
        lo, hi = cr["min"], cr["max"]
        count = rng.choice([lo, hi]) if rng.random() < hprob else rng.randint(lo, hi)
        return [{k: _pick(rng, sub, hprob) for k, sub in spec["segment_params"].items()} for _ in range(count)]
    raise ValueError(f"unknown ParameterSpec type {kind!r}")


def heuristic_probability(seed: int) -> float:
    """Probability of drawing an edge value at iteration `seed` (see module docstring)."""
    return min(HEURISTIC_CAP, max(0.0, 0.01 * seed))


def sample_from_space(space: dict[str, Any], seed: int) -> dict[str, Any]:
    """Draw one concrete assignment from a validated parameter space.

    Deterministic in `seed`, and independent of global `random` state. The seed is also passed
    to the generator as `seed` unless the space defines a parameter of that name.
    """
    rng = random.Random(seed)
    hprob = heuristic_probability(seed)
    params: dict[str, Any] = {"seed": seed}
    for name, spec in space.items():
        params[name] = _pick(rng, spec, hprob)
    return params


def _representative(spec: dict[str, Any]) -> list[Any]:
    kind = spec.get("type")
    if kind in ("int_range", "float_range"):
        return [spec.get("min"), spec.get("max")]
    if kind == "categorical":
        return list(spec.get("values", []))
    if kind == "bool":
        return [True, False]
    if kind == "base_seed":
        return [spec.get("seed_file_path")]
    return []


def merge_parameter_spaces(spaces: list[dict[str, Any]]) -> dict[str, Any]:
    """Merge the per-seed spaces an extractor produced into one space (ported from the corpus server).

    Same-typed ranges are widened, categoricals unioned; a bool meeting an int_range/categorical
    yields the latter; any other type clash becomes a categorical of representative values.
    """
    merged: dict[str, Any] = {}
    for space in spaces:
        if not isinstance(space, dict):
            continue
        for name, spec in space.items():
            if not isinstance(spec, dict) or "type" not in spec:
                continue
            if name not in merged:
                merged[name] = dict(spec)
                continue
            cur = merged[name]
            if cur["type"] == spec["type"]:
                if spec["type"] in ("int_range", "float_range"):
                    cur["min"] = min(cur["min"], spec["min"])
                    cur["max"] = max(cur["max"], spec["max"])
                elif spec["type"] == "categorical":
                    for v in spec.get("values", []):
                        if v not in cur["values"]:
                            cur["values"].append(v)
            elif cur["type"] == "bool" and spec["type"] in ("int_range", "categorical"):
                merged[name] = dict(spec)
            elif spec["type"] == "bool" and cur["type"] in ("int_range", "categorical"):
                pass
            else:
                values: list[Any] = []
                for v in _representative(cur) + _representative(spec):
                    if v not in values:
                        values.append(v)
                merged[name] = {"type": "categorical", "values": values or [None]}
    return merged
