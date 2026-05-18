"""Runtime logging helpers for reproduction runs."""

from __future__ import annotations

import traceback
from pathlib import Path

from pbfuzz_repro.workspace import RunLayout


def append_runtime(output_dir: Path, line: str) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    with (output_dir / "runtime.log").open("a", encoding="utf-8") as f:
        f.write(line.rstrip() + "\n")


def append_error(output_dir: Path, stage: str, exc: BaseException) -> None:
    append_runtime(output_dir, f"[error] {stage}: {exc}")
    findings = output_dir / "findings"
    findings.mkdir(parents=True, exist_ok=True)
    with (findings / "driver_errors.log").open("a", encoding="utf-8") as f:
        f.write(f"[{stage}] {exc}\n")
        f.write(traceback.format_exc())
        f.write("\n")


def append_error_layout(layout: RunLayout, stage: str, exc: BaseException) -> None:
    append_error(layout.run_root, stage, exc)
