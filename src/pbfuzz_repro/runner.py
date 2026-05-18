"""CVE reproduction orchestration: INIT → oracle → pbfuzz inner loop."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from pbfuzz_repro import cursor_runner, init_check, logs, pbfuzz_env, workspace
from pbfuzz_repro.prompts import PIER_APPENDIX, build_init_prompt
from pbfuzz_repro.run_timeout import DEFAULT_RUN_TIMEOUT_SEC, RunTimeoutError, run_with_timeout
from pbfuzz_repro.verification import (
    FailureKind,
    VerificationResult,
    build_init_retry_feedback,
    build_pier_no_oracle_feedback,
    verify_poc,
)
from pbfuzz_repro.workspace import RunLayout


@dataclass
class ReproArgs:
    cve_description: Path
    patch: Path | None
    source: Path
    output: Path
    max_outer_rounds: int = 2
    max_inner_iter: int = 10
    init_max_attempts: int = 2
    init_timeout_sec: int = 1200
    inner_timeout_sec: int = 1800
    run_timeout_sec: int = DEFAULT_RUN_TIMEOUT_SEC
    hint_enabled: bool = True


def _load_build_meta(layout: RunLayout) -> dict:
    meta_path = layout.env / "build_info.json"
    if meta_path.is_file():
        try:
            return json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {}


def _load_cve_id(layout: RunLayout, fallback: str) -> str:
    meta = _load_build_meta(layout)
    cid = (meta.get("cve_id") or "").strip()
    return cid if cid else fallback


def _build_run_argv(layout: RunLayout, poc_path: Path, meta: dict) -> list[str] | None:
    run_cmd = meta.get("run_cmd") or []
    if not run_cmd:
        bp = meta.get("binary_path") or ""
        run_cmd = [bp, "@@"] if bp else []
    if not run_cmd:
        return None

    src = layout.source.resolve()
    args: list[str] = []
    for i, part in enumerate(run_cmd):
        if part == "@@":
            args.append(str(poc_path.resolve()))
            continue
        if i == 0 and part and not part.startswith("-"):
            p = Path(part)
            if not p.is_absolute():
                p = src / part
            if p.is_file():
                args.append(str(p.resolve()))
                continue
        args.append(part)
    return args


def verify_sanitizer_crash(
    layout: RunLayout, poc_path: Path, outer_round: int
) -> tuple[bool, str]:
    """Run PoC on the built binary; success only on sanitizer crash output."""
    result = verify_poc(
        layout,
        poc_path,
        outer_round,
        build_run_argv=_build_run_argv,
        load_build_meta=_load_build_meta,
        cve_id=_load_cve_id(layout, ""),
    )
    return result.crashed, result.excerpt


async def _run_init_phase(
    args: ReproArgs, layout: RunLayout, cve_id: str, last_feedback: str = ""
) -> bool:
    source_repo = args.source.resolve()
    output_dir = args.output.resolve()
    feedback = last_feedback

    for attempt in range(args.init_max_attempts):
        logs.append_runtime(output_dir, f"init.attempt.{attempt}.start feedback={feedback!r}")
        workspace.prepare_init_ws(layout)
        prompt = build_init_prompt(
            source_repo=source_repo,
            layout=layout,
            patch_available=args.patch is not None,
            last_feedback=feedback,
            hint_enabled=args.hint_enabled,
        )
        try:
            await cursor_runner.run_iteration(
                layout.init_ws, prompt, timeout=args.init_timeout_sec
            )
            workspace.copy_init_agent_log(layout, attempt)
        except Exception as e:  # noqa: BLE001
            logs.append_error(output_dir, f"init.attempt.{attempt}", e)
            feedback = build_init_retry_feedback(
                failure_kind=FailureKind.INIT_FAILED,
                meta=_load_build_meta(layout),
                extra_context=f"INIT cursor-agent raised: {e}",
            )
            continue

        ok, reason = init_check.validate_init(layout)
        logs.append_runtime(output_dir, f"init.attempt.{attempt}.validate ok={ok} reason={reason!r}")
        if ok:
            cve_id = _load_cve_id(layout, cve_id)
            if init_check.normalize_sanitizer_build(layout):
                logs.append_runtime(
                    output_dir, "init.normalized_sanitizer asan+ubsan for ubsan-required bug_class"
                )
            oracle_ok, oracle_log = init_check.auto_insert_oracles(layout, cve_id)
            logs.append_runtime(
                output_dir,
                f"init.auto_oracles ok={oracle_ok} log_tail={oracle_log[-400:]!r}",
            )
            meta = _load_build_meta(layout)
            logs.append_runtime(
                output_dir,
                f"init.meta bug_class={meta.get('bug_class')!r} sanitizer={meta.get('sanitizer')!r}",
            )
            return oracle_ok
        feedback = build_init_retry_feedback(
            failure_kind=FailureKind.INIT_FAILED,
            meta=_load_build_meta(layout),
            extra_context=reason,
        )

    return False


async def _run_inner_pier(args: ReproArgs, layout: RunLayout, cve_id: str, outer: int) -> tuple[bool, "Path | None"]:
    output_dir = args.output.resolve()
    src_ws = layout.source.resolve()

    logs.append_runtime(output_dir, f"outer.{outer}.pier.start")
    workspace.clear_candidate_marker(layout)
    cve_id = _load_cve_id(layout, cve_id)
    cfg_path = pbfuzz_env.write_launcher_config(
        layout, cve_id, patch_available=args.patch is not None
    )
    try:
        rc = await pbfuzz_env.run_launcher(cfg_path, output_dir=output_dir)
    except Exception as e:  # noqa: BLE001
        logs.append_error(output_dir, f"outer.{outer}.launcher", e)
        return False, None
    if rc != 0:
        logs.append_runtime(output_dir, f"outer.{outer}.launcher_exit={rc}")

    prompt_file = layout.findings / "prompt.txt"
    if not prompt_file.is_file():
        logs.append_runtime(output_dir, f"outer.{outer}.no_prompt")
        return False, None

    pier_extra = PIER_APPENDIX
    prompt_text = prompt_file.read_text(encoding="utf-8", errors="replace")
    if pier_extra.strip() not in prompt_text:
        prompt_file.write_text(prompt_text + pier_extra, encoding="utf-8")

    try:
        await cursor_runner.run_iteration_source_only(
            prompt_file, src_ws, timeout=args.inner_timeout_sec
        )
    except Exception as e:  # noqa: BLE001
        logs.append_error(output_dir, f"outer.{outer}.inner", e)
        return False, None

    workspace.sync_findings(layout)
    candidate_path = workspace.read_candidate_poc(layout)
    if candidate_path:
        logs.append_runtime(
            output_dir,
            f"outer.{outer}.oracle_triggered poc_bytes={candidate_path.stat().st_size}",
        )
        return True, candidate_path

    logs.append_runtime(output_dir, f"outer.{outer}.pier_no_trigger")
    return False, None


def _read_bb_text(layout: RunLayout) -> str:
    bb_path = layout.env / "static_results" / "BBtargets.txt"
    if bb_path.is_file():
        return bb_path.read_text(encoding="utf-8", errors="replace")[:1500]
    return ""


def _collect_poc_candidates(layout: RunLayout) -> list[Path]:
    """Ordered PoC paths to try when promoting a verified crash (newest first)."""
    findings = layout.findings
    ordered: list[Path] = []

    def _add(path: Path) -> None:
        if path.is_file() and path.stat().st_size > 0:
            ordered.append(path)

    _add(findings / "candidate_poc.bin")
    tc_dir = findings / "testcases"
    if tc_dir.is_dir():
        triggered = sorted(
            tc_dir.glob("*_triggered"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for p in triggered:
            _add(p)
    crash_dir = findings / "crashes"
    if crash_dir.is_dir():
        crashes = sorted(
            crash_dir.glob("poc_*"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for p in crashes:
            _add(p)

    seen: set[str] = set()
    unique: list[Path] = []
    for p in ordered:
        key = str(p.resolve())
        if key in seen:
            continue
        seen.add(key)
        unique.append(p)
    return unique


def try_promote_verified_poc(
    layout: RunLayout, output_dir: Path, outer_round: int, cve_id: str
) -> Path | None:
    """Verify collected fuzz artifacts and write poc.bin on first sanitizer crash."""
    for poc_path in _collect_poc_candidates(layout):
        verification = verify_poc(
            layout,
            poc_path,
            outer_round,
            build_run_argv=_build_run_argv,
            load_build_meta=_load_build_meta,
            cve_id=cve_id,
        )
        if not verification.crashed:
            continue
        poc_out = output_dir / "poc.bin"
        shutil.copy2(poc_path, poc_out)
        logs.append_runtime(
            output_dir,
            f"Reproduced: yes ({cve_id}) promoted from {poc_path.relative_to(layout.findings)}",
        )
        return poc_out
    return None


async def run_reproduction_async(args: ReproArgs) -> Path | None:
    args.output.mkdir(parents=True, exist_ok=True)
    os.environ["PBFUZZ_HINT_ENABLED"] = "1" if args.hint_enabled else "0"
    patch_available = args.patch is not None
    cve_id = workspace.write_inputs(args.output, args.cve_description, args.patch)
    workspace.compose_task_md(
        args.output, cve_id, patch_available=patch_available, hint_enabled=args.hint_enabled
    )
    layout = workspace.init_layout(args.output, cve_id)

    logs.append_runtime(args.output, f"start cve_id={cve_id} source={args.source}")

    last_feedback = ""
    for outer in range(args.max_outer_rounds):
        logs.append_runtime(args.output, f"outer.{outer}.start")
        workspace.reset_source_tree(layout)

        init_ok = await _run_init_phase(args, layout, cve_id, last_feedback=last_feedback)
        if not init_ok:
            last_feedback = build_init_retry_feedback(
                failure_kind=FailureKind.INIT_FAILED,
                meta=_load_build_meta(layout),
                bb_text=_read_bb_text(layout),
                extra_context="INIT phase failed; check env/build_info.json and env/init_agent_*.log",
            )
            logs.append_runtime(args.output, f"outer.{outer}.init_failed")
            continue

        cve_id = _load_cve_id(layout, cve_id)
        pier_ok, candidate_path = await _run_inner_pier(args, layout, cve_id, outer)
        meta = _load_build_meta(layout)
        bb_text = _read_bb_text(layout)

        if not pier_ok or candidate_path is None:
            last_feedback = build_pier_no_oracle_feedback(meta, bb_text)
            continue

        verification: VerificationResult = verify_poc(
            layout,
            candidate_path,
            outer,
            build_run_argv=_build_run_argv,
            load_build_meta=_load_build_meta,
            cve_id=cve_id,
        )

        logs.append_runtime(
            args.output,
            f"outer.{outer}.sanitizer crashed={verification.crashed} "
            f"excerpt_tail={verification.excerpt[-500:]!r}",
        )

        if verification.crashed:
            poc_out = args.output / "poc.bin"
            shutil.copy2(candidate_path, poc_out)
            logs.append_runtime(args.output, f"Reproduced: yes ({cve_id})")
            return poc_out

        last_feedback = build_init_retry_feedback(
            failure_kind=FailureKind.ORACLE_TRIGGERED_NO_SANITIZER,
            meta=meta,
            bb_text=bb_text,
            verification=verification,
        )

    logs.append_runtime(args.output, "no PoC produced; scanning triggered artifacts")
    cve_id = _load_cve_id(layout, cve_id)
    promoted = try_promote_verified_poc(layout, args.output, args.max_outer_rounds, cve_id)
    if promoted is not None:
        return promoted
    logs.append_runtime(args.output, "no verified PoC among collected artifacts")
    return None


def _promote_on_timeout(args: ReproArgs) -> None:
    """Best-effort poc.bin promotion when the outer wall-clock limit fires."""
    desc = args.cve_description.read_text(encoding="utf-8", errors="replace")
    cve_id = workspace.extract_cve_id(desc)
    layout = workspace.init_layout(args.output, cve_id)
    try_promote_verified_poc(
        layout, args.output, max(0, args.max_outer_rounds - 1), cve_id
    )


def run_reproduction(args: ReproArgs) -> Path | None:
    async def _run() -> Path | None:
        return await run_with_timeout(
            run_reproduction_async(args),
            timeout_sec=args.run_timeout_sec,
            run_root=args.output,
            on_timeout=lambda: _promote_on_timeout(args),
        )

    result = asyncio.run(_run())
    if result is not None:
        return result
    poc = args.output / "poc.bin"
    if poc.is_file() and poc.stat().st_size > 0:
        return poc
    return None
