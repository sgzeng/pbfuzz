"""Prepare launcher config and run pbfuzz/launcher.py."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from pbfuzz_repro.workspace import RunLayout

def _default_pbfuzz_home() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in (
        here.parent.parent / "pbfuzz",
        here.parent.parent.parent / "pbfuzz",
    ):
        if candidate.is_dir():
            return candidate
    return here.parent.parent.parent / "pbfuzz"


_PBFUZZ = Path(os.environ.get("PBFUZZ_HOME") or _default_pbfuzz_home()).resolve()


def build_launcher_dict(
    layout: RunLayout, cve_id: str, *, patch_available: bool = True
) -> dict[str, Any]:
    meta_path = layout.env / "build_info.json"
    meta: dict[str, Any] = {}
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    run_cmd = meta.get("run_cmd")
    if not run_cmd:
        bin_path = meta.get("binary_path") or "./a.out"
        run_cmd = [str(bin_path).strip(), "@@"]
    max_iters = int(os.environ.get("MAX_INNER_ITER", "10"))
    exec_timeout = int(os.environ.get("EXEC_TIMEOUT_SEC", "5"))
    llm_model = (os.environ.get("PBFUZZ_LLM_MODEL") or os.environ.get("CURSOR_MODEL") or "").strip()
    if not llm_model:
        llm_model = "gemini-2.5-pro"
    cve = (meta.get("cve_id") or cve_id or "CVE-UNKNOWN").strip()
    return {
        "static_result_folder": str((layout.env / "static_results").resolve()),
        "source_code_folder": str(layout.source.resolve()),
        "output_dir": str(layout.findings.resolve()),
        "workspace_root": str(layout.env.resolve()),
        "llm_model": llm_model,
        "cve_id": cve,
        "build_cmd": meta.get("build_cmd", ""),
        "binary_path": meta.get("binary_path", ""),
        "build_cwd": meta.get("cwd", ""),
        "cmd": run_cmd,
        "reached_pattern": f"{cve} reached",
        "triggered_pattern": f"{cve} triggered",
        "max_iters": max_iters,
        "exec_timeout_sec": exec_timeout,
        "enable_static_precondition_inference": os.environ.get(
            "PBFUZZ_STATIC_PRECONDITIONS", "0"
        ).strip() in ("1", "true", "yes"),
        "lldb_path": os.environ.get("LLDB_PATH", "/usr/bin/lldb-20"),
        "bug_class": meta.get("bug_class", ""),
        "sanitizer": meta.get("sanitizer", ""),
        "sanitizer_env": meta.get("sanitizer_env") or {},
        "patch_available": patch_available,
    }


async def run_launcher(config_path: Path, output_dir: Path | None = None) -> int:
    launcher = _PBFUZZ / "launcher.py"
    cmd = [sys.executable, str(launcher), "-config", str(config_path)]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(_PBFUZZ),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env={**os.environ, "PYTHONPATH": str(_PBFUZZ)},
    )
    out, _ = await proc.communicate()
    text = out.decode(errors="replace")
    rc = proc.returncode if proc.returncode is not None else -1
    if rc != 0 and output_dir is not None:
        from pbfuzz_repro.logs import append_runtime

        tail = text[-2000:] if len(text) > 2000 else text
        append_runtime(output_dir, f"launcher.py failed rc={rc} tail={tail!r}")
    return rc


def write_launcher_config(
    layout: RunLayout, cve_id: str, *, patch_available: bool = True
) -> Path:
    cfg = build_launcher_dict(layout, cve_id, patch_available=patch_available)
    path = layout.findings / "launcher.json"
    path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return path
