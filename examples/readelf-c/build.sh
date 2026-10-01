#!/usr/bin/env bash
# Builds the V1 verification target: a debug build for pbfuzz to run and trace, and (only when a
# kanalyzer clang is on PATH) the LTO bitcode kanalyzer's `prepare` step expects, so the example
# also works as a standalone kanalyzer smoke target without going through pbfuzz at all.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

CXX="${CXX:-clang++-14}"
command -v "$CXX" >/dev/null 2>&1 || CXX=clang++

"$CXX" -g -O0 -o readelf readelf.cpp
echo "built ./readelf ($($CXX --version | head -1))"

if command -v clang++-14 >/dev/null 2>&1 && command -v llvm-nm-14 >/dev/null 2>&1; then
  clang++-14 -O0 -g -fPIC -flto -fuse-ld=lld-14 -Wl,-plugin-opt=save-temps -o readelf.lto readelf.cpp
  if [ -f readelf.lto.0.0.preopt.bc ]; then
    echo "built readelf.lto.0.0.preopt.bc for kanalyzer"
  fi
fi
