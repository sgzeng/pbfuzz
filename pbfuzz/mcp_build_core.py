"""Oracle insertion and rebuild logic without MCP dependencies (for reuse and unit tests)."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, List, Optional

from mcp_workflow_server import parse_json_block, replace_json_block


def workflow_path(source_code_dir: Path) -> Path:
    return source_code_dir / ".cursor" / "workflow_state.md"


def read_phase(workflow_file: Path) -> str:
    if not workflow_file.exists():
        return "PLAN"
    content = workflow_file.read_text(encoding="utf-8")
    state = parse_json_block(content, "State")
    if isinstance(state, dict):
        return str(state.get("phase", "PLAN"))
    return "PLAN"


def workspace_root(source_code_dir: Path, explicit: Optional[Path] = None) -> Path:
    if explicit is not None:
        return explicit
    parent = source_code_dir.parent
    if (parent / "build_info.json").exists():
        return parent
    return source_code_dir


# Backward-compatible alias for unit tests
cybergym_root = workspace_root


def resolve_rebuild_workdir(
    ws_root: Path,
    source_code_dir: Path,
    cwd_field: Optional[str],
) -> Path:
    """Directory where ``build_info.json`` ``build_cmd`` runs (``subprocess.run(..., cwd=...)``).

    - Empty ``cwd`` → ``source_code_dir`` (vulnerable tree root; matches INIT_PROMPT).
    - Non-empty ``cwd`` → ``source_code_dir / cwd`` when that path is an existing directory;
      otherwise ``ws_root / cwd`` (legacy layout).
    """
    cwd = (cwd_field or "").strip()
    if cwd:
        candidate = (source_code_dir / cwd).resolve()
        if candidate.is_dir():
            return candidate
        return (ws_root / cwd).resolve()
    return source_code_dir.resolve()


def _bbtargets_path(ws_root: Path) -> Path:
    return ws_root / "static_results" / "BBtargets.txt"


def upsert_bbtargets_entry(
    bb_path: Path,
    relative_file: str,
    line_1based: int,
    condition_expr: str,
) -> None:
    """Insert or replace the ``relative_file:line`` entry in BBtargets.txt.

    Comment lines (``#``) and blank lines are preserved. Existing entries that share
    the same ``file:line`` are dropped before appending the new ``file:line,cond``.
    """
    bb_path.parent.mkdir(parents=True, exist_ok=True)
    target_loc = f"{relative_file}:{line_1based}"
    existing: List[str] = []
    if bb_path.is_file():
        existing = bb_path.read_text(encoding="utf-8", errors="replace").splitlines()

    kept: List[str] = []
    for raw in existing:
        line = raw.strip()
        if not line or line.startswith("#"):
            kept.append(raw)
            continue
        loc = line.split(",", 1)[0].strip()
        if loc == target_loc:
            continue  # drop duplicate; will re-append updated row below
        kept.append(raw)

    new_row = f"{target_loc},{condition_expr}" if condition_expr else target_loc
    kept.append(new_row)
    bb_path.write_text("\n".join(kept).rstrip() + "\n", encoding="utf-8")


def _c_string_literal(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def strip_oracle_blocks(text: str) -> str:
    lines = text.splitlines(keepends=True)
    out: List[str] = []
    skip = False
    for line in lines:
        if "PBFUZZ_ORACLE_START" in line:
            skip = True
            continue
        if "PBFUZZ_ORACLE_END" in line:
            skip = False
            continue
        if not skip:
            out.append(line)
    return "".join(out)


def _insert_oracle_at_line(text: str, line_1based: int, snippet: str) -> str:
    lines = text.splitlines(keepends=True)
    idx = max(0, min(len(lines), line_1based - 1))
    ins = snippet if snippet.endswith("\n") else snippet + "\n"
    return "".join(lines[:idx]) + ins + "".join(lines[idx:])


def insert_oracle_into_file(
    source_root: Path,
    relative_file: str,
    line_1based: int,
    condition_expr: str,
    task_id: str,
    bbtargets_root: Optional[Path] = None,
) -> dict[str, Any]:
    """Insert (or replace) a PBFUZZ_ORACLE block at ``relative_file:line``.

    Also upserts the ``relative_file:line[,condition_expr]`` row in
    ``<bbtargets_root or workspace_root(source_root)>/static_results/BBtargets.txt``
    so Target Locations stay in sync with whatever oracle was last written.
    """
    path = (source_root / relative_file).resolve()
    try:
        source_root_r = source_root.resolve()
        path.relative_to(source_root_r)
    except ValueError:
        return {"ok": False, "error": "path escapes source root"}
    if not path.is_file():
        return {"ok": False, "error": f"not a file: {path}"}

    cleaned = strip_oracle_blocks(path.read_text(encoding="utf-8", errors="replace"))
    tid = _c_string_literal(task_id)
    snippet = (
        f"/* PBFUZZ_ORACLE_START {task_id} */\n"
        f'fprintf(stderr, "%s reached\\n", "{tid}"); fflush(stderr);\n'
        f"if ({condition_expr}) "
        f'{{ fprintf(stderr, "%s triggered\\n", "{tid}"); fflush(stderr); }}\n'
        f"/* PBFUZZ_ORACLE_END {task_id} */\n"
    )
    new_body = _insert_oracle_at_line(cleaned, line_1based, snippet)
    backup = path.with_suffix(path.suffix + ".pbfuzz.bak")
    backup.write_bytes(path.read_bytes())
    path.write_text(new_body, encoding="utf-8")

    bb_root = bbtargets_root if bbtargets_root is not None else workspace_root(source_root, None)
    try:
        upsert_bbtargets_entry(_bbtargets_path(bb_root), relative_file, line_1based, condition_expr)
    except OSError as e:
        return {
            "ok": True,
            "path": str(path),
            "backup": str(backup),
            "warning": f"BBtargets upsert failed: {e}",
        }

    return {"ok": True, "path": str(path), "backup": str(backup)}


def run_rebuild(
    ws_root: Path,
    source_code_dir: Path,
    workflow_file: Path,
    log_path: Path,
) -> dict[str, Any]:
    meta_path = ws_root / "build_info.json"
    if not meta_path.exists():
        return {"ok": False, "error": f"missing {meta_path}"}
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    build_cmd = meta.get("build_cmd") or meta.get("BUILD_CMD")
    if not build_cmd:
        return {"ok": False, "error": "build_info.json has no build_cmd"}

    cwd_meta = meta.get("cwd")
    if cwd_meta is None:
        cwd_meta = ""
    elif not isinstance(cwd_meta, str):
        cwd_meta = str(cwd_meta)
    workdir = resolve_rebuild_workdir(ws_root, source_code_dir, cwd_meta)

    log_lines: List[str] = []
    log_lines.append(
        f"workdir={workdir}\n"
        f"cwd_field={meta.get('cwd')!r}\n"
        f"build_cmd={build_cmd!r}\n"
    )
    proc: Optional[subprocess.CompletedProcess[str]] = None
    try:
        proc = subprocess.run(
            build_cmd,
            shell=True,
            cwd=str(workdir),
            capture_output=True,
            text=True,
            timeout=600,
            env=os.environ.copy(),
        )
        log_lines.append(f"exit_code={proc.returncode}\n")
        log_lines.append(proc.stdout or "")
        log_lines.append(proc.stderr or "")
    except subprocess.TimeoutExpired:
        log_lines.append("TIMEOUT after 600s\n")

    log_path.parent.mkdir(parents=True, exist_ok=True)
    full_log = "".join(log_lines)
    log_path.write_text(full_log[-8000:], encoding="utf-8")

    excerpt = full_log[-4000:] if len(full_log) > 4000 else full_log

    ok = proc is not None and proc.returncode == 0
    binary_path = meta.get("binary_path") or meta.get("BINARY_PATH", "")
    bin_exists = False
    resolved_bin: Optional[Path] = None
    if binary_path:
        bp = Path(binary_path)
        if not bp.is_absolute():
            resolved_bin = (source_code_dir / bp).resolve()
        else:
            resolved_bin = bp.resolve()
        bin_exists = resolved_bin.is_file()

    if workflow_file.exists():
        content = workflow_file.read_text(encoding="utf-8")
        bi = parse_json_block(content, "BuildInfo")
        if not isinstance(bi, dict):
            bi = {}
        bi["build_attempts"] = int(bi.get("build_attempts", 0)) + 1
        bi["last_build_log_excerpt"] = excerpt
        bi["dirty"] = not (ok and bin_exists)
        content = replace_json_block(content, "BuildInfo", bi)
        workflow_file.write_text(content, encoding="utf-8")

    return {
        "ok": ok and bin_exists,
        "binary_exists": bin_exists,
        "binary_path": str(resolved_bin) if resolved_bin else "",
        "log_path": str(log_path),
        "excerpt": excerpt,
    }


__all__ = [
    "insert_oracle_into_file",
    "run_rebuild",
    "resolve_rebuild_workdir",
    "strip_oracle_blocks",
    "workflow_path",
    "read_phase",
    "workspace_root",
    "cybergym_root",
    "upsert_bbtargets_entry",
]
