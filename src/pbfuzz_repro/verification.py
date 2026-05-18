"""Structured PoC verification and INIT retry feedback for the reproduction driver."""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from pbfuzz_repro.workspace import RunLayout

_ASAN_RE = re.compile(
    r"==\d+==ERROR: (AddressSanitizer|UndefinedBehaviorSanitizer|MemorySanitizer|LeakSanitizer):"
)
_UBSAN_RUNTIME_RE = re.compile(r"runtime error:", re.IGNORECASE)
_CRASH_EXIT_CODES = frozenset({1, 134, -6, -11})
_SANITIZER_HINT_RE = re.compile(
    r"AddressSanitizer:|heap-buffer-overflow|SEGV|ABRT", re.IGNORECASE
)


class FailureKind(str, Enum):
    """Category of outer-round failure passed to INIT retry feedback."""

    ORACLE_TRIGGERED_NO_SANITIZER = "oracle_triggered_no_sanitizer"
    PIER_NO_ORACLE = "pier_no_oracle"
    INIT_FAILED = "init_failed"
    VERIFICATION_ERROR = "verification_error"


@dataclass
class OutputSignals:
    """Signals extracted from verification subprocess output."""

    has_asan_error: bool = False
    has_ubsan_runtime: bool = False
    has_ubsan_summary: bool = False
    has_sanitizer_summary: bool = False
    has_crash_exit: bool = False
    has_sanitizer_hint: bool = False
    has_signed_overflow: bool = False
    oracle_reached: bool = False
    oracle_triggered: bool = False


@dataclass
class VerificationResult:
    """Structured outcome of running a candidate PoC through verify_sanitizer_crash."""

    crashed: bool
    excerpt: str
    exit_code: int | None = None
    timed_out: bool = False
    os_error: str | None = None
    argv: list[str] | None = None
    poc_size: int = 0
    signals: OutputSignals = field(default_factory=OutputSignals)
    failure_kind: FailureKind | None = None

    @property
    def triggered_then_clean_exit(self) -> bool:
        return (
            self.signals.oracle_triggered
            and not self.crashed
            and self.exit_code == 0
            and not self.timed_out
            and not self.os_error
        )


def analyze_output(combined: str, exit_code: int | None, cve_id: str) -> OutputSignals:
    """Extract sanitizer and oracle signals from combined process output."""
    cve = (cve_id or "").strip()
    reached_pat = f"{cve} reached" if cve else " reached"
    triggered_pat = f"{cve} triggered" if cve else " triggered"

    sig = OutputSignals(
        has_asan_error=bool(_ASAN_RE.search(combined)),
        has_ubsan_runtime=bool(_UBSAN_RUNTIME_RE.search(combined)),
        has_ubsan_summary="SUMMARY: UndefinedBehaviorSanitizer" in combined,
        has_sanitizer_summary="SUMMARY:" in combined,
        has_crash_exit=exit_code in _CRASH_EXIT_CODES if exit_code is not None else False,
        has_sanitizer_hint=bool(_SANITIZER_HINT_RE.search(combined)),
        has_signed_overflow="runtime error: signed integer overflow" in combined.lower(),
        oracle_reached=reached_pat in combined,
        oracle_triggered=triggered_pat in combined,
    )
    return sig


def classify_sanitizer_crash(
    combined: str, exit_code: int | None, signals: OutputSignals | None = None
) -> bool:
    """Return True when output matches driver success criteria for sanitizer crash."""
    sig = signals or analyze_output(combined, exit_code, "")
    if sig.has_asan_error:
        return True
    if sig.has_ubsan_runtime and sig.has_ubsan_summary:
        return True
    if sig.has_crash_exit and sig.has_sanitizer_summary:
        return True
    if sig.has_sanitizer_hint:
        return True
    if sig.has_signed_overflow:
        return True
    return False


def verify_poc(
    layout: RunLayout,
    poc_path: Path,
    outer_round: int,
    *,
    build_run_argv,
    load_build_meta,
    cve_id: str = "",
) -> VerificationResult:
    """Run PoC on the built binary and return a structured verification result."""
    meta = load_build_meta(layout)
    args = build_run_argv(layout, poc_path, meta)
    poc_size = poc_path.stat().st_size if poc_path.is_file() else 0

    if not args:
        return VerificationResult(
            crashed=False,
            excerpt="no run_cmd in build_info.json",
            argv=None,
            poc_size=poc_size,
            failure_kind=FailureKind.VERIFICATION_ERROR,
        )

    env = os.environ.copy()
    san_env = meta.get("sanitizer_env")
    if isinstance(san_env, dict):
        for k, v in san_env.items():
            if isinstance(k, str) and v is not None:
                env[str(k)] = str(v)

    log_path = layout.findings / f"sanitizer_run_{outer_round}.log"
    cid = (meta.get("cve_id") or cve_id or "").strip()

    try:
        proc = subprocess.run(
            args,
            cwd=str(layout.source.resolve()),
            capture_output=True,
            text=True,
            timeout=int(os.environ.get("EXEC_TIMEOUT_SEC", "60")),
            env=env,
        )
    except subprocess.TimeoutExpired:
        log_path.write_text("verification run timed out\n", encoding="utf-8")
        return VerificationResult(
            crashed=False,
            excerpt="verification run timed out",
            timed_out=True,
            argv=args,
            poc_size=poc_size,
            failure_kind=FailureKind.VERIFICATION_ERROR,
        )
    except OSError as e:
        msg = f"verification run failed: {e}"
        log_path.write_text(msg + "\n", encoding="utf-8")
        return VerificationResult(
            crashed=False,
            excerpt=msg,
            os_error=str(e),
            argv=args,
            poc_size=poc_size,
            failure_kind=FailureKind.VERIFICATION_ERROR,
        )

    combined = (proc.stdout or "") + (proc.stderr or "")
    log_path.write_text(
        f"exit_code={proc.returncode}\n"
        f"argv={args!r}\n"
        f"--- output ---\n{combined}",
        encoding="utf-8",
    )

    signals = analyze_output(combined, proc.returncode, cid)
    crashed = classify_sanitizer_crash(combined, proc.returncode, signals)
    failure_kind = None
    if not crashed and signals.oracle_triggered:
        failure_kind = FailureKind.ORACLE_TRIGGERED_NO_SANITIZER

    return VerificationResult(
        crashed=crashed,
        excerpt=combined[-2000:],
        exit_code=proc.returncode,
        argv=args,
        poc_size=poc_size,
        signals=signals,
        failure_kind=failure_kind,
    )


def _format_signals(sig: OutputSignals) -> str:
    lines = [
        f"- sanitizer ERROR line: {sig.has_asan_error}",
        f"- UBSan runtime error: {sig.has_ubsan_runtime}",
        f"- UBSan SUMMARY: {sig.has_ubsan_summary}",
        f"- any SUMMARY line: {sig.has_sanitizer_summary}",
        f"- crash-like exit code: {sig.has_crash_exit}",
        f"- sanitizer hint (ASan/heap/SEGV/ABRT): {sig.has_sanitizer_hint}",
        f"- signed integer overflow message: {sig.has_signed_overflow}",
        f"- oracle reached: {sig.oracle_reached}",
        f"- oracle triggered: {sig.oracle_triggered}",
    ]
    return "\n".join(lines)


def _format_init_outputs(meta: dict[str, Any], bb_text: str) -> str:
    run_cmd = meta.get("run_cmd") or []
    return (
        f"- bug_class: {meta.get('bug_class')!r}\n"
        f"- sanitizer: {meta.get('sanitizer')!r}\n"
        f"- run_cmd: {run_cmd!r}\n"
        f"- binary_path: {meta.get('binary_path')!r}\n"
        f"- BBtargets:\n{bb_text or '(empty)'}"
    )


def build_init_retry_feedback(
    *,
    failure_kind: FailureKind,
    meta: dict[str, Any],
    bb_text: str = "",
    verification: VerificationResult | None = None,
    extra_context: str = "",
) -> str:
    """Build structured, general-purpose feedback for the next INIT attempt."""
    sections: list[str] = []

    if failure_kind == FailureKind.ORACLE_TRIGGERED_NO_SANITIZER and verification:
        v = verification
        sig = v.signals
        sections.append(
            "## Outcome\n"
            "- Inner fuzz reported oracle **triggered**.\n"
            f"- Driver sanitizer verification: **no crash detected**.\n"
            f"- Verification exit code: {v.exit_code!r}\n"
            f"- PoC size: {v.poc_size} bytes\n"
            f"- Process timed out: {v.timed_out}\n"
            f"- Process OS error: {v.os_error!r}"
        )
        sections.append("## Observed evidence\n" + _format_signals(sig))
        if v.excerpt.strip():
            sections.append(
                "## Runtime output tail\n"
                f"{v.excerpt.strip()}\n"
            )
        if v.triggered_then_clean_exit:
            sections.append(
                "## Interpretation hint\n"
                "Oracle triggered but the process exited cleanly. The current oracle "
                "condition may be **necessary but not sufficient** for the sanitizer-visible "
                "failure. Tighten the oracle predicate and/or ensure run_cmd exercises the "
                "full crashing path."
            )
        sections.append("## Current INIT outputs\n" + _format_init_outputs(meta, bb_text))
        sections.append(
            "## Likely failure categories to evaluate\n"
            "Consider **all** of the following; more than one may apply:\n"
            "1. **Oracle condition too broad** — input satisfies reach/trigger but not the "
            "crash precondition (e.g. width/truncation/cast edge not reached).\n"
            "2. **Oracle placement** — oracle is not immediately before the operation the "
            "sanitizer will abort on, or labels a guard line instead of the root cause.\n"
            "3. **bug_class / sanitizer mismatch** — chosen sanitizer may not observe this "
            "failure mode (e.g. heap OOB needs ASan; pure UB needs UBSan).\n"
            "4. **run_cmd incomplete** — flags or invocation skip the code path that crashes "
            "(wrong binary, missing format/demuxer/filter flags, wrong input placeholder).\n"
            "5. **Vulnerable ref or build** — worktree is post-fix, wrong tag, or build_cmd "
            "omits required sanitizer flags / builds the wrong target.\n"
            "6. **Environment / execution** — sanitizer_env, timeout, or cwd prevents abort "
            "from being reported.\n"
            "7. **Input-space gap (outer scope)** — environment may be correct; the inner "
            "loop may need a stronger input. Only change INIT-side knobs if you can justify "
            "them from the evidence above."
        )
        sections.append(
            "## Next INIT actions\n"
            "Diagnose which category fits best from the evidence, then apply **minimal** "
            "targeted changes:\n"
            "- Tighten `condition_expr` in BBtargets so trigger implies crash precondition "
            "when possible.\n"
            "- Move oracle line to the root-cause statement **before** the sanitizer-aborting "
            "operation.\n"
            "- Re-evaluate bug_class and sanitizer; rebuild with matching `-fsanitize` flags.\n"
            "- Fix `run_cmd`, vulnerable git ref, or `build_cmd` if the path/build is wrong.\n"
            "- Document your reasoning in the final `INIT done:` line (which category you chose "
            "and what you changed)."
        )

    elif failure_kind == FailureKind.PIER_NO_ORACLE:
        sections.append(
            "## Outcome\n"
            "- Inner PIER loop finished without a valid oracle **triggered** marker.\n"
            "- Driver did not promote a PoC."
        )
        if extra_context.strip():
            sections.append(f"## Context\n{extra_context.strip()}")
        sections.append("## Current INIT outputs\n" + _format_init_outputs(meta, bb_text))
        sections.append(
            "## Likely failure categories to evaluate\n"
            "1. **Oracle never reached** — run_cmd does not hit the instrumented function, "
            "or BBtargets line/file is wrong.\n"
            "2. **Reached but not triggered** — `condition_expr` is too strict or does not "
            "match the actual bug predicate.\n"
            "3. **Wrong vulnerable ref** — code path differs from the CVE-affected revision.\n"
            "4. **Build / binary mismatch** — fuzzer runs a different binary than intended.\n"
            "5. **Launcher or inner agent failure** — check findings/agent.log and launcher "
            "exit status before changing oracles."
        )
        sections.append(
            "## Next INIT actions\n"
            "Inspect logs, then adjust BBtargets (line + condition), run_cmd, ref, or "
            "sanitizer/build only as justified. Explain your diagnosis in `INIT done:`."
        )

    elif failure_kind == FailureKind.VERIFICATION_ERROR and verification:
        v = verification
        sections.append(
            "## Outcome\n"
            "- Driver could not complete sanitizer verification.\n"
            f"- Timed out: {v.timed_out}\n"
            f"- OS error: {v.os_error!r}\n"
            f"- Excerpt: {v.excerpt.strip()}"
        )
        sections.append("## Current INIT outputs\n" + _format_init_outputs(meta, bb_text))
        sections.append(
            "## Likely failure categories to evaluate\n"
            "1. **run_cmd / argv** — binary path, `@@` placeholder, or flags incorrect.\n"
            "2. **Execution timeout** — PoC or command too slow; may need different run flags.\n"
            "3. **Environment** — missing binary, wrong cwd, or sanitizer_env issues.\n"
            "4. **Build incomplete** — binary_path does not exist or is not executable."
        )
        sections.append(
            "## Next INIT actions\n"
            "Fix execution environment (run_cmd, binary_path, build_cmd, cwd, sanitizer_env) "
            "and verify the command runs manually on a small test input."
        )

    else:
        sections.append(
            "## Outcome\n"
            "- INIT phase did not produce a valid environment for the inner loop."
        )
        if extra_context.strip():
            sections.append(f"## Context\n{extra_context.strip()}")
        sections.append(
            "## Next INIT actions\n"
            "Read env/init_agent_*.log and validation errors; fix build_info.json, "
            "BBtargets.txt, worktree ref, and rebuild."
        )

    return "\n\n".join(sections)


def build_pier_no_oracle_feedback(meta: dict[str, Any], bb_text: str = "") -> str:
    """Feedback when inner loop exhausts without oracle trigger."""
    return build_init_retry_feedback(
        failure_kind=FailureKind.PIER_NO_ORACLE,
        meta=meta,
        bb_text=bb_text,
        extra_context="PIER loop exhausted without oracle trigger.",
    )


__all__ = [
    "FailureKind",
    "OutputSignals",
    "VerificationResult",
    "analyze_output",
    "build_init_retry_feedback",
    "build_pier_no_oracle_feedback",
    "classify_sanitizer_crash",
    "verify_poc",
]
