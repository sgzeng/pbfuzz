#!/usr/bin/env bash
# Generates a confirmed pbfuzz campaign yaml for one Magma bug via the Magma adapter
# (engine/pbfuzz_engine/adapters/magma.py). Point it at a target built by build-target.sh:
#
#   WORK=$PWD/magma-work ./generate-campaign.sh                  # TARGET_NAME=lua BUG_ID=LUA001
#   WORK=... TARGET_NAME=libpng BUG_ID=PNG001 ./generate-campaign.sh
#
# Every path can be overridden on its own (REPO, BINARY, RUN_ARGS, SEEDS_DIR, BBTARGETS, OUTPUT);
# see below. Prints the path of the written yaml on stdout.
#
# What the agent gets, deliberately: only the bug's location (BBtargets.txt) and the MAGMA_LOG
# condition read off the *built* source at that line — the same two things a real crash report or
# CVE advisory would give you. Magma's own bug patch (which shows the buggy code right next to its
# `#ifdef MAGMA_ENABLE_FIXES` fix) is never read by this script and never named in the campaign;
# build-target.sh deletes it from the built tree once applied, precisely so nothing here could
# hand it to the agent even by accident.
#
# Static analysis: off by default — the campaign runs on gdb traces alone. Set PREBUILT_DIR to a
# directory of KAMain outputs (Magma's SKIP_STATIC_ANALYSIS path, or a previous kanalyzer run), or
# STATIC_ANALYSIS=1 to have kanalyzer build bitcode itself (needs ./install.sh --with-kanalyzer).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PBFUZZ_ROOT="$(cd "$HERE/../.." && pwd)"

WORK="${WORK:-$PWD/magma-work}"
TARGET_NAME="${TARGET_NAME:-lua}"
BUG_ID="${BUG_ID:-LUA001}"
TARGET="${TARGET:-$WORK/$TARGET_NAME}"
[ -f "$TARGET/configrc" ] || { echo "error: $TARGET is not a built Magma target; run build-target.sh first" >&2; exit 1; }

PROGRAMS=()
# shellcheck disable=SC1091
. "$TARGET/configrc"
PROGRAM="${PROGRAM:-${PROGRAMS[0]}}"
args_var="${PROGRAM}_ARGS"
RUN_ARGS="${RUN_ARGS:-${!args_var:-@@}}"   # configrc's <program>_ARGS, as magma/run.sh uses them

REPO="${REPO:-$TARGET/repo}"
SRC_DIR="${SRC_DIR:-$REPO}"                # where the patched sources live (sqlite3: $TARGET/work)
BINARY="${BINARY:-$TARGET/out/$PROGRAM}"
SEEDS_DIR="${SEEDS_DIR:-$TARGET/corpus/$PROGRAM}"
BBTARGETS="${BBTARGETS:-${PREBUILT_DIR:+$PREBUILT_DIR/BBtargets.txt}}"
BBTARGETS="${BBTARGETS:-$TARGET/BBtargets/$BUG_ID/BBtargets.txt}"
OUTPUT="${OUTPUT:-$TARGET/campaigns/$BUG_ID.campaign.yaml}"
PY="${PBFUZZ_PYTHON:-$PBFUZZ_ROOT/engine/.venv/bin/python}"

[ -x "$BINARY" ] || { echo "error: no binary at $BINARY (PROGRAM=$PROGRAM)" >&2; exit 1; }
[ -x "$PY" ] || { echo "error: no engine Python at $PY; run ./build.sh in $PBFUZZ_ROOT or set PBFUZZ_PYTHON" >&2; exit 1; }

# BBtargets.txt: every MAGMA_LOG("<BUG_ID>", ...) call site as basename:line — the same grep
# magma/fuzzers/pbfuzz/instrument.sh feeds KAMain's -target-list.
if [ ! -s "$BBTARGETS" ]; then
  mkdir -p "$(dirname "$BBTARGETS")"
  grep -nR "MAGMA_LOG(\"${BUG_ID}\"" "$SRC_DIR" --include='*.c' --include='*.h' --include='*.cc' --include='*.cpp' \
    | awk -F: '{print $1":"$2}' | sed 's/.*\///' > "$BBTARGETS" || true
  [ -s "$BBTARGETS" ] || { echo "error: no MAGMA_LOG(\"$BUG_ID\" ...) in $SRC_DIR — was the bug patch applied?" >&2; exit 1; }
fi

static_args=(--no-static-analysis)
if [ -n "${PREBUILT_DIR:-}" ]; then static_args=(--prebuilt-dir "$PREBUILT_DIR")
elif [ "${STATIC_ANALYSIS:-0}" = 1 ]; then static_args=()
fi
corpus_args=()
[ -d "$SEEDS_DIR" ] && corpus_args=(--seeds-dir "$SEEDS_DIR")

"$PY" -m pbfuzz_engine.adapters.magma \
  --target-name "$TARGET_NAME" \
  --target-repo "$REPO" \
  --bug-id "$BUG_ID" \
  --binary "$BINARY" \
  --run-cmd "$BINARY ${RUN_ARGS}" \
  --bbtargets "$BBTARGETS" \
  "${static_args[@]}" \
  "${corpus_args[@]}" \
  --write "$OUTPUT"

echo "$OUTPUT"
