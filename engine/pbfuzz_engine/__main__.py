"""`python -m pbfuzz_engine` / `pbfuzz-engine`: run the JSON-RPC sidecar on stdin/stdout."""

from __future__ import annotations

import argparse
import logging
import os
import sys


def main(argv: list[str] | None = None) -> int:
    """Start the sidecar. Logs go to stderr only; stdout is the protocol channel."""
    parser = argparse.ArgumentParser(prog="pbfuzz-engine", description=__doc__)
    parser.add_argument("--log-level", default=os.environ.get("PBFUZZ_ENGINE_LOG", "info"),
                        choices=["error", "warn", "info", "debug"])
    parser.add_argument("--version", action="store_true", help="print the engine version to stderr and exit")
    args = parser.parse_args(argv)
    from . import CONTRACTS_VERSION, __version__

    if args.version:
        print(f"pbfuzz-engine {__version__} (contracts {CONTRACTS_VERSION})", file=sys.stderr)
        return 0
    level = {"warn": "WARNING"}.get(args.log_level, args.log_level.upper())
    logging.basicConfig(stream=sys.stderr, level=level, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    from .server import serve_stdio

    serve_stdio()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
