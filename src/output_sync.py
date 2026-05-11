"""Mirror task workspace state to a host directory for debugging (best-effort)."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from prompts import WORKSPACE_FILES_GUIDE

_PACKAGE_ROOT = Path(__file__).resolve().parent.parent


def resolve_output_root() -> Path | None:
    raw = os.environ.get("PURPLE_OUTPUT_HOST")
    if raw is None:
        return None
    raw = raw.strip()
    if raw in ("", "0", "false", "none", "off", "disabled"):
        return None
    if raw in ("default", "auto", "1", "true", "yes"):
        return (_PACKAGE_ROOT / "purple_agent_output").resolve()
    p = Path(raw).expanduser()
    if not p.is_absolute():
        p = (_PACKAGE_ROOT / p).resolve()
    else:
        p = p.resolve()
    return p


def sync_context_output(
    *,
    context_id: str,
    workspace: Path,
    phase: str,
    iteration: int | None = None,
) -> None:
    try:
        root = resolve_output_root()
        if root is None:
            return
        safe_id = (context_id or "unknown").replace("/", "_")
        dest = root / safe_id
        dest.mkdir(parents=True, exist_ok=True)

        (dest / "WORKSPACE_FILES_GUIDE.txt").write_text(WORKSPACE_FILES_GUIDE.rstrip() + "\n", encoding="utf-8")

        for name in ("TASK.md", "description.txt", "error.txt", "patch.diff", "agent_runtime.log", "agent_error.log"):
            src = workspace / name
            if src.is_file():
                shutil.copy2(src, dest / name)

        pf = workspace / "pbfuzz_workspace"
        if pf.is_dir():
            for sub in ("output",):
                d = pf / sub
                if d.is_dir():
                    od = dest / "pbfuzz_output"
                    od.mkdir(parents=True, exist_ok=True)
                    for f in d.glob("*"):
                        if f.is_file():
                            shutil.copy2(f, od / f.name)

            cgj = pf / "cybergym_build.json"
            if cgj.is_file():
                shutil.copy2(cgj, dest / "cybergym_build.json")
            bbt = pf / "static_results" / "BBtargets.txt"
            if bbt.is_file():
                shutil.copy2(bbt, dest / "BBtargets.txt")
            lbl = pf / "output" / "last_build.log"
            if lbl.is_file():
                shutil.copy2(lbl, dest / "last_build.log")

            vuln = (pf / "source").resolve()
            vlog = vuln / "cursor.log"
            if vlog.is_file():
                it_part = f"_iter{iteration}" if iteration is not None else ""
                snap = dest / f"cursor_agent{it_part}_{phase}.log"
                shutil.copy2(vlog, snap)

            cur = vuln / ".cursor"
            if cur.is_dir():
                dc = dest / "vuln_cursor"
                for name in ("mcp.json", "cli.json", "workflow_state.md", "project_config.md"):
                    f = cur / name
                    if f.is_file():
                        dc.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(f, dc / name)

        clog = workspace / "cursor.log"
        if clog.is_file():
            it_part = f"_iter{iteration}" if iteration is not None else ""
            snap = dest / f"cursor_agent_workspace_root{it_part}_{phase}.log"
            shutil.copy2(clog, snap)

        meta = {"context_id": context_id, "phase": phase, "iteration": iteration, "workspace": str(workspace)}
        with (dest / "sync_manifest.jsonl").open("a", encoding="utf-8") as mj:
            mj.write(json.dumps(meta) + "\n")
    except Exception:
        return
