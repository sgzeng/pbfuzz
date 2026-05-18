"""Workspace layout for standalone CVE reproduction."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

_PBFUZZ_SRC = Path(__file__).resolve().parent.parent.parent / "pbfuzz"
if _PBFUZZ_SRC.is_dir() and str(_PBFUZZ_SRC) not in sys.path:
    sys.path.insert(0, str(_PBFUZZ_SRC))

from mcp_build_core import strip_oracle_blocks  # noqa: E402

POC_MAX_BYTES = int(os.environ.get("PBFUZZ_POC_MAX_BYTES", str(16 * 1024 * 1024)))


@dataclass(frozen=True)
class RunLayout:
    """Paths for a single reproduction run (<run-root>/)."""

    run_root: Path
    env: Path
    source: Path
    findings: Path
    init_ws: Path

    @classmethod
    def from_run_root(cls, run_root: Path) -> RunLayout:
        root = run_root.resolve()
        return cls(
            run_root=root,
            env=root / "env",
            source=root / "source",
            findings=root / "findings",
            init_ws=root / "env" / "init_ws",
        )


def extract_cve_id(text: str) -> str:
    m = re.search(r"CVE-\d{4}-\d+", text, re.IGNORECASE)
    if m:
        return m.group(0).upper()
    return "CVE-UNKNOWN"


def write_inputs(output_dir: Path, cve_desc_path: Path, patch_path: Path) -> str:
    """Copy user inputs into output_dir/inputs/; return extracted cve_id."""
    inputs = output_dir / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    desc_text = cve_desc_path.read_text(encoding="utf-8", errors="replace")
    shutil.copy2(cve_desc_path, inputs / "CVE_description.txt")
    shutil.copy2(patch_path, inputs / "fix.patch")
    return extract_cve_id(desc_text)


def compose_task_md(output_dir: Path, cve_id: str) -> None:
    desc = (output_dir / "inputs" / "CVE_description.txt").read_text(
        encoding="utf-8", errors="replace"
    )
    hints = ""
    dl = desc.lower()
    if "swscale" in dl or "yuv2ya16" in dl:
        hints = (
            "\n## FFmpeg swscale hint\n\n"
            "This class of bugs often triggers via **ffmpeg** with **rawvideo** input "
            "(e.g. `yuva444p16le`), a **large scale** filter (`scale=8192:8192:flags=lanczos+...`), "
            "and output `ya16le`. The PoC is typically a small raw planar frame file, not a container.\n"
        )
    elif "jpegxl" in dl or "jpeg xl" in dl:
        hints = (
            "\n## FFmpeg demuxer hint\n\n"
            "JPEG XL animation bugs often need **ffprobe** or **ffmpeg** with `-f jpegxl_anim` "
            "and an oversized/sparse `.jxl` input.\n"
        )
    elif "sbgdec" in dl or "sbg" in dl.lower():
        hints = (
            "\n## FFmpeg sbgdec hint\n\n"
            "SBG demuxer bugs often use **ffmpeg** with `-f sbg` and a crafted text/script input.\n"
        )
    body = (
        f"# CVE Reproduction: {cve_id}\n\n"
        f"## Description\n\n{desc.strip()}\n\n"
        "## Inputs\n\n"
        "- `inputs/CVE_description.txt`\n"
        "- `inputs/fix.patch` (upstream fix; derive BBtargets and condition_expr from this)\n"
        f"{hints}\n"
        "## Goal\n\n"
        "Produce a PoC input that triggers the vulnerability on the vulnerable build.\n"
        "The inner fuzz loop succeeds when the oracle prints `{cve_id} triggered`.\n"
        "The driver promotes a PoC only after a **sanitizer crash** on the built binary.\n"
        "Inner agent writes `findings/candidate_poc.bin` and `findings/CANDIDATE_READY`.\n"
    )
    (output_dir / "TASK.md").write_text(body, encoding="utf-8")


def init_layout(output_dir: Path, cve_id: str) -> RunLayout:
    """Create env/, source/, findings/ skeleton."""
    layout = RunLayout.from_run_root(output_dir)
    static_dir = layout.env / "static_results"
    static_dir.mkdir(parents=True, exist_ok=True)
    layout.findings.mkdir(parents=True, exist_ok=True)
    layout.init_ws.mkdir(parents=True, exist_ok=True)

    bb = static_dir / "BBtargets.txt"
    if not bb.is_file() or bb.stat().st_size == 0:
        bb.write_text(
            "# placeholder; INIT must overwrite from inputs/fix.patch\n"
            "# format: relative/path.c:LINE[,condition_expr]\n",
            encoding="utf-8",
        )

    build_info = {
        "cve_id": cve_id,
        "build_cmd": "",
        "binary_path": "",
        "cwd": "",
        "run_cmd": [],
        "bug_class": "",
        "sanitizer": "",
        "sanitizer_env": {},
    }
    (layout.env / "build_info.json").write_text(json.dumps(build_info, indent=2), encoding="utf-8")
    return layout


def sync_findings(layout: RunLayout) -> None:
    """Copy inner agent .cursor/ and cursor.log snapshot into findings/."""
    layout.findings.mkdir(parents=True, exist_ok=True)
    src_cursor = layout.source / ".cursor"
    if src_cursor.is_dir():
        dst = layout.findings / ".cursor"
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(src_cursor, dst)
    src_log = layout.source / "cursor.log"
    if src_log.is_file():
        shutil.copy2(src_log, layout.findings / "agent.log")


def _log_driver_error(layout: RunLayout, message: str) -> None:
    layout.findings.mkdir(parents=True, exist_ok=True)
    with (layout.findings / "driver_errors.log").open("a", encoding="utf-8") as f:
        f.write(message.rstrip() + "\n")


def read_candidate_poc(layout: RunLayout) -> bytes | None:
    """Return candidate bytes only if PBF fuzzer declared a valid PoC."""
    ready = layout.findings / "CANDIDATE_READY"
    poc = layout.findings / "candidate_poc.bin"
    if not ready.is_file() or not poc.is_file():
        return None
    size = poc.stat().st_size
    if size == 0:
        return None
    if size > POC_MAX_BYTES:
        _log_driver_error(
            layout,
            f"candidate_poc.bin too large ({size} bytes > {POC_MAX_BYTES}); discarding",
        )
        clear_candidate_marker(layout)
        return None

    marker = ready.read_text(encoding="utf-8", errors="replace").strip()
    if not re.fullmatch(r"poc_\d+_\d+", marker):
        _log_driver_error(
            layout,
            f"invalid CANDIDATE_READY marker {marker!r}; expected poc_<round>_<iter>",
        )
        clear_candidate_marker(layout)
        return None

    crash_path = layout.findings / "crashes" / marker
    if not crash_path.is_file():
        _log_driver_error(
            layout,
            f"CANDIDATE_READY={marker!r} but missing {crash_path}",
        )
        clear_candidate_marker(layout)
        return None

    return poc.read_bytes()


def clear_candidate_marker(layout: RunLayout) -> None:
    for name in ("CANDIDATE_READY", "candidate_poc.bin"):
        p = layout.findings / name
        if p.is_file():
            p.unlink()


def reset_source_tree(layout: RunLayout) -> None:
    """Reset shared source tree and strip prior oracle blocks before a new outer round."""
    clear_candidate_marker(layout)

    for cursor_dir in (layout.source / ".cursor", layout.init_ws / ".cursor"):
        if cursor_dir.is_dir():
            shutil.rmtree(cursor_dir, ignore_errors=True)

    bb_path = layout.env / "static_results" / "BBtargets.txt"
    if layout.source.is_dir() and bb_path.is_file():
        for rel, _, _ in _parse_bbtargets(bb_path):
            target = layout.source / rel
            if target.is_file():
                cleaned = strip_oracle_blocks(
                    target.read_text(encoding="utf-8", errors="replace")
                )
                target.write_text(cleaned, encoding="utf-8")

    if layout.source.is_dir() and (layout.source / ".git").is_dir():
        subprocess.run(
            ["git", "-C", str(layout.source), "reset", "--hard"],
            check=False,
            capture_output=True,
        )
        subprocess.run(
            ["git", "-C", str(layout.source), "clean", "-fdx"],
            check=False,
            capture_output=True,
        )


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
        if path_part:
            out.append((path_part, ln, cond))
    return out


def prepare_init_ws(layout: RunLayout) -> None:
    """Symlink run inputs into init_ws so INIT agent can read inputs/ relative paths."""
    layout.init_ws.mkdir(parents=True, exist_ok=True)
    link = layout.init_ws / "inputs"
    target = layout.run_root / "inputs"
    if link.is_symlink() or link.exists():
        if link.is_symlink() or link.is_file():
            link.unlink()
        elif link.is_dir() and not link.is_symlink():
            # leave real dir if agent created one
            return
    if target.is_dir():
        link.symlink_to(target, target_is_directory=True)


def copy_init_agent_log(layout: RunLayout, attempt: int) -> None:
    """Snapshot INIT cursor-agent log into env/init_agent_{attempt}.log."""
    src = layout.init_ws / "cursor.log"
    if src.is_file():
        dest = layout.env / f"init_agent_{attempt}.log"
        dest.write_text(src.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
