"""Child-process runner for the ``pymon`` tracer. Not imported by the engine.

Usage::

    python _pymon_runner.py <spec.json> <report.json> -- <argv of the target...>

It installs a line hook for the requested ``file:line`` pairs, runs the target
with ``runpy``, and writes the same JSON report the gdb and lldb backends write.
It uses :mod:`sys.monitoring` on Python ≥ 3.12 and falls back to
``sys.settrace``; both paths produce identical reports.

:module: pbfuzz_engine.tracers._pymon_runner
"""

from __future__ import annotations

import json
import linecache
import os
import runpy
import sys
import time
import traceback

MONITORING_TOOL_ID = 3  # the id reserved for profilers/debuggers by PEP 669

# N2: a plain per-hit flush caps a hot breakpoint at roughly one os.replace()
# syscall per hit. Batching hits into a periodic flush removes that ceiling;
# init and the final flush in main() still force an immediate write so
# evidence is never more than one interval stale when the run is killed.
FLUSH_INTERVAL_SEC = 0.25  # same design constant as gdb_batch.FLUSH_INTERVAL_SEC; kept separate on purpose (this file is a standalone leaf script, never importing from the package -- see module docstring)


def _normalise(path: str) -> str:
    try:
        return os.path.realpath(path)
    except OSError:
        return path


def _line_is_code(path: str, line: int) -> bool | None:
    """Whether ``path:line`` carries executable code, or None if unknowable."""
    if not os.path.exists(path):
        return False
    try:
        source = open(path, "r", encoding="utf-8", errors="replace").read()
        code = compile(source, path, "exec")
    except (OSError, SyntaxError):
        return None
    lines: set[int] = set()
    stack = [code]
    while stack:
        current = stack.pop()
        for _, _, lineno in current.co_lines():
            if lineno:
                lines.add(lineno)
        for const in current.co_consts:
            if hasattr(const, "co_lines"):
                stack.append(const)
    if line in lines:
        return True
    text = linecache.getline(path, line).strip()
    if not text or text.startswith("#"):
        return False
    return False


class _Recorder:
    def __init__(self, spec: dict, out_path: str) -> None:
        self.out_path = out_path
        self.specs = spec["breakpoints"]
        self.report = {
            "breakpoints": [
                {
                    "location": bp["location"],
                    "function": None,
                    "resolved": None,
                    "hit_times": 0,
                    "hits": [],
                    "number": index,
                }
                for index, bp in enumerate(self.specs)
            ],
            "signal": None,
            "exit_code": None,
            "errors": [],
            "info_breakpoints": "",
            "flush_count": 0,
        }
        self.order = 0
        self.index_by_key: dict[tuple[str, int], list[int]] = {}
        self._last_flush_mono = 0.0
        for index, bp in enumerate(self.specs):
            path = _normalise(str(bp["file"]))
            key = (path, int(bp["line"]))
            self.index_by_key.setdefault(key, []).append(index)
            resolved = _line_is_code(str(bp["file"]), int(bp["line"]))
            self.report["breakpoints"][index]["resolved"] = resolved
        self.active = {index for index in range(len(self.specs))}
        self.flush(force=True)

    def flush(self, force: bool = False) -> None:
        # Write to a temp file in the same directory, then atomically replace
        # the real path (os.replace is a single rename(2) on the same
        # filesystem). A plain `open(self.out_path, "w")` truncates in place,
        # so a SIGKILL landing mid-write left a corrupted/empty file. The temp
        # name is unique per-process (pid), because this runs inside the
        # traced target, which may fork -- two forked writers must not race
        # on the same temp path.
        #
        # N2: `force=False` throttles the write to at most once per
        # FLUSH_INTERVAL_SEC instead of one os.replace() per hit, which was
        # the throughput ceiling on a hot breakpoint. Init and the final
        # flush in main() pass force=True so evidence is never more than one
        # interval stale when the run is killed.
        now = time.monotonic()
        if not force and (now - self._last_flush_mono) < FLUSH_INTERVAL_SEC:
            return
        self._last_flush_mono = now
        self.report["flush_count"] += 1
        tmp_path = f"{self.out_path}.{os.getpid()}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as handle:
                json.dump(self.report, handle)
            os.replace(tmp_path, self.out_path)
        except OSError:
            pass

    def on_line(self, frame) -> None:
        filename = frame.f_code.co_filename
        lineno = frame.f_lineno
        frame_globals_name = frame.f_code.co_name
        key = (_normalise(filename), lineno)
        for index in self.index_by_key.get(key, ()):
            if index not in self.active:
                continue
            spec = self.specs[index]
            record = self.report["breakpoints"][index]
            self.order += 1
            record["hit_times"] += 1
            record["resolved"] = True
            if record["function"] is None:
                record["function"] = frame_globals_name
            hit = {"order": self.order, "callstack": "", "inline_expr": []}
            if spec.get("print_call_stack") and frame is not None:
                stack = traceback.extract_stack(frame)
                lines = []
                for depth, entry in enumerate(reversed(stack[-16:])):
                    marker = "*" if depth == 0 else " "
                    lines.append(
                        "%s #%d: %s at %s:%d"
                        % (marker, depth, entry.name, entry.filename, entry.lineno or 0)
                    )
                hit["callstack"] = "\n".join(lines)
            for expr in spec.get("inline_expr") or []:
                if frame is None:
                    value = "<unavailable>"
                else:
                    try:
                        value = repr(eval(expr, frame.f_globals, frame.f_locals))  # noqa: S307
                    except Exception as exc:  # the expression is model-written
                        value = (
                            "<error: %s is not evaluable here (%s). How to fix: "
                            "1. check the name is in scope at this line "
                            "2. set the breakpoint after the assignment>" % (expr, exc)
                        )
                hit["inline_expr"].append({"name": expr, "value": value})
            record["hits"].append(hit)
            if record["hit_times"] >= int(spec.get("hit_limit") or 10):
                self.active.discard(index)
            self.flush()


def _install_settrace(recorder: _Recorder):
    watched = {key[0] for key in recorder.index_by_key}

    def local_trace(frame, event, arg):
        if event == "line":
            recorder.on_line(frame)
        return local_trace

    def global_trace(frame, event, arg):
        if event == "call" and _normalise(frame.f_code.co_filename) in watched:
            return local_trace
        return None

    sys.settrace(global_trace)
    threading_hook = None
    try:
        import threading

        threading.settrace(global_trace)
        threading_hook = threading
    except Exception:
        pass
    return lambda: (sys.settrace(None), threading_hook and threading_hook.settrace(None))


def main(argv: list[str]) -> int:
    separator = argv.index("--")
    spec_path, out_path = argv[0], argv[1]
    target_argv = argv[separator + 1 :]
    with open(spec_path, encoding="utf-8") as handle:
        spec = json.load(handle)
    recorder = _Recorder(spec, out_path)

    script = None
    for index, arg in enumerate(target_argv):
        if index > 0 and arg.endswith(".py"):
            script = arg
            break
    if script is None:
        recorder.report["errors"].append(
            "entry.run_cmd does not name a .py script; pymon can only trace a script run."
        )
        recorder.flush()
        return 2

    script_index = target_argv.index(script)
    sys.argv = [script, *target_argv[script_index + 1 :]]
    # Behave like `python script.py`: the script's directory, not this runner's
    # (which holds modules such as selection.py), heads sys.path.
    sys.path[0] = os.path.dirname(os.path.abspath(script))
    uninstall = _install_settrace(recorder)
    exit_code = 0
    try:
        runpy.run_path(script, run_name="__main__")
    except SystemExit as exc:
        exit_code = int(exc.code or 0) if not isinstance(exc.code, str) else 1
    except BaseException:
        traceback.print_exc()
        exit_code = 1
    finally:
        try:
            uninstall()
        except Exception:
            pass
        recorder.report["exit_code"] = exit_code
        recorder.flush(force=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
