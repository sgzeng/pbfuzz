"""Breakpoint tracers (W3): gdb batch (primary), lldb batch, pymon, jdb.

Replaces the old LLDB-DAP ``debugger.py``, the gdb FIFO MCP server and
``gdb.sh``. RPC entry points for W2's dispatcher:

* :func:`trace_run` — ``trace.run``

Both take the request ``params`` dict and return the ``result`` dict; both
raise :class:`TracerError` (render ``err.to_rpc_error_data()`` as
``error.data``) only when the request cannot be served at all.

:module: pbfuzz_engine.tracers
"""

from .base import (
    Breakpoint,
    BreakpointReport,
    HitRecord,
    InlineValue,
    Remedy,
    TraceResult,
    Tracer,
    TracerError,
    build_command,
    load_campaign,
)
from .gdb_batch import GdbBatchTracer
from .jdb import JdbTracer
from .lldb_batch import LldbBatchTracer
from .pymon import PymonTracer
from .seam import trace_run, trace_run_result
from .selection import TracerPaths, make_tracer, select_tracer

__all__ = [
    "Breakpoint",
    "BreakpointReport",
    "GdbBatchTracer",
    "HitRecord",
    "InlineValue",
    "JdbTracer",
    "LldbBatchTracer",
    "PymonTracer",
    "Remedy",
    "TraceResult",
    "Tracer",
    "TracerError",
    "TracerPaths",
    "build_command",
    "load_campaign",
    "make_tracer",
    "select_tracer",
    "trace_run",
    "trace_run_result",
]
