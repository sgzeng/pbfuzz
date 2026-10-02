#!/usr/bin/env bash
# Runs one generated Magma campaign headless: DSH (the version pinned in HARNESS_COMMIT) boots the
# profile pbfuzz was installed into, in the target's source tree, and the plugin picks up
# "/pbfuzz run <yaml>" and drives PIER unattended until SUCCESS or STOPPED.
#
#   DEEPSEEK_API_KEY=... ./run-campaign.sh magma-work/lua/campaigns/LUA001.campaign.yaml
#
# PROFILE (default: headless) must have the plugin installed: ./install.sh --profile headless.
# Budgets (pbfuzz.budget.* in ~/.dsh/settings.yaml) are the only brake on an unattended run.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PBFUZZ_ROOT="$(cd "$HERE/../.." && pwd)"

CAMPAIGN="${1:?usage: run-campaign.sh <campaign.yaml>}"
CAMPAIGN="$(cd "$(dirname "$CAMPAIGN")" && pwd)/$(basename "$CAMPAIGN")"
PROFILE="${PROFILE:-headless}"
DSH_VERSION="$(sed -n 's/^DSH_VERSION=//p' "$PBFUZZ_ROOT/HARNESS_COMMIT")"
PY="${PBFUZZ_PYTHON:-$PBFUZZ_ROOT/engine/.venv/bin/python}"

[ -n "${DEEPSEEK_API_KEY:-}" ] || {
  echo "error: DEEPSEEK_API_KEY is not set — DSH needs it for the model (or store it via the web UI's Models page)" >&2
  exit 1
}

# The campaign's target.repo is the workspace: the agent reads the target source from there.
read -r REPO OUTDIR < <("$PY" -c 'import sys,yaml; c=yaml.safe_load(open(sys.argv[1])); print(c["target"]["repo"], c["output"]["dir"])' "$CAMPAIGN")

echo "==> dsh@$DSH_VERSION --profile $PROFILE in $REPO"
status=0
(cd "$REPO" && npx --yes "@deepseek-ai/dsh@$DSH_VERSION" --profile "$PROFILE" "/pbfuzz run $CAMPAIGN") || status=$?

echo
echo "==> $OUTDIR/state/state.json"
cat "$OUTDIR/state/state.json" 2>/dev/null || echo "(no state written)"
exit "$status"
