#!/usr/bin/env bash
# Does pbfuzz still work with a DeepSeek Harness release?
#
#   scripts/compat-check.sh              # re-pin to npm's latest DSH, then check
#   scripts/compat-check.sh 0.2.1        # re-pin to that release, then check
#   scripts/compat-check.sh --current    # check the pins as committed (what a dev machine usually wants)
#
# Every step runs against the real DSH packages: forced typecheck (tsc -b alone skips work when only
# the typings changed), unit tests, client bundles, then the plugins are built, installed into a
# scratch DSH profile and a real `dsh web` is driven with Chromium (scripts/smoke-web.mjs). The
# web step is the one that caught the 0.2 `settingsScope` removal: the host half was fine, both
# client bundles silently never activated and the UI was blank.
#
# On failure the last stdout/stderr line is `COMPAT-FAILED-AT: <step>` (the weekly workflow reads it).
# Needs: node >= 22.19, pnpm, python >= 3.11 (engine tests), Chromium + the `playwright` package.
# Re-pinning edits package.json / pnpm-workspace.yaml / HARNESS_COMMIT / pnpm-lock.yaml in place.
set -euo pipefail
cd "$(dirname "$0")/.."

STEP=start
step() { STEP=$*; printf '\n==> %s\n' "$STEP"; }
trap 'echo "COMPAT-FAILED-AT: $STEP" >&2' ERR

arg=${1:-}
if [ "$arg" != --current ]; then
  step "pin to DSH ${arg:-latest}"
  node scripts/bump-dsh.mjs ${arg:+"$arg"}
fi
DSH_VERSION=$(sed -n 's/^DSH_VERSION=//p' HARNESS_COMMIT)
echo "DSH $DSH_VERSION"

step "pnpm install"
pnpm install --no-frozen-lockfile --ignore-scripts

step "typecheck (forced)"
pnpm -r typecheck

step "unit tests"
pnpm -r test

step "client bundles + contracts"
pnpm run check:clients
pnpm run codegen:check

step "build and install into a scratch DSH profile"
SCRATCH=$(mktemp -d)
trap 'echo "COMPAT-FAILED-AT: $STEP" >&2; rm -rf "$SCRATCH"' ERR
trap 'rm -rf "$SCRATCH"' EXIT
export DSH_HOME=$SCRATCH/dsh-home
./install.sh --profile web
npx --yes "@deepseek-ai/dsh@$DSH_VERSION" plugin --profile web add "$PWD/$(ls dist/pbfuzz-dsh-kanalyzer-*.tgz)"

step "web smoke (real dsh web + Chromium)"
npm install --silent --no-audit --no-fund --prefix "$SCRATCH/dsh" "@deepseek-ai/dsh@$DSH_VERSION"
DSH_BIN=$SCRATCH/dsh/node_modules/.bin/dsh node scripts/smoke-web.mjs --kanalyzer

printf '\nCOMPAT-OK: pbfuzz works with DSH %s\n' "$DSH_VERSION"
