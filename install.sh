#!/usr/bin/env bash
# Build pbfuzz-dsh and install it into DeepSeek Harness (DSH must already be set up).
#   ./install.sh                    # pbfuzz plugin + Python engine
#   ./install.sh --with-kanalyzer   # also the static-analysis plugin + LLVM toolchain (slow, needs sudo)
#   ./install.sh --profile NAME     # DSH profile to install into (default: web)
set -euo pipefail
cd "$(dirname "$0")"

WITH_KANALYZER=0
PROFILE=web
while [ $# -gt 0 ]; do
  case "$1" in
    --with-kanalyzer) WITH_KANALYZER=1 ;;
    --profile) PROFILE=${2:?--profile needs a value}; shift ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

if [ "$WITH_KANALYZER" = 1 ]; then
  echo "==> LLVM toolchain (sudo)"
  sudo bash scripts/setup-linux.sh
fi

./build.sh

# build.sh may have installed a local Node under .local; use it for npx too.
. scripts/ensure-deps.sh
ensure_node

DSH=(npx --yes @deepseek-ai/dsh)
add() { echo "==> dsh plugin add $1"; "${DSH[@]}" plugin --profile "$PROFILE" add "$PWD/$(ls dist/$1-*.tgz)"; }
add pbfuzz-dsh-pbfuzz
[ "$WITH_KANALYZER" = 0 ] || add pbfuzz-dsh-kanalyzer

cat <<MSG

Installed into DSH profile '$PROFILE'. Start (or restart) the server:

  npx @deepseek-ai/dsh web

Then open a session in your target repo and type:  /pbfuzz <describe the bug>
MSG
