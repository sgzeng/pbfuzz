"""Best-effort Java tracer driven through ``jdb`` by an interactive feed.

jdb has no batch/scripting API, and its ``run`` command is asynchronous — it
returns to the prompt before the debuggee JVM has finished booting. Piping a
whole command script (``stop at`` per breakpoint, ``run``, ``where``/``cont``
pairs, ``exit``) into jdb's stdin in one write loses that race: jdb drains its
stdin far faster than the JVM starts, so ``exit`` kills the VM before the
target class even loads. Instead, this backend drives jdb interactively over a
subprocess pipe, writing each command only after jdb's own stdout has shown
the event that command depends on (a breakpoint resolving, a hit, or the
debuggee exiting) — see ``run()``. Limits, stated rather than hidden:

* the target must take its input from a file (``input_channel: file``) because
  jdb's own stdin carries the command script;
* ``inline_expr`` is not evaluated — each value is reported as unsupported;
* the class for ``File.java:N`` is derived from the file's ``package`` line
  plus its basename, so inner/anonymous classes are not addressable.

Binding is reported honestly from jdb's own messages: ``Set breakpoint`` /
``Set deferred breakpoint`` mean bound; ``Unable to set`` means unresolved.

:module: pbfuzz_engine.tracers.jdb
"""

from __future__ import annotations

import os
import queue
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Mapping, Sequence

from .base import (
    Breakpoint,
    BreakpointReport,
    HitRecord,
    InlineValue,
    Remedy,
    TraceResult,
    Tracer,
    TracerError,
    build_command,
    which,
)

__all__ = ["JdbTracer", "java_class_for", "build_jdb_session", "parse_jdb_transcript"]

_UNSUPPORTED = "<unsupported: the jdb tracer does not evaluate expressions>"
_HIT = re.compile(r'Breakpoint hit: "thread=[^"]*", (?P<method>[\w$.<>]+)\(\), line=(?P<line>\d+)')
_SET = re.compile(r"Set (?:deferred )?breakpoint (?P<cls>[\w$.]+):(?P<line>\d+)")
_UNABLE = re.compile(r"Unable to set (?:deferred )?breakpoint (?P<cls>[\w$.]+):(?P<line>\d+)")
# jdb's own terminal response to an unresolvable deferred breakpoint: it
# halts the JVM at an internal frame and never emits `_HIT`/`_APP_EXITED`
# afterward, so this line is the only signal that no further useful events
# are coming. Recognizing it lets the driver bail out immediately instead of
# burning the entire configured timeout waiting for a hit that can't happen
# (see `_wait_for`'s use below).
_STOP_DEFERRED = re.compile(r"Stopping due to deferred breakpoint errors")
# A `where` frame, possibly behind the `main[1] ` prompt jdb prints first.
_FRAME = re.compile(r"^(?:\S+\[\d+\]\s+)?\s*(?P<frame>\[\d+\]\s+\S.*)$")
_EXC = re.compile(r"Exception occurred: (?P<exc>[\w$.]+)")
_PACKAGE = re.compile(r"^\s*package\s+([\w.]+)\s*;", re.MULTILINE)
# Events that pace the interactive feed (see ``_drive_jdb``): a breakpoint
# resolving one way or the other, the VM booting, a hit, or the debuggee
# finishing on its own before every expected stop was reached.
_VM_STARTED = re.compile(r"VM Started:")
_APP_EXITED = re.compile(r"The application exited|The application has been disconnected")


def java_class_for(file_path: str, repo: str | None = None) -> str:
    """Fully qualified class name for a ``.java`` file (best effort)."""
    stem = Path(file_path).stem
    candidates = [Path(file_path)]
    if repo:
        candidates.append(Path(repo) / file_path)
    for candidate in candidates:
        try:
            match = _PACKAGE.search(candidate.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if match:
            return f"{match.group(1)}.{stem}"
    return stem


def build_jdb_session(classes: Sequence[tuple[str, int]], max_stops: int) -> str:
    """The commands one jdb run issues, in order (kept for its own unit test).

    ``run()`` no longer pipes this as one blind write — see ``_drive_jdb`` —
    but the command sequence is identical, just paced against jdb's output.
    """
    lines = [f"stop at {cls}:{line}" for cls, line in classes]
    lines.append("run")
    for _ in range(max_stops):
        lines.append("where")
        lines.append("cont")
    lines.append("exit")
    return "\n".join(lines) + "\n"


def _drive_jdb(
    jdb_argv: Sequence[str],
    cwd: str | None,
    env: Mapping[str, str],
    stop_commands: Sequence[str],
    max_stops: int,
    timeout_sec: float | None,
) -> tuple[str, bool]:
    """Feed jdb interactively, pacing each write to jdb's own event lines.

    Returns ``(transcript, timed_out)``. Never raises for a normal bad
    outcome (jdb dying, the debuggee never hitting, running out of time).
    """
    deadline = time.monotonic() + (timeout_sec if timeout_sec is not None else float("inf"))
    proc = subprocess.Popen(
        list(jdb_argv),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=cwd or None,
        env=dict(env),
        text=True,
        bufsize=1,
    )

    lines: "queue.Queue[str | None]" = queue.Queue()

    def _pump() -> None:
        try:
            for out_line in iter(proc.stdout.readline, ""):
                lines.put(out_line)
        finally:
            lines.put(None)

    reader = threading.Thread(target=_pump, daemon=True)
    reader.start()

    transcript: list[str] = []

    def _wait_for(patterns: Sequence[re.Pattern[str]]) -> str | None:
        """Read lines until one matches a pattern; None on EOF or deadline."""
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                out_line = lines.get(timeout=min(remaining, 0.5))
            except queue.Empty:
                continue
            if out_line is None:
                return None
            transcript.append(out_line)
            if any(p.search(out_line) for p in patterns):
                return out_line

    def _send(text: str) -> bool:
        try:
            proc.stdin.write(text)
            proc.stdin.flush()
            return True
        except (BrokenPipeError, OSError):
            return False

    for command in stop_commands:
        if not _send(command + "\n"):
            break
    else:
        if _send("run\n"):
            event = _wait_for([_HIT, _SET, _UNABLE, _VM_STARTED, _APP_EXITED, _STOP_DEFERRED])
            for _ in range(max_stops):
                if event is None:
                    break
                if not _HIT.search(event):
                    # Not stopped yet (still booting, or a bind just resolved) —
                    # wait for the actual hit, the debuggee finishing first, or
                    # jdb giving up on an unresolvable deferred breakpoint
                    # (which otherwise looks identical to "still booting" and
                    # would block here until the deadline).
                    event = _wait_for([_HIT, _APP_EXITED, _STOP_DEFERRED])
                    if event is None or not _HIT.search(event):
                        break
                if not (_send("where\n") and _send("cont\n")):
                    break
                event = _wait_for([_HIT, _APP_EXITED, _STOP_DEFERRED])

    timed_out = False
    if proc.poll() is None:
        _send("exit\n")
    remaining = deadline - time.monotonic()
    try:
        proc.wait(timeout=max(remaining, 0.0))
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass

    while True:
        try:
            out_line = lines.get(timeout=0.2)
        except queue.Empty:
            break
        if out_line is None:
            break
        transcript.append(out_line)
    reader.join(timeout=1.0)
    for stream in (proc.stdin, proc.stdout):
        try:
            stream.close()
        except OSError:
            pass

    return "".join(transcript), timed_out


def parse_jdb_transcript(
    transcript: str, breakpoints: Sequence[Breakpoint], classes: Sequence[str]
) -> TraceResult:
    """Parse a jdb transcript into a :class:`TraceResult`. Pure."""
    key_to_index: dict[tuple[str, int], int] = {}
    for index, (bp, cls) in enumerate(zip(breakpoints, classes)):
        key_to_index[(cls, bp.line_no)] = index
        key_to_index.setdefault((cls.rsplit(".", 1)[-1], bp.line_no), index)

    reports = [BreakpointReport(location=bp.location) for bp in breakpoints]
    for match in _SET.finditer(transcript):
        index = key_to_index.get((match.group("cls"), int(match.group("line"))))
        if index is not None:
            reports[index].resolved = True
    for match in _UNABLE.finditer(transcript):
        index = key_to_index.get((match.group("cls"), int(match.group("line"))))
        if index is not None:
            reports[index].resolved = False

    lines = transcript.splitlines()
    order = 0
    for position, line in enumerate(lines):
        hit = _HIT.search(line)
        if not hit:
            continue
        method = hit.group("method")
        cls = method.rsplit(".", 1)[0]
        line_no = int(hit.group("line"))
        index = key_to_index.get((cls, line_no), key_to_index.get((cls.rsplit(".", 1)[-1], line_no)))
        if index is None:
            continue
        bp = breakpoints[index]
        report = reports[index]
        if report.hit_times >= bp.hit_limit:
            continue
        order += 1
        report.hit_times += 1
        report.resolved = True
        report.function = report.function or method
        frames: list[str] = []
        for follow in lines[position + 1 :]:
            if _HIT.search(follow):
                break
            frame_match = _FRAME.match(follow)
            if frame_match:
                frames.append(frame_match.group("frame").strip())
            elif frames:
                break
        report.hits.append(
            HitRecord(
                order=order,
                callstack="\n".join(frames) if bp.print_call_stack else "",
                inline_expr=tuple(InlineValue(e, _UNSUPPORTED) for e in bp.inline_expr),
                location=bp.location,
            )
        )

    result = TraceResult(breakpoints=reports, tracer="jdb", stderr=transcript)
    exc = _EXC.search(transcript)
    if exc:
        result.signal = exc.group("exc")
    return result


class JdbTracer(Tracer):
    """Trace a Java target with jdb (best effort; see module docs)."""

    name = "jdb"
    languages = ("java",)

    def __init__(self, jdb_path: str = "jdb") -> None:
        self.jdb_path = jdb_path or "jdb"

    def available(self) -> tuple[bool, str]:
        resolved = which(self.jdb_path)
        if not resolved:
            return False, f"`{self.jdb_path}` not found on PATH (it ships with a JDK)"
        code, out, err, _ = self._run_process([resolved, "-version"], None, os.environ, 20.0)
        text = (out or err).strip().splitlines()
        if code != 0:
            return False, f"`{resolved} -version` exited {code}"
        return True, f"{resolved}: {text[0] if text else 'jdb'}"

    def run(
        self,
        campaign: Mapping[str, Any],
        input_path: str,
        breakpoints: Sequence[Breakpoint],
        timeout_sec: float | None = None,
    ) -> TraceResult:
        jdb_bin = which(self.jdb_path)
        if not jdb_bin:
            raise TracerError(
                "jdb was not found; it ships with a JDK, not a JRE.",
                [
                    Remedy(id="install_jdk", label="Install a JDK", effect="run_command"),
                    Remedy(
                        id="disable_tracer",
                        label="Set campaign `tracer: off`",
                        effect="edit_campaign",
                    ),
                ],
            )
        bps = self._normalise(breakpoints)
        cmd = build_command(campaign, input_path)
        if cmd.stdin_path:
            raise TracerError(
                "The jdb tracer needs `entry.input_channel: file`; jdb's stdin carries its commands.",
                [
                    Remedy(
                        id="use_file_channel",
                        label="Switch the campaign to a file input (`@@`)",
                        effect="edit_campaign",
                    )
                ],
            )
        argv = list(cmd.argv)
        if not argv or Path(argv[0]).name not in {"java", "java.exe"}:
            raise TracerError(
                "The jdb tracer can only trace a run command that starts with `java`.",
                [
                    Remedy(
                        id="java_run_cmd",
                        label=(
                            "Make entry.run_cmd a plain `java -classpath … Main @@` command "
                            "(jdb requires the long `-classpath` flag; it rejects `-cp`)"
                        ),
                        effect="edit_campaign",
                    )
                ],
            )
        repo = (campaign.get("target") or {}).get("repo")
        classes = [java_class_for(bp.file_path, repo) for bp in bps]
        max_stops = sum(bp.hit_limit for bp in bps) + 1
        stop_commands = [f"stop at {cls}:{line}" for cls, line in zip(classes, (bp.line_no for bp in bps))]
        jdb_argv = [jdb_bin, *argv[1:]]

        transcript, timed_out = _drive_jdb(
            jdb_argv, cmd.cwd, cmd.env, stop_commands, max_stops, timeout_sec
        )
        result = parse_jdb_transcript(transcript, bps, classes)
        result.timed_out = timed_out
        return result
