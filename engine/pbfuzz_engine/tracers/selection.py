"""Tracer auto-selection from ``campaign.tracer`` and ``campaign.target.language``.

Precedence: an explicit per-call ``tracer`` (the RPC ``TraceRunParams.tracer``)
beats ``campaign.tracer``, which beats language-based ``auto``. ``auto`` maps
python → pymon, java → jdb, and c/cpp/other/unset → gdb, falling back to lldb
only when gdb is genuinely unavailable (and saying so in the reason).

:module: pbfuzz_engine.tracers.selection
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping

from .base import Remedy, Tracer, TracerError
from .gdb_batch import GdbBatchTracer
from .jdb import JdbTracer
from .lldb_batch import LldbBatchTracer
from .pymon import PymonTracer

__all__ = ["TracerPaths", "Selection", "select_tracer", "make_tracer", "TRACER_NAMES"]

TRACER_NAMES = ("gdb", "lldb", "pymon", "jdb")

_BY_LANGUAGE = {"python": "pymon", "java": "jdb", "c": "gdb", "cpp": "gdb", "other": "gdb"}


@dataclass(frozen=True)
class TracerPaths:
    """Debugger binaries, from pbfuzz settings (`execution.gdbPath`, …)."""

    gdb: str = "gdb"
    lldb: str = "lldb"
    python: str = ""
    jdb: str = "jdb"

    @classmethod
    def from_params(cls, params: Mapping[str, Any]) -> "TracerPaths":
        return cls(
            gdb=str(params.get("gdbPath") or "gdb"),
            lldb=str(params.get("lldbPath") or "lldb"),
            python=str(params.get("pythonPath") or ""),
            jdb=str(params.get("jdbPath") or "jdb"),
        )


@dataclass(frozen=True)
class Selection:
    """The chosen tracer and why it was chosen."""

    tracer: Tracer
    reason: str


def make_tracer(name: str, paths: TracerPaths = TracerPaths()) -> Tracer:
    """Instantiate a tracer by its contract name."""
    if name == "gdb":
        return GdbBatchTracer(paths.gdb)
    if name == "lldb":
        return LldbBatchTracer(paths.lldb)
    if name == "pymon":
        return PymonTracer(paths.python)
    if name == "jdb":
        return JdbTracer(paths.jdb)
    raise TracerError(
        f"Unknown tracer {name!r}; expected one of {', '.join(TRACER_NAMES)}.",
        [Remedy(id="fix_tracer", label="Set campaign `tracer` to a known value", effect="edit_campaign")],
    )


def select_tracer(
    campaign: Mapping[str, Any],
    override: str | None = None,
    paths: TracerPaths = TracerPaths(),
    factory: Callable[[str, TracerPaths], Tracer] = make_tracer,
) -> Selection:
    """Pick the tracer for this campaign; raises :class:`TracerError` when tracing is off."""
    requested = override if override and override != "auto" else None
    source = "request"
    if requested is None:
        configured = campaign.get("tracer") or "auto"
        if configured != "auto":
            requested, source = configured, "campaign.tracer"
    if requested == "off":
        raise TracerError(
            "Tracing is turned off for this campaign (`tracer: off`).",
            [
                Remedy(
                    id="enable_tracer",
                    label="Set campaign `tracer: auto` to enable breakpoint tracing",
                    effect="edit_campaign",
                )
            ],
        )
    if requested is not None:
        return Selection(factory(requested, paths), f"{source} = {requested}")

    language = (campaign.get("target") or {}).get("language") or "other"
    name = _BY_LANGUAGE.get(language, "gdb")
    chosen = factory(name, paths)
    if name == "gdb":
        ok, _ = chosen.available()
        if not ok:
            fallback = factory("lldb", paths)
            if fallback.available()[0]:
                return Selection(fallback, f"auto: language={language}; gdb unavailable, using lldb")
    return Selection(chosen, f"auto: language={language} -> {name}")
