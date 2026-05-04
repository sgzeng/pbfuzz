"""Expose the CyberGym purple agent over HTTP: Agent Card discovery and an A2A Starlette app.

Request bodies can reach hundreds of MB once task tarballs are base64-encoded; max body size is
raised accordingly so the SDK default limit does not reject green agents."""

import argparse
import os

import uvicorn
from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard, AgentSkill

from executor import Executor

_DEFAULT_A2A_MAX_CONTENT = 512 * 1024 * 1024


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
    """Build Agent Card + DefaultRequestHandler and serve the A2A HTTP app with uvicorn."""
    parser = argparse.ArgumentParser(description="Run the cursor-cli-purple A2A agent.")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind the server")
    parser.add_argument("--port", type=int, default=9019, help="Port to bind the server")
    parser.add_argument("--card-url", type=str, help="URL to advertise in the agent card")
    args = parser.parse_args()

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
