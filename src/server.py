"""Expose the CyberGym purple agent over HTTP: Agent Card discovery and an A2A Starlette app.

Request bodies can reach hundreds of MB once task tarballs are base64-encoded; max body size is
raised accordingly so the SDK default limit does not reject green agents."""

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


def _listen_port(cli_port: int | None) -> int:
    """Bind port: explicit --port wins, else PORT env, else 9019."""
    if cli_port is not None:
        return cli_port
    raw = os.environ.get("PORT")
    if raw is None or not str(raw).strip():
        return 9019
    try:
        return int(str(raw).strip())
    except ValueError:
        return 9019


def _agent_card_url(host: str, port: int, card_url: str | None) -> str:
    """Public URL in the Agent Card; avoid advertising 0.0.0.0 when no --card-url."""
    if card_url:
        return card_url if card_url.endswith("/") else f"{card_url}/"
    display_host = host
    if host in ("0.0.0.0", "::", "[::]"):
        display_host = "127.0.0.1"
    return f"http://{display_host}:{port}/"


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
    """Resolve JSON-RPC body size limit from env, keeping CyberGym-sized payloads viable."""
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
    """Build Agent Card + DefaultRequestHandler and serve the A2A HTTP app with uvicorn.

    Per-task wall-clock cap: ``AGENT_RUN_TIMEOUT_SEC`` (default 600), enforced in ``Executor``.
    """
    parser = argparse.ArgumentParser(description="Run the cursor-cli-purple A2A agent.")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind the server")
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Port to bind (default: PORT environment variable if set, else 9019)",
    )
    parser.add_argument("--card-url", type=str, help="URL to advertise in the agent card")
    parser.add_argument(
        "--output-host",
        nargs="?",
        const="default",
        default=None,
        metavar="PATH",
        help="Mirror each context workspace under PATH for debugging (default: ./purple_agent_output). "
        "Also via env PURPLE_OUTPUT_HOST (use 'off' to disable when env would otherwise enable).",
    )
    args = parser.parse_args()
    port = _listen_port(args.port)

    if args.output_host is not None:
        if args.output_host == "default":
            os.environ["PURPLE_OUTPUT_HOST"] = str(_PACKAGE_ROOT / "purple_agent_output")
        else:
            os.environ["PURPLE_OUTPUT_HOST"] = args.output_host

    _install_cursor_auth_from_env()

    skill = AgentSkill(
        id="vuln_poc_generation",
        name="Vulnerability PoC Generation",
        description="Analyzes a vulnerable program and produces a single raw-input PoC file.",
        tags=["cybergym", "cybersecurity", "ctf", "fuzzing"],
        examples=[],
    )
    agent_card = AgentCard(
        name="cursor-cli-purple",
        description="Cursor CLI based purple agent for the CyberGym benchmark.",
        url=_agent_card_url(args.host, port, args.card_url),
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
        port=port,
        timeout_keep_alive=300,
    )


if __name__ == "__main__":
    main()
