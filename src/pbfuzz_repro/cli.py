"""CLI entry point for standalone CVE reproduction."""

from __future__ import annotations

import argparse
import base64
import os
import sys
from pathlib import Path

from pbfuzz_repro.runner import ReproArgs, run_reproduction, verify_sanitizer_crash
from pbfuzz_repro.workspace import RunLayout, extract_cve_id, init_layout


def install_cursor_auth(raw_b64: str | None) -> None:
    """Decode base64 auth JSON into ~/.config/cursor/auth.json."""
    raw = raw_b64 or os.environ.get("CURSOR_AUTH", "")
    if not str(raw).strip():
        home = Path(os.environ.get("HOME", str(Path.home())))
        if (home / ".config" / "cursor" / "auth.json").is_file():
            return
        print(
            "Cursor auth missing: set CURSOR_AUTH, pass --cursor-auth-b64, or place auth.json in ~/.config/cursor/",
            file=sys.stderr,
        )
        sys.exit(1)
    home = Path(os.environ.get("HOME", str(Path.home())))
    path = home / ".config" / "cursor" / "auth.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    cleaned = "".join(str(raw).split())
    try:
        decoded = base64.standard_b64decode(cleaned)
    except Exception as e:
        print(f"CURSOR_AUTH / --cursor-auth-b64 is not valid base64: {e}", file=sys.stderr)
        sys.exit(1)
    path.write_bytes(decoded)


def _parse_reproduce(ns: argparse.Namespace) -> int:
    install_cursor_auth(ns.cursor_auth_b64)
    if ns.model:
        os.environ["PBFUZZ_LLM_MODEL"] = ns.model
    if ns.max_inner_iter:
        os.environ["MAX_INNER_ITER"] = str(ns.max_inner_iter)

    args = ReproArgs(
        cve_description=Path(ns.cve_description).resolve(),
        patch=Path(ns.patch).resolve() if ns.patch else None,
        source=Path(ns.source).resolve(),
        output=Path(ns.output).resolve(),
        max_outer_rounds=ns.max_outer_rounds,
        max_inner_iter=ns.max_inner_iter,
        init_max_attempts=ns.init_max_attempts,
        init_timeout_sec=ns.init_timeout_sec,
        inner_timeout_sec=ns.inner_timeout_sec,
    )
    for p, label in (
        (args.cve_description, "CVE description"),
        (args.patch, "patch"),
        (args.source, "source"),
    ):
        if p is None:
            continue
        if not p.is_file() and not (label == "source" and p.is_dir()):
            print(f"{label} not found: {p}", file=sys.stderr)
            return 2
    if not args.source.is_dir():
        print(f"source must be a directory (git repo root): {args.source}", file=sys.stderr)
        return 2

    args.output.mkdir(parents=True, exist_ok=True)
    poc = run_reproduction(args)
    if poc is None or not poc.is_file() or poc.stat().st_size == 0:
        print("Failed: no poc.bin produced. See runtime.log under --output.", file=sys.stderr)
        return 1
    print(f"PoC written to {poc} ({poc.stat().st_size} bytes)")
    log = args.output / "runtime.log"
    if log.is_file() and "Reproduced: yes" in log.read_text(encoding="utf-8", errors="replace"):
        return 0

    layout = init_layout(
        args.output,
        extract_cve_id(
            args.cve_description.read_text(encoding="utf-8", errors="replace")
        ),
    )
    crashed, _ = verify_sanitizer_crash(layout, poc, 0)
    if crashed:
        return 0
    print(
        "Warning: poc.bin exists but sanitizer verification did not report a crash. "
        "See findings/sanitizer_run_*.log and runtime.log.",
        file=sys.stderr,
    )
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pbfuzz",
        description="PBFuzz: agentic directed fuzzing for CVE bug reproduction",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    repro = sub.add_parser(
        "reproduce",
        help="Reproduce a CVE from description (optionally with fix patch)",
    )
    repro.add_argument("--cve-description", required=True, help="Path to CVE_description.txt")
    repro.add_argument(
        "--patch",
        default=None,
        help="Optional path to upstream fix.patch (oracle targets derived from patch when set)",
    )
    repro.add_argument("--source", required=True, help="Path to vulnerable source git repository")
    repro.add_argument(
        "--output",
        required=True,
        help="Run directory: inputs/, env/, source/, findings/, and final poc.bin",
    )
    repro.add_argument(
        "--cursor-auth-b64",
        default=None,
        help="Base64-encoded ~/.config/cursor/auth.json (else env CURSOR_AUTH)",
    )
    repro.add_argument("--model", default=None, help="cursor-agent model (PBFUZZ_LLM_MODEL)")
    repro.add_argument("--max-outer-rounds", type=int, default=2)
    repro.add_argument("--max-inner-iter", type=int, default=10)
    repro.add_argument("--init-max-attempts", type=int, default=2)
    repro.add_argument("--init-timeout", type=int, default=1200, dest="init_timeout_sec")
    repro.add_argument("--inner-timeout", type=int, default=1800, dest="inner_timeout_sec")
    repro.set_defaults(func=_parse_reproduce)

    ns = parser.parse_args(argv)
    return int(ns.func(ns))


if __name__ == "__main__":
    raise SystemExit(main())
