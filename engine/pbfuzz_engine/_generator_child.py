"""The sandbox's child process. Not imported by the engine — only executed.

Run as `python -m pbfuzz_engine._generator_child`. It reads one JSON request from stdin,
imports a model-written module (a generator or a parameter extractor), calls one function in
it, and reports back:

* mode `bytes` (generators): `generate(**kwargs)` must return bytes (or the legacy
  `(bytes, used_params)` tuple); the bytes are written to `out_path`.
* mode `json` (extractors): the function's return value is JSON-encoded into `out_path`.

Exactly one JSON status line is printed on fd 1, as the last line of output.

This module runs with model-written code in its address space. The engine process never does:
that separation is the point of the sandbox, so code that segfaults, allocates 40 GB or calls
`sys.exit()` takes down only this child.

Run as `python -m pbfuzz_engine._generator_child --worker` instead, `worker_main()` serves the
SAME two modes over a long-lived NDJSON request/response loop on stdin/stdout, importing the
module exactly once instead of once per call — see its docstring. That entry point is additive:
`main()` above is unchanged and stays reachable the same way for any caller that wants a fully
isolated one-shot call (a fresh interpreter, a fresh address space, no state left over from a
previous call).
"""

from __future__ import annotations

import collections  # noqa: F401 - see "sys.modules priming" comment below
import importlib.util
import json
import os
import random  # noqa: F401 - see "sys.modules priming" comment below
import re  # noqa: F401 - see "sys.modules priming" comment below
import resource
import string  # noqa: F401 - see "sys.modules priming" comment below
import struct  # noqa: F401 - see "sys.modules priming" comment below
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

try:
    import numpy  # noqa: F401 - see "sys.modules priming" comment below
except ImportError:
    pass

#: sys.modules priming: `worker_main()`'s `_load_function(..., extra_sys_path=...)` inserts the
#: GENERATOR's OWN directory into `sys.path[0]` before the module -- with `_COMMON_IMPORTS_
#: PREAMBLE` prepended to its source -- is exec'd (so sibling-helper imports the generator
#: author intends, e.g. `from helper import x`, still resolve). That means a bare `import
#: <name>` inside the preamble resolves to a same-named file sitting next to the generator
#: instead of the real stdlib module, for any `<name>` not ALREADY in `sys.modules` by the time
#: the module is exec'd. `os`/`sys` above are already this module's own top-level imports, and
#: `typing` is already forced by `from typing import Any` below, but `collections`/`random`/
#: `re`/`string`/`struct`/`numpy` were previously cached only "by accident" (e.g. `tempfile`
#: happens to import `random` internally) or not at all (`struct`/`string` were NOT cached and
#: were exploitable: a `struct.py`/`string.py` sibling silently shadowed the stdlib module).
#: Importing every name the preamble injects HERE makes that immunity deliberate for all of
#: them instead of incidental for some. None of these six are otherwise used in this file --
#: they exist solely to populate `sys.modules` before `worker_main` ever runs.

#: Ported from the CCS'26 artifact's `_inject_common_imports` (property_based_fuzzer.py):
#: forgetting to `import struct`/`random` was the single most common model-generator mistake,
#: and paying a full round trip (in the worker: an aborted batch item) to report a `NameError`
#: for a name almost every generator eventually needs is wasteful. `numpy` is best-effort since
#: it is not a guaranteed dependency of the engine's own environment.
_COMMON_IMPORTS_PREAMBLE = (
    "import random\n"
    "import struct\n"
    "import os\n"
    "import sys\n"
    "import re\n"
    "import string\n"
    "from typing import Dict, List, Any, Optional, Callable, Tuple, Union\n"
    "from collections import defaultdict, Counter, deque\n"
    "try:\n"
    "    import numpy as np\n"
    "except ImportError:\n"
    "    pass\n"
)


def _apply_limits(mem_mb: int, cpu_sec: int) -> list[str]:
    """Apply rlimits before the model-written module is imported.

    Returns the names of limits that could not be applied, so the parent reports honestly
    rather than claiming a sandbox it does not have. `RLIMIT_AS` is enforced on Linux (the
    deployment target) but is unreliable on macOS.
    """
    unenforced: list[str] = []
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (ValueError, OSError):
        unenforced.append("RLIMIT_CORE")
    if cpu_sec > 0:
        try:
            # Hard limit one second above soft: Linux sends SIGKILL (not SIGXCPU) when the
            # hard limit is reached, so equal limits would hide the CPU-limit diagnosis.
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_sec, cpu_sec + 1))
        except (ValueError, OSError):
            unenforced.append("RLIMIT_CPU")
    if mem_mb > 0:
        limit = mem_mb * 1024 * 1024
        try:
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        except (ValueError, OSError):
            unenforced.append("RLIMIT_AS")
    return unenforced


def _load_function(module_path: str, function: str, *, extra_sys_path: str | None = None):
    """Import the module from its file path and return `function` from it.

    Args:
        extra_sys_path: An additional directory to add to `sys.path` (highest priority), used
            by the worker entry point when `module_path` is a prepared copy living in a
            different directory than the original module — so sibling files the model's code
            imports (`from helper import x` next to its own `generate.py`) still resolve.
    """
    spec = importlib.util.spec_from_file_location("pbfuzz_sandboxed", module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load a Python module from {module_path}")
    module = importlib.util.module_from_spec(spec)
    # Registered so dataclasses/pickle inside the module can find themselves.
    sys.modules["pbfuzz_sandboxed"] = module
    sys.path.insert(0, os.path.dirname(os.path.abspath(module_path)))
    if extra_sys_path and extra_sys_path not in sys.path:
        sys.path.insert(0, extra_sys_path)
    spec.loader.exec_module(module)
    if not hasattr(module, function):
        raise AttributeError(f"{module_path} defines no `{function}` function")
    fn = getattr(module, function)
    if not callable(fn):
        raise TypeError(f"`{function}` in {module_path} is not callable")
    return fn


def _prepare_module_source(module_path: str, work_dir: str) -> str:
    """Copy `module_path` into `work_dir` with `_COMMON_IMPORTS_PREAMBLE` prepended.

    The names are injected into the module's SOURCE text before it is imported — not poked
    into an already-imported module's namespace — so introspection inside the model's own code
    (`dir()`, `inspect`) sees ordinary top-level imports, not magic, and the module is still
    imported exactly once by the normal `_load_function` path.
    """
    original = Path(module_path)
    source = original.read_text(encoding="utf-8", errors="replace")
    prepared = Path(work_dir) / f"prepared-{original.name}"
    prepared.write_text(_COMMON_IMPORTS_PREAMBLE + "\n" + source, encoding="utf-8")
    return str(prepared)


def _coerce_bytes(produced: Any) -> tuple[bytes, dict[str, Any] | None]:
    """Accept the contract's `bytes` return and the legacy `(bytes, used_params)` tuple.

    contracts/engine-rpc.schema.json specifies `generate(**params) -> bytes`. The CCS'26
    generators returned `(bytes, used_params)`; both are accepted, and the tuple form's
    resolved values are kept for the iteration record.
    """
    if isinstance(produced, (bytes, bytearray)):
        return bytes(produced), None
    if isinstance(produced, tuple) and len(produced) == 2:
        data, used = produced
        if isinstance(data, (bytes, bytearray)):
            return bytes(data), used if isinstance(used, dict) else None
    raise TypeError(
        f"generate() must return bytes (or a (bytes, dict) tuple), got {type(produced).__name__}"
    )


def main() -> int:
    """Entry point. Always ends its output with exactly one JSON status line on fd 1."""
    status: dict[str, Any] = {"ok": False}
    try:
        request = json.loads(sys.stdin.read())
        status["unenforced_limits"] = _apply_limits(
            int(request.get("mem_mb", 0)), int(request.get("cpu_sec", 0))
        )
        fn = _load_function(request["module_path"], request.get("function", "generate"))
        mode = request.get("mode", "bytes")
        if mode == "bytes":
            data, used = _coerce_bytes(fn(**request.get("kwargs", {})))
            with open(request["out_path"], "wb") as handle:
                handle.write(data)
            status["size"] = len(data)
            if used is not None:
                status["used_params"] = used
        else:
            value = fn(*request.get("args", []), **request.get("kwargs", {}))
            with open(request["out_path"], "w", encoding="utf-8") as handle:
                json.dump(value, handle, default=repr)
        status["ok"] = True
    except MemoryError:
        status["error"] = "MemoryError: the sandboxed code exceeded its memory limit"
        status["kind"] = "memory"
    except BaseException as exc:  # noqa: BLE001 - model code may raise or exit arbitrarily
        status["error"] = f"{type(exc).__name__}: {exc}"
        status["kind"] = "exception"
        status["traceback"] = traceback.format_exc(limit=12)
    # os.write on fd 1 rather than print(): code that replaced or closed sys.stdout must not
    # be able to corrupt or swallow the status line. The parent reads the LAST line.
    os.write(1, ("\n" + json.dumps(status, default=str) + "\n").encode("utf-8", errors="replace"))
    return 0 if status.get("ok") else 1


def worker_main() -> int:
    """Long-lived worker entry point: `python -m pbfuzz_engine._generator_child --worker`.

    Amortises the interpreter-start cost `main()` pays on every single call across many calls
    to the SAME generator/extractor module, for `sandbox.BatchedGeneratorSandbox`. Framing is
    NDJSON, one line each way:

    1. Exactly one CONFIG line on stdin: `{module_path, function, mode, mem_mb, cpu_sec}`.
       Rlimits are applied once (`_apply_limits`, same as `main()`), the module's source is
       prepared once (`_prepare_module_source`) and imported once (`_load_function`) — never
       per request.
    2. Then, forever: one REQUEST line = `{id, kwargs}` (mode `bytes`) or `{id, args}` (mode
       `json`), answered by exactly one RESPONSE line = `{id, ok, out_path, used_params?,
       unenforced_limits}` on success, or `{id, ok: false, error, kind, traceback}` on an
       ordinary Python exception raised by the model's function — caught here exactly like
       `main()` catches it, so it does NOT end the worker; the loop reads the next request line.
       Output for request `id` is written to `<work_dir>/out-<id>`, inside the ONE
       `TemporaryDirectory` this function creates, which outlives every request the worker
       serves and is removed when the worker exits.
    3. EOF on stdin (the parent closed its write end) ends the loop and the process cleanly.

    A genuinely fatal failure — the model's code calling `os._exit()`, a real crash/signal, or
    a fatal interpreter error near the RLIMIT_AS boundary — ends this PROCESS with no response
    line for whatever request was in flight. That is by design: this function does not try to
    catch what cannot be caught. The parent (`sandbox.BatchedGeneratorSandbox`) detects it by
    EOF/a broken pipe on read, records the in-flight item as a `SandboxError`, and starts a
    fresh worker for whatever was still unsent — see its docstring for the restart protocol.
    """
    config_line = sys.stdin.readline()
    if not config_line:
        return 0
    config = json.loads(config_line)
    unenforced_limits = _apply_limits(int(config.get("mem_mb", 0)), int(config.get("cpu_sec", 0)))
    mode = config.get("mode", "bytes")
    function = config.get("function", "generate")

    with tempfile.TemporaryDirectory(prefix="pbfuzz-worker-") as work_dir:
        prepared_path = _prepare_module_source(config["module_path"], work_dir)
        fn = _load_function(function=function, module_path=prepared_path, extra_sys_path=str(Path(config["module_path"]).resolve().parent))

        while True:
            request_line = sys.stdin.readline()
            if not request_line:
                break
            try:
                request = json.loads(request_line)
            except json.JSONDecodeError:
                # Nothing sane to report against (no `id` to answer to); a confused/desynced
                # parent should not be able to wedge the loop, so just wait for the next line.
                continue
            req_id = request.get("id")
            out_path = os.path.join(work_dir, f"out-{req_id}")
            response: dict[str, Any] = {"id": req_id, "unenforced_limits": unenforced_limits}
            try:
                if mode == "bytes":
                    data, used = _coerce_bytes(fn(**request.get("kwargs", {})))
                    with open(out_path, "wb") as handle:
                        handle.write(data)
                    if used is not None:
                        response["used_params"] = used
                else:
                    value = fn(*request.get("args", []), **request.get("kwargs", {}))
                    with open(out_path, "w", encoding="utf-8") as handle:
                        json.dump(value, handle, default=repr)
                response["ok"] = True
                response["out_path"] = out_path
            except MemoryError:
                response["ok"] = False
                response["error"] = "MemoryError: the sandboxed code exceeded its memory limit"
                response["kind"] = "memory"
            except BaseException as exc:  # noqa: BLE001 - model code may raise arbitrarily; see docstring
                response["ok"] = False
                response["error"] = f"{type(exc).__name__}: {exc}"
                response["kind"] = "exception"
                response["traceback"] = traceback.format_exc(limit=12)
            os.write(1, (json.dumps(response, default=str) + "\n").encode("utf-8", errors="replace"))
    return 0


if __name__ == "__main__":
    if "--worker" in sys.argv[1:]:
        raise SystemExit(worker_main())
    raise SystemExit(main())
