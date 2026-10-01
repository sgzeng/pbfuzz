"""Tracer base types shared by every tracer backend.

A tracer runs the program under test **once** on **one** input with a set of
breakpoints taken from ``contracts/common.schema.json#/$defs/Breakpoint`` and
reports what was observed, in the shape of
``contracts/engine-rpc.schema.json#/$defs/TraceRunResult``.

Two properties matter more than anything else here:

* **A breakpoint that could not bind is reported as ``resolved: false``**, never
  as a breakpoint with zero hits. The self-check needs to tell "the line was
  never executed" apart from "the debugger could not place a breakpoint there"
  (missing ``-g``, optimised out, wrong file), because the remedies differ.
* **Nothing is invented.** When the tracer does not know something (it timed
  out before the run finished, the debugger never reported resolution) the
  field is left out rather than guessed.

This module depends on the standard library only, so it can be imported by the
RPC server without pulling in a debugger.

:module: pbfuzz_engine.tracers.base
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from ..proc import run_with_group_kill

__all__ = [
    "AT_FILE",
    "Breakpoint",
    "BreakpointReport",
    "HitRecord",
    "InlineValue",
    "Remedy",
    "TraceResult",
    "Tracer",
    "TracerError",
    "TargetCommand",
    "build_command",
    "load_campaign",
    "parse_location",
    "campaign_targets",
    "which",
]

#: AFL-style placeholder replaced by the input file path in ``entry.run_cmd``.
AT_FILE = "@@"


class TracerError(RuntimeError):
    """A tracer could not run at all, with a diagnosis and concrete remedies.

    This is raised for setup failures (no debugger binary, unusable campaign,
    missing program) — never for "the program did not reach the breakpoint",
    which is an ordinary, reportable outcome.
    """

    def __init__(self, diagnosis: str, remedies: Sequence["Remedy"] = ()) -> None:
        super().__init__(diagnosis)
        self.diagnosis = diagnosis
        self.remedies: list[Remedy] = list(remedies)

    def to_rpc_error_data(self) -> dict[str, Any]:
        """Render as the ``error.data`` object of the engine RPC contract."""
        return {
            "diagnosis": self.diagnosis,
            "remedies": [r.to_dict() for r in self.remedies],
        }


@dataclass(frozen=True)
class Remedy:
    """One concrete option offered to the user when something failed."""

    id: str
    label: str
    detail: str | None = None
    effect: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id, "label": self.label}
        if self.detail:
            out["detail"] = self.detail
        if self.effect:
            out["effect"] = self.effect
        return out


@dataclass(frozen=True)
class Breakpoint:
    """A breakpoint request, mirroring ``common.schema.json#/$defs/Breakpoint``."""

    location: str
    hit_limit: int = 10
    inline_expr: tuple[str, ...] = ()
    print_call_stack: bool = False

    @property
    def file_path(self) -> str:
        return parse_location(self.location)[0]

    @property
    def line_no(self) -> int:
        return parse_location(self.location)[1]

    @classmethod
    def from_obj(cls, obj: Mapping[str, Any] | "Breakpoint") -> "Breakpoint":
        """Accept either a contract dict (camel or snake keys) or a Breakpoint."""
        if isinstance(obj, Breakpoint):
            return obj
        location = obj.get("location")
        if not isinstance(location, str) or ":" not in location:
            raise TracerError(
                f"Breakpoint location {location!r} is not `file:line`.",
                [
                    Remedy(
                        id="fix_breakpoint",
                        label="Give the breakpoint as file:line",
                        detail="e.g. src/readelf.c:1234",
                        effect="manual",
                    )
                ],
            )
        parse_location(location)  # validates the line number
        inline = obj.get("inline_expr", obj.get("inlineExpr", ())) or ()
        return cls(
            location=location,
            hit_limit=int(obj.get("hit_limit", obj.get("hitLimit", 10)) or 10),
            inline_expr=tuple(str(e) for e in inline),
            print_call_stack=bool(
                obj.get("print_call_stack", obj.get("printCallStack", False))
            ),
        )

    def to_spec(self) -> dict[str, Any]:
        """The JSON form handed to an out-of-process debugger script."""
        return {
            "location": self.location,
            "file": self.file_path,
            "line": self.line_no,
            "hit_limit": self.hit_limit,
            "inline_expr": list(self.inline_expr),
            "print_call_stack": self.print_call_stack,
        }


@dataclass(frozen=True)
class InlineValue:
    """One ``inline_expr`` evaluated at one hit."""

    name: str
    value: str

    def to_dict(self) -> dict[str, str]:
        return {"name": self.name, "value": self.value}


@dataclass(frozen=True)
class HitRecord:
    """One observation of one breakpoint.

    ``order`` is a run-global sequence number. Deviation detection needs to know
    which of two breakpoints was hit first, and per-breakpoint hit counts cannot
    answer that.
    """

    order: int
    callstack: str = ""
    inline_expr: tuple[InlineValue, ...] = ()
    location: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"callstack": self.callstack}
        out["inlineExpr"] = [v.to_dict() for v in self.inline_expr]
        out["order"] = self.order
        if self.location:
            out["location"] = self.location
        return out


@dataclass
class BreakpointReport:
    """What happened at one requested breakpoint.

    ``resolved`` is tri-state on purpose: ``None`` means the tracer genuinely
    does not know (e.g. the run was killed by the timeout before the debugger
    reported binding), and the field is then omitted from the RPC result.
    """

    location: str
    function: str | None = None
    resolved: bool | None = None
    hit_times: int = 0
    hits: list[HitRecord] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"location": self.location, "hitTimes": self.hit_times}
        if self.function:
            out["function"] = self.function
        if self.resolved is not None:
            out["resolved"] = self.resolved
        if self.hits:
            out["hits"] = [h.to_dict() for h in self.hits]
        return out


@dataclass
class TraceResult:
    """One traced execution — ``TraceRunResult`` plus engine-internal detail."""

    breakpoints: list[BreakpointReport] = field(default_factory=list)
    signal: str | None = None
    exit_code: int | None = None
    reached: bool | None = None
    triggered: bool | None = None
    timed_out: bool = False
    stderr: str = ""
    tracer: str = ""
    diagnostics: list[str] = field(default_factory=list)

    def to_rpc(self) -> dict[str, Any]:
        """Render exactly the contract's ``TraceRunResult`` — no extra keys."""
        out: dict[str, Any] = {"breakpoints": [b.to_dict() for b in self.breakpoints]}
        if self.signal:
            out["signal"] = self.signal
        if self.exit_code is not None:
            out["exitCode"] = self.exit_code
        if self.reached is not None:
            out["reached"] = self.reached
        if self.triggered is not None:
            out["triggered"] = self.triggered
        return out

    def hits_in_order(self) -> list[tuple[HitRecord, BreakpointReport]]:
        """Every hit of every breakpoint, in execution order."""
        pairs = [(h, b) for b in self.breakpoints for h in b.hits]
        pairs.sort(key=lambda p: p[0].order)
        return pairs


def parse_location(location: str) -> tuple[str, int]:
    """Split a ``file:line`` location. Raises :class:`TracerError` if malformed."""
    head, _, tail = location.rpartition(":")
    if not head or not tail.isdigit():
        raise TracerError(
            f"Location {location!r} is not `file:line`.",
            [
                Remedy(
                    id="fix_location",
                    label="Use file:line",
                    detail="Locations are `path/to/file.c:123`.",
                    effect="manual",
                )
            ],
        )
    return head, int(tail)


def which(name: str) -> str | None:
    """``shutil.which`` that also accepts an absolute path already given."""
    if not name:
        return None
    candidate = Path(name)
    if candidate.is_absolute():
        return str(candidate) if candidate.exists() and os.access(candidate, os.X_OK) else None
    return shutil.which(name)


@dataclass(frozen=True)
class TargetCommand:
    """How to run the program under test on one input."""

    argv: list[str]
    stdin_path: str | None
    cwd: str | None
    env: dict[str, str]

    @property
    def program(self) -> str:
        return self.argv[0] if self.argv else ""


def build_command(
    campaign: Mapping[str, Any], input_path: str | os.PathLike[str]
) -> TargetCommand:
    """Turn ``entry.run_cmd`` plus one input file into a concrete command.

    ``@@`` is replaced by the input path when ``entry.input_channel`` is
    ``file``; with ``stdin`` the input file is piped and ``@@`` must not appear.
    This is the whole of what makes the engine language-agnostic, so it lives
    here rather than in any one tracer.
    """
    entry = campaign.get("entry") or {}
    run_cmd = entry.get("run_cmd")
    if not run_cmd:
        raise TracerError(
            "Campaign has no `entry.run_cmd`, so the target cannot be run.",
            [
                Remedy(
                    id="set_run_cmd",
                    label="Add entry.run_cmd to the campaign",
                    detail="Full command template; `@@` marks the input file.",
                    effect="edit_campaign",
                )
            ],
        )
    channel = entry.get("input_channel") or "file"
    argv = shlex.split(run_cmd)
    input_path = str(input_path)
    stdin_path: str | None = None
    if channel == "file":
        if AT_FILE not in argv:
            raise TracerError(
                "`entry.input_channel` is `file` but `entry.run_cmd` has no `@@` placeholder.",
                [
                    Remedy(
                        id="add_at_file",
                        label="Put `@@` where the input file goes",
                        effect="edit_campaign",
                    ),
                    Remedy(
                        id="use_stdin",
                        label="Switch entry.input_channel to `stdin`",
                        effect="edit_campaign",
                    ),
                ],
            )
        argv = [input_path if a == AT_FILE else a for a in argv]
    else:
        if AT_FILE in argv:
            raise TracerError(
                "`entry.input_channel` is `stdin` but `entry.run_cmd` still contains `@@`.",
                [
                    Remedy(
                        id="drop_at_file",
                        label="Remove `@@` from entry.run_cmd",
                        effect="edit_campaign",
                    )
                ],
            )
        stdin_path = input_path

    env = dict(os.environ)
    for key, value in (entry.get("env") or {}).items():
        env[str(key)] = str(value)
    cwd = entry.get("cwd") or (campaign.get("target") or {}).get("repo")
    return TargetCommand(argv=argv, stdin_path=stdin_path, cwd=cwd, env=env)


def campaign_targets(campaign: Mapping[str, Any]) -> list[str]:
    """The campaign's target locations, in order."""
    bug = campaign.get("bug") or {}
    out = []
    for target in bug.get("targets") or []:
        location = (target or {}).get("location")
        if isinstance(location, str):
            out.append(location)
    return out


def load_campaign(path: str | os.PathLike[str]) -> dict[str, Any]:
    """Load ``pbfuzz.campaign.yaml`` (or a JSON campaign) as a plain dict.

    The engine's own campaign model belongs to the rest of the engine; a tracer
    only needs `target`, `entry`, `oracle`, `bug.targets` and `tracer`, so this
    deliberately stays a dependency-free dict load.
    """
    p = Path(path)
    if not p.exists():
        raise TracerError(
            f"Campaign file not found: {p}",
            [Remedy(id="check_path", label="Check the campaign path", effect="manual")],
        )
    text = p.read_text(encoding="utf-8")
    if p.suffix in {".json"}:
        return json.loads(text)
    try:
        import yaml  # type: ignore[import-untyped]
    except ImportError:
        try:  # a JSON document is also valid YAML, so try that before failing
            return json.loads(text)
        except json.JSONDecodeError:
            raise TracerError(
                "PyYAML is not installed, so the YAML campaign cannot be read.",
                [
                    Remedy(
                        id="install_pyyaml",
                        label="Install PyYAML into the engine interpreter",
                        detail="pip install pyyaml",
                        effect="run_command",
                    )
                ],
            ) from None
    data = yaml.safe_load(text)
    if not isinstance(data, dict):
        raise TracerError(f"Campaign {p} did not parse to a mapping.")
    return data


class Tracer:
    """One breakpoint-tracing backend.

    Implementations run the target exactly once and must never raise for a
    normal bad outcome (crash, timeout, breakpoint never hit) — those are
    reported in the :class:`TraceResult`. :class:`TracerError` is for "this
    tracer cannot run at all".
    """

    #: Stable id, matching the `tracer` enum in the campaign/settings schemas.
    name: str = "base"
    #: Languages this tracer can trace, per `campaign.target.language`.
    languages: tuple[str, ...] = ()

    def available(self) -> tuple[bool, str]:
        """Whether the backend can run here, with the evidence either way."""
        raise NotImplementedError

    def run(
        self,
        campaign: Mapping[str, Any],
        input_path: str,
        breakpoints: Sequence[Breakpoint],
        timeout_sec: float | None = None,
    ) -> TraceResult:
        """Run the target once on ``input_path`` with ``breakpoints`` set."""
        raise NotImplementedError

    # -- helpers shared by the subprocess-driven backends ------------------

    @staticmethod
    def _normalise(breakpoints: Iterable[Mapping[str, Any] | Breakpoint]) -> list[Breakpoint]:
        return [Breakpoint.from_obj(b) for b in breakpoints]

    @staticmethod
    def _run_process(
        argv: Sequence[str],
        cwd: str | None,
        env: Mapping[str, str],
        timeout_sec: float | None,
        stdin_path: str | None = None,
    ) -> tuple[int | None, str, str, bool]:
        """Run a process, returning ``(returncode, stdout, stderr, timed_out)``.

        Delegates to :func:`pbfuzz_engine.proc.run_with_group_kill` rather than a bare
        ``subprocess.run(timeout=...)``, so a timeout kills the whole session the child
        started, not just that one process. Every backend that goes through here needs that:
        lldb launches its inferior via ``lldb-server``, which can ``setpgid`` the inferior into
        its own process group while staying in the same session as lldb itself -- so a
        ``killpg`` on lldb's group alone can miss it, which is why the shared helper kills by
        session id instead. A pymon target that shells out to a subprocess of its own leaks
        that grandchild the same way if only the direct child is signalled.
        """
        # Always feed *some* bytes (possibly none) rather than leaving `input=None`: that keeps
        # the child's stdin a closed pipe (immediate EOF, like the previous `DEVNULL` default)
        # instead of `run_with_group_kill` falling back to inheriting this process's own stdin.
        stdin_bytes = b""
        if stdin_path:
            with open(stdin_path, "rb") as stdin_handle:
                stdin_bytes = stdin_handle.read()
        result = run_with_group_kill(
            list(argv),
            input=stdin_bytes,
            cwd=cwd or None,
            env=dict(env),
            timeout_sec=timeout_sec,
        )
        stdout = result.stdout.decode("utf-8", "replace")
        stderr = result.stderr.decode("utf-8", "replace")
        if result.timed_out:
            return (None, stdout, stderr, True)
        return (result.returncode, stdout, stderr, False)
