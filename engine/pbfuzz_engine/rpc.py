"""Newline-delimited JSON-RPC 2.0 framing (contracts/engine-rpc.schema.json).

One JSON object per line in each direction. stdin carries requests; stdout carries responses
and server→client notifications (`progress`, `iteration`, `log`); stderr is log only.

Each request is handled on its own thread so a long `fuzz.run` does not block `fuzz.cancel` or
`ping`. All writes to stdout go through one lock, so lines never interleave.
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass, field
from typing import Any, BinaryIO, Callable

from .errors import (
    INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR,
    EngineError, remedy,
)

log = logging.getLogger("pbfuzz_engine.rpc")

#: The exact method set of the contract's `Request.method` enum.
CONTRACT_METHODS = (
    "ping", "campaign.load", "fuzz.run", "fuzz.cancel", "trace.run", "deviation.run",
    "corpus.analyze", "params.extract", "generator.validate", "selfcheck.engine",
)
NOTIFICATION_METHODS = ("progress", "iteration", "log")


@dataclass
class RequestContext:
    """Handed to every handler: the request id and a way to stream notifications."""

    id: Any
    method: str
    notify: Callable[[str, dict[str, Any]], None]
    server: "RpcServer"
    extra: dict[str, Any] = field(default_factory=dict)


Handler = Callable[[dict[str, Any], RequestContext], Any]


def invalid_params(message: str, diagnosis: str) -> EngineError:
    """An INVALID_PARAMS error carrying the diagnosis/remedies every engine error must have."""
    return EngineError(INVALID_PARAMS, message, diagnosis=diagnosis,
                       remedies=[remedy("fix_call", "Fix the RPC parameters", detail="See engine/README.md for each method's params.", effect="manual")])


class RpcServer:
    """Serve JSON-RPC over a pair of binary streams.

    Args:
        handlers: Method name → handler. Must be a subset of `CONTRACT_METHODS`.
        infile: Where requests arrive (the sidecar's stdin).
        outfile: Where responses and notifications go (the sidecar's real stdout).
    """

    def __init__(self, handlers: dict[str, Handler], infile: BinaryIO, outfile: BinaryIO) -> None:
        unknown = set(handlers) - set(CONTRACT_METHODS)
        if unknown:
            raise ValueError(f"handlers outside the contract: {sorted(unknown)}")
        self.handlers = handlers
        self.infile = infile
        self.outfile = outfile
        self._write_lock = threading.Lock()
        self._threads: list[threading.Thread] = []
        self.shutdown = threading.Event()

    # -- output ---------------------------------------------------------------

    def _write(self, message: dict[str, Any]) -> None:
        line = json.dumps(message, default=str, ensure_ascii=False) + "\n"
        with self._write_lock:
            try:
                self.outfile.write(line.encode("utf-8"))
                self.outfile.flush()
            except (BrokenPipeError, ValueError):
                self.shutdown.set()

    def notify(self, method: str, params: dict[str, Any]) -> None:
        """Send a server→client notification. `method` must be one the contract declares."""
        if method not in NOTIFICATION_METHODS:
            raise ValueError(f"notification {method!r} is not in the contract")
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _respond(self, id: Any, *, result: Any = None, error: dict[str, Any] | None = None) -> None:
        msg: dict[str, Any] = {"jsonrpc": "2.0", "id": id}
        if error is not None:
            msg["error"] = error
        else:
            msg["result"] = result
        self._write(msg)

    # -- input ----------------------------------------------------------------

    def handle_line(self, raw: bytes) -> threading.Thread | None:
        """Parse one line and dispatch it. Returns the worker thread, if one was started."""
        text = raw.decode("utf-8", errors="replace").strip()
        if not text:
            return None
        try:
            msg = json.loads(text)
        except json.JSONDecodeError as exc:
            self._respond(None, error=EngineError(
                PARSE_ERROR, "parse error",
                diagnosis=f"The line is not valid JSON ({exc.msg} at column {exc.colno}). Each request must be one JSON object on one line.",
                remedies=[remedy("fix_framing", "Send one JSON object per line", effect="manual")],
            ).to_rpc())
            return None
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
            rid = msg.get("id") if isinstance(msg, dict) else None
            self._respond(rid if isinstance(rid, (str, int)) else None, error=EngineError(
                INVALID_REQUEST, "invalid request",
                diagnosis="A request must be an object with `jsonrpc: \"2.0\"`, a string `method` and an `id`.",
                remedies=[remedy("fix_request", "Send a JSON-RPC 2.0 request object", effect="manual")],
            ).to_rpc())
            return None
        if "id" not in msg:
            log.warning("ignoring client notification %r: the contract has no client→server notifications", msg.get("method"))
            return None
        rid = msg["id"]
        if not isinstance(rid, (str, int)) or isinstance(rid, bool):
            self._respond(None, error=EngineError(
                INVALID_REQUEST, "invalid request id",
                diagnosis=f"`id` must be a string or integer, got {type(rid).__name__}.",
                remedies=[remedy("fix_request", "Use a string or integer id", effect="manual")],
            ).to_rpc())
            return None
        method = msg["method"]
        params = msg.get("params", {})
        if params is None:
            params = {}
        if not isinstance(params, dict):
            self._respond(rid, error=invalid_params("params must be an object", f"`params` is a {type(params).__name__}; the contract uses by-name params only.").to_rpc())
            return None
        handler = self.handlers.get(method)
        if handler is None:
            in_contract = method in CONTRACT_METHODS
            self._respond(rid, error=EngineError(
                METHOD_NOT_FOUND, f"method not found: {method}",
                diagnosis=(f"`{method}` is in the contract but this engine build does not serve it." if in_contract
                           else f"`{method}` is not a method of contracts/engine-rpc.schema.json. Valid methods: {', '.join(CONTRACT_METHODS)}."),
                remedies=[remedy("check_method", "Call a contract method", effect="manual")],
            ).to_rpc())
            return None

        ctx = RequestContext(id=rid, method=method, notify=self.notify, server=self)
        thread = threading.Thread(target=self._run, args=(handler, params, ctx), name=f"rpc-{method}-{rid}", daemon=True)
        self._threads = [t for t in self._threads if t.is_alive()]
        self._threads.append(thread)
        thread.start()
        return thread

    def _run(self, handler: Handler, params: dict[str, Any], ctx: RequestContext) -> None:
        try:
            result = handler(params, ctx)
        except EngineError as exc:
            self._respond(ctx.id, error=exc.to_rpc())
        except Exception as exc:  # noqa: BLE001 - never let a handler bug kill the sidecar
            log.exception("handler %s crashed", ctx.method)
            self._respond(ctx.id, error=EngineError(
                INTERNAL_ERROR, f"internal error in {ctx.method}: {type(exc).__name__}: {exc}",
                diagnosis="The engine hit an unexpected exception; the traceback is on the sidecar's stderr. The sidecar is still running.",
                remedies=[remedy("retry", "Retry the call", effect="retry"),
                          remedy("report", "Report the stderr traceback as an engine bug", effect="manual")],
            ).to_rpc())
        else:
            self._respond(ctx.id, result=result)

    def serve(self, join_timeout: float = 5.0) -> None:
        """Read requests until EOF on the input stream, then wait briefly for in-flight work."""
        for raw in iter(self.infile.readline, b""):
            if self.shutdown.is_set():
                break
            self.handle_line(raw)
        self.shutdown.set()
        on_eof = getattr(self, "on_eof", None)
        if on_eof:
            on_eof()
        for thread in self._threads:
            thread.join(join_timeout)


if __name__ == "__main__":
    # `python3 -m pbfuzz_engine.rpc` is the launch form W1's bridge uses (PYTHONPATH=engine/);
    # it is identical to `python -m pbfuzz_engine` / `pbfuzz-engine`. Delegating to the package
    # entry point keeps one implementation; the handlers import `pbfuzz_engine.rpc` normally,
    # so this `__main__` copy of the module only supplies the entry point.
    from pbfuzz_engine.__main__ import main

    raise SystemExit(main())
