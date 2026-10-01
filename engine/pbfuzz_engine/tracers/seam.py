"""RPC dispatch seam for ``trace.run``.

W2's JSON-RPC server calls these with the request's ``params`` dict and sends
back the returned dict as ``result``. On :class:`TracerError` the server renders
``err.to_rpc_error_data()`` as ``error.data`` (diagnosis + remedies).

Params accepted beyond ``TraceRunParams`` (all optional): ``campaign`` (an
already-parsed campaign dict, preferred over re-reading ``campaignPath``),
``gdbPath`` / ``lldbPath`` / ``pythonPath`` / ``jdbPath`` (from settings).

:module: pbfuzz_engine.tracers.seam
"""

from __future__ import annotations

from typing import Any, Callable, Mapping

from .base import Breakpoint, Remedy, TraceResult, Tracer, TracerError, load_campaign
from .selection import TracerPaths, make_tracer, select_tracer

__all__ = ["resolve_campaign", "judge", "trace_run", "trace_run_result"]

DEFAULT_TIMEOUT_SEC = 10.0


def resolve_campaign(params: Mapping[str, Any]) -> dict[str, Any]:
    """The campaign for this request: inline ``campaign`` or ``campaignPath``."""
    inline = params.get("campaign")
    if isinstance(inline, Mapping):
        return dict(inline)
    path = params.get("campaignPath")
    if not path:
        raise TracerError(
            "The request has neither `campaign` nor `campaignPath`.",
            [Remedy(id="pass_campaign", label="Pass campaignPath", effect="manual")],
        )
    return load_campaign(str(path))


def judge(campaign: Mapping[str, Any], result: TraceResult) -> None:
    """Set ``reached``/``triggered`` using the engine's stderr oracle."""
    oracle = campaign.get("oracle") or {}
    reached_pattern = oracle.get("reached_pattern")
    triggered_pattern = oracle.get("triggered_pattern")
    if not reached_pattern or not triggered_pattern:
        return
    try:
        from ..oracle import StderrOracle
    except ImportError:  # engine core not installed alongside; stay honest
        return
    verdict = StderrOracle(reached_pattern, triggered_pattern).judge(
        result.stderr, timed_out=result.timed_out
    )
    result.reached = verdict.reached
    result.triggered = verdict.triggered


def trace_run_result(
    params: Mapping[str, Any],
    factory: Callable[[str, TracerPaths], Tracer] = make_tracer,
) -> tuple[dict[str, Any], TraceResult]:
    """Run ``trace.run`` and return both the campaign and the full result."""
    campaign = resolve_campaign(params)
    input_path = params.get("input")
    if not input_path:
        raise TracerError(
            "`input` (path to the input file) is required.",
            [Remedy(id="pass_input", label="Pass the input file path", effect="manual")],
        )
    breakpoints = [Breakpoint.from_obj(b) for b in (params.get("breakpoints") or [])]
    selection = select_tracer(
        campaign, params.get("tracer"), TracerPaths.from_params(params), factory
    )
    timeout = float(params.get("timeoutSec") or DEFAULT_TIMEOUT_SEC)
    result = selection.tracer.run(campaign, str(input_path), breakpoints, timeout_sec=timeout)
    judge(campaign, result)
    return campaign, result


def trace_run(
    params: Mapping[str, Any],
    factory: Callable[[str, TracerPaths], Tracer] = make_tracer,
) -> dict[str, Any]:
    """``trace.run`` → ``TraceRunResult``."""
    _, result = trace_run_result(params, factory)
    return result.to_rpc()
