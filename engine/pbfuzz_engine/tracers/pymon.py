"""The Python tracer: line breakpoints via ``sys.monitoring`` / ``sys.settrace``.

Python targets need no debugger. The runner module is executed as a child
process, installs a line hook for exactly the requested ``file:line`` pairs,
and runs the harness with ``runpy``. It emits the same JSON report shape as the
gdb and lldb backends so all three share one parser.

Breakpoint resolution here means "that line exists in that file and carries
executable code", which the runner checks against the compiled code object's
line table before the run — so an unreachable-because-mistyped location is
reported as ``resolved: false``, not as a silent zero-hit.

:module: pbfuzz_engine.tracers.pymon
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping, Sequence

from .base import Breakpoint, Remedy, TraceResult, Tracer, TracerError, build_command, which
from .gdb_batch import parse_trace_report

__all__ = ["PymonTracer", "find_python_script", "build_pymon_argv"]


def find_python_script(argv: Sequence[str]) -> str | None:
    """The ``.py`` file a run command executes, if it names one directly."""
    for index, arg in enumerate(argv):
        if arg == "-m":
            return None  # a module run; handled by the -m passthrough
        if arg.endswith(".py") and index > 0:
            return arg
    return None


def build_pymon_argv(
    python_bin: str, runner_path: str, spec_path: str, out_path: str, argv: Sequence[str]
) -> list[str]:
    """Build the child command line that runs the target under the line hook."""
    return [python_bin, runner_path, spec_path, out_path, "--", *argv]


class PymonTracer(Tracer):
    """Trace a Python target in a child interpreter."""

    name = "pymon"
    languages = ("python",)

    def __init__(self, python_path: str = "") -> None:
        self.python_path = python_path or sys.executable or "python3"

    def available(self) -> tuple[bool, str]:
        resolved = which(self.python_path)
        if not resolved:
            return False, f"`{self.python_path}` not found on PATH"
        code, out, err, _ = self._run_process(
            [resolved, "-c", "import sys; print(sys.version.split()[0])"],
            None,
            os.environ,
            20.0,
        )
        if code != 0:
            return False, f"`{resolved}` is not usable: {err.strip()[:200]}"
        return True, f"{resolved}: python {out.strip()}"

    def run(
        self,
        campaign: Mapping[str, Any],
        input_path: str,
        breakpoints: Sequence[Breakpoint],
        timeout_sec: float | None = None,
    ) -> TraceResult:
        python_bin = which(self.python_path)
        if not python_bin:
            raise TracerError(
                f"The Python interpreter `{self.python_path}` was not found.",
                [
                    Remedy(
                        id="set_python_path",
                        label="Set Settings → pbfuzz → execution.pythonPath",
                        effect="manual",
                    )
                ],
            )
        bps = self._normalise(breakpoints)
        cmd = build_command(campaign, input_path)
        runner = Path(__file__).with_name("_pymon_runner.py")

        with tempfile.TemporaryDirectory(prefix="pbfuzz-pymon-") as tmp:
            tmpdir = Path(tmp)
            spec_path = tmpdir / "spec.json"
            out_path = tmpdir / "report.json"
            spec_path.write_text(
                json.dumps({"breakpoints": [b.to_spec() for b in bps]}), encoding="utf-8"
            )
            argv = build_pymon_argv(
                python_bin, str(runner), str(spec_path), str(out_path), cmd.argv
            )
            code, _, child_stderr, timed_out = self._run_process(
                argv, cmd.cwd, cmd.env, timeout_sec, stdin_path=cmd.stdin_path
            )
            report: dict[str, Any] = {}
            if out_path.exists():
                try:
                    report = json.loads(out_path.read_text(encoding="utf-8") or "{}")
                except json.JSONDecodeError:
                    report = {}

        if not report and not timed_out:
            raise TracerError(
                "The pymon runner produced no report — the target could not be started.",
                [
                    Remedy(
                        id="inspect_run_cmd",
                        label="Check entry.run_cmd runs the harness directly",
                        detail=(child_stderr or "").strip()[:400] or None,
                        effect="edit_campaign",
                    )
                ],
            )
        if report.get("exit_code") is None and code is not None:
            report = dict(report)
            report["exit_code"] = code
        result = parse_trace_report(report, bps, stderr=child_stderr, timed_out=timed_out)
        result.tracer = "pymon"
        return result
