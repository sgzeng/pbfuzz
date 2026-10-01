#!/usr/bin/env bash
# Generates a confirmed pbfuzz.campaign.yaml for one Magma bug via the Magma adapter
# (engine/pbfuzz_engine/adapters/magma.py), then prints it. This is the headless path PLAN.md
# §2.6 describes: "users hand-write the same yaml... The Magma adapter generates the yaml
# automatically." Nothing here fetches or builds Magma — point the variables below at an
# existing Magma checkout with the target already built (either freshly, or Magma's own
# pre-built image under fuzzers/pre-built/<target>/).
#
# Verified against magma/fuzzers/pre-built/lua/{clang_bc/lua/lua, BBtargets/LUA001} (V2,
# docs/verification.md) — defaults below match that exact run.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

MAGMA_ROOT="${MAGMA_ROOT:?set MAGMA_ROOT to a Magma checkout, e.g. /mnt/work/pbfuzz/magma}"
TARGET_NAME="${TARGET_NAME:-lua}"
BUG_ID="${BUG_ID:-LUA001}"
# Magma's own pre-built image layout (fuzzers/pre-built/<target>/...); point PREBUILT_DIR /
# BINARY / BBTARGETS elsewhere for a fresh native build instead (see README.md).
PREBUILT="${PREBUILT:-$MAGMA_ROOT/fuzzers/pre-built/$TARGET_NAME}"
BINARY="${BINARY:-$PREBUILT/clang_bc/$TARGET_NAME/$TARGET_NAME}"
BBTARGETS="${BBTARGETS:-$PREBUILT/BBtargets/$BUG_ID/BBtargets.txt}"
PREBUILT_DIR="${PREBUILT_DIR:-$PREBUILT/BBtargets/$BUG_ID}"
SEEDS_DIR="${SEEDS_DIR:-$MAGMA_ROOT/targets/$TARGET_NAME/corpus/$TARGET_NAME}"
BUG_PATCH="${BUG_PATCH:-$MAGMA_ROOT/targets/$TARGET_NAME/patches/bugs/$BUG_ID.patch}"
OUTPUT="${OUTPUT:-$MAGMA_ROOT/targets/$TARGET_NAME/pbfuzz.campaign.yaml}"

"${PBFUZZ_PYTHON:-python3}" -m pbfuzz_engine.adapters.magma \
    --target-name "$TARGET_NAME" \
    --target-repo "$MAGMA_ROOT/targets/$TARGET_NAME" \
    --bug-id "$BUG_ID" \
    --binary "$BINARY" \
    --bbtargets "$BBTARGETS" \
    --bug-patch "$BUG_PATCH" \
    --prebuilt-dir "$PREBUILT_DIR" \
    --seeds-dir "$SEEDS_DIR" \
    --output-dir "$MAGMA_ROOT/targets/$TARGET_NAME/.pbfuzz/$TARGET_NAME-$(echo "$BUG_ID" | tr '[:upper:]' '[:lower:]')" \
    --write "$OUTPUT"

echo "wrote $OUTPUT" >&2
