"""INIT validator + automatic oracle insertion.

The wrapper runs the INIT cursor-agent up to ``INIT_MAX_ATTEMPTS`` times. Between
attempts, ``validate_init`` checks ``cybergym_build.json`` and
``static_results/BBtargets.txt`` produced by the agent. Once the agent's output
validates, ``auto_insert_oracles`` calls ``mcp_build_core.insert_oracle_into_file``
once per BBtargets entry and then triggers a single ``run_rebuild`` so the binary
ships with the wrapper-provided baseline oracle (PLAN may refine later).
"""

from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path
from typing import Tuple

_PBFUZZ_SRC = Path(__file__).resolve().parent.parent / "pbfuzz"
if _PBFUZZ_SRC.is_dir() and str(_PBFUZZ_SRC) not in sys.path:
    sys.path.insert(0, str(_PBFUZZ_SRC))

from mcp_build_core import (  # noqa: E402
    cybergym_root,
    insert_oracle_into_file,
    resolve_rebuild_workdir,
    run_rebuild,
    workflow_path,
)

# Build tools usually resolved from PATH; do not treat missing files under cwd as errors.
_KNOWN_PATH_TOOLS = frozenset(
    {
        "make",
        "cmake",
        "ninja",
        "gcc",
        "g++",
        "clang",
        "clang++",
        "cargo",
        "go",
        "mvn",
        "gradle",
        "python",
        "python3",
        "pip",
        "perl",
        "ruby",
        "meson",
        "autoreconf",
        "automake",
        "autoconf",
        "configure",
        "nproc",
    }
)


def _first_shell_invoke_token(build_cmd: str) -> str | None:
    """First non-option argument after optional ``bash``/``sh`` wrapper (best-effort)."""
    try:
        parts = shlex.split(build_cmd, posix=True)
    except ValueError:
        return None
    if not parts:
        return None
    i = 0
    first = parts[0]
    if first in ("bash", "sh") or first.endswith("/bash") or first.endswith("/sh"):
        i = 1
        if i < len(parts) and parts[i] == "-c":
            return None
    while i < len(parts) and parts[i].startswith("-") and len(parts[i]) > 1:
        i += 1
    if i >= len(parts):
        return None
    return parts[i]


def _validate_build_cmd_script_path(build_cmd: str, workdir: Path) -> Tuple[bool, str]:
    """Catch ``bash foo.sh`` when ``foo.sh`` is not visible from ``workdir`` (common cwd bug)."""
    tok = _first_shell_invoke_token(build_cmd)
    if not tok:
        return True, ""
    if tok.startswith("/") or "/" in tok or tok.startswith("./"):
        return True, ""
    name = Path(tok).name
    if name in _KNOWN_PATH_TOOLS or tok in _KNOWN_PATH_TOOLS:
        return True, ""
    if (workdir / tok).is_file():
        return True, ""
    if tok.endswith(".sh") or tok.endswith(".bash"):
        return (
            False,
            (
                f"build_cmd runs script {tok!r} but it is not a file under the rebuild cwd "
                f"({workdir}). From that directory use e.g. `bash ./{tok}` or an absolute path."
            ),
        )
    return True, ""


def _parse_bbtargets(bb_path: Path) -> list[tuple[str, int, str]]:
    """Return ``[(relative_path, line, condition_expr), ...]`` from BBtargets.txt.

    Lines starting with ``#`` and blanks are skipped. ``condition_expr`` defaults
    to ``"1"`` when the optional fourth comma-separated field is missing.
    """
    out: list[tuple[str, int, str]] = []
    if not bb_path.is_file():
        return out
    for raw in bb_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        loc, _, cond = line.partition(",")
        loc = loc.strip()
        cond = cond.strip() or "1"
        if ":" not in loc:
            continue
        path_part, _, line_part = loc.rpartition(":")
        try:
            ln = int(line_part)
        except ValueError:
            continue
        if not path_part:
            continue
        out.append((path_part, ln, cond))
    return out


def validate_init(workspace: Path, pbfuzz_ws: Path) -> Tuple[bool, str]:
    """Validate INIT agent output. Returns ``(ok, reason)``.

    ``reason`` is empty on success and a single human-readable explanation on failure
    (suitable to feed back to the INIT agent for retry).
    """
    cg_path = pbfuzz_ws / "cybergym_build.json"
    if not cg_path.is_file():
        return False, f"missing {cg_path} (write build_cmd / binary_path / run_cmd)"
    try:
        cg = json.loads(cg_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return False, f"{cg_path} is not valid JSON: {e}"
    build_cmd = (cg.get("build_cmd") or "").strip()
    binary_path = (cg.get("binary_path") or "").strip()
    if not build_cmd:
        return False, "cybergym_build.json: build_cmd is empty"
    if not binary_path:
        return False, "cybergym_build.json: binary_path is empty"

    src = (pbfuzz_ws / "source").resolve()
    root = cybergym_root(src, pbfuzz_ws)
    cwd_meta = cg.get("cwd")
    if cwd_meta is None:
        cwd_meta = ""
    elif not isinstance(cwd_meta, str):
        cwd_meta = str(cwd_meta)
    workdir = resolve_rebuild_workdir(root, src, cwd_meta)
    ok_cmd, reason_cmd = _validate_build_cmd_script_path(build_cmd, workdir)
    if not ok_cmd:
        return False, reason_cmd

    bp = Path(binary_path)
    resolved_bin = bp if bp.is_absolute() else (src / bp).resolve()
    if not resolved_bin.is_file():
        return False, (
            f"binary_path {binary_path!r} does not resolve to an existing file "
            f"(checked {resolved_bin}). Run build_cmd until the binary exists."
        )

    bb_path = pbfuzz_ws / "static_results" / "BBtargets.txt"
    entries = _parse_bbtargets(bb_path)
    if not entries:
        return False, (
            f"{bb_path} has no usable entries. Write at least one line of form "
            f"'relative/path.c:LINE[,condition_expr]' derived from patch.diff."
        )
    valid = []
    invalid_reasons: list[str] = []
    for rel, ln, cond in entries:
        candidate = (src / rel).resolve()
        try:
            candidate.relative_to(src)
        except ValueError:
            invalid_reasons.append(f"{rel}: escapes source root")
            continue
        if not candidate.is_file():
            invalid_reasons.append(f"{rel}: file does not exist under {src}")
            continue
        valid.append((rel, ln, cond))
    if not valid:
        joined = "; ".join(invalid_reasons[:5])
        return False, f"BBtargets.txt has no entries pointing to existing source files ({joined})"
    return True, ""


def auto_insert_oracles(pbfuzz_ws: Path, task_id: str) -> Tuple[bool, str]:
    """Insert a baseline oracle for each BBtargets entry, then rebuild once.

    Returns ``(ok, log_excerpt)``. ``ok`` is true only when every insert succeeded
    and the rebuild produced the binary at ``binary_path``.
    """
    src = (pbfuzz_ws / "source").resolve()
    bb_path = pbfuzz_ws / "static_results" / "BBtargets.txt"
    entries = _parse_bbtargets(bb_path)
    if not entries:
        return False, "BBtargets.txt has no entries; cannot insert oracles."

    failures: list[str] = []
    for rel, ln, cond in entries:
        result = insert_oracle_into_file(src, rel, ln, cond, task_id, bbtargets_root=pbfuzz_ws)
        if not result.get("ok"):
            failures.append(f"{rel}:{ln}: {result.get('error')}")
    if failures:
        return False, "insert_oracle failures: " + "; ".join(failures)

    log_path = pbfuzz_ws / "output" / "last_build.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    wf = workflow_path(src)
    root = cybergym_root(src, pbfuzz_ws)
    rebuild = run_rebuild(root, src, wf, log_path)
    if rebuild.get("ok"):
        return True, rebuild.get("excerpt", "")[-2000:]
    return False, "rebuild after oracle insertion failed: " + str(rebuild.get("excerpt", ""))[-2000:]


__all__ = ["validate_init", "auto_insert_oracles"]
