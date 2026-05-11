#!/usr/bin/env python3
"""Tests for oracle insertion helpers (no stdio MCP)."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from mcp_build_core import (  # noqa: E402
    insert_oracle_into_file,
    resolve_rebuild_workdir,
    run_rebuild,
    strip_oracle_blocks,
)


def test_strip_oracle_blocks_idempotent():
    s = "before\n/* PBFUZZ_ORACLE_START t */\nx();\n/* PBFUZZ_ORACLE_END t */\nafter\n"
    assert "x()" not in strip_oracle_blocks(s)
    assert "before" in strip_oracle_blocks(s)


def test_insert_oracle_into_file(tmp_path: Path):
    f = tmp_path / "bug.c"
    f.write_text("// line1\nvoid foo() {}\n", encoding="utf-8")
    r = insert_oracle_into_file(tmp_path, "bug.c", 2, "0", "arvo:99999")
    assert r.get("ok") is True
    body = f.read_text(encoding="utf-8")
    assert "PBFUZZ_ORACLE_START arvo:99999" in body
    assert "%s reached" in body


def test_run_rebuild_updates_buildinfo(tmp_path: Path):
    """Minimal rebuild: compile a trivial C file via shell."""
    src = tmp_path / "sub"
    src.mkdir()
    cfile = src / "hi.c"
    cfile.write_text("#include <stdio.h>\nint main(){puts(\"ok\");return 0;}\n", encoding="utf-8")
    (tmp_path / "source").mkdir()
    wf = tmp_path / "source" / ".cursor"
    wf.mkdir(parents=True)
    wf_state = wf / "workflow_state.md"
    wf_state.write_text(
        """<!-- DYNAMIC:BUILD_INFO:START -->
## BuildInfo
```json
{"build_cmd":"","binary_path":"","dirty":false,"last_build_log_excerpt":"","build_attempts":0}
```
<!-- DYNAMIC:BUILD_INFO:END -->
""",
        encoding="utf-8",
    )
    out_bin = (src / "hi").resolve()
    (tmp_path / "cybergym_build.json").write_text(
        json.dumps(
            {
                "build_cmd": f"gcc -o hi {cfile.name}",
                "binary_path": str(out_bin),
                "cwd": "sub",
            }
        ),
        encoding="utf-8",
    )
    logp = tmp_path / "output" / "log.txt"
    out = run_rebuild(tmp_path, tmp_path / "source", wf_state, logp)
    assert out.get("ok") is True
    assert (tmp_path / "sub" / "hi").is_file()


def test_resolve_rebuild_workdir_prefers_source_subdir(tmp_path: Path):
    cybergym = tmp_path
    src = cybergym / "source"
    src.mkdir()
    (src / "nested").mkdir()
    assert resolve_rebuild_workdir(cybergym, src, "nested") == (src / "nested").resolve()


def test_run_rebuild_empty_cwd_uses_source_root(tmp_path: Path):
    """Empty cwd must run build_cmd from ``source/`` (INIT contract)."""
    cybergym = tmp_path
    src = cybergym / "source"
    src.mkdir()
    (src / "hi.c").write_text(
        '#include <stdio.h>\nint main(){puts("ok");return 0;}\n',
        encoding="utf-8",
    )
    wf = src / ".cursor"
    wf.mkdir(parents=True)
    wf_state = wf / "workflow_state.md"
    wf_state.write_text(
        """<!-- DYNAMIC:BUILD_INFO:START -->
## BuildInfo
```json
{"build_cmd":"","binary_path":"","dirty":false,"last_build_log_excerpt":"","build_attempts":0}
```
<!-- DYNAMIC:BUILD_INFO:END -->
""",
        encoding="utf-8",
    )
    (cybergym / "cybergym_build.json").write_text(
        json.dumps(
            {
                "build_cmd": "gcc -o hi hi.c",
                "binary_path": "hi",
                "cwd": "",
            }
        ),
        encoding="utf-8",
    )
    logp = cybergym / "output" / "log_empty_cwd.txt"
    out = run_rebuild(cybergym, src, wf_state, logp)
    assert out.get("ok") is True
    assert (src / "hi").is_file()
