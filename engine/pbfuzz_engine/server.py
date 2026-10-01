"""The engine's RPC method handlers.

Params shapes for methods the contract does not pin (it defines only `FuzzRunParams` and
`TraceRunParams`) are documented in engine/README.md and on each handler.
"""

from __future__ import annotations

import os
import platform
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any

from . import __version__
from .campaign import Campaign, load_campaign
from .corpus import analyze_corpus
from .errors import BUSY, EngineError, remedy
from .extract import extract_parameters
from .fuzzer import DEFAULT_RUNTIME, FuzzSession, load_plan
from .generated.contracts import CONTRACTS_VERSION
from .oracle import StderrOracle
from .params import RESERVED_BATCH_KEYS, sample_from_space, validate_space
from .rpc import CONTRACT_METHODS, RequestContext, RpcServer, invalid_params
from .runner import run_target
from .sandbox import BatchedGeneratorSandbox, GeneratorSandbox, SandboxError, SandboxLimits
from .selfcheck import check_engine
from .signature import fit_kwargs, read_signature, signature_issues
from .tracing import call_w3, flatten_debugger_paths, load_tracer

_FUZZ_KEYS = {"campaignPath", "planPath", "generatorPath", "runtime", "pierRound", "debuggerPaths"}

#: How many `next_batch_plan` entries `generator.validate` runs through the real target. Two is
#: enough to answer the only question the preflight asks — can this plan reach the target at all —
#: and every additional one is paid on the caller's foreground path, including the crash-handler
#: cost when an entry actually triggers an aborting bug.
DEFAULT_PREFLIGHT_LIMIT = 2
_DEBUGGER_KEYS = ("gdbPath", "lldbPath", "pythonPath", "jdbPath")


def _debugger_paths(params: dict[str, Any]) -> dict[str, Any]:
    """`FuzzRunParams.debuggerPaths`, flattened the same way trace.run's are, for stage-1 tracing."""
    nested = params.get("debuggerPaths")
    if nested is not None and not isinstance(nested, dict):
        raise invalid_params("`debuggerPaths` must be an object", f"Got {type(nested).__name__}.")
    flat = flatten_debugger_paths(params)
    return {k: flat[k] for k in _DEBUGGER_KEYS if isinstance(flat.get(k), str) and flat[k]}


def _lenient_plan(plan: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """`(parameter_space, batch kwargs)` from an inline plan, without judging the batch values.

    The parameter space must still be structurally valid — nothing can be sampled otherwise — but
    a batch value outside its domain, or a key the space does not declare, is passed through: the
    caller validates those itself and reports them alongside whatever this call finds, instead of
    one rejection hiding the next.
    """
    if not isinstance(plan, dict):
        raise invalid_params("`plan` must be an object", f"Got {type(plan).__name__}.")
    space = validate_space(plan.get("parameter_space") or {})
    batch = plan.get("next_batch_plan") or []
    if not isinstance(batch, list):
        raise invalid_params("`plan.next_batch_plan` must be a list", f"Got {type(batch).__name__}.")
    return space, [{k: v for k, v in e.items() if k not in RESERVED_BATCH_KEYS} for e in batch if isinstance(e, dict)]


def _str(params: dict[str, Any], key: str, *, required: bool = True) -> str | None:
    value = params.get(key)
    if value is None:
        if required:
            raise invalid_params(f"`{key}` is required", f"The call did not include `{key}`.")
        return None
    if not isinstance(value, str) or not value:
        raise invalid_params(f"`{key}` must be a non-empty string", f"`{key}` is {value!r}.")
    return value


def _num(params: dict[str, Any], key: str, default: float) -> float:
    value = params.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        raise invalid_params(f"`{key}` must be a positive number", f"`{key}` is {value!r}.")
    return float(value)


class EngineService:
    """Holds sidecar-wide state: the in-flight fuzz session's cancel flag."""

    def __init__(self) -> None:
        self._fuzz_lock = threading.Lock()
        self._cancel: threading.Event | None = None

    # -- methods --------------------------------------------------------------

    def ping(self, params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
        """`ping` → `PingResult`."""
        caps = [m for m in CONTRACT_METHODS]
        return {
            "engineVersion": __version__,
            "contractsVersion": CONTRACTS_VERSION,
            "python": f"{platform.python_version()} ({sys.executable})",
            "capabilities": caps,
        }

    def campaign_load(self, params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
        """`campaign.load {campaignPath}` → `{id, confirmed, outputDir, stateDir, inputChannel, tracer, targets}`."""
        c = load_campaign(_str(params, "campaignPath"))
        return {
            "id": c.id, "confirmed": c.confirmed, "language": c.language,
            "outputDir": str(c.output_dir), "stateDir": str(c.state_dir),
            "inputChannel": c.entry.input_channel, "runCmd": c.entry.run_cmd,
            "tracer": c.tracer, "targets": list(c.target_locations),
            "corpusEnabled": c.corpus_enabled, "seedsDir": str(c.seeds_dir) if c.seeds_dir else None,
        }

    def fuzz_run(self, params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
        """`fuzz.run FuzzRunParams` → `FuzzRunResult`. One session at a time per sidecar."""
        unknown = set(params) - _FUZZ_KEYS
        if unknown:
            raise invalid_params(f"unknown fuzz.run params {sorted(unknown)}", f"FuzzRunParams allows only {sorted(_FUZZ_KEYS)}.")
        runtime = params.get("runtime") or {}
        if not isinstance(runtime, dict):
            raise invalid_params("`runtime` must be an object", f"Got {type(runtime).__name__}.")
        pier_round = params.get("pierRound")
        if pier_round is not None and (not isinstance(pier_round, int) or isinstance(pier_round, bool) or pier_round < 0):
            raise invalid_params("`pierRound` must be a non-negative integer", f"Got {pier_round!r}.")
        debugger_paths = _debugger_paths(params)
        campaign = load_campaign(_str(params, "campaignPath"))
        plan = load_plan(_str(params, "planPath"))
        generator = _str(params, "generatorPath")

        if not self._fuzz_lock.acquire(blocking=False):
            raise EngineError(BUSY, "a fuzz.run is already in progress",
                              diagnosis="The sidecar runs one fuzz session at a time; a second would race on metrics.json and the testcase directory.",
                              remedies=[remedy("wait", "Wait for the running session to finish", effect="retry"),
                                        remedy("cancel", "Send fuzz.cancel, then retry", effect="retry")])
        try:
            cancel = threading.Event()
            self._cancel = cancel
            tracer = None
            if plan["breakpoints"]:
                tracer, reason = load_tracer(campaign, paths=debugger_paths or None)
                ctx.notify("log", {"level": "info" if tracer else "warn", "message": reason})
            session = FuzzSession(campaign, plan, generator, runtime=runtime, pier_round=pier_round,
                                  notify=ctx.notify, cancel=cancel, tracer=tracer)
            return session.run()
        finally:
            self._cancel = None
            self._fuzz_lock.release()

    def fuzz_cancel(self, params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
        """`fuzz.cancel {}` → `{cancelled}`. The running `fuzz.run` then fails with CANCELLED."""
        cancel = self._cancel
        if cancel is None:
            return {"cancelled": False}
        cancel.set()
        return {"cancelled": True}

    def corpus_analyze(self, params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
        """`corpus.analyze {campaignPath, seedsDir?, timeoutSec?, maxSeeds?, routes?=true}` → `CorpusAnalyzeResult`."""
        campaign = load_campaign(_str(params, "campaignPath"))
        tracer = None
        if params.get("routes", True):
            tracer, reason = load_tracer(campaign)
            ctx.notify("log", {"level": "info", "message": reason})
        max_seeds = params.get("maxSeeds")
        return analyze_corpus(campaign, seeds_dir=_str(params, "seedsDir", required=False),
                              timeout_sec=_num(params, "timeoutSec", 3.0),
                              max_seeds=int(max_seeds) if max_seeds else None, tracer=tracer, notify=ctx.notify)

    def params_extract(self, params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
        """`params.extract {extractorPath | extractorCode, inputs?: [path], seedsDir?, timeoutSec?}`
        → `{parameter_space, extracted, failed}`."""
        inputs = params.get("inputs") or []
        if not isinstance(inputs, list) or not all(isinstance(i, str) for i in inputs):
            raise invalid_params("`inputs` must be a list of paths", f"Got {inputs!r}.")
        seeds_dir = _str(params, "seedsDir", required=False)
        if not inputs and seeds_dir:
            inputs = [str(p) for p in sorted(Path(seeds_dir).iterdir()) if p.is_file()]
        return extract_parameters(inputs, extractor_path=_str(params, "extractorPath", required=False),
                                  extractor_code=_str(params, "extractorCode", required=False),
                                  limits=SandboxLimits(timeout_sec=_num(params, "timeoutSec", 5.0)))

    def generator_validate(self, params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
        """`generator.validate {generatorPath, plan? | planPath? | parameterSpace?, samples?=3,
        timeoutSec?, campaignPath?, execTimeoutSec?}`
        → `{ok, issues, samples: [{source, params, size?, preview?, error?, diagnosis?, reach?}], unenforcedLimits}`.

        Reports EVERYTHING it can find in one call rather than stopping at the first class of
        problem: each rejection costs the caller a full resubmission of the generator, and a
        recorded session paid that three times over for three problems that one call could have
        named together. So:

        - `plan` (inline) is read leniently — a batch value outside its declared domain is the
          caller's own validator's finding, not a reason to skip generating and preflighting the
          rest. `planPath` keeps the strict `load_plan` reading.
        - `generate`'s signature is read from source (`signature.read_signature`, no execution)
          and checked against what the plan supplies; mismatches go in `issues`. Generation still
          runs, with each call's kwargs fitted to what `generate` can bind, so the same response
          also says what the generator produced and whether it reached the target.
        - The engine's own `seed` is passed only when `generate` can take it. It is the engine's
          convention, not the plan's, so a generator that ignores seeding is not an error.

        Runs the generator (in the sandbox, never the target) on every batch-plan entry and on
        `samples` draws from the space, so a broken generator is caught before EXECUTE. All of
        those generator calls share ONE worker process (`BatchedGeneratorSandbox`): the plain
        `GeneratorSandbox.generate()` pays a fresh fork+exec+CPython boot per call (~416ms), and
        a 9-entry plan plus 3 samples spent ~5s of the caller's foreground time on nothing else.

        When `campaignPath` is also given, this is additionally a REAL preflight of the plan
        against the target: `preflightLimit` batch-plan entries (default 2, and never the
        `sample(seed=...)` draws, which only smoke-test the generator over the space) are run
        through the actual target once each (`runner.run_target`, the same function `fuzz.run`
        stage 1 uses) and judged by the campaign's stderr oracle. The cap matters: the preflight
        exists to catch a plan that cannot reach the target at all, which two entries answer as
        well as nine, and on a target whose bug aborts, every preflighted entry that triggers
        pays the crash-handler tax (~2.5s here) on the caller's foreground path.

        `ok` is false when a generator call fails, when running the target fails outright (e.g.
        the binary is not built), or when none of the preflighted entries reach the target.
        `campaignPath` is optional; without it, no target is run.
        """
        limits = SandboxLimits(timeout_sec=_num(params, "timeoutSec", float(DEFAULT_RUNTIME["generatorTimeoutSec"])))
        generator_path = _str(params, "generatorPath")
        GeneratorSandbox(generator_path, limits).check_syntax()
        signature = read_signature(generator_path)
        space: dict[str, Any] = {}
        batch: list[dict[str, Any]] = []
        plan_path = _str(params, "planPath", required=False)
        if params.get("plan") is not None:
            space, batch = _lenient_plan(params["plan"])
        elif plan_path:
            plan = load_plan(plan_path)
            space, batch = plan["parameter_space"], plan["_batch_params"]
        elif params.get("parameterSpace") is not None:
            space = validate_space(params["parameterSpace"])
        n = params.get("samples", 3)
        if not isinstance(n, int) or isinstance(n, bool) or n < 0 or n > 100:
            raise invalid_params("`samples` must be an integer in [0, 100]", f"Got {n!r}.")

        supplied = set(space) | {k for entry in batch for k in entry if k != "seed"}
        issues = signature_issues(signature, supplied)
        cases: list[tuple[str, dict[str, Any], bool]] = [
            (f"next_batch_plan[{i}]", fit_kwargs(dict(p, seed=p.get("seed", i + 1)), signature), True)
            for i, p in enumerate(batch)
        ]
        cases += [(f"sample(seed={s})", fit_kwargs(sample_from_space(space, s), signature), False) for s in range(1, n + 1)]

        campaign_path = _str(params, "campaignPath", required=False)
        campaign = load_campaign(campaign_path) if campaign_path else None
        oracle = StderrOracle.from_campaign(campaign.oracle) if campaign is not None else None
        exec_timeout = _num(params, "execTimeoutSec", float(DEFAULT_RUNTIME["execTimeoutSec"]))

        preflight_limit = params.get("preflightLimit", DEFAULT_PREFLIGHT_LIMIT)
        if not isinstance(preflight_limit, int) or isinstance(preflight_limit, bool) or preflight_limit < 0:
            raise invalid_params("`preflightLimit` must be a non-negative integer", f"Got {preflight_limit!r}.")

        with BatchedGeneratorSandbox(generator_path, limits) as batch:
            generated = batch.generate_many([p for _, p, _ in cases])

        results, unenforced, ok = [], set(), not issues
        preflighted = 0
        any_reached = False
        for (source, p, from_batch_plan), out in zip(cases, generated):
            entry: dict[str, Any] = {"source": source, "params": p}
            if isinstance(out, SandboxError):
                ok = False
                entry.update({"error": out.message, "diagnosis": out.diagnosis})
                results.append(entry)
                continue
            entry.update({"size": len(out.data), "preview": out.data[:32].hex()})
            unenforced.update(out.unenforced_limits)
            if campaign is not None and from_batch_plan and preflighted < preflight_limit:
                preflighted += 1
                entry["reach"] = self._preflight_reach(campaign, oracle, out.data, exec_timeout)
                if entry["reach"].get("ranTarget") is False:
                    ok = False
                elif entry["reach"].get("reached"):
                    any_reached = True
            results.append(entry)
        if preflighted and not any_reached:
            ok = False
        return {"ok": ok, "issues": issues, "samples": results, "unenforcedLimits": sorted(unenforced), "preflighted": preflighted}

    @staticmethod
    def _preflight_reach(campaign: Campaign, oracle: StderrOracle, data: bytes, timeout_sec: float) -> dict[str, Any]:
        """One real `run_target` on `data`, judged by `oracle` — the Task-3 preflight body.

        Isolated from `generator_validate` so its per-entry try/except stays readable; never
        raises (a `TARGET_FAILED`-class `EngineError`, e.g. a missing binary, is reported in the
        returned dict exactly like a generator failure is, rather than aborting the whole
        `generator.validate` call).
        """
        with tempfile.TemporaryDirectory(prefix="pbfuzz-preflight-") as tmp:
            input_path = Path(tmp) / "input"
            input_path.write_bytes(data)
            try:
                result = run_target(campaign.entry, input_path, data, timeout_sec=timeout_sec, cwd=Path(tmp))
            except EngineError as exc:
                return {"ranTarget": False, "error": exc.message, "diagnosis": exc.diagnosis}
            verdict = oracle.judge(result.stderr, timed_out=result.timed_out)
            reach: dict[str, Any] = {
                "ranTarget": True, "reached": verdict.reached, "triggered": verdict.triggered,
                "timedOut": result.timed_out, "exitCode": result.exit_code, "durationMs": result.duration_ms,
            }
            if not verdict.reached and result.stderr:
                reach["stderrTail"] = result.stderr[-500:]
            return reach

    def selfcheck_engine(self, params: dict[str, Any], ctx: RequestContext) -> dict[str, Any]:
        """`selfcheck.engine {contractsVersion?}` → one selfcheck item named `engine`."""
        return check_engine(_str(params, "contractsVersion", required=False))

    # W3 seam — see pbfuzz_engine/tracing.py for what W3 must provide.
    def trace_run(self, params: dict[str, Any], ctx: RequestContext) -> Any:
        return call_w3("tracers", "trace_run", "trace.run", params)

    def deviation_run(self, params: dict[str, Any], ctx: RequestContext) -> Any:
        return call_w3("deviation", "deviation_run", "deviation.run", params)

    def handlers(self) -> dict[str, Any]:
        """Method table, covering exactly the contract's method enum."""
        table = {
            "ping": self.ping, "campaign.load": self.campaign_load, "fuzz.run": self.fuzz_run,
            "fuzz.cancel": self.fuzz_cancel, "trace.run": self.trace_run, "deviation.run": self.deviation_run,
            "corpus.analyze": self.corpus_analyze, "params.extract": self.params_extract,
            "generator.validate": self.generator_validate, "selfcheck.engine": self.selfcheck_engine,
        }
        assert set(table) == set(CONTRACT_METHODS)
        return table


def build_server(infile: Any, outfile: Any) -> RpcServer:
    """Wire the service into a server over the given binary streams."""
    service = EngineService()
    server = RpcServer(service.handlers(), infile, outfile)
    server.on_eof = lambda: service._cancel.set() if service._cancel else None  # type: ignore[attr-defined]
    return server


def serve_stdio() -> None:
    """Serve on the process's stdin/stdout.

    fd 1 is duplicated for the protocol and then pointed at stderr, so a stray `print` anywhere
    in the engine (or a library) lands in the log instead of corrupting the JSON-RPC stream.
    """
    proto_out = os.fdopen(os.dup(1), "wb", buffering=0)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    build_server(sys.stdin.buffer, proto_out).serve()
