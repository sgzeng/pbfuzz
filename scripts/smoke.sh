#!/usr/bin/env bash
# Local smoke with live visibility:
#   - `docker compose logs -f pbfuzz` (A2A server + Python tracebacks)
# Then runs the one-shot client and `docker compose down`.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -z "${CURSOR_AUTH:-}" ]]; then
  AUTH_JSON="${HOST_CURSOR_AUTH_JSON:-$HOME/.config/cursor/auth.json}"
  if [[ ! -f "$AUTH_JSON" ]]; then
    echo "Set CURSOR_AUTH (base64 of auth.json) or place Cursor auth at $AUTH_JSON (or set HOST_CURSOR_AUTH_JSON)"
    exit 1
  fi
  CURSOR_AUTH="$(base64 -w0 < "$AUTH_JSON")"
  export CURSOR_AUTH
fi
mkdir -p purple_agent_output

echo "==> pull / build"
docker compose pull cybergym-green
docker compose build pbfuzz client

echo "==> up (green + purple)"
docker compose up -d cybergym-green pbfuzz

cleanup() {
  set +e
  if [[ -n "${TAIL_LOGS:-}" ]]; then kill "${TAIL_LOGS}" 2>/dev/null; fi
  docker compose down
}
trap cleanup EXIT

echo "==> follow pbfuzz container logs ([pbfuzz] prefix)"
docker compose logs -f --tail=40 pbfuzz 2>&1 | sed -u 's/^/[pbfuzz] /' &
TAIL_LOGS=$!

echo "==> run client (scenario.toml)"
echo "    TIP: tail specific sync files, e.g."
echo "      tail -f purple_agent_output/<ctx>/pbfuzz_output/agent_bundle.log"
echo "      tail -f purple_agent_output/<ctx>/cursor_agent_after_inner_*.log"
set +e
docker compose run --rm client
RC=$?
set -e
exit "$RC"
