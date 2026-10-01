"""Deviation detection (W3), built on the analysis provider's critical locations.

RPC entry point for W2's dispatcher: :func:`deviation_run` (``deviation.run``).

``deviation.run`` params (the RPC contract fixes only the result shape):

* ``campaignPath`` or ``campaign`` — the campaign;
* ``input`` — input file path (required);
* ``criticalLocations`` — ``ProviderLocation[]`` from the active analysis
  provider's ``criticalLocations()``; absent/empty ⇒ ``mode: target_only``;
* ``extraBreakpoints`` (alias ``extra_bp``) — agent ``Breakpoint[]``;
* ``tracer``, ``timeoutSec``, ``gdbPath`` … — as for ``trace.run``.

:module: pbfuzz_engine.deviation
"""

from __future__ import annotations

from typing import Any, Callable, Mapping

from ..tracers.base import Breakpoint, Tracer, campaign_targets
from ..tracers.selection import TracerPaths, make_tracer
from ..tracers.seam import trace_run_result
from .detector import (
    MAX_CRITICAL_BREAKPOINTS,
    CriticalLocation,
    DeviationReport,
    detect_deviation,
    plan_breakpoints,
)

__all__ = [
    "CriticalLocation",
    "DeviationReport",
    "MAX_CRITICAL_BREAKPOINTS",
    "detect_deviation",
    "deviation_run",
    "plan_breakpoints",
]


def deviation_run(
    params: Mapping[str, Any],
    factory: Callable[[str, TracerPaths], Tracer] = make_tracer,
) -> dict[str, Any]:
    """``deviation.run`` → ``DeviationRunResult``."""
    from ..tracers.seam import resolve_campaign

    campaign = resolve_campaign(params)
    critical = [CriticalLocation.from_obj(c) for c in (params.get("criticalLocations") or [])]
    extra = [Breakpoint.from_obj(b) for b in (params.get("extraBreakpoints") or params.get("extra_bp") or [])]
    targets = campaign_targets(campaign)
    breakpoints, dropped = plan_breakpoints(critical, targets, extra)
    trace_params = dict(params)
    trace_params["campaign"] = campaign
    trace_params["breakpoints"] = [b.to_spec() for b in breakpoints]
    _, result = trace_run_result(trace_params, factory)
    return detect_deviation(result, critical, targets, dropped).to_rpc()
