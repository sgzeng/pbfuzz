"""Pytest fixtures for live A2A conformance runs against a running purple agent."""

import httpx
import pytest


def pytest_addoption(parser):
    """Register ``--agent-url`` so CI or local runs can target any listening agent."""
    parser.addoption(
        "--agent-url",
        default="http://localhost:9019",
        help="Agent URL (default: http://localhost:9019)",
    )


@pytest.fixture(scope="session")
def agent(request):
    """Resolve base URL and fail fast if the Agent Card endpoint is unreachable."""
    url = request.config.getoption("--agent-url")

    try:
        response = httpx.get(f"{url}/.well-known/agent-card.json", timeout=2)
        if response.status_code != 200:
            pytest.exit(f"Agent at {url} returned status {response.status_code}", returncode=1)
    except Exception as e:
        pytest.exit(f"Could not connect to agent at {url}: {e}", returncode=1)

    return url
