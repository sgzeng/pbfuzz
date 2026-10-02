"""The sandbox for model-written code.

Generators (`generate(**params) -> bytes`) and parameter extractors
(`extract_parameters(file_path) -> dict`) are written by the model. The CCS'26 engine imported
them into its own process and ran them on a thread with a join timeout — which cannot actually
stop a runaway generator (Python threads are not killable), shares the engine's memory, and lets
`sys.exit()` or a segfault in a C extension take the whole engine down.

Here every call runs in a fresh child process (`python -m pbfuzz_engine._generator_child`) with
`RLIMIT_AS`/`RLIMIT_CPU`/`RLIMIT_CORE` applied before the module is imported, its own session so
the whole process group can be killed, and a wall-clock timeout. The engine process never
imports the code.

The cost is one interpreter start per call (tens of milliseconds). Target executions usually
dominate, and the isolation is worth it.
"""

from __future__ import annotations

import json
import os
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .errors import GENERATOR_FAILED, EngineError, remedy
from .proc import kill_session

_ENGINE_ROOT = str(Path(__file__).resolve().parent.parent)


class SandboxError(EngineError):
    """A sandboxed call failed. `kind` is one of: timeout, exception, memory, crash, protocol."""

    def __init__(self, kind: str, message: str, *, diagnosis: str, remedies: list[dict[str, Any]], traceback: str = "") -> None:
        super().__init__(GENERATOR_FAILED, message, diagnosis=diagnosis, remedies=remedies)
        self.kind = kind
        self.traceback = traceback


@dataclass(frozen=True)
class SandboxLimits:
    """Resource limits for one sandboxed call (settings `execution.generator*`)."""

    timeout_sec: float = 1.0
    mem_mb: int = 512
    cpu_sec: int = 10


@dataclass
class GeneratedInput:
    """The output of one generator call."""

    data: bytes
    used_params: dict[str, Any] | None = None
    unenforced_limits: list[str] = field(default_factory=list)


def _kill_group(proc: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        proc.kill()


def _child_env() -> dict[str, str]:
    env = dict(os.environ)
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = _ENGINE_ROOT + (os.pathsep + existing if existing else "")
    return env


def _error_for_failed_status(status: dict[str, Any], *, what: str, function: str, module_path: str, mem_mb: int) -> SandboxError:
    """Build the `SandboxError` for a child/worker status line reporting `ok: false`.

    Shared by the one-shot `run_sandboxed` and the batched worker path
    (`BatchedGeneratorSandbox`), so the two report the exact same message/diagnosis shape for
    the same underlying failure.
    """
    kind = status.get("kind", "exception")
    message = status.get("error", "unknown error")
    tb = status.get("traceback", "")
    if kind == "memory":
        return SandboxError(
            "memory", f"{what} exceeded its {mem_mb} MB memory limit",
            diagnosis=f"`{function}` raised MemoryError under RLIMIT_AS={mem_mb} MB.",
            remedies=[
                remedy("shrink", "Generate smaller inputs", detail="Clamp sampled sizes; most targets need kilobytes, not gigabytes.", effect="manual"),
                remedy("raise_mem", "Raise generatorMemLimitMB in pbfuzz settings", effect="retry"),
            ],
        )
    return SandboxError(
        "exception", f"{what} raised {message}",
        diagnosis=f"`{function}` in {module_path} failed: {message}\n{tb}".rstrip(),
        remedies=[
            remedy("fix_code", f"Fix the {what}", detail="The traceback above points at the failing line.", effect="manual"),
            remedy("validate", "Run generator.validate before fuzzing", detail="It exercises the generator on the batch plan without running the target.", effect="retry"),
        ],
        traceback=tb,
    )


def run_sandboxed(
    module_path: str | Path,
    function: str,
    *,
    mode: str,
    kwargs: dict[str, Any] | None = None,
    args: list[Any] | None = None,
    limits: SandboxLimits = SandboxLimits(),
    python: str | None = None,
    what: str = "generator",
) -> tuple[bytes, dict[str, Any]]:
    """Call `function` from `module_path` in a sandboxed child process.

    Returns:
        `(raw_output_bytes, status)` where status is the child's JSON status line.

    Raises:
        SandboxError: With a diagnosis and remedies for every failure mode.
    """
    module_path = str(Path(module_path).resolve())
    with tempfile.TemporaryDirectory(prefix="pbfuzz-sbx-") as tmp:
        out_path = os.path.join(tmp, "out")
        request = {
            "module_path": module_path,
            "function": function,
            "mode": mode,
            "kwargs": kwargs or {},
            "args": args or [],
            "out_path": out_path,
            "mem_mb": limits.mem_mb,
            "cpu_sec": limits.cpu_sec,
        }
        try:
            payload = json.dumps(request, default=str).encode()
        except (TypeError, ValueError) as exc:
            raise SandboxError(
                "protocol", f"{what} arguments are not JSON-serialisable",
                diagnosis=f"The parameters could not be encoded for the sandbox: {exc}",
                remedies=[remedy("fix_params", "Use JSON-compatible parameter values", effect="edit_campaign")],
            ) from exc

        proc = subprocess.Popen(
            [python or sys.executable, "-m", "pbfuzz_engine._generator_child"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=tmp,
            env=_child_env(),
            start_new_session=True,
        )
        try:
            stdout, stderr = proc.communicate(payload, timeout=limits.timeout_sec)
        except subprocess.TimeoutExpired:
            _kill_group(proc)
            proc.communicate()
            raise SandboxError(
                "timeout", f"{what} timed out after {limits.timeout_sec}s",
                diagnosis=(
                    f"`{function}` in {module_path} did not return within {limits.timeout_sec}s and "
                    f"was killed. Usual causes: an unbounded loop over a sampled size, or building a "
                    f"huge buffer byte by byte."
                ),
                remedies=[
                    remedy("bound_loops", f"Bound the loops in the {what}", detail="Clamp any size drawn from the parameter space before looping on it.", effect="manual"),
                    remedy("raise_timeout", "Raise generatorTimeoutSec", detail="Per-run override `runtime.generatorTimeoutSec`, or the pbfuzz settings default.", effect="retry"),
                ],
            ) from None

        err_text = stderr.decode("utf-8", errors="replace")[-2000:]
        status = _parse_status(stdout)
        if status is None:
            sig = -proc.returncode if proc.returncode and proc.returncode < 0 else None
            killed_by = signal.Signals(sig).name if sig and sig in signal.Signals._value2member_map_ else (f"signal {sig}" if sig else f"exit code {proc.returncode}")
            cpu = sig == signal.SIGXCPU if hasattr(signal, "SIGXCPU") and sig else False
            raise SandboxError(
                "crash", f"{what} process died ({killed_by})",
                diagnosis=(
                    f"The sandbox child running `{function}` from {module_path} terminated with "
                    f"{killed_by} before reporting a result"
                    + (" — it exceeded its CPU-time limit." if cpu else ".")
                    + (f" stderr tail: {err_text.strip()}" if err_text.strip() else "")
                ),
                remedies=[
                    remedy("inspect", f"Run the {what} by hand to reproduce", detail=f"{sys.executable} -c \"import runpy; runpy.run_path({module_path!r})\"", effect="manual"),
                    remedy("raise_limits", "Raise generatorCpuLimitSec / generatorMemLimitMB", effect="retry"),
                ],
            )
        if not status.get("ok"):
            raise _error_for_failed_status(status, what=what, function=function, module_path=module_path, mem_mb=limits.mem_mb)
        try:
            with open(out_path, "rb") as handle:
                raw = handle.read()
        except OSError as exc:
            raise SandboxError(
                "protocol", f"{what} reported success but wrote no output",
                diagnosis=f"The sandbox output file was missing: {exc}",
                remedies=[remedy("retry", "Retry", effect="retry")],
            ) from exc
        return raw, status


def _parse_status(stdout: bytes) -> dict[str, Any] | None:
    """The child's status is the last non-empty line; earlier lines are the code's own prints."""
    for line in reversed(stdout.decode("utf-8", errors="replace").splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            return None
        return value if isinstance(value, dict) and "ok" in value else None
    return None


class GeneratorSandbox:
    """Calls a generator module's `generate(**params)` out of process.

    Args:
        generator_path: The model-written module.
        limits: Timeout and rlimits for each call.
        python: Interpreter for the child; defaults to the engine's own.
    """

    def __init__(self, generator_path: str | Path, limits: SandboxLimits = SandboxLimits(), python: str | None = None) -> None:
        self.generator_path = Path(generator_path)
        self.limits = limits
        self.python = python
        if not self.generator_path.is_file():
            raise SandboxError(
                "protocol", f"generator not found: {self.generator_path}",
                diagnosis=f"No generator module exists at `{self.generator_path}`; IMPLEMENT writes it before EXECUTE.",
                remedies=[
                    remedy("write_generator", "Write the generator", detail="A module exposing `generate(**params) -> bytes`.", effect="manual"),
                    remedy("fix_path", "Correct generatorPath / fuzz_plan.generator_path", effect="edit_campaign"),
                ],
            )

    def check_syntax(self) -> None:
        """Compile (never execute) the generator source, so syntax errors surface precisely."""
        source = self.generator_path.read_text(encoding="utf-8", errors="replace")
        try:
            compile(source, str(self.generator_path), "exec")
        except SyntaxError as exc:
            raise SandboxError(
                "exception", f"generator has a syntax error at line {exc.lineno}",
                diagnosis=f"{self.generator_path}:{exc.lineno}:{exc.offset}: {exc.msg}\n{(exc.text or '').rstrip()}",
                remedies=[remedy("fix_syntax", "Fix the syntax error", effect="manual")],
            ) from exc

    def generate(self, params: dict[str, Any]) -> GeneratedInput:
        """Produce one input from `params`."""
        raw, status = run_sandboxed(
            self.generator_path, "generate", mode="bytes", kwargs=params,
            limits=self.limits, python=self.python, what="generator",
        )
        return GeneratedInput(data=raw, used_params=status.get("used_params"), unenforced_limits=list(status.get("unenforced_limits", [])))


def call_extractor(extractor_path: str | Path, input_path: str, limits: SandboxLimits, python: str | None = None) -> Any:
    """Run `extract_parameters(input_path)` from a model-written extractor in the sandbox."""
    raw, _ = run_sandboxed(
        extractor_path, "extract_parameters", mode="json", args=[input_path],
        limits=limits, python=python, what="extractor",
    )
    return json.loads(raw.decode("utf-8"))


#: Read granularity for `BatchedGeneratorSandbox._read_response_line`'s `os.read` calls. One
#: response line (a status dict plus a short `out_path`) is always far smaller than this.
_WORKER_READ_CHUNK = 65536


class BatchedGeneratorSandbox:
    """Drives one long-lived `_generator_child --worker` process across many calls.

    `GeneratorSandbox.generate()`/`call_extractor()` each pay a fresh fork+exec+CPython-boot
    (measured at ~416ms) per call — fine for a handful of calls, but 571 iterations of a fuzz
    stage cost 237s of that alone. This class amortises the interpreter start across a whole
    batch by keeping one worker process alive and sending it one request per line
    (`_generator_child.worker_main`'s protocol).

    Crash/timeout resilience: a per-call timeout, or the worker dying mid-call (a segfault, a
    fatal error near the memory-limit boundary, `os._exit()`), is detected by
    `_read_response_line` returning no line before the deadline. Either way the whole worker
    session is killed (`proc.kill_session`, the same process-group-and-session-wide kill
    `run_target` uses — a bare SIGKILL of the direct child is not enough if the model's code
    forked something) and a fresh worker is started for the remaining items; the failed item is
    recorded as its own `SandboxError` rather than losing the rest of the batch. Distinguishing
    the two: a timeout means the worker is presumably still alive but slow (`poll()` returns
    None); a crash means it has already exited (`poll()` returns a status) — both still restart
    and continue, but are reported with a different `kind` so the diagnosis is honest.

    Cancellation: `generate_many()`/`call_extractor_many()` take an optional `should_stop`
    callable, polled between requests (see `_run_batch`), so a caller iterating in bounded
    sub-batches (`FuzzSession.run()`) can cut a batch short instead of always waiting for every
    item — a batch of otherwise-uninterruptible calls would each pay its own restart-and-detect
    cost before control ever returned to the caller.

    Args:
        generator_path: The model-written module (a generator OR an extractor — `function`
            picks which entry point).
        limits: Timeout and rlimits for each call. `limits.timeout_sec` bounds each individual
            request, not the whole batch.
        python: Interpreter for the worker process; defaults to the engine's own.
        function: The function to call in the module (`generate` or `extract_parameters`).
        mode: `bytes` (generator; requests carry `kwargs`) or `json` (extractor; requests carry
            positional `args`).
        what: Noun used in error messages ("generator" / "extractor"), matching
            `run_sandboxed`'s `what`.
    """

    def __init__(
        self,
        generator_path: str | Path,
        limits: SandboxLimits = SandboxLimits(),
        python: str | None = None,
        *,
        function: str = "generate",
        mode: str = "bytes",
        what: str = "generator",
    ) -> None:
        self.generator_path = Path(generator_path)
        self.limits = limits
        self.python = python
        self.function = function
        self.mode = mode
        self.what = what
        if not self.generator_path.is_file():
            raise SandboxError(
                "protocol", f"{what} not found: {self.generator_path}",
                diagnosis=f"No {what} module exists at `{self.generator_path}`; IMPLEMENT writes it before EXECUTE.",
                remedies=[
                    remedy("write_generator", f"Write the {what}", detail="A module exposing the expected function.", effect="manual"),
                    remedy("fix_path", "Correct the configured path", effect="edit_campaign"),
                ],
            )
        self._proc: subprocess.Popen[bytes] | None = None
        self._buf = b""
        self._eof = False
        self._next_id = 0
        self._work_dir: str | None = None

    # -- worker lifecycle ------------------------------------------------------------------

    def _start(self) -> None:
        """Launch a fresh worker and send it its one config line."""
        self._work_dir = tempfile.mkdtemp(prefix="pbfuzz-worker-cwd-")
        self._proc = subprocess.Popen(
            [self.python or sys.executable, "-m", "pbfuzz_engine._generator_child", "--worker"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=self._work_dir, env=_child_env(), start_new_session=True,
        )
        assert self._proc.stdout is not None and self._proc.stdin is not None and self._proc.stderr is not None
        os.set_blocking(self._proc.stdout.fileno(), False)
        os.set_blocking(self._proc.stderr.fileno(), False)
        self._buf = b""
        config = {
            "module_path": str(self.generator_path.resolve()),
            "function": self.function,
            "mode": self.mode,
            "mem_mb": self.limits.mem_mb,
            "cpu_sec": self.limits.cpu_sec,
        }
        self._proc.stdin.write((json.dumps(config) + "\n").encode())
        self._proc.stdin.flush()

    def _ensure_started(self) -> None:
        if self._proc is None or self._proc.poll() is not None:
            self._kill_worker()
            self._start()

    def _drain_stderr_tail(self) -> str:
        """Best-effort, non-blocking read of whatever stderr the dying worker left behind."""
        if self._proc is None or self._proc.stderr is None:
            return ""
        chunks: list[bytes] = []
        try:
            while True:
                chunk = os.read(self._proc.stderr.fileno(), _WORKER_READ_CHUNK)
                if not chunk:
                    break
                chunks.append(chunk)
        except (BlockingIOError, OSError):
            pass
        return b"".join(chunks).decode("utf-8", errors="replace")[-2000:]

    def _kill_worker(self) -> None:
        """Tear down the current worker session (if any) so a fresh one can be started."""
        proc_ref, self._proc = self._proc, None
        self._buf = b""
        if proc_ref is None:
            return
        kill_session(proc_ref.pid)
        try:
            proc_ref.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            pass
        for stream in (proc_ref.stdin, proc_ref.stdout, proc_ref.stderr):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass

    def close(self) -> None:
        """Terminate the worker cleanly: EOF its stdin, wait briefly, then kill on the way out.

        Safe to call whether or not a worker is currently running, and safe to call more than
        once (a no-op after the first).
        """
        proc_ref = self._proc
        if proc_ref is not None and proc_ref.stdin is not None:
            try:
                proc_ref.stdin.close()
            except OSError:
                pass
            try:
                proc_ref.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                pass
        self._kill_worker()
        if self._work_dir is not None:
            shutil.rmtree(self._work_dir, ignore_errors=True)
            self._work_dir = None

    def __enter__(self) -> "BatchedGeneratorSandbox":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # -- the wire protocol -------------------------------------------------------------------

    def _read_response_line(self, deadline: float) -> bytes | None:
        """Read one newline-terminated response line, or `None` on timeout/EOF.

        Non-blocking reads on the worker's stdout fd, gated by `select.select()` so this
        actually enforces a per-call deadline — `Popen.communicate(timeout=...)` (the one-shot
        path's mechanism) only supports a single request/response pair per process, not
        picking one line at a time out of an otherwise still-open pipe.
        """
        assert self._proc is not None and self._proc.stdout is not None
        fd = self._proc.stdout.fileno()
        while b"\n" not in self._buf:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            ready, _, _ = select.select([fd], [], [], remaining)
            if not ready:
                continue
            try:
                chunk = os.read(fd, _WORKER_READ_CHUNK)
            except (BlockingIOError, InterruptedError):
                continue
            if not chunk:
                # EOF: the worker's stdout closed because it died. Remembered, because `poll()` may
                # still say "running" for a moment: the pipe closes before the child is reapable.
                self._eof = True
                return None
            self._buf += chunk
        line, _, self._buf = self._buf.partition(b"\n")
        return line

    def _run_batch(
        self,
        requests: list[dict[str, Any]],
        *,
        should_stop: Callable[[], bool] | None = None,
    ) -> list[tuple[bytes, dict[str, Any]] | SandboxError]:
        """Send each of `requests` (`{'kwargs': ...}` or `{'args': ...}`) to the worker in
        order, restarting it after any timeout/crash so one bad item never drops the rest.

        Returns one entry per request, in order: `(raw_output_bytes, response_status)` on
        success, or a `SandboxError` on failure.

        `should_stop`, if given, is polled once per remaining request, right before that
        request would be sent (so it never interrupts a request already in flight — only the
        gap between two requests). The moment it returns true, the loop stops sending and
        returns immediately with only the responses already collected. That means the returned
        list can be SHORTER than `requests` — the sentinel is the list's length, not a value in
        it, mirroring how a per-item `SandboxError` already tells a caller "this slot failed"
        without changing the shape of the other slots. This is what makes a bounded sub-batch
        (see `generate_many`'s caller, `FuzzSession.run()`) interruptible at roughly one
        request's latency instead of only before/after the whole batch: without it, a
        persistently slow or crash-looping generator pays its full restart-and-detect cost for
        every one of the up-to-`GENERATE_BATCH_SIZE` remaining items before a cancel or fuzz
        timeout is ever checked again.
        """
        results: list[tuple[bytes, dict[str, Any]] | SandboxError | None] = [None] * len(requests)
        module_path = str(self.generator_path)
        i = 0
        while i < len(requests):
            if should_stop is not None and should_stop():
                break
            self._ensure_started()
            assert self._proc is not None and self._proc.stdin is not None
            req_id = self._next_id
            self._next_id += 1
            body = {**requests[i], "id": req_id}
            try:
                payload = json.dumps(body, default=str).encode()
            except (TypeError, ValueError) as exc:
                results[i] = SandboxError(
                    "protocol", f"{self.what} arguments are not JSON-serialisable",
                    diagnosis=f"The parameters could not be encoded for the sandbox: {exc}",
                    remedies=[remedy("fix_params", "Use JSON-compatible parameter values", effect="edit_campaign")],
                )
                i += 1
                continue
            try:
                self._proc.stdin.write(payload + b"\n")
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError):
                self._kill_worker()
                continue  # retry the same item against a fresh worker

            deadline = time.monotonic() + self.limits.timeout_sec
            self._eof = False
            line = self._read_response_line(deadline)
            if line is None:
                crashed = self._eof or (self._proc is not None and self._proc.poll() is not None)
                stderr_tail = self._drain_stderr_tail()
                self._kill_worker()
                if crashed:
                    results[i] = SandboxError(
                        "crash", f"{self.what} worker process died",
                        diagnosis=(
                            f"The sandbox worker running `{self.function}` from {module_path} terminated "
                            "unexpectedly while this call was in flight (a signal, `os._exit()`, or a fatal "
                            "interpreter error). A fresh worker was started for the remaining items."
                            + (f" stderr tail: {stderr_tail.strip()}" if stderr_tail.strip() else "")
                        ),
                        remedies=[
                            remedy("inspect", f"Run the {self.what} by hand to reproduce", effect="manual"),
                            remedy("raise_limits", "Raise generatorCpuLimitSec / generatorMemLimitMB", effect="retry"),
                        ],
                    )
                else:
                    results[i] = SandboxError(
                        "timeout", f"{self.what} timed out after {self.limits.timeout_sec}s",
                        diagnosis=(
                            f"`{self.function}` in {module_path} did not return within {self.limits.timeout_sec}s "
                            "and the sandbox worker was killed. Usual causes: an unbounded loop over a sampled "
                            "size, or building a huge buffer byte by byte."
                        ),
                        remedies=[
                            remedy("bound_loops", f"Bound the loops in the {self.what}", detail="Clamp any size drawn from the parameter space before looping on it.", effect="manual"),
                            remedy("raise_timeout", "Raise generatorTimeoutSec", detail="Per-run override `runtime.generatorTimeoutSec`, or the pbfuzz settings default.", effect="retry"),
                        ],
                    )
                i += 1
                continue

            try:
                response = json.loads(line)
            except json.JSONDecodeError:
                self._kill_worker()
                results[i] = SandboxError(
                    "protocol", f"{self.what} worker produced a malformed response",
                    diagnosis=f"Could not parse a response line from the worker: {line[:200]!r}",
                    remedies=[remedy("retry", "Retry", effect="retry")],
                )
                i += 1
                continue
            if not response.get("ok"):
                results[i] = _error_for_failed_status(response, what=self.what, function=self.function, module_path=module_path, mem_mb=self.limits.mem_mb)
                i += 1
                continue
            out_path = response.get("out_path")
            try:
                with open(out_path, "rb") as handle:
                    raw = handle.read()
            except (OSError, TypeError) as exc:
                results[i] = SandboxError(
                    "protocol", f"{self.what} reported success but wrote no output",
                    diagnosis=f"The sandbox output file was missing: {exc}",
                    remedies=[remedy("retry", "Retry", effect="retry")],
                )
                i += 1
                continue
            results[i] = (raw, response)
            i += 1
        # Slots [0, i) were filled above; a `should_stop` break leaves [i, len(requests)) at
        # their `None` placeholder, so those are dropped rather than returned as fake results.
        return results[:i]  # type: ignore[return-value]

    # -- public API --------------------------------------------------------------------------

    def generate_many(
        self,
        params_list: list[dict[str, Any]],
        *,
        should_stop: Callable[[], bool] | None = None,
    ) -> list[GeneratedInput | SandboxError]:
        """Produce one input per entry of `params_list`, reusing one worker process.

        The batched counterpart of `GeneratorSandbox.generate()`: one entry in, one entry out,
        in order, never raising — a per-item failure (of any `SandboxError` kind) is returned
        in that item's slot instead of aborting the whole batch.

        `should_stop`, if given, is forwarded to `_run_batch` — see its docstring. When it
        fires partway through, the returned list is SHORTER than `params_list`; callers must
        `zip()` against their own inputs (as `FuzzSession.run()` does) rather than assume a
        1:1-length response, so a cancel/timeout lands within one sandbox round trip instead of
        waiting out the rest of the sub-batch.
        """
        raw_results = self._run_batch([{"kwargs": p} for p in params_list], should_stop=should_stop)
        out: list[GeneratedInput | SandboxError] = []
        for item in raw_results:
            if isinstance(item, SandboxError):
                out.append(item)
            else:
                raw, response = item
                out.append(GeneratedInput(data=raw, used_params=response.get("used_params"), unenforced_limits=list(response.get("unenforced_limits", []))))
        return out


def call_extractor_many(
    extractor_path: str | Path,
    input_paths: list[str],
    limits: SandboxLimits,
    python: str | None = None,
    *,
    should_stop: Callable[[], bool] | None = None,
) -> list[Any]:
    """Run `extract_parameters(input_path)` over many inputs, reusing one long-lived worker.

    The batched counterpart of `call_extractor()`, for `extract_parameters`'s per-seed loop.
    Returns one entry per `input_paths` entry, in order: the parsed JSON value on success, or a
    `SandboxError` on failure (never raises) — unless `should_stop` fires partway through, in
    which case (mirroring `generate_many`) fewer entries than `input_paths` come back.
    """
    sandbox = BatchedGeneratorSandbox(extractor_path, limits, python, function="extract_parameters", mode="json", what="extractor")
    try:
        raw_results = sandbox._run_batch([{"args": [str(p)]} for p in input_paths], should_stop=should_stop)
        out: list[Any] = []
        for item in raw_results:
            if isinstance(item, SandboxError):
                out.append(item)
            else:
                raw, _response = item
                out.append(json.loads(raw.decode("utf-8")))
        return out
    finally:
        sandbox.close()
