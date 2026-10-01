"""Engine errors.

Every error the engine returns over JSON-RPC carries a `diagnosis` and a list of concrete
`remedies` (contracts/engine-rpc.schema.json `Response.error.data`). Failure recovery is a
first-class step in PBFuzz: the agent never just retries or gives up, it diagnoses and offers
the user choices. A bare message is therefore not an acceptable error here — `EngineError`
makes the diagnosis and the remedies required arguments so a caller cannot omit them.
"""

from __future__ import annotations

from typing import Any, Literal

#: Remedy effects, mirroring `Response.error.data.remedies[].effect` in the RPC contract.
RemedyEffect = Literal["retry", "edit_campaign", "disable_tool", "run_command", "manual"]

# JSON-RPC 2.0 reserved codes.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# Engine-specific codes, inside the -32000..-32099 "server error" band the spec reserves for
# implementations. These are part of the sidecar surface: W1's client may switch on them.
CAMPAIGN_INVALID = -32001
GENERATOR_FAILED = -32002
TARGET_FAILED = -32003
ORACLE_FAILED = -32004
CANCELLED = -32005
NOT_IMPLEMENTED = -32006
CORPUS_EMPTY = -32007
PLAN_INVALID = -32008
TRACER_FAILED = -32009
BUSY = -32010


def remedy(
    id: str,
    label: str,
    *,
    detail: str | None = None,
    effect: RemedyEffect | None = None,
) -> dict[str, Any]:
    """Build one remedy entry for an error's `data.remedies`."""
    out: dict[str, Any] = {"id": id, "label": label}
    if detail is not None:
        out["detail"] = detail
    if effect is not None:
        out["effect"] = effect
    return out


class EngineError(Exception):
    """An error that can be rendered directly as a JSON-RPC error object.

    Args:
        code: One of the module-level codes.
        message: The short summary line.
        diagnosis: Why this happened, in terms the agent or user can act on — the concrete
            observation, not a restatement of `message`.
        remedies: Concrete options for getting past it. Must be non-empty.
    """

    def __init__(
        self,
        code: int,
        message: str,
        *,
        diagnosis: str,
        remedies: list[dict[str, Any]],
    ) -> None:
        super().__init__(message)
        if not remedies:
            raise ValueError("EngineError requires at least one remedy")
        self.code = code
        self.message = message
        self.diagnosis = diagnosis
        self.remedies = remedies

    def to_rpc(self) -> dict[str, Any]:
        """Render as the `error` member of a JSON-RPC response."""
        return {
            "code": self.code,
            "message": self.message,
            "data": {"diagnosis": self.diagnosis, "remedies": self.remedies},
        }


def not_implemented_by_w3(method: str, module: str) -> EngineError:
    """The error the W3 seam raises until the tracer/deviation modules land.

    `trace.run` and `deviation.run` are declared in the RPC contract but
    implemented by workstream W3 under `pbfuzz_engine/tracers/` and `pbfuzz_engine/deviation/`.
    Until those exist the dispatcher answers with this rather than a bare "method not found",
    so the client can tell "not built yet" apart from "you called something that is not in the
    contract".
    """
    return EngineError(
        NOT_IMPLEMENTED,
        f"{method} is not available: the {module} module is not installed",
        diagnosis=(
            f"`{method}` is served by `pbfuzz_engine.{module}`, which is owned by workstream W3 "
            f"and is not present in this engine build. The engine itself is healthy."
        ),
        remedies=[
            remedy(
                "disable_tracing",
                "Run without breakpoint tracing",
                detail=(
                    "Stage-1 runs still execute and the stderr oracle still reports "
                    "reached/triggered; only breakpoint observations are missing."
                ),
                effect="disable_tool",
            ),
            remedy(
                "install_w3",
                f"Install an engine build that includes pbfuzz_engine.{module}",
                detail="Re-install the engine package from a checkout where W3 has landed.",
                effect="run_command",
            ),
        ],
    )
