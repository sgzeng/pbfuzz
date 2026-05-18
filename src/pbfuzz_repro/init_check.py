"""INIT validator and automatic oracle insertion."""

from __future__ import annotations

import json
import shlex
import sys
from pathlib import Path
from typing import Tuple

from pbfuzz_repro.workspace import RunLayout

_PBFUZZ_SRC = Path(__file__).resolve().parent.parent.parent / "pbfuzz"
if _PBFUZZ_SRC.is_dir() and str(_PBFUZZ_SRC) not in sys.path:
    sys.path.insert(0, str(_PBFUZZ_SRC))

from mcp_build_core import (  # noqa: E402
    insert_oracle_into_file,
    resolve_rebuild_workdir,
    run_rebuild,
    workflow_path,
    workspace_root,
)

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

_VALID_BUG_CLASSES = frozenset(
    {
        "heap-buffer-overflow",
        "stack-buffer-overflow",
        "integer-overflow",
        "signed-shift",
        "null-deref",
        "use-after-free",
        "uninit-memory",
        "divide-by-zero",
        "oob-read",
        "oob-write",
        "other",
    }
)

_VALID_SANITIZERS = frozenset({"asan", "ubsan", "msan", "asan+ubsan"})


def _first_shell_invoke_token(build_cmd: str) -> str | None:
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


def validate_init(layout: RunLayout) -> Tuple[bool, str]:
    """Validate INIT output under env/ and source/."""
    meta_path = layout.env / "build_info.json"
    if not meta_path.is_file():
        return False, f"missing {meta_path} (write build_cmd / binary_path / run_cmd)"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return False, f"{meta_path} is not valid JSON: {e}"

    cve_id = (meta.get("cve_id") or "").strip()
    if not cve_id or cve_id == "CVE-UNKNOWN":
        return False, "build_info.json: cve_id is missing or unknown"

    build_cmd = (meta.get("build_cmd") or "").strip()
    binary_path = (meta.get("binary_path") or "").strip()
    if not build_cmd:
        return False, "build_info.json: build_cmd is empty"
    if not binary_path:
        return False, "build_info.json: binary_path is empty"

    bug_class = (meta.get("bug_class") or "").strip()
    if not bug_class:
        return False, "build_info.json: bug_class is required"
    if bug_class not in _VALID_BUG_CLASSES:
        return False, f"build_info.json: bug_class must be one of {sorted(_VALID_BUG_CLASSES)}"

    sanitizer = (meta.get("sanitizer") or "").strip().lower()
    if not sanitizer:
        return False, "build_info.json: sanitizer is required"
    if sanitizer not in _VALID_SANITIZERS:
        return False, f"build_info.json: sanitizer must be one of {sorted(_VALID_SANITIZERS)}"

    san_env = meta.get("sanitizer_env")
    if san_env is not None and not isinstance(san_env, dict):
        return False, "build_info.json: sanitizer_env must be a JSON object"

    if "-fsanitize" not in build_cmd and "fsanitize" not in build_cmd:
        return False, "build_info.json: build_cmd must include -fsanitize=... flags"

    src = layout.source
    if not src.is_dir():
        return False, f"missing vulnerable tree at {src} (run git worktree add during INIT)"

    src = src.resolve()
    root = workspace_root(src, layout.env)
    cwd_meta = meta.get("cwd")
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

    bb_path = layout.env / "static_results" / "BBtargets.txt"
    entries = _parse_bbtargets(bb_path)
    if not entries:
        return False, (
            f"{bb_path} has no usable entries. Write at least one line of form "
            f"'relative/path.c:LINE[,condition_expr]' (from fix patch or CVE/source analysis)."
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


def auto_insert_oracles(layout: RunLayout, cve_id: str) -> Tuple[bool, str]:
    src = layout.source.resolve()
    bb_path = layout.env / "static_results" / "BBtargets.txt"
    entries = _parse_bbtargets(bb_path)
    if not entries:
        return False, "BBtargets.txt has no entries; cannot insert oracles."

    failures: list[str] = []
    for rel, ln, cond in entries:
        result = insert_oracle_into_file(src, rel, ln, cond, cve_id, bbtargets_root=layout.env)
        if not result.get("ok"):
            failures.append(f"{rel}:{ln}: {result.get('error')}")
    if failures:
        return False, "insert_oracle failures: " + "; ".join(failures)

    log_path = layout.findings / "last_build.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    wf = workflow_path(src)
    root = workspace_root(src, layout.env)
    rebuild = run_rebuild(root, src, wf, log_path)
    if rebuild.get("ok"):
        return True, rebuild.get("excerpt", "")[-2000:]
    return False, "rebuild after oracle insertion failed: " + str(rebuild.get("excerpt", ""))[-2000:]


__all__ = ["validate_init", "auto_insert_oracles"]
