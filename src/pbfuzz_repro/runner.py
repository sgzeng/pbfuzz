"""CVE reproduction orchestration: INIT → oracle → pbfuzz inner loop."""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path

from pbfuzz_repro import cursor_runner, init_check, logs, pbfuzz_env, workspace
from pbfuzz_repro.prompts import build_init_prompt


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


def _load_cve_id(work: Path, fallback: str) -> str:
    meta_path = work / "build_info.json"
    if meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            cid = (meta.get("cve_id") or "").strip()
            if cid:
                return cid
        except json.JSONDecodeError:
            pass
    return fallback


def verify_poc_triggered(work: Path, poc_path: Path, cve_id: str) -> tuple[bool, str]:
    """Run the built binary with poc_path; check stderr for triggered oracle."""
    meta_path = work / "build_info.json"
    if not meta_path.is_file():
        return False, "missing build_info.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    run_cmd = meta.get("run_cmd") or []
    if not run_cmd:
        bp = meta.get("binary_path") or ""
        run_cmd = [bp, "@@"] if bp else []
    if not run_cmd:
        return False, "no run_cmd in build_info.json"

    src = (work / "source").resolve()
    args = []
    for i, part in enumerate(run_cmd):
        if part == "@@":
            args.append(str(poc_path.resolve()))
            continue
        # Only resolve the executable (first token); leave flags and literals unchanged.
        if i == 0 and part and not part.startswith("-"):
            p = Path(part)
            if not p.is_absolute():
                p = src / part
            if p.is_file():
                args.append(str(p.resolve()))
                continue
        args.append(part)

    try:
        proc = subprocess.run(
            args,
            cwd=str(src),
            capture_output=True,
            text=True,
            timeout=int(os.environ.get("EXEC_TIMEOUT_SEC", "30")),
            env=os.environ.copy(),
        )
    except subprocess.TimeoutExpired:
        return False, "verification run timed out"
    except OSError as e:
        return False, f"verification run failed: {e}"

    combined = (proc.stdout or "") + (proc.stderr or "")
    marker = f"{cve_id} triggered"
    if marker.lower() in combined.lower():
        return True, combined[-2000:]
    return False, combined[-2000:]


async def _run_init_phase(args: ReproArgs, work: Path, cve_id: str) -> bool:
    source_repo = args.source.resolve()
    output_dir = args.output.resolve()
    last_feedback = ""
    init_cwd = output_dir  # INIT reads inputs/ and writes work/

    for attempt in range(args.init_max_attempts):
        logs.append_runtime(output_dir, f"init.attempt.{attempt}.start feedback={last_feedback!r}")
        prompt = build_init_prompt(
            source_repo=source_repo,
            output_dir=output_dir,
            work_dir=work,
            last_feedback=last_feedback,
        )
        try:
            await cursor_runner.run_iteration(init_cwd, prompt, timeout=args.init_timeout_sec)
            log_dest = output_dir / "logs" / f"init_cursor_{attempt}.log"
            log_dest.parent.mkdir(parents=True, exist_ok=True)
            src_log = init_cwd / "cursor.log"
            if src_log.is_file():
                log_dest.write_text(src_log.read_text(encoding="utf-8", errors="replace"))
        except Exception as e:  # noqa: BLE001
            logs.append_error(output_dir, f"init.attempt.{attempt}", e)
            last_feedback = f"INIT cursor-agent raised: {e}"
            continue

        ok, reason = init_check.validate_init(work)
        logs.append_runtime(output_dir, f"init.attempt.{attempt}.validate ok={ok} reason={reason!r}")
        if ok:
            workspace.seed_cursor_templates(work, cve_id)
            workspace.write_init_mcp(work)
            cve_id = _load_cve_id(work, cve_id)
            oracle_ok, oracle_log = init_check.auto_insert_oracles(work, cve_id)
            logs.append_runtime(
                output_dir,
                f"init.auto_oracles ok={oracle_ok} log_tail={oracle_log[-400:]!r}",
            )
            logs.mirror_logs(output_dir, work, f"after_init_{attempt}")
            return oracle_ok
        last_feedback = reason

    return False


async def _run_outer_loop(args: ReproArgs, work: Path, cve_id: str) -> Path | None:
    output_dir = args.output.resolve()
    src_ws = (work / "source").resolve()

    for outer in range(args.max_outer_rounds):
        workspace.clear_candidate_marker(work)
        logs.append_runtime(output_dir, f"outer.{outer}.start")
        cve_id = _load_cve_id(work, cve_id)
        cfg_path = pbfuzz_env.write_launcher_config(work, cve_id)
        log_agg = work / "output" / "agent_bundle.log"
        try:
            rc = await pbfuzz_env.run_launcher(cfg_path, log_append=log_agg)
        except Exception as e:  # noqa: BLE001
            logs.append_error(output_dir, f"outer.{outer}.launcher", e)
            continue
        logs.mirror_logs(output_dir, work, f"after_launcher_{outer}")
        if rc != 0:
            logs.append_runtime(output_dir, f"outer.{outer}.launcher_exit={rc}")

        prompt_file = work / "output" / "prompt.txt"
        if not prompt_file.is_file():
            logs.append_runtime(output_dir, f"outer.{outer}.no_prompt")
            continue

        try:
            await cursor_runner.run_iteration_source_only(
                prompt_file, src_ws, timeout=args.inner_timeout_sec
            )
            inner_log = output_dir / "logs" / f"inner_cursor_{outer}.log"
            inner_log.parent.mkdir(parents=True, exist_ok=True)
            if (src_ws / "cursor.log").is_file():
                inner_log.write_text(
                    (src_ws / "cursor.log").read_text(encoding="utf-8", errors="replace")
                )
        except Exception as e:  # noqa: BLE001
            logs.append_error(output_dir, f"outer.{outer}.inner", e)
            continue

        logs.mirror_logs(output_dir, work, f"after_inner_{outer}")
        candidate = workspace.read_candidate_poc(work)
        if candidate:
            poc_out = output_dir / "poc.bin"
            poc_out.write_bytes(candidate)
            logs.append_runtime(output_dir, f"outer.{outer}.candidate_bytes={len(candidate)}")
            return poc_out

        logs.append_runtime(output_dir, f"outer.{outer}.no_candidate")

    return None


async def run_reproduction_async(args: ReproArgs) -> Path | None:
    args.output.mkdir(parents=True, exist_ok=True)
    cve_id = workspace.write_inputs(args.output, args.cve_description, args.patch)
    workspace.compose_task_md(args.output, cve_id)
    work = workspace.init_work_layout(args.output, cve_id)

    logs.append_runtime(args.output, f"start cve_id={cve_id} source={args.source}")

    init_ok = await _run_init_phase(args, work, cve_id)
    if not init_ok:
        logs.append_runtime(args.output, "INIT failed; aborting")
        return None

    cve_id = _load_cve_id(work, cve_id)
    poc_path = await _run_outer_loop(args, work, cve_id)
    if poc_path is None:
        logs.append_runtime(args.output, "no PoC produced")
        return None

    ok, excerpt = verify_poc_triggered(work, poc_path, cve_id)
    logs.append_runtime(
        args.output,
        f"verify triggered={ok} excerpt_tail={excerpt[-500:]!r}",
    )
    if ok:
        logs.append_runtime(args.output, f"Reproduced: yes ({cve_id})")
    else:
        logs.append_runtime(args.output, f"Reproduced: no (poc written but oracle not triggered)")
    return poc_path


def run_reproduction(args: ReproArgs) -> Path | None:
    return asyncio.run(run_reproduction_async(args))
