"""PBFuzz engine — the Python sidecar behind the dsh-pbfuzz plugin.

The engine owns everything that actually executes: the two-stage property-based fuzzing loop,
the stderr oracle, the generator sandbox, corpus analysis and parameter extraction. It speaks
newline-delimited JSON-RPC 2.0 over stdin/stdout (contracts/engine-rpc.schema.json) and is
started on demand by the TS plugin.

One invariant matters above the rest: **the engine is the sole writer of `metrics.json`**. The
agent may read it and never write it, which is what makes the numbers REFLECT reasons over
trustworthy — the model cannot report progress it did not make. See `pbfuzz_engine.metrics`.
"""

from __future__ import annotations

from .generated.contracts import CONTRACTS_VERSION

__version__ = "0.1.0"

__all__ = ["__version__", "CONTRACTS_VERSION"]
