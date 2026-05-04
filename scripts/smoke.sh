#!/usr/bin/env bash
# Local end-to-end smoke for CyberGym + purple: pull green image, build images, run compose until the client exits.
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
docker compose pull cybergym-green
docker compose build cursor-cli-purple client
docker compose up --abort-on-container-exit --exit-code-from client
