# syntax=docker/dockerfile:1
# Purple service: A2A server + cursor-agent + embedded pbfuzz + native toolchain for CyberGym INIT builds.
#
# Build contexts (APP_DIR prefixes every COPY):
#   - Repo root with a real `pbfuzz-purple/` tree (CI): docker build -f pbfuzz-purple/Dockerfile .
#     Default APP_DIR=pbfuzz-purple.
#   - This directory (recommended for docker compose): compose passes APP_DIR=.
#     Also use if your monorepo uses a symlink for `pbfuzz-purple/` — Docker context from the repo root
#     does not include files behind that symlink, so building from `pbfuzz-purple/` as context avoids empty COPYs.
#   - Manual: docker build --build-arg APP_DIR=. -f Dockerfile .
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

ARG APP_DIR=pbfuzz-purple
COPY ${APP_DIR}/pyproject.toml ${APP_DIR}/README.md ./
COPY --chown=agent:agent ${APP_DIR}/cursor-cli-config.json /home/agent/.cursor/cli-config.json
COPY ${APP_DIR}/src src
COPY ${APP_DIR}/fallback fallback
COPY ${APP_DIR}/pbfuzz pbfuzz

RUN \
    --mount=type=cache,target=/home/agent/.cache/uv,uid=1000 \
    uv sync && \
    uv pip install -r pbfuzz/requirements.txt

ENTRYPOINT ["uv", "run", "src/server.py"]
CMD ["--host", "0.0.0.0", "--port", "9029", "--card-url", "http://pbfuzz:9029/"]
EXPOSE 9029
