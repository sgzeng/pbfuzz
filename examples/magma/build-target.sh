#!/usr/bin/env bash
# Builds one Magma target natively — no Docker — the way magma/docker/Dockerfile does it: fetch the
# upstream source, apply Magma's setup and bug patches, then build Magma's canary library and the
# target with canaries on and debug info. The result is what generate-campaign.sh points a pbfuzz
# campaign at: the patched source tree, the instrumented binary, and Magma's seed corpus.
#
#   MAGMA_ROOT=/path/to/magma ./build-target.sh            # TARGET_NAME=lua by default
#   MAGMA_ROOT=... TARGET_NAME=libpng WORK=/data/magma-work ./build-target.sh
#
# Layout written under $WORK/$TARGET_NAME/:
#   repo/      the upstream source with every Magma patch applied (the campaign's target.repo)
#   out/       magma.a and the built programs (configrc's PROGRAMS)
#   corpus/    Magma's seeds, one directory per program
#   patches/   Magma's setup and bug patches (bugs/<BUG_ID>.patch)
#
# Verified with lua (LUA001). Other targets follow the same steps; their system dependencies come
# from Magma's own preinstall scripts (INSTALL_DEPS=1 runs them, with sudo when not root).
set -euo pipefail

MAGMA_ROOT="${MAGMA_ROOT:?set MAGMA_ROOT to a Magma checkout (R-Fuzz/magma, branch pbfuzz)}"
MAGMA_ROOT="$(cd "$MAGMA_ROOT" && pwd)"
TARGET_NAME="${TARGET_NAME:-lua}"
WORK="${WORK:-$PWD/magma-work}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"

[ -d "$MAGMA_ROOT/targets/$TARGET_NAME" ] || { echo "error: no target $MAGMA_ROOT/targets/$TARGET_NAME" >&2; exit 1; }

export MAGMA="$MAGMA_ROOT/magma"
export TARGET="$WORK/$TARGET_NAME"
export OUT="$TARGET/out"
export SHARED="$TARGET/shared"
mkdir -p "$TARGET" "$OUT" "$SHARED"

if [ "${INSTALL_DEPS:-0}" = 1 ]; then
  SUDO=; [ "$(id -u)" -eq 0 ] || SUDO=sudo
  $SUDO env TARGET="$TARGET" bash "$MAGMA/preinstall.sh"
  $SUDO env TARGET="$TARGET" bash "$MAGMA_ROOT/targets/$TARGET_NAME/preinstall.sh"
fi

# Magma's own target files (build.sh, configrc, patches, corpus, src) — never the fetched repo.
(cd "$MAGMA_ROOT/targets/$TARGET_NAME" && tar cf - --exclude=./repo .) | (cd "$TARGET" && tar xf -)

if [ ! -d "$TARGET/repo" ]; then
  echo "==> fetch $TARGET_NAME"
  bash "$TARGET/fetch.sh"
fi

# apply_patches.sh is not idempotent; stamp the tree once every patch went in.
if [ ! -f "$TARGET/.magma-patched" ]; then
  echo "==> apply Magma patches"
  bash "$MAGMA/apply_patches.sh"
  touch "$TARGET/.magma-patched"
fi

# The Dockerfile's build environment, with canaries on (MAGMA_ENABLE_CANARIES) so every injected
# bug prints "MAGMA: Bug <ID> reached/triggered" — the oracle the pbfuzz campaign reuses.
export CC="${CC:-clang}" CXX="${CXX:-clang++}" AR="${AR:-ar}" RANLIB="${RANLIB:-ranlib}"
BUILD_FLAGS="-include $MAGMA/src/canary.h -DMAGMA_ENABLE_CANARIES -g -O0"
export CFLAGS="$BUILD_FLAGS" CXXFLAGS="$BUILD_FLAGS"
export LIBS="-l:magma.a -lrt" LDFLAGS="-L$OUT -g"

echo "==> build magma.a and $TARGET_NAME ($CC)"
bash "$MAGMA/build.sh"

# libFuzzer-style harnesses (LLVMFuzzerTestOneInput) get the same standalone file-input main()
# magma/fuzzers/pbfuzz/instrument.sh links in; its main() is weak, so lua's own main() still wins.
export FUZZER_LIB="$OUT/libfuzzer-harness-fast.a"
$CXX $CXXFLAGS -c -fPIC -o "$OUT/harness-proxy.o" "$MAGMA_ROOT/fuzzers/pbfuzz/src/afl_driver.cpp"
rm -f "$FUZZER_LIB"
$AR rcs "$FUZZER_LIB" "$OUT/harness-proxy.o"
[ "$TARGET_NAME" = poppler ] || export LIBS="$LIBS $FUZZER_LIB"

bash "$TARGET/build.sh"

PROGRAMS=()
# shellcheck disable=SC1091
. "$TARGET/configrc"
echo
for p in "${PROGRAMS[@]}"; do
  [ -x "$OUT/$p" ] && echo "built $OUT/$p" || echo "warning: $OUT/$p was not produced" >&2
done
