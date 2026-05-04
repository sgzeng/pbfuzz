"""Mirror task workspace state to a host directory for manual debugging.

Failures here must never affect A2A execution: all public entrypoints swallow errors."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from prompts import WORKSPACE_FILES_GUIDE

_PACKAGE_ROOT = Path(__file__).resolve().parent.parent


def resolve_output_root() -> Path | None:
    """Return destination root from ``PURPLE_OUTPUT_HOST``, or ``None`` if mirroring is off."""
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
    """Copy debugging artifacts under ``<root>/<sanitized_context_id>/``.

    Includes ``WORKSPACE_FILES_GUIDE.txt`` (prompts workspace list), task files, cursor logs,
    ``make_poc.py``, ``poc.bin``, and an append-only aggregate log.
    """
    try:
        root = resolve_output_root()
        if root is None:
            return
        safe_id = (context_id or "unknown").replace("/", "_")
        dest = root / safe_id
        dest.mkdir(parents=True, exist_ok=True)

        (dest / "WORKSPACE_FILES_GUIDE.txt").write_text(WORKSPACE_FILES_GUIDE.rstrip() + "\n", encoding="utf-8")

        for name in ("TASK.md", "description.txt", "error.txt", "feedback.json", "patch.diff"):
            src = workspace / name
            if src.is_file():
                shutil.copy2(src, dest / name)

        for name in ("make_poc.py", "poc.bin"):
            src = workspace / name
            if src.is_file():
                shutil.copy2(src, dest / name)

        clog = workspace / "cursor.log"
        if clog.is_file():
            it_part = f"_iter{iteration}" if iteration is not None else ""
            snap = dest / f"cursor_agent{it_part}_{phase}.log"
            shutil.copy2(clog, snap)
            acc = dest / "cursor_agent_all_output.txt"
            with acc.open("a", encoding="utf-8") as out:
                out.write(f"\n\n===== phase={phase} iteration={iteration} =====\n")
                out.write(clog.read_text(encoding="utf-8", errors="replace"))

        meta = {"context_id": context_id, "phase": phase, "iteration": iteration, "workspace": str(workspace)}
        with (dest / "sync_manifest.jsonl").open("a", encoding="utf-8") as mj:
            mj.write(json.dumps(meta) + "\n")
    except Exception:
        return
