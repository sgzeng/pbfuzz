"""Prepare pbfuzz workspace files (launcher.py): workflow, ``prompt.txt``, ``mcp.json``.

## Data flow (Cybergym green → purple → launcher)

The green agent (`cybergym-green/src/agent.py`) sends **one** initial ``Message`` per task
with the source tarballs and supporting files. Green does not ship static-analysis
outputs; the purple wrapper builds ``pbfuzz_workspace/static_results/BBtargets.txt`` via
the INIT cursor-agent, then auto-instruments the source via
``init_check.auto_insert_oracles`` before the inner loop runs. ``function_info.txt`` and
``bid_loc_mapping.txt`` are no longer required — PromptBuilder treats their absence as
"no static enrichment available".

After ``run_launcher``, ``cursor_runner`` runs ``cursor-agent`` with ``--workspace`` =
``pbfuzz_workspace/source`` (vulnerable tree symlink target).

Purple flow: ``write_launcher_config`` → ``run_launcher`` → ``cursor_runner`` inner loop.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

_PBFUZZ = Path(os.environ.get("PBFUZZ_HOME", Path(__file__).resolve().parent.parent / "pbfuzz")).resolve()


def build_launcher_dict(pbfuzz_ws: Path, task_id: str) -> dict[str, Any]:
    """Assemble launcher JSON from ``cybergym_build.json`` and patterns."""
    cg_path = pbfuzz_ws / "cybergym_build.json"
    cg: dict[str, Any] = {}
    if cg_path.is_file():
        cg = json.loads(cg_path.read_text(encoding="utf-8"))
    run_cmd = cg.get("run_cmd")
    if not run_cmd:
        bin_path = cg.get("binary_path") or "./a.out"
        run_cmd = [str(bin_path).strip(), "@@"]
    max_iters = int(os.environ.get("MAX_INNER_ITER", "10"))
    exec_timeout = int(os.environ.get("EXEC_TIMEOUT_SEC", "5"))
    # Treat empty env (common with `CURSOR_MODEL: ${CURSOR_MODEL:-}` in compose) as unset
    llm_model = (os.environ.get("PBFUZZ_LLM_MODEL") or os.environ.get("CURSOR_MODEL") or "").strip()
    if not llm_model:
        llm_model = "gemini-2.5-pro"
    return {
        "static_result_folder": str((pbfuzz_ws / "static_results").resolve()),
        "source_code_folder": str((pbfuzz_ws / "source").resolve()),
        "output_dir": str((pbfuzz_ws / "output").resolve()),
        "llm_model": llm_model,
        "task_id": task_id,
        "build_cmd": cg.get("build_cmd", ""),
        "binary_path": cg.get("binary_path", ""),
        "cybergym_cwd": cg.get("cwd", ""),
        "cmd": run_cmd,
        "reached_pattern": f"{task_id} reached",
        "triggered_pattern": f"{task_id} triggered",
        "max_iters": max_iters,
        "exec_timeout_sec": exec_timeout,
        # Static-analysis-driven precondition inference is unavailable without function_info.txt /
        # bid_loc_mapping.txt; default off but allow opting back in when those files are populated.
        "enable_static_precondition_inference": os.environ.get(
            "PBFUZZ_STATIC_PRECONDITIONS", "0"
        ).strip() in ("1", "true", "yes"),
        "lldb_path": os.environ.get("LLDB_PATH", "/usr/bin/lldb-20"),
    }


async def run_launcher(config_path: Path, log_append: Path | None = None) -> int:
    """Run ``python launcher.py -config ...`` to write prompt, workflow, and MCP config."""
    launcher = _PBFUZZ / "launcher.py"
    cmd = [
        sys.executable,
        str(launcher),
        "-config",
        str(config_path),
    ]
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


def write_launcher_config(pbfuzz_ws: Path, task_id: str) -> Path:
    """Write ``cybergym_launcher.json`` under ``pbfuzz_ws``."""
    cfg = build_launcher_dict(pbfuzz_ws, task_id)
    path = pbfuzz_ws / "cybergym_launcher.json"
    path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return path
