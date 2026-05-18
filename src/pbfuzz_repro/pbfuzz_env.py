"""Prepare launcher config and run pbfuzz/launcher.py."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

_PBFUZZ = Path(os.environ.get("PBFUZZ_HOME", Path(__file__).resolve().parent.parent.parent / "pbfuzz")).resolve()


def build_launcher_dict(work: Path, cve_id: str) -> dict[str, Any]:
    meta_path = work / "build_info.json"
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
        "static_result_folder": str((work / "static_results").resolve()),
        "source_code_folder": str((work / "source").resolve()),
        "output_dir": str((work / "output").resolve()),
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
    }


async def run_launcher(config_path: Path, log_append: Path | None = None) -> int:
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
    if log_append:
        log_append.parent.mkdir(parents=True, exist_ok=True)
        with log_append.open("a", encoding="utf-8") as f:
            f.write("\n===== launcher.py =====\n")
            f.write(text)
    rc = proc.returncode
    return rc if rc is not None else -1


def write_launcher_config(work: Path, cve_id: str) -> Path:
    cfg = build_launcher_dict(work, cve_id)
    path = work / "launcher.json"
    path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return path
