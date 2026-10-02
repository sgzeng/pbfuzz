#!/usr/bin/env bash
# Runs one generated Magma campaign headless: DSH (the version pinned in HARNESS_COMMIT) boots the
# profile pbfuzz was installed into, in the target's source tree, and the plugin picks up
# "/pbfuzz run <yaml>" and drives PIER unattended until SUCCESS or STOPPED.
#
#   DEEPSEEK_API_KEY=... ./run-campaign.sh magma-work/lua/campaigns/LUA001.campaign.yaml
#
# PROFILE (default: headless) must have the plugin installed: ./install.sh --profile headless.
# Budgets (`budget.*` under the pbfuzz entry of the profile's cordis.patch.yml) are the only brake on an unattended run.
#
# MAGMA_ROOT, if set, also hides this target's bug patches in the *source* Magma checkout for the
# session's duration (restored on exit, any outcome). build-target.sh already deletes them from
# the built tree, but the agent's shell has ordinary filesystem access and, given MAGMA_ROOT on
# disk, can and does go looking for patches/bugs/<BUG_ID>.patch there — chmod does not stop a
# root-run agent from reading it, so this moves the directory aside instead.
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

# Opportunistic, root-proof hide of the bug patches at their source: target.repo's layout is
# always $WORK/<target_name>/repo (build-target.sh), so <target_name> is the name of REPO's
# containing directory. Only acts when MAGMA_ROOT is given and that target's patches/ still
# exists there; always restores on exit via the trap, success or failure alike.
if [ -n "${MAGMA_ROOT:-}" ]; then
  target_name="$(basename "$(dirname "$REPO")")"
  src_patches="$MAGMA_ROOT/targets/$target_name/patches"
  if [ -d "$src_patches" ]; then
    hidden_patches="$(mktemp -d)/patches"
    mv "$src_patches" "$hidden_patches"
    trap 'mv "$hidden_patches" "$src_patches"' EXIT
    echo "==> hid $src_patches for the agent session (restored on exit)"
  fi
fi

echo "==> dsh@$DSH_VERSION --profile $PROFILE in $REPO"
status=0
(cd "$REPO" && npx --yes "@deepseek-ai/dsh@$DSH_VERSION" --profile "$PROFILE" "/pbfuzz run $CAMPAIGN") || status=$?

echo
echo "==> $OUTDIR/state/state.json"
cat "$OUTDIR/state/state.json" 2>/dev/null || echo "(no state written)"
exit "$status"
