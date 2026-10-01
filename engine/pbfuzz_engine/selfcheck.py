"""The engine-side environment self-check (`selfcheck.engine`).

A REAL invocation — interpreter version, readable contract schemas, and a generator-sandbox
round trip — returned as one item with the evidence of what was actually run. This is the
environment check only; there is no campaign-scoped self-check, and `/pbfuzz selfcheck` (the
settings card's button) is its one caller.
"""

from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from . import __version__
from .errors import EngineError, remedy
from .generated.contracts import CONTRACTS_VERSION, SCHEMA_FILES, load_schema
from .sandbox import GeneratorSandbox, SandboxLimits

_REGEX_META = set(".^$*+?{}[]\\|()")


def _item(name: str, status: str, evidence: list[str], started: float, *, reason: str | None = None, remedies: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"name": name, "status": status, "evidence": evidence, "duration_ms": int((time.monotonic() - started) * 1000)}
    if reason:
        out["reason"] = reason
    if remedies:
        out["remedies"] = remedies
    return out


def check_engine(expect_contracts_version: str | None = None) -> dict[str, Any]:
    """Interpreter version, contract schemas readable, contract version match, sandbox round trip."""
    started = time.monotonic()
    evidence = [f"engine {__version__}, python {sys.version.split()[0]} at {sys.executable}"]
    if sys.version_info < (3, 11):
        return _item("engine", "fail", evidence, started, reason="the engine needs Python >= 3.11",
                     remedies=[remedy("python", "Point execution.pythonPath at Python 3.11+", effect="edit_campaign")])
    if expect_contracts_version is not None and expect_contracts_version != CONTRACTS_VERSION:
        return _item("engine", "fail", evidence + [f"engine contracts {CONTRACTS_VERSION}, plugin contracts {expect_contracts_version}"], started,
                     reason="contract version mismatch between plugin and engine; running would risk silent schema skew",
                     remedies=[remedy("reinstall", "Reinstall the engine from the same checkout as the plugin", detail="pip install -e engine", effect="run_command")])
    try:
        for name in SCHEMA_FILES:
            load_schema(name)
        evidence.append(f"loaded {len(SCHEMA_FILES)} contract schemas (contracts version {CONTRACTS_VERSION})")
    except (OSError, ValueError) as exc:
        evidence.append(f"contract schemas unreadable: {exc}")
        # Not fatal for execution — the engine embeds what it validates — but surfaced.
        return _item("engine", "warn", evidence, started, reason="contracts/ is not next to the engine package; schema files could not be read")
    with tempfile.TemporaryDirectory(prefix="pbfuzz-selfcheck-") as tmp:
        gen = Path(tmp) / "gen.py"
        gen.write_text("def generate(**p):\n    return b'pbfuzz-selfcheck-' + str(p.get('n')).encode()\n")
        try:
            out = GeneratorSandbox(gen, SandboxLimits(timeout_sec=10)).generate({"n": 7})
        except EngineError as exc:
            return _item("engine", "fail", evidence + [f"sandbox round trip failed: {exc.message}"], started, reason=exc.diagnosis, remedies=exc.remedies)
        if out.data != b"pbfuzz-selfcheck-7":
            return _item("engine", "fail", evidence + [f"sandbox returned {out.data!r}"], started, reason="generator sandbox returned wrong bytes",
                         remedies=[remedy("reinstall", "Reinstall the engine", effect="run_command")])
        evidence.append("generator sandbox round trip ok" + (f" (unenforced here: {', '.join(out.unenforced_limits)})" if out.unenforced_limits else " (all rlimits applied)"))
    return _item("engine", "pass", evidence, started)
