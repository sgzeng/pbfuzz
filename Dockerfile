# Purple service: A2A server + cursor-agent + embedded pbfuzz + native toolchain for CyberGym INIT builds.
FROM ghcr.io/astral-sh/uv:python3.13-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    build-essential gcc g++ clang cmake ninja-build \
    pkg-config autoconf automake libtool make git python3-dev gdb \
    && rm -rf /var/lib/apt/lists/*

RUN adduser agent
RUN mkdir -p /work /home/agent/.config/cursor /home/agent/.cursor \
    && chown -R agent:agent /work /home/agent/.config /home/agent/.cursor

USER agent
WORKDIR /home/agent

RUN curl https://cursor.com/install -fsS | bash
ENV PATH="/home/agent/.local/bin:${PATH}"
# /home/agent on PYTHONPATH so `from fallback import ...` resolves; pbfuzz/ kept for sibling MCP imports.
ENV PYTHONPATH="/home/agent:/home/agent/pbfuzz"

COPY pbfuzz-purple/pyproject.toml pbfuzz-purple/README.md ./
COPY --chown=agent:agent pbfuzz-purple/cursor-cli-config.json /home/agent/.cursor/cli-config.json
COPY pbfuzz-purple/src src
COPY pbfuzz-purple/fallback fallback
COPY pbfuzz-purple/pbfuzz pbfuzz

RUN \
    --mount=type=cache,target=/home/agent/.cache/uv,uid=1000 \
    uv sync && \
    uv pip install -r pbfuzz/requirements.txt

ENTRYPOINT ["uv", "run", "src/server.py"]
CMD ["--host", "0.0.0.0", "--port", "9029", "--card-url", "http://pbfuzz:9029/"]
EXPOSE 9029
