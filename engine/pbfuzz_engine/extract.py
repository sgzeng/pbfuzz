"""Parameter extraction (`params.extract`).

The agent writes an extractor `extract_parameters(file_path) -> dict` that reads one reaching
input and describes it as a `ParameterSpace` (e.g. the width/height a PNG actually carries). The
engine runs it on every given input — in the sandbox, since it is model-written code — merges
the per-input spaces, and validates the merged space against common.schema.json.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from .errors import PLAN_INVALID, EngineError, remedy
from .params import merge_parameter_spaces, validate_space
from .sandbox import SandboxError, SandboxLimits, call_extractor_many


def extract_parameters(
    inputs: list[str | Path],
    *,
    extractor_path: str | Path | None = None,
    extractor_code: str | None = None,
    limits: SandboxLimits = SandboxLimits(timeout_sec=5.0),
) -> dict[str, Any]:
    """Run an extractor over `inputs` and return the merged, validated parameter space.

    Returns:
        `{"parameter_space": {...}, "extracted": n, "failed": [{"input", "error"}]}`.
    """
    if not inputs:
        raise EngineError(
            PLAN_INVALID, "params.extract needs at least one input",
            diagnosis="No inputs were given and none were found; extraction needs reaching seeds to read.",
            remedies=[
                remedy("run_corpus", "Run corpus.analyze first", detail="Its route exemplars are the inputs to extract from.", effect="retry"),
                remedy("pass_inputs", "Pass `inputs` explicitly", effect="manual"),
            ],
        )
    if (extractor_path is None) == (extractor_code is None):
        raise EngineError(
            PLAN_INVALID, "give exactly one of extractorPath / extractorCode",
            diagnosis="params.extract runs one extractor; both or neither were supplied.",
            remedies=[remedy("fix_params", "Pass extractorPath or extractorCode", effect="manual")],
        )
    with tempfile.TemporaryDirectory(prefix="pbfuzz-extract-") as tmp:
        if extractor_code is not None:
            extractor_path = Path(tmp) / "extractor.py"
            extractor_path.write_text(extractor_code, encoding="utf-8")
        spaces: list[dict[str, Any]] = []
        failed: list[dict[str, str]] = []
        resolved_paths = [str(Path(item).resolve()) for item in inputs]
        # One long-lived worker for the whole seed corpus (`call_extractor_many`) instead of a
        # fresh interpreter per seed — the same fix as the fuzz loop's generate() calls, for the
        # identical one-child-per-call pattern this loop used to have.
        outcomes = call_extractor_many(extractor_path, resolved_paths, limits)
        for path, outcome in zip(resolved_paths, outcomes):
            if isinstance(outcome, SandboxError):
                failed.append({"input": path, "error": outcome.message})
                continue
            if not isinstance(outcome, dict):
                failed.append({"input": path, "error": f"extract_parameters returned {type(outcome).__name__}, not a dict"})
                continue
            spaces.append(outcome)

    if not spaces:
        first = failed[0]["error"] if failed else "no output"
        raise EngineError(
            PLAN_INVALID, "the extractor produced no parameter space",
            diagnosis=f"All {len(failed)} inputs failed. First failure: {first}",
            remedies=[
                remedy("fix_extractor", "Fix extract_parameters", detail="It must take a file path and return a ParameterSpace dict.", effect="manual"),
            ],
        )
    merged = merge_parameter_spaces(spaces)
    validate_space(merged)
    return {"parameter_space": merged, "extracted": len(spaces), "failed": failed}
