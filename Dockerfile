# Purple service image: uv lockfile sync plus Cursor CLI for headless cursor-agent (CyberGym PoC loop).
FROM ghcr.io/astral-sh/uv:python3.13-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN adduser agent
RUN mkdir -p /work /home/agent/.config/cursor \
    && chown -R agent:agent /work /home/agent/.config

USER agent
WORKDIR /home/agent

RUN curl https://cursor.com/install -fsS | bash
ENV PATH="/home/agent/.local/bin:${PATH}"

COPY pyproject.toml uv.lock README.md ./
COPY src src

RUN \
    --mount=type=cache,target=/home/agent/.cache/uv,uid=1000 \
    uv sync --locked

ENV PORT=9019
ENTRYPOINT ["uv", "run", "src/server.py"]
CMD ["--host", "0.0.0.0", "--card-url", "http://cursor-cli-purple:9019/"]
EXPOSE 9019
