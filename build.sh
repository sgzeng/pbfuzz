#!/usr/bin/env bash
# Build pbfuzz-dsh (build only — does not touch your DSH install; see ./install.sh for that).
# Missing or too-old Node/pnpm/Python are installed under ./.local (never system-wide).
#   ./build.sh
# Output: both plugin packages built and packed into ./dist/*.tgz, Python engine in engine/.venv.
set -euo pipefail
cd "$(dirname "$0")"
. scripts/ensure-deps.sh

[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "Linux x86-64 only"
. /etc/os-release 2>/dev/null || true
[ "${ID:-}" = ubuntu ] || printf 'warning: tested on Ubuntu 22.04/24.04 only (found %s)\n' "${PRETTY_NAME:-unknown}" >&2

ensure_node
ensure_pnpm
ensure_python
echo "node $(node -v) | pnpm $(pnpm -v) | python $("$PY" -V 2>&1 | cut -d' ' -f2)"

log "Build plugins"
pnpm install --frozen-lockfile
pnpm run build

log "Python engine"
# The venv must be built from the interpreter chosen above (the local pyenv one when the system
# Python was too old). Rebuild it if it was made from a different or older Python.
want=$("$PY" -c 'import sys; print(sys.base_prefix)')
have=$(engine/.venv/bin/python -c 'import sys; print(sys.base_prefix)' 2>/dev/null || true)
[ "$want" = "$have" ] || rm -rf engine/.venv
[ -d engine/.venv ] || "$PY" -m venv engine/.venv || die "venv failed (sudo apt install python3-venv)"
engine/.venv/bin/pip install -q -e engine

log "Pack plugins -> dist/"
rm -rf dist && mkdir dist
npm pack --silent --pack-destination dist ./packages/dsh-pbfuzz >/dev/null
npm pack --silent --pack-destination dist ./packages/dsh-kanalyzer >/dev/null
ls dist

printf '\nBuild OK. Run ./install.sh to add the plugins to DeepSeek Harness.\n'
