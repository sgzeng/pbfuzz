"""Runtime logging helpers for reproduction runs."""

from __future__ import annotations

import shutil
import traceback
from pathlib import Path


def append_runtime(output_dir: Path, line: str) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / "runtime.log").open("a", encoding="utf-8") as f:
        f.write(line.rstrip() + "\n")


def append_error(output_dir: Path, stage: str, exc: BaseException) -> None:
    logs = output_dir / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    with (logs / "errors.log").open("a", encoding="utf-8") as f:
        f.write(f"[{stage}] {exc}\n")
        f.write(traceback.format_exc())
        f.write("\n")


def mirror_logs(output_dir: Path, work_dir: Path, phase: str) -> None:
    """Copy key artifacts from work/ into output/logs/ for debugging."""
    try:
        dest = output_dir / "logs"
        dest.mkdir(parents=True, exist_ok=True)

        for name in ("build_info.json", "launcher.json"):
            src = work_dir / name
            if src.is_file():
                shutil.copy2(src, dest / name)

        bb = work_dir / "static_results" / "BBtargets.txt"
        if bb.is_file():
            shutil.copy2(bb, dest / "BBtargets.txt")

        out = work_dir / "output"
        if out.is_dir():
            for fname in (
                "prompt.txt",
                "agent_bundle.log",
                "last_build.log",
                "candidate_poc.bin",
                "CANDIDATE_READY",
            ):
                f = out / fname
                if f.is_file():
                    shutil.copy2(f, dest / f"{phase}_{fname}")

        src_root = work_dir / "source"
        for log_name in ("cursor.log",):
            f = src_root / log_name
            if f.is_file():
                shutil.copy2(f, dest / f"{phase}_{log_name}")

        cur = src_root / ".cursor"
        if cur.is_dir():
            snap = dest / f"{phase}_cursor"
            snap.mkdir(parents=True, exist_ok=True)
            for name in ("mcp.json", "cli.json", "workflow_state.md", "project_config.md"):
                f = cur / name
                if f.is_file():
                    shutil.copy2(f, snap / name)
    except OSError:
        return
