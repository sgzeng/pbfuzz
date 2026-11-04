#!/usr/bin/env bash
# build.cmd for the Magma poppler target under kanalyzer: LTO bitcode of pdf_fuzzer for KAMain.
#
# Run by dsh-kanalyzer's prepare() through `/bin/sh -c` in its isolated copy of target.repo (cwd =
# that copy). kanalyzer passes the LTO recipe through CC/CXX/CFLAGS/CXXFLAGS/LDFLAGS; this script
# adds only what the Magma harness needs on top of that:
#   - MAGMA_ENABLE_CANARIES + canary.h: poppler's MAGMA_LOG("PDF005", ...) call site at
#     JPEG2000Stream.cc:312 sits inside #ifdef MAGMA_ENABLE_CANARIES; without the define the target
#     line does not exist and kanalyzer reports no_target;
#   - the harness: Magma's pdf_fuzzer.cc (from the built target dir) with afl_driver.cpp's main,
#     linked against Magma's native magma.a exactly as build-target.sh does.
#
# Inputs (env, set inline in the campaign's build.cmd by generate-campaign.sh):
#   MAGMA_ROOT  Magma checkout (R-Fuzz/magma, branch pbfuzz)
#   WORK        build-target.sh's work dir (contains poppler/out/magma.a and poppler/src/)
# Output: $SRC/.pbfuzz/kanalyzer-build/pdf_fuzzer and pdf_fuzzer.0.0.preopt.bc next to it.
set -euo pipefail
: "${MAGMA_ROOT:?set MAGMA_ROOT to a Magma checkout}"
: "${WORK:?set WORK to the build-target.sh work dir}"

SRC=$PWD
B=$SRC/.pbfuzz/kanalyzer-build
OUT=$WORK/poppler/out
CANARY="-include $MAGMA_ROOT/magma/src/canary.h -DMAGMA_ENABLE_CANARIES"
export CFLAGS="${CFLAGS:-} $CANARY" CXXFLAGS="${CXXFLAGS:-} $CANARY"

echo "==> cmake poppler (canaries on, system freetype)"
cmake -S "$SRC" -B "$B" -G Ninja \
  -DCMAKE_BUILD_TYPE=debug -DBUILD_SHARED_LIBS=OFF \
  -DFONT_CONFIGURATION=generic \
  -DBUILD_GTK_TESTS=OFF -DBUILD_QT5_TESTS=OFF -DBUILD_CPP_TESTS=OFF \
  -DENABLE_LIBPNG=ON -DENABLE_LIBTIFF=ON -DENABLE_LIBJPEG=ON \
  -DENABLE_SPLASH=ON -DENABLE_UTILS=ON -DWITH_Cairo=ON -DENABLE_CMS=none \
  -DENABLE_LIBCURL=OFF -DENABLE_GLIB=OFF -DENABLE_GOBJECT_INTROSPECTION=OFF \
  -DENABLE_QT5=OFF -DWITH_NSS3=OFF

echo "==> build poppler libraries"
cmake --build "$B" --target poppler poppler-cpp

echo "==> link pdf_fuzzer"
$CXX $CXXFLAGS -std=c++11 -I"$B/cpp" -I"$SRC/cpp" \
  -c "$WORK/poppler/src/pdf_fuzzer.cc" -o "$B/pdf_fuzzer.o"
$CXX $CXXFLAGS -c "$MAGMA_ROOT/fuzzers/pbfuzz/src/afl_driver.cpp" -o "$B/afl_driver.o"
$CXX $CXXFLAGS -o "$B/pdf_fuzzer" "$B/pdf_fuzzer.o" "$B/afl_driver.o" \
  "$B/cpp/libpoppler-cpp.a" "$B/libpoppler.a" \
  -lfreetype -ljpeg -lz -lopenjp2 -lpng -ltiff -llcms2 -lbrotlidec -lbz2 -lm -lpthread \
  -L"$OUT" -l:magma.a -lrt $LDFLAGS

ls -l "$B"/pdf_fuzzer*
