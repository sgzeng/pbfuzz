#!/usr/bin/env bash
# Local end-to-end smoke for CyberGym + purple: pull green image, build images, run compose until the client exits.
set -euo pipefail
cd "$(dirname "$0")/.."
AUTH_JSON="${HOST_CURSOR_AUTH_JSON:-$HOME/.config/cursor/auth.json}"
if [[ ! -f "$AUTH_JSON" ]]; then
  echo "Missing Cursor auth file: $AUTH_JSON (set HOST_CURSOR_AUTH_JSON if elsewhere)"
  exit 1
fi
docker compose pull cybergym-green
docker compose build cursor-cli-purple client
docker compose up --abort-on-container-exit --exit-code-from client
