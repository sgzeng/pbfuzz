#!/usr/bin/env bash
# End-to-end smoke: three FFmpeg CVE reproduction cases.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PBFUZZ_HOME="${PBFUZZ_HOME:-$ROOT/pbfuzz}"
export PYTHONPATH="$PBFUZZ_HOME:$ROOT/src:${PYTHONPATH:-}"

if [[ -z "${CURSOR_AUTH:-}" ]] && [[ -f "$HOME/.config/cursor/auth.json" ]]; then
  export CURSOR_AUTH="$(base64 -w0 < "$HOME/.config/cursor/auth.json")"
fi
if [[ -f "$ROOT/secret.txt" ]] && [[ ! -f "$HOME/.config/cursor/auth.json" ]]; then
  mkdir -p "$HOME/.config/cursor"
  base64 -d "$ROOT/secret.txt" > "$HOME/.config/cursor/auth.json"
fi

RUN_ROOT="${RUN_ROOT:-/tmp/pbfuzz-runs}"
mkdir -p "$RUN_ROOT"

run_one() {
  local cve="$1"
  local out="$RUN_ROOT/$cve"
  echo "==> $cve -> $out"
  pbfuzz reproduce \
    --cve-description "/mnt/work/FFmpeg/${cve}-repro/CVE_description.txt" \
    --patch "/mnt/work/FFmpeg/${cve}-repro/fix.patch" \
    --source "/mnt/work/FFmpeg" \
    --output "$out" \
    --max-outer-rounds "${MAX_OUTER_ROUNDS:-2}" \
    --max-inner-iter "${MAX_INNER_ITER:-10}"
}

run_one cve-2024-22860
run_one cve-2024-35366
run_one cve-2025-63757

echo "All smoke cases finished under $RUN_ROOT"
