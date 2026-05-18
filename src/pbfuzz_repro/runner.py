"""CVE reproduction orchestration: INIT → oracle → pbfuzz inner loop."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from pbfuzz_repro import cursor_runner, init_check, logs, pbfuzz_env, workspace
from pbfuzz_repro.prompts import PIER_APPENDIX, build_init_prompt
from pbfuzz_repro.workspace import RunLayout

_ASAN_RE = re.compile(
    r"==\d+==ERROR: (AddressSanitizer|UndefinedBehaviorSanitizer|MemorySanitizer|LeakSanitizer):"
)
_UBSAN_RUNTIME_RE = re.compile(r"runtime error:", re.IGNORECASE)
_CRASH_EXIT_CODES = frozenset({1, 134, -6, -11})


@dataclass
class ReproArgs:
    cve_description: Path
    patch: Path
    source: Path
    output: Path
    max_outer_rounds: int = 2
    max_inner_iter: int = 10
    init_max_attempts: int = 2
    init_timeout_sec: int = 1200
    inner_timeout_sec: int = 1800


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
    meta = _load_build_meta(layout)
    args = _build_run_argv(layout, poc_path, meta)
    if not args:
        return False, "no run_cmd in build_info.json"

    env = os.environ.copy()
    san_env = meta.get("sanitizer_env")
    if isinstance(san_env, dict):
        for k, v in san_env.items():
            if isinstance(k, str) and v is not None:
                env[str(k)] = str(v)

    log_path = layout.findings / f"sanitizer_run_{outer_round}.log"
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
        return False, "verification run timed out"
    except OSError as e:
        log_path.write_text(f"verification run failed: {e}\n", encoding="utf-8")
        return False, f"verification run failed: {e}"

    combined = (proc.stdout or "") + (proc.stderr or "")
    log_path.write_text(
        f"exit_code={proc.returncode}\n"
        f"argv={args!r}\n"
        f"--- output ---\n{combined}",
        encoding="utf-8",
    )

    crashed = False
    if _ASAN_RE.search(combined):
        crashed = True
    elif _UBSAN_RUNTIME_RE.search(combined) and "SUMMARY: UndefinedBehaviorSanitizer" in combined:
        crashed = True
    elif proc.returncode in _CRASH_EXIT_CODES and "SUMMARY:" in combined:
        crashed = True
    elif re.search(
        r"AddressSanitizer:|heap-buffer-overflow|SEGV|ABRT", combined, re.IGNORECASE
    ):
        crashed = True
    elif "runtime error: signed integer overflow" in combined.lower():
        crashed = True

    return crashed, combined[-2000:]


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
            last_feedback=feedback,
        )
        try:
            await cursor_runner.run_iteration(
                layout.init_ws, prompt, timeout=args.init_timeout_sec
            )
            workspace.copy_init_agent_log(layout, attempt)
        except Exception as e:  # noqa: BLE001
            logs.append_error(output_dir, f"init.attempt.{attempt}", e)
            feedback = f"INIT cursor-agent raised: {e}"
            continue

        ok, reason = init_check.validate_init(layout)
        logs.append_runtime(output_dir, f"init.attempt.{attempt}.validate ok={ok} reason={reason!r}")
        if ok:
            cve_id = _load_cve_id(layout, cve_id)
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
        feedback = reason

    return False


async def _run_inner_pier(args: ReproArgs, layout: RunLayout, cve_id: str, outer: int) -> tuple[bool, "Path | None"]:
    output_dir = args.output.resolve()
    src_ws = layout.source.resolve()

    logs.append_runtime(output_dir, f"outer.{outer}.pier.start")
    workspace.clear_candidate_marker(layout)
    cve_id = _load_cve_id(layout, cve_id)
    cfg_path = pbfuzz_env.write_launcher_config(layout, cve_id)
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


async def run_reproduction_async(args: ReproArgs) -> Path | None:
    args.output.mkdir(parents=True, exist_ok=True)
    cve_id = workspace.write_inputs(args.output, args.cve_description, args.patch)
    workspace.compose_task_md(args.output, cve_id)
    layout = workspace.init_layout(args.output, cve_id)

    logs.append_runtime(args.output, f"start cve_id={cve_id} source={args.source}")

    last_feedback = ""
    for outer in range(args.max_outer_rounds):
        logs.append_runtime(args.output, f"outer.{outer}.start")
        workspace.reset_source_tree(layout)

        init_ok = await _run_init_phase(args, layout, cve_id, last_feedback=last_feedback)
        if not init_ok:
            last_feedback = "INIT phase failed; check env/build_info.json and env/init_agent_*.log"
            logs.append_runtime(args.output, f"outer.{outer}.init_failed")
            continue

        cve_id = _load_cve_id(layout, cve_id)
        pier_ok, candidate_path = await _run_inner_pier(args, layout, cve_id, outer)
        if not pier_ok or candidate_path is None:
            last_feedback = (
                "PIER loop exhausted without oracle trigger. "
                "Refine bug_class, sanitizer, BBtargets, or run_cmd."
            )
            continue

        crashed, excerpt = verify_sanitizer_crash(layout, candidate_path, outer)

        logs.append_runtime(
            args.output,
            f"outer.{outer}.sanitizer crashed={crashed} excerpt_tail={excerpt[-500:]!r}",
        )

        if crashed:
            poc_out = args.output / "poc.bin"
            shutil.copy2(candidate_path, poc_out)
            logs.append_runtime(args.output, f"Reproduced: yes ({cve_id})")
            return poc_out

        meta = _load_build_meta(layout)
        bb_text = ""
        bb_path = layout.env / "static_results" / "BBtargets.txt"
        if bb_path.is_file():
            bb_text = bb_path.read_text(encoding="utf-8", errors="replace")[:1500]
        poc_size = candidate_path.stat().st_size
        last_feedback = (
            f"Oracle triggered but sanitizer {meta.get('sanitizer')!r} did NOT crash.\n"
            f"PoC size={poc_size} bytes. Runtime output tail:\n{excerpt}\n"
            f"Previous bug_class={meta.get('bug_class')!r}, sanitizer={meta.get('sanitizer')!r}\n"
            f"BBtargets:\n{bb_text}\n"
            "Re-classify the vulnerability, pick a different sanitizer/ref/oracle, and rebuild."
        )

    logs.append_runtime(args.output, "no PoC produced")
    return None


def run_reproduction(args: ReproArgs) -> Path | None:
    return asyncio.run(run_reproduction_async(args))
