"""Deviation detection: where did this run leave the path toward the target?

Critical locations come from the analysis provider
(``contracts/analysis-provider.ts`` ``criticalLocations()``): branch targets
from which the bug target is no longer reachable. Hitting one means the run
left the path, so the **first critical location hit, in execution order**, is
the deviation point.

Two modes, per ``DeviationRunResult.mode``:

* ``critical_bb`` — critical locations were supplied; report the first one hit.
* ``target_only`` — no static provider; report how far the run got (the last
  breakpoint observed). No ``deviationPoint`` is ever reported in this mode.

Never fabricated: if nothing critical was hit, ``deviationPoint`` is absent and
the explanation says why (including unbound breakpoints, which make the
observation incomplete rather than negative).

:module: pbfuzz_engine.deviation.detector
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

from ..tracers.base import Breakpoint, TraceResult

__all__ = [
    "CriticalLocation",
    "DeviationReport",
    "plan_breakpoints",
    "detect_deviation",
    "MAX_CRITICAL_BREAKPOINTS",
]

#: More breakpoints than this slows gdb noticeably for little extra signal.
MAX_CRITICAL_BREAKPOINTS = 50


@dataclass(frozen=True)
class CriticalLocation:
    """A provider ``ProviderLocation``."""

    location: str
    function: str | None = None
    distance: float | None = None

    @classmethod
    def from_obj(cls, obj: Mapping[str, Any] | "CriticalLocation") -> "CriticalLocation":
        if isinstance(obj, CriticalLocation):
            return obj
        distance = obj.get("distance")
        return cls(
            location=str(obj["location"]),
            function=obj.get("function") or None,
            distance=float(distance) if isinstance(distance, (int, float)) else None,
        )


@dataclass
class DeviationReport:
    """``DeviationRunResult`` plus the planning note."""

    mode: str
    deviation_point: str | None = None
    function: str | None = None
    last_reached_location: str | None = None
    distance_remaining: float | None = None
    callstack: str | None = None
    explanation: str = ""

    def to_rpc(self) -> dict[str, Any]:
        out: dict[str, Any] = {"mode": self.mode, "explanation": self.explanation}
        if self.deviation_point:
            out["deviationPoint"] = self.deviation_point
        if self.function:
            out["function"] = self.function
        if self.last_reached_location:
            out["lastReachedLocation"] = self.last_reached_location
        if self.distance_remaining is not None:
            out["distanceRemaining"] = self.distance_remaining
        if self.callstack:
            out["callstack"] = self.callstack
        return out


def plan_breakpoints(
    critical: Sequence[CriticalLocation],
    targets: Sequence[str],
    extra: Iterable[Breakpoint] = (),
    limit: int = MAX_CRITICAL_BREAKPOINTS,
) -> tuple[list[Breakpoint], int]:
    """Breakpoints for one deviation run, and how many critical ones were dropped.

    Every breakpoint prints its call stack (that is what the agent reasons over).
    Critical locations are only needed once each: the first hit is the answer.
    """
    seen: set[str] = set()
    out: list[Breakpoint] = []
    for location in targets:
        if location not in seen:
            seen.add(location)
            out.append(Breakpoint(location=location, hit_limit=1, print_call_stack=True))
    for bp in extra:
        if bp.location not in seen:
            seen.add(bp.location)
            out.append(Breakpoint(bp.location, bp.hit_limit, bp.inline_expr, True))
    kept = 0
    dropped = 0
    for loc in critical:
        if loc.location in seen:
            continue
        if kept >= limit:
            dropped += 1
            continue
        seen.add(loc.location)
        out.append(Breakpoint(location=loc.location, hit_limit=1, print_call_stack=True))
        kept += 1
    return out, dropped


def detect_deviation(
    result: TraceResult,
    critical: Sequence[CriticalLocation],
    targets: Sequence[str],
    dropped_critical: int = 0,
) -> DeviationReport:
    """Compute the deviation from one traced run. Pure."""
    mode = "critical_bb" if critical else "target_only"
    by_location = {b.location: b for b in result.breakpoints}
    critical_by_location = {c.location: c for c in critical}
    ordered = result.hits_in_order()

    target_hit = next((b for t in targets if (b := by_location.get(t)) and b.hit_times > 0), None)
    if result.reached or target_hit is not None:
        how = "the oracle's reached pattern matched" if result.reached else "the target breakpoint was hit"
        return DeviationReport(
            mode=mode,
            last_reached_location=target_hit.location if target_hit else (targets[0] if targets else None),
            function=target_hit.function if target_hit else None,
            distance_remaining=0,
            explanation=f"Reached the target ({how}); no deviation.",
        )

    tail: list[str] = []
    if result.timed_out:
        tail.append("The run timed out, so the observation may be incomplete.")
    if result.signal:
        tail.append(f"The run stopped on {result.signal}.")

    if mode == "critical_bb":
        unresolved = [c.location for c in critical
                      if (b := by_location.get(c.location)) is not None and b.resolved is False]
        if dropped_critical:
            tail.append(f"{dropped_critical} critical location(s) beyond the first "
                        f"{MAX_CRITICAL_BREAKPOINTS} were not traced.")
        for index, (hit, report) in enumerate(ordered):
            loc = critical_by_location.get(report.location)
            if loc is None:
                continue
            previous = ordered[index - 1][1].location if index > 0 else None
            text = (f"Target not reached. Execution first took a critical branch at "
                    f"{report.location}"
                    + (f" in {report.function or loc.function}" if (report.function or loc.function) else "")
                    + "; the target is not reachable from there.")
            if previous:
                text += f" The last on-path breakpoint before it was {previous}."
            return DeviationReport(
                mode=mode,
                deviation_point=report.location,
                function=report.function or loc.function,
                last_reached_location=previous,
                distance_remaining=loc.distance,
                callstack=hit.callstack or None,
                explanation=" ".join([text, *tail]),
            )
        last = ordered[-1][1] if ordered else None
        parts = ["Target not reached, and no critical location was hit, so no deviation point "
                 "can be named from this run."]
        if unresolved:
            parts.append(f"{len(unresolved)} of {len(critical)} critical breakpoint(s) could not bind "
                         f"(e.g. {unresolved[0]}) — rebuild with -g -O0 for a complete picture.")
        if last is not None:
            parts.append(f"The last breakpoint observed was {last.location}.")
        else:
            parts.append("No breakpoint was hit at all; the run may have exited before the "
                         "instrumented region. Add breakpoints nearer the entry.")
        return DeviationReport(
            mode=mode,
            last_reached_location=last.location if last else None,
            function=last.function if last else None,
            explanation=" ".join([*parts, *tail]),
        )

    # target_only: no static provider — report progress only.
    last_hit = ordered[-1] if ordered else None
    unresolved_targets = [t for t in targets if (b := by_location.get(t)) and b.resolved is False]
    parts = ["No static analysis provider supplied critical locations, so the exact deviation "
             "point cannot be determined (mode target_only)."]
    if unresolved_targets:
        parts.append(f"The target breakpoint {unresolved_targets[0]} could not bind.")
    if last_hit is not None:
        parts.append(f"Target not reached; the furthest breakpoint observed was {last_hit[1].location}.")
    else:
        parts.append("Target not reached and no breakpoint was hit. Pass extra breakpoints along the "
                     "expected path to see how far execution gets.")
    return DeviationReport(
        mode=mode,
        last_reached_location=last_hit[1].location if last_hit else None,
        function=last_hit[1].function if last_hit else None,
        callstack=(last_hit[0].callstack or None) if last_hit else None,
        explanation=" ".join([*parts, *tail]),
    )
