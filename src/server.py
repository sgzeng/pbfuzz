"""Expose the pbfuzz-purple CyberGym agent over HTTP (A2A Starlette app)."""

import argparse
import base64
import os
from pathlib import Path

import uvicorn
from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard, AgentSkill

from executor import Executor

_PACKAGE_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_A2A_MAX_CONTENT = 2 * 1024 * 1024 * 1024


def _install_cursor_auth_from_env() -> None:
    """If CURSOR_AUTH is set, decode standard base64 and write ~/.config/cursor/auth.json."""
    raw = os.environ.get("CURSOR_AUTH")
    if not raw or not str(raw).strip():
        return
    home = Path(os.environ.get("HOME", "/home/agent"))
    path = home / ".config" / "cursor" / "auth.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    cleaned = "".join(str(raw).split())
    try:
        decoded = base64.standard_b64decode(cleaned)
    except Exception as e:
        raise SystemExit(f"CURSOR_AUTH is not valid base64: {e}") from e
    path.write_bytes(decoded)


def _max_content_length() -> int | None:
    raw = os.environ.get("A2A_MAX_CONTENT_LENGTH")
    if raw is None:
        return _DEFAULT_A2A_MAX_CONTENT
    raw_stripped = raw.strip().lower()
    if raw_stripped in ("0", "none", "unlimited"):
        return None
    try:
        return int(raw_stripped)
    except ValueError:
        return _DEFAULT_A2A_MAX_CONTENT


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the pbfuzz-purple A2A agent.")
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9029)
    parser.add_argument("--card-url", type=str, default=None)
    parser.add_argument(
        "--output-host",
        nargs="?",
        const="default",
        default=None,
        metavar="PATH",
        help="Mirror workspaces under PATH (env PURPLE_OUTPUT_HOST).",
    )
    args = parser.parse_args()

    if args.output_host is not None:
        if args.output_host == "default":
            os.environ["PURPLE_OUTPUT_HOST"] = str(_PACKAGE_ROOT / "purple_agent_output")
        else:
            os.environ["PURPLE_OUTPUT_HOST"] = args.output_host

    _install_cursor_auth_from_env()

    skill = AgentSkill(
        id="pbfuzz_cybergym",
        name="pbfuzz CyberGym PoC",
        description="Property-based fuzzing workflow with oracle insertion for CyberGym level3.",
        tags=["cybergym", "fuzzing", "pbfuzz"],
        examples=[],
    )
    agent_card = AgentCard(
        name="pbfuzz-purple",
        description="pbfuzz + cursor-agent purple agent for CyberGym (INIT + PLAN→SUCCESS).",
        url=args.card_url or f"http://{args.host}:{args.port}/",
        version="1.0.0",
        default_input_modes=["text", "file"],
        default_output_modes=["text", "file"],
        capabilities=AgentCapabilities(streaming=True),
        skills=[skill],
    )

    request_handler = DefaultRequestHandler(
        agent_executor=Executor(),
        task_store=InMemoryTaskStore(),
    )
    server = A2AStarletteApplication(
        agent_card=agent_card,
        http_handler=request_handler,
        max_content_length=_max_content_length(),
    )
    uvicorn.run(
        server.build(),
        host=args.host,
        port=args.port,
        timeout_keep_alive=300,
    )


if __name__ == "__main__":
    main()
