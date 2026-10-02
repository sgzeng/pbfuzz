#!/usr/bin/env bash
# Headless pbfuzz run on readelf.cpp: stage a clean workspace, run PIER unattended, print the verdict.
#   DEEPSEEK_API_KEY=... ./run.sh        (needs `./install.sh --profile headless` once, at the repo root)
# The agent works in $WORK, a copy WITHOUT reference/ (the answer from an earlier run).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
HERE=$PWD
DSH_VERSION=$(sed -n 's/^DSH_VERSION=//p' ../../HARNESS_COMMIT)
PROFILE=${PROFILE:-headless}
WORK=${WORK:-${TMPDIR:-/tmp}/pbfuzz-readelf-c}
: "${DEEPSEEK_API_KEY:?set DEEPSEEK_API_KEY (or store a key in DSH)}"

rm -rf "$WORK" && mkdir -p "$WORK/.pbfuzz"
cp -r readelf.cpp build.sh seeds "$WORK/"
sed "s#@DIR@#$WORK#g" campaign.template.yaml > "$WORK/.pbfuzz/campaign.yaml"
(cd "$WORK" && ./build.sh)

status=0
(cd "$WORK" && npx --yes "@deepseek-ai/dsh@$DSH_VERSION" --profile "$PROFILE" "/pbfuzz run $WORK/.pbfuzz/campaign.yaml") || status=$?

echo; echo "== verdict: $WORK/.pbfuzz/readelf-c/state/state.json"
cat "$WORK/.pbfuzz/readelf-c/state/state.json" 2>/dev/null || echo "(no state written)"
exit "$status"
