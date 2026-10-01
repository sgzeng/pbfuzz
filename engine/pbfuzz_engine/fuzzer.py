"""The two-stage property-based fuzzing loop (`fuzz.run`).

Ported from the CCS'26 `PropertyBasedFuzzer`:

* **Stage 1** runs each concrete assignment in the plan's `next_batch_plan` — the hypotheses the
  agent wants tested — and, when a tracer is available and the plan has breakpoints, traces
  each of those runs. The traced observations are the evidence REFLECT reasons over.
* **Stage 2** samples the `parameter_space` (deduplicating repeated draws) until `maxIters`,
  the fuzz timeout, a trigger, a fatal error, or `fuzz.cancel`.

Every execution is judged by the stderr oracle. Every iteration record goes to
`<output.dir>/runs/session-NNNN/iterations.jsonl` and every input to `testcases/`, so a long run
does not flood the agent's context; the RPC result is a summary. `metrics.json` is updated
through `MetricsStore` at the end of every session, including failed and cancelled ones.
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .campaign import Campaign
from .errors import CANCELLED, GENERATOR_FAILED, PLAN_INVALID, EngineError, remedy
from .metrics import MetricsStore, SessionMetrics
from .oracle import StderrOracle
from .params import sample_from_space, validate_batch_entry, validate_space
from .runner import run_target
from .sandbox import BatchedGeneratorSandbox, GeneratedInput, SandboxError, SandboxLimits
from .signature import fit_kwargs, read_signature

Notify = Callable[[str, dict[str, Any]], None]

#: Bound on how many `generate()` calls are batched into one `generate_many()` round trip.
#: Large enough to amortise the sandbox worker's interpreter-start cost across most of a
#: session, small enough that progress notifications and `fuzz.cancel` responsiveness stay on
#: roughly the same cadence they had one-iteration-at-a-time (a whole batch's generation is
#: cheap now — milliseconds, not the old 416ms/call — so the wait between opportunities to
#: notice a cancel is bounded by this many target executions, not by sandbox cost).
GENERATE_BATCH_SIZE = 32

#: Settings defaults (contracts/pbfuzz-settings.schema.json `fuzzing` / `execution`).
DEFAULT_RUNTIME: dict[str, Any] = {
    "maxIters": 1000,
    "execTimeoutSec": 3.0,
    "fuzzTimeoutSec": 600.0,
    "generatorTimeoutSec": 1.0,
    "enableDebuggerForAll": False,
    "generatorMemLimitMB": 512,
    "generatorCpuLimitSec": 10,
    "stage1MinConcreteParams": 5,
}

#: How many reaching inputs `bestReachingInputs` lists (smallest first).
BEST_REACHING_LIMIT = 5
#: How many times a triggering input is re-run, after the session stops, to record whether the
#: PoV actually reproduces. Cheap (the session has already stopped) and it is the only honest
#: source for that number — see `FuzzSession._reproduce`.
REPRODUCE_TIMES = 3
#: Minimum interval between `progress` notifications.
PROGRESS_INTERVAL_SEC = 1.0


def load_plan(plan_path: str | Path) -> dict[str, Any]:
    """Read and validate `fuzz_plan.json` (state/blocks.schema.json `FuzzPlan`)."""
    path = Path(plan_path)
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise EngineError(
            PLAN_INVALID, f"fuzz plan not found: {path}",
            diagnosis=f"No file at `{path}`. IMPLEMENT writes fuzz_plan.json before EXECUTE.",
            remedies=[remedy("write_plan", "Write fuzz_plan.json", effect="manual")],
        ) from exc
    except json.JSONDecodeError as exc:
        raise EngineError(
            PLAN_INVALID, "fuzz plan is not valid JSON",
            diagnosis=f"{path}: {exc}",
            remedies=[remedy("fix_plan", "Fix the JSON syntax in fuzz_plan.json", effect="manual")],
        ) from exc
    if not isinstance(plan, dict) or "parameter_space" not in plan:
        raise EngineError(
            PLAN_INVALID, "fuzz plan has no parameter_space",
            diagnosis="`parameter_space` is the one required key of a FuzzPlan.",
            remedies=[remedy("fix_plan", "Add parameter_space to fuzz_plan.json", effect="manual")],
        )
    unknown = set(plan) - {"trigger_plan_id", "parameter_space", "next_batch_plan", "breakpoints", "generator_path"}
    if unknown:
        raise EngineError(
            PLAN_INVALID, f"fuzz plan has unknown keys {sorted(unknown)}",
            diagnosis=f"FuzzPlan allows no additional properties; found {sorted(unknown)}.",
            remedies=[remedy("fix_plan", f"Remove {sorted(unknown)} from fuzz_plan.json", effect="manual")],
        )
    validate_space(plan["parameter_space"])
    batch = plan.get("next_batch_plan") or []
    if not isinstance(batch, list):
        raise EngineError(PLAN_INVALID, "next_batch_plan must be a list", diagnosis=f"Got {type(batch).__name__}.", remedies=[remedy("fix_plan", "Make next_batch_plan a list", effect="manual")])
    plan["_batch_params"] = [validate_batch_entry(i, e, plan["parameter_space"]) for i, e in enumerate(batch)]
    breakpoints = plan.get("breakpoints") or []
    for i, bp in enumerate(breakpoints):
        if not isinstance(bp, dict) or not isinstance(bp.get("location"), str) or ":" not in bp["location"]:
            raise EngineError(PLAN_INVALID, f"breakpoints[{i}] needs a file:line location", diagnosis=f"Got {bp!r}.", remedies=[remedy("fix_plan", "Give each breakpoint a `location: file:line`", effect="manual")])
    plan["breakpoints"] = breakpoints
    return plan


@dataclass
class _Tally:
    iterations: int = 0
    reached: int = 0
    triggered: int = 0
    timeouts: int = 0
    errors: int = 0
    first_trigger: str | None = None
    reaching: list[tuple[int, str]] = field(default_factory=list)


class FuzzSession:
    """One `fuzz.run` invocation.

    Args:
        campaign: The validated campaign.
        plan: A plan from `load_plan`.
        generator_path: The generator module (run only in the sandbox).
        runtime: Per-run overrides of `DEFAULT_RUNTIME` (FuzzRunParams.runtime).
        pier_round: Recorded into metrics.json.
        notify: Sends `progress` / `iteration` / `log` notifications.
        cancel: Set by `fuzz.cancel`; checked between iterations.
        tracer: A `tracers.base.Tracer`, or None to run without breakpoint tracing.
    """

    def __init__(
        self,
        campaign: Campaign,
        plan: dict[str, Any],
        generator_path: str | Path,
        *,
        runtime: dict[str, Any] | None = None,
        pier_round: int | None = None,
        notify: Notify | None = None,
        cancel: threading.Event | None = None,
        tracer: Any | None = None,
    ) -> None:
        self.campaign = campaign
        self.plan = plan
        self.runtime = {**DEFAULT_RUNTIME, **{k: v for k, v in (runtime or {}).items() if v is not None}}
        self.pier_round = pier_round
        self.notify: Notify = notify or (lambda method, params: None)
        self.cancel = cancel or threading.Event()
        self.tracer = tracer
        self.oracle = StderrOracle.from_campaign(campaign.oracle)
        # What `generate` can bind, read once from source: the engine's own `seed` (and nothing
        # else the plan did not ask for) is only passed when it would not raise a TypeError.
        self.signature = read_signature(generator_path)
        self.sandbox = BatchedGeneratorSandbox(
            generator_path,
            SandboxLimits(
                timeout_sec=float(self.runtime["generatorTimeoutSec"]),
                mem_mb=int(self.runtime["generatorMemLimitMB"]),
                cpu_sec=int(self.runtime["generatorCpuLimitSec"]),
            ),
        )
        out = campaign.output_dir
        self.testcases_dir = out / "testcases"
        self.crashes_dir = out / "crashes"
        runs = out / "runs"
        runs.mkdir(parents=True, exist_ok=True)
        existing = [p for p in runs.glob("session-*") if p.is_dir()]
        self.session_index = len(existing) + 1
        self.session_dir = runs / f"session-{self.session_index:04d}"
        while self.session_dir.exists():
            self.session_index += 1
            self.session_dir = runs / f"session-{self.session_index:04d}"
        self.session_dir.mkdir(parents=True)
        self.testcases_dir.mkdir(parents=True, exist_ok=True)
        self.crashes_dir.mkdir(parents=True, exist_ok=True)
        self.iterations_path = self.session_dir / "iterations.jsonl"
        self.metrics = MetricsStore(campaign.state_dir)
        self._tally = _Tally()
        self._observations: list[dict[str, Any]] = []
        self._traced = 0
        self._last_progress = 0.0

    # -- helpers -------------------------------------------------------------

    def _log(self, level: str, message: str) -> None:
        self.notify("log", {"level": level, "message": message})

    def _progress(self, stage: int, iteration: int, started: float, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_progress < PROGRESS_INTERVAL_SEC:
            return
        self._last_progress = now
        t = self._tally
        self.notify("progress", {
            "stage": stage, "iteration": iteration, "maxIters": int(self.runtime["maxIters"]),
            "reached": t.reached, "triggered": t.triggered, "timeouts": t.timeouts, "errors": t.errors,
            "elapsedSec": round(now - started, 3),
        })

    def _record(self, record: dict[str, Any], handle: Any) -> None:
        handle.write(json.dumps(record, default=str) + "\n")
        handle.flush()

    def _trace(self, input_path: Path) -> dict[str, Any] | None:
        from .tracing import convert_tracer_error, is_tracer_error

        try:
            result = self.tracer.run(self.campaign.raw, str(input_path), self.plan["breakpoints"], float(self.runtime["execTimeoutSec"]) * 3 + 2)
            return result.to_rpc()
        except Exception as exc:  # noqa: BLE001 - a tracer failure must not abort fuzzing
            err = convert_tracer_error(exc) if is_tracer_error(exc) else exc
            self._log("warn", f"tracing {input_path.name} failed: {getattr(err, 'diagnosis', err)}")
            return None

    # -- one iteration -------------------------------------------------------

    def _run_one(self, iteration: int, stage: int, params: dict[str, Any], description: str | None, trace: bool, handle: Any, generated: GeneratedInput | SandboxError) -> dict[str, Any]:
        """Process one already-generated input: run the target, judge it, record it.

        `generated` is produced ahead of time, for a whole sub-batch at once, by
        `self.sandbox.generate_many()` in `run()` — batching is entirely the caller's concern;
        this method's contract (one params dict + one generated-or-error in, one record out) is
        unchanged from when it called `self.sandbox.generate(params)` itself.
        """
        t = self._tally
        t.iterations += 1
        record: dict[str, Any] = {"iter": iteration, "stage": stage, "parameters": params}
        if description:
            record["plan_description"] = description
        if isinstance(generated, SandboxError):
            exc = generated
            t.errors += 1
            record.update({"type": "error", "phase": f"generator_{exc.kind}", "message": exc.message, "diagnosis": exc.diagnosis})
            self._record(record, handle)
            self.notify("iteration", {k: record[k] for k in ("iter", "stage", "type", "message")})
            record["_error"] = exc
            return record

        name = f"round{self.pier_round if self.pier_round is not None else 0}_s{self.session_index}_stage{stage}_iter{iteration}"
        pending = self.testcases_dir / (name + ".input")
        pending.write_bytes(generated.data)
        result = run_target(self.campaign.entry, pending, generated.data, timeout_sec=float(self.runtime["execTimeoutSec"]), cwd=self.session_dir)
        verdict = self.oracle.judge(result.stderr, timed_out=result.timed_out)
        suffix = "_triggered" if verdict.triggered else "_reached" if verdict.reached else ""
        testcase = self.testcases_dir / (name + suffix)
        pending.replace(testcase)

        if verdict.reached:
            t.reached += 1
            t.reaching.append((len(generated.data), str(testcase)))
        if verdict.triggered:
            t.triggered += 1
            poc = self.crashes_dir / f"poc_{name}"
            # The triggering bytes are already on disk as `testcase`; hardlink the stable PoV pointer
            # in crashes/ to it instead of writing the same bytes a second time (half the I/O and
            # disk, which matters on a large crash corpus). Fall back to a byte copy when a link
            # cannot be made (e.g. crashes/ on a different filesystem than testcases/).
            try:
                if poc.exists() or poc.is_symlink():
                    poc.unlink()
                os.link(testcase, poc)
            except OSError:
                poc.write_bytes(generated.data)
            if t.first_trigger is None:
                t.first_trigger = str(poc)
        if result.timed_out:
            t.timeouts += 1

        record.update({
            "type": "iter_result",
            "parameters": generated.used_params if generated.used_params is not None else params,
            "reached": verdict.reached_count, "triggered": verdict.triggered_count,
            "timeout": result.timed_out, "exit_code": result.exit_code, "duration_ms": result.duration_ms,
            "testcase_file": str(testcase), "size": len(generated.data),
        })
        if result.signal_name:
            record["signal"] = result.signal_name
        if trace and self.tracer is not None and self.plan["breakpoints"]:
            observation = self._trace(testcase)
            if observation is not None:
                self._traced += 1
                record["trace"] = observation
                self._observations.append({"iter": iteration, "plan_description": description, "parameters": record["parameters"], "reached": verdict.reached, "triggered": verdict.triggered, **observation})
        self._record(record, handle)
        if stage == 1 or verdict.reached or verdict.triggered:
            self.notify("iteration", {k: record[k] for k in ("iter", "stage", "type", "reached", "triggered", "timeout", "exit_code", "testcase_file")})
        return record

    # -- the loop ------------------------------------------------------------

    def _reproduce(self, input_path: str, times: int = REPRODUCE_TIMES) -> tuple[int, int]:
        """Re-run a triggering input to see whether it triggers again, and how reliably.

        A PoV is only a PoV if it reproduces, and the agent has no way to establish that from
        engine evidence — in a recorded session it ran the target four times by hand through the
        shell to fill in a `reproduced_times` field, which cost 11s and which
        `pbfuzz_reflect` then never read. The engine is the one party that can answer this
        honestly, so it does, once, here.

        Never raises: a failure to re-run is reported as zero successes, not as a lost session
        whose real trigger evidence is already recorded.

        Args:
            input_path: The input that triggered.
            times: How many re-runs to attempt.

        Returns:
            `(attempted, triggered_again)`.
        """
        path = Path(input_path)
        try:
            data = path.read_bytes()
        except OSError:
            return (0, 0)
        ok = 0
        for _ in range(times):
            try:
                result = run_target(self.campaign.entry, path, data, timeout_sec=float(self.runtime["execTimeoutSec"]), cwd=self.session_dir)
            except EngineError:
                continue
            if self.oracle.judge(result.stderr, timed_out=result.timed_out).triggered:
                ok += 1
        return (times, ok)

    def run(self) -> dict[str, Any]:
        """Execute both stages and return a `FuzzRunResult`."""
        started = time.monotonic()
        max_iters = int(self.runtime["maxIters"])
        fuzz_timeout = float(self.runtime["fuzzTimeoutSec"])
        trace_all = bool(self.runtime["enableDebuggerForAll"])
        batch = self.plan["_batch_params"]
        descriptions = [e.get("plan_description") for e in (self.plan.get("next_batch_plan") or [])]
        minimum = int(self.runtime["stage1MinConcreteParams"])
        if len(batch) < minimum:
            self._log("warn", f"next_batch_plan has {len(batch)} concrete entries; settings ask for at least {minimum} so stage 1 actually tests the hypothesis")

        stopped_by = "completed"
        fatal: EngineError | None = None
        cancelled = False
        iteration = 0
        # F20-engine: a mid-run (non-fatal) error still needs its diagnosis to reach the
        # `FuzzRunResult` a caller inspects after the fact, not just the "iteration" notification
        # and the iterations.jsonl record. Captured whenever `stopped_by` becomes "error"; only
        # surfaced in `summary` for the non-fatal case, since the fatal case raises instead of
        # returning a summary at all.
        last_error: dict[str, str] | None = None
        try:
            with self.iterations_path.open("w", encoding="utf-8") as handle:
                seen: set[str] = set()
                for stage in (1, 2):
                    if stopped_by != "completed" or cancelled:
                        break
                    candidates = iter(range(len(batch)) if stage == 1 else range(iteration + 1, max_iters + 1))
                    # `generate()` is batched (`self.sandbox.generate_many()`) in bounded chunks
                    # of `GENERATE_BATCH_SIZE`, not the whole stage at once: the outer `while`
                    # below plans one sub-batch of (idx, params, description) entries, generates
                    # all of them in one round trip to the sandbox worker, then processes each
                    # against the real target one at a time — checking `fuzz.cancel`/the fuzz
                    # timeout before every single target run, exactly as the old one-call-per-
                    # iteration loop did. That alone would only make responsiveness *between*
                    # sub-batches unchanged, not between iterations — a sub-batch's own up-to-
                    # `GENERATE_BATCH_SIZE` sandbox calls are not otherwise interruptible, so a
                    # slow or crash-looping generator could blow the fuzz timeout by a whole
                    # sub-batch's worth of restart-and-detect cost before control ever returned
                    # here. `should_stop` below closes that gap: `generate_many()` polls it
                    # between requests and cuts the sub-batch short the moment it fires, so
                    # responsiveness stays at roughly one target-run's scale, not one
                    # sub-batch's.
                    while stopped_by == "completed" and not cancelled:
                        planned: list[tuple[int, dict[str, Any], str | None]] = []
                        for idx in candidates:
                            if iteration + len(planned) >= max_iters:
                                break
                            if self.cancel.is_set():
                                cancelled = True
                                stopped_by = "cancelled"
                                break
                            if time.monotonic() - started >= fuzz_timeout:
                                stopped_by = "timeout"
                                break
                            if stage == 1:
                                params, desc = dict(batch[idx]), descriptions[idx]
                                params.setdefault("seed", idx + 1)
                            else:
                                params, desc = sample_from_space(self.plan["parameter_space"], seed=idx), None
                                # `seed` differs on every draw; dedup on the rest, as the old
                                # engine effectively did for small spaces.
                                dedup = json.dumps({k: v for k, v in params.items() if k != "seed"}, sort_keys=True, default=str)
                                if dedup in seen and self.plan["parameter_space"]:
                                    continue
                                seen.add(dedup)
                            planned.append((idx, fit_kwargs(params, self.signature), desc))
                            if len(planned) >= GENERATE_BATCH_SIZE:
                                break
                        if not planned:
                            break  # candidates exhausted, or a stop condition fired with nothing queued
                        generated_results = self.sandbox.generate_many(
                            [p for _, p, _ in planned],
                            should_stop=lambda: self.cancel.is_set() or time.monotonic() - started >= fuzz_timeout,
                        )
                        for (idx, params, desc), generated in zip(planned, generated_results):
                            if self.cancel.is_set():
                                cancelled = True
                                stopped_by = "cancelled"
                                break
                            if time.monotonic() - started >= fuzz_timeout:
                                stopped_by = "timeout"
                                break
                            iteration += 1
                            record = self._run_one(iteration, stage, params, desc, stage == 1 or trace_all, handle, generated)
                            self._progress(stage, iteration, started)
                            if record.get("type") == "error":
                                exc: SandboxError = record.pop("_error")
                                stopped_by = "error"
                                last_error = {"phase": record.get("phase", ""), "message": exc.message, "diagnosis": exc.diagnosis}
                                if self._tally.iterations - self._tally.errors == 0:
                                    fatal = exc
                                break
                            if record.get("triggered"):
                                stopped_by = "trigger"
                                break
                    if stage == 1 and not cancelled and stopped_by == "completed":
                        self._progress(1, iteration, started, force=True)
        except EngineError as exc:
            stopped_by, fatal = "error", exc
        finally:
            self.sandbox.close()
            elapsed = time.monotonic() - started
            t = self._tally
            best = [p for _, p in sorted(t.reaching)[:BEST_REACHING_LIMIT]]
            reproduced = self._reproduce(t.first_trigger) if stopped_by == "trigger" and t.first_trigger else None
            self.metrics.record_session(
                SessionMetrics(
                    iterations=t.iterations, reached=t.reached, triggered=t.triggered, timeouts=t.timeouts,
                    errors=t.errors, elapsed_sec=elapsed, stopped_by=stopped_by,
                    first_triggering_input=t.first_trigger, best_reaching_input=best[0] if best else None,
                    reproduced_times=None if reproduced is None else reproduced[0],
                    reproduced_ok=None if reproduced is None else reproduced[1],
                ),
                campaign_id=self.campaign.id, pier_round=self.pier_round,
            )

        self._progress(2, iteration, started, force=True)
        if cancelled:
            raise EngineError(
                CANCELLED, f"fuzz.run cancelled after {t.iterations} iterations",
                diagnosis=f"fuzz.cancel was received. The {t.iterations} completed iterations are recorded in metrics.json and {self.iterations_path}.",
                remedies=[remedy("rerun", "Run fuzz.run again", effect="retry")],
            )
        if fatal is not None:
            if isinstance(fatal, SandboxError):
                raise EngineError(
                    GENERATOR_FAILED, f"generator failed before any input ran: {fatal.message}",
                    diagnosis=fatal.diagnosis, remedies=fatal.remedies,
                )
            raise fatal

        summary: dict[str, Any] = {
            "totalIterations": t.iterations, "reachedCount": t.reached, "triggeredCount": t.triggered,
            "timeoutCount": t.timeouts, "errorCount": t.errors, "elapsedSec": round(elapsed, 3), "stoppedBy": stopped_by,
        }
        if stopped_by == "error" and last_error is not None:
            # Only reachable here for the non-fatal case (see `fatal` handling above): a caller
            # that only inspects the RPC result now sees why the run stopped early, without
            # having to tail "iteration" notifications or read iterations.jsonl.
            summary["errorPhase"] = last_error["phase"]
            summary["errorMessage"] = last_error["message"]
            summary["errorDiagnosis"] = last_error["diagnosis"]
        result: dict[str, Any] = {
            "summary": summary,
            "metricsPath": str(self.metrics.path),
            "iterationsPath": str(self.iterations_path),
            "bestReachingInputs": best,
            "stage1": {"entries": len(batch), "tracedEntries": self._traced, "observations": self._observations},
        }
        if t.first_trigger:
            result["firstTriggeringInput"] = t.first_trigger
        return result
