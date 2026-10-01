"""The W2/W3 seam: breakpoint tracing and deviation detection.

`trace.run` and `deviation.run` are declared in
contracts/engine-rpc.schema.json but implemented by workstream W3, which owns
`pbfuzz_engine/tracers/` and `pbfuzz_engine/deviation/`. The RPC server forwards those methods
through `call_w3`, which answers `NOT_IMPLEMENTED` with remedies (never a bare "method not
found") when W3's module is absent from the build.

W3 entry points used (each takes the request `params` dict and returns the `result` dict):

* `pbfuzz_engine.tracers.trace_run` — `trace.run`
* `pbfuzz_engine.deviation.deviation_run` — `deviation.run`
* `pbfuzz_engine.tracers.select_tracer(campaign_dict, override, paths)` — backend choice for
  stage-1 tracing and corpus routes (`load_tracer`)

W3 raises `tracers.base.TracerError` (diagnosis + remedies) when a request cannot be served;
it is converted to an `EngineError` here so the RPC error shape stays uniform.
"""

from __future__ import annotations

import importlib
from typing import Any, Callable, Mapping, Sequence

from .errors import TRACER_FAILED, EngineError, not_implemented_by_w3, remedy


def _import(name: str) -> Any | None:
    try:
        return importlib.import_module(name)
    except ImportError:
        return None


def convert_tracer_error(exc: BaseException) -> EngineError:
    """Map W3's `TracerError` (diagnosis + remedies) onto an `EngineError`."""
    diagnosis = getattr(exc, "diagnosis", None) or str(exc)
    remedies = [r.to_dict() if hasattr(r, "to_dict") else dict(r) for r in (getattr(exc, "remedies", None) or [])]
    if not remedies:
        remedies = [remedy("disable_tracing", "Turn tracing off for this campaign", effect="disable_tool")]
    first = diagnosis.splitlines()[0] if diagnosis else str(exc)
    return EngineError(TRACER_FAILED, f"tracer failed: {first}", diagnosis=diagnosis, remedies=remedies)


def is_tracer_error(exc: BaseException) -> bool:
    """True for W3's `TracerError` (duck-typed on diagnosis+remedies if the module moved)."""
    base = _import("pbfuzz_engine.tracers.base")
    cls = getattr(base, "TracerError", None) if base else None
    if cls is not None and isinstance(exc, cls):
        return True
    return hasattr(exc, "diagnosis") and hasattr(exc, "remedies") and not isinstance(exc, EngineError)


_DEBUGGER_PATH_KEYS = ("gdbPath", "lldbPath", "pythonPath", "jdbPath")


def flatten_debugger_paths(params: dict[str, Any]) -> dict[str, Any]:
    """Unpack the contract's `debuggerPaths` object into the flat keys W3's seam reads.

    `TraceRunParams`/`DeviationRunParams` carry `debuggerPaths: {gdbPath?, lldbPath?,
    pythonPath?, jdbPath?}`; W3's `trace_run`/`deviation_run` read
    `params["gdbPath"]` etc. An explicit top-level key wins over the nested one.
    """
    nested = params.get("debuggerPaths")
    if not isinstance(nested, dict):
        return params
    out = {k: v for k, v in params.items() if k != "debuggerPaths"}
    for key in _DEBUGGER_PATH_KEYS:
        if nested.get(key) and not out.get(key):
            out[key] = nested[key]
    return out


def call_w3(module: str, function: str, method: str, params: dict[str, Any]) -> Any:
    """Forward an RPC method to W3's implementation, or raise the documented stub error."""
    mod = _import(f"pbfuzz_engine.{module}")
    fn: Callable[[dict[str, Any]], Any] | None = getattr(mod, function, None) if mod else None
    if fn is None:
        raise not_implemented_by_w3(method, module)
    try:
        return fn(flatten_debugger_paths(params))
    except EngineError:
        raise
    except Exception as exc:
        if is_tracer_error(exc):
            raise convert_tracer_error(exc) from exc
        raise


class TracerAdapter:
    """Wraps a W3 `Tracer` so engine code can pass contract-shaped breakpoint dicts."""

    def __init__(self, tracer: Any, reason: str) -> None:
        self.tracer = tracer
        self.reason = reason

    def run(self, campaign: Mapping[str, Any], input_path: str, breakpoints: Sequence[Any], timeout_sec: float | None = None) -> Any:
        base = _import("pbfuzz_engine.tracers.base")
        bp_cls = getattr(base, "Breakpoint", None) if base else None
        bps = [bp_cls.from_obj(b) for b in breakpoints] if bp_cls else list(breakpoints)
        return self.tracer.run(campaign, input_path, bps, timeout_sec)


def load_tracer(campaign: Any, *, paths: Mapping[str, Any] | None = None) -> tuple[TracerAdapter | None, str]:
    """Pick and probe the campaign's tracer. Returns `(adapter, reason)`; adapter is None when
    tracing is off or unavailable, and `reason` is the evidence either way (surfaced to the
    agent as a `log` notification, so a run without observations is never silently degraded).
    """
    pkg = _import("pbfuzz_engine.tracers")
    select = getattr(pkg, "select_tracer", None) if pkg else None
    if select is None:
        return None, "breakpoint tracing is not installed in this engine build (pbfuzz_engine.tracers)"
    try:
        path_cls = getattr(pkg, "TracerPaths", None)
        tracer_paths = path_cls.from_params(paths or {}) if path_cls and hasattr(path_cls, "from_params") else None
        selection = select(campaign.raw, None, tracer_paths) if tracer_paths is not None else select(campaign.raw)
        ok, evidence = selection.tracer.available()
    except Exception as exc:  # noqa: BLE001 - tracing is optional; degrade with the reason
        reason = getattr(exc, "diagnosis", None) or str(exc)
        return None, f"tracing unavailable: {reason}"
    if not ok:
        return None, f"tracer unavailable ({selection.reason}): {evidence}"
    return TracerAdapter(selection.tracer, selection.reason), f"tracer {selection.reason}: {evidence}"
