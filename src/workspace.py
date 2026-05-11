"""CyberGym task workspace layout: unpack attachments, wire pbfuzz_workspace, green-feedback edits."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import sys
import shutil
import tarfile
from pathlib import Path
from typing import Any

# Ensure sibling package imports resolve when running from docker entrypoint
import sys

_PBFUZZ_SRC = Path(__file__).resolve().parent.parent / "pbfuzz"
if _PBFUZZ_SRC.is_dir() and str(_PBFUZZ_SRC) not in sys.path:
    sys.path.insert(0, str(_PBFUZZ_SRC))

from mcp_workflow_server import parse_json_block, replace_json_block  # noqa: E402


def guess_task_id(workspace: Path) -> str:
    """Infer task id from TASK.md / env / default smoke task."""
    env = os.environ.get("CYBERGYM_TASK_ID", "").strip()
    if env:
        return env
    for name in ("TASK.md", "description.txt"):
        p = workspace / name
        if p.is_file():
            text = p.read_text(encoding="utf-8", errors="replace")
            m = re.search(r"\b(arvo:\d+|oss-fuzz:\d+)\b", text)
            if m:
                return m.group(1)
    return "arvo:47101"


def resolve_repo_vul_inner(workspace: Path) -> Path:
    """Return the likely project root inside extracted repo-vul/."""
    rv = workspace / "repo-vul"
    if not rv.is_dir():
        return rv
    subs = [x for x in rv.iterdir() if x.is_dir() and not x.name.startswith(".")]
    if len(subs) == 1:
        return subs[0]
    return rv


def _write_bbtargets_placeholder(static_dir: Path) -> None:
    """Seed an empty BBtargets.txt so launcher validation can run before INIT.

    INIT must overwrite this file with real ``relative/path.c:LINE[,condition_expr]`` entries
    derived from ``patch.diff``.
    """
    static_dir.mkdir(parents=True, exist_ok=True)
    bb = static_dir / "BBtargets.txt"
    if not bb.is_file() or bb.stat().st_size == 0:
        bb.write_text(
            "# placeholder; INIT must overwrite with real entries from patch.diff\n"
            "# format: relative/path.c:LINE[,condition_expr]\n"
            "placeholder.c:1\n",
            encoding="utf-8",
        )


def init_pbfuzz_layout(workspace: Path, task_id: str) -> Path:
    """Create pbfuzz_workspace with source symlink, static stubs, dirs, template workflow."""
    inner = resolve_repo_vul_inner(workspace)
    ws = workspace / "pbfuzz_workspace"
    src = ws / "source"
    static_dir = ws / "static_results"
    out_dir = ws / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    static_dir.mkdir(parents=True, exist_ok=True)

    if src.is_symlink() or src.exists():
        if src.is_symlink():
            src.unlink()
        elif src.is_dir():
            shutil.rmtree(src)
    src.symlink_to(inner.resolve(), target_is_directory=True)

    _write_bbtargets_placeholder(static_dir)

    cursor_dir = src / ".cursor"
    cursor_dir.mkdir(parents=True, exist_ok=True)
    tmpl_dir = _PBFUZZ_SRC / "templates"
    if (tmpl_dir / "workflow_state.md").is_file():
        shutil.copy2(tmpl_dir / "workflow_state.md", cursor_dir / "workflow_state.md")
    schemas_src = _PBFUZZ_SRC / "schemas.py"
    if schemas_src.is_file():
        shutil.copy2(schemas_src, src / "schemas.py")

    (cursor_dir / "project_config.md").write_text(
        f"# Project Configuration\n\n## Target Information\n"
        f"- **Task ID**: {task_id}\n"
        f"- Complete INIT: build_cmd, binary_path, run_cmd in `cybergym_build.json`.\n",
        encoding="utf-8",
    )

    cybergym = {
        "task_id": task_id,
        "build_cmd": "",
        "binary_path": "",
        "cwd": "",
        "run_cmd": [],
    }
    (ws / "cybergym_build.json").write_text(json.dumps(cybergym, indent=2), encoding="utf-8")
    return ws


def write_init_mcp(pbfuzz_ws: Path) -> None:
    """Minimal MCP config next to workflow files under vulnerable root ``source/.cursor/``.

    cursor-agent / cursor-cli must run with cwd = vulnerable project root; MCP paths match
    ``launcher.py`` (same ``source`` + ``pbfuzz_workspace`` layout).
    """
    script_dir = _PBFUZZ_SRC.resolve()
    src = (pbfuzz_ws / "source").resolve()
    out = (pbfuzz_ws / "output").resolve()
    out.mkdir(parents=True, exist_ok=True)
    root = pbfuzz_ws.resolve()
    cfg = {
        "mcpServers": {
            "workflow": {
                "command": "python3",
                "args": [
                    str(script_dir / "mcp_workflow_server.py"),
                    "--output-dir",
                    str(out),
                    "--source-code-dir",
                    str(src),
                ],
            },
            "build": {
                "command": "python3",
                "args": [
                    str(script_dir / "mcp_build_server.py"),
                    "--source-code-dir",
                    str(src),
                    "--cybergym-root",
                    str(root),
                ],
            },
        }
    }
    cursor = src / ".cursor"
    cursor.mkdir(parents=True, exist_ok=True)
    (cursor / "mcp.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def unpack_message_parts(message: Any, workspace: Path) -> None:
    """Write FilePart attachments and unpack repo tarballs (same as cursor-cli-purple)."""
    import base64

    from a2a.types import FilePart, FileWithBytes

    workspace.mkdir(parents=True, exist_ok=True)
    for part in message.parts:
        root = part.root
        if isinstance(root, FilePart) and isinstance(root.file, FileWithBytes):
            raw = base64.b64decode(root.file.bytes)
            name = Path(root.file.name or "attachment").name
            dest = workspace / ("TASK.md" if name == "README.md" else name)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(raw)
            if name == "repo-vul.tar.gz":
                _extract_tgz(raw, workspace / "repo-vul")
            elif name == "repo-fix.tar.gz":
                _extract_tgz(raw, workspace / "repo-fix")


def _extract_tgz(data: bytes, target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        # ``filter=`` is Python 3.12+ (PEP 706); 3.11 images/containers need the fallback.
        if sys.version_info >= (3, 12):
            tar.extractall(target_dir, filter="data")
        else:
            tar.extractall(target_dir)


def append_green_feedback(
    pbfuzz_ws: Path,
    outer_round: int,
    candidate_poc: bytes | None,
    feedback: dict[str, Any] | None,
    note: str = "",
) -> None:
    """Append one entry to GreenFeedbackHistory in workflow_state.md."""
    wf = pbfuzz_ws / "source" / ".cursor" / "workflow_state.md"
    if not wf.is_file():
        return
    content = wf.read_text(encoding="utf-8")
    hist = parse_json_block(content, "GreenFeedbackHistory")
    if not isinstance(hist, list):
        hist = []
    sha = ""
    if candidate_poc:
        sha = hashlib.sha256(candidate_poc).hexdigest()
    excerpt = ""
    code: Any = None
    if feedback:
        excerpt = str(feedback.get("output") or feedback.get("error") or "")[:2000]
        code = feedback.get("exit_code")
        if code is None and "error" in feedback:
            excerpt = (excerpt + " " + str(feedback.get("error")))[:2000]
    hist.append(
        {
            "outer_round": outer_round,
            "candidate_poc_sha256": sha,
            "exit_code": code,
            "output_excerpt": excerpt,
            "source": "green",
            "note": note,
        }
    )
    content = replace_json_block(content, "GreenFeedbackHistory", hist)
    wf.write_text(content, encoding="utf-8")


def read_candidate_poc(pbfuzz_ws: Path) -> bytes | None:
    """Return PoC bytes if fuzzer wrote candidate_poc.bin + CANDIDATE_READY."""
    ready = pbfuzz_ws / "output" / "CANDIDATE_READY"
    poc = pbfuzz_ws / "output" / "candidate_poc.bin"
    if ready.is_file() and poc.is_file() and poc.stat().st_size > 0:
        return poc.read_bytes()
    return None


def clear_candidate_marker(pbfuzz_ws: Path) -> None:
    for name in ("CANDIDATE_READY", "candidate_poc.bin"):
        p = pbfuzz_ws / "output" / name
        if p.is_file():
            p.unlink()
