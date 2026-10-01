#!/usr/bin/env bash
# System prerequisites for pbfuzz-dsh on Ubuntu 22.04/24.04 x86-64 (the only supported platform).
#
#   sudo bash scripts/setup-linux.sh
#
# Installs only what is missing; nothing already present is reinstalled or overwritten.
# 1. apt: build tools, python venv, a JDK (Jazzer / jdb) — only packages not yet installed.
# 2. LLVM 14 (the version KAMain is verified against), component by component:
#      clang, compiler-rt   reused from an existing LLVM 14 (e.g. apt clang-14 / libclang-rt-14-dev)
#      lld                  built from the 14.0.x source *standalone* against the existing LLVM 14
#      lldb (+ Python)      built standalone the same way; falls back to apt lldb-14 (optional tracer)
#    With no LLVM 14 on the machine at all, the whole toolchain is built from source into
#    /opt/llvm-14 instead. Built components are staged with DESTDIR and copied with
#    `rsync --ignore-existing`, so a file that already exists (including any dpkg-owned file) is
#    never replaced; the list of files added is written to $BUILD_ROOT/logs/installed-*.txt.
#    Compilation runs as $SUDO_USER; only the final copy runs as root.
#
# Environment overrides: LLVM_PREFIX (auto), BUILD_ROOT (/mnt/work/build), JOBS (nproc),
# JDK_PACKAGE (openjdk-17-jdk-headless), SKIP_LLDB=1.
set -euo pipefail

LLVM_MAJOR=14
BUILD_ROOT=${BUILD_ROOT:-/mnt/work/build}
JOBS=${JOBS:-$(nproc)}
JDK_PACKAGE=${JDK_PACKAGE:-openjdk-17-jdk-headless}
SKIP_LLDB=${SKIP_LLDB:-0}

[ "$(id -u)" -eq 0 ] || { echo "run with sudo: sudo bash $0" >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "Linux x86-64 only" >&2; exit 1; }
USER_NAME=${SUDO_USER:?run via sudo from your normal account so the build does not run as root}

LOG_DIR=$BUILD_ROOT/logs
declare -A RESULT
as_user() { sudo -u "$USER_NAME" -H "$@"; }
log() { printf '\n==> %s\n' "$*"; }
mkdir -p "$LOG_DIR"
chown "$USER_NAME": "$BUILD_ROOT" "$LOG_DIR"

have_pkg() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q '^install ok installed'; }
apt_missing() {  # apt_missing <pkg>... — install only the packages not already installed
  local missing=() p
  for p in "$@"; do have_pkg "$p" || missing+=("$p"); done
  if [ ${#missing[@]} -eq 0 ]; then echo "  apt: all present ($*)"; return 0; fi
  echo "  apt: installing ${missing[*]}"
  [ -n "${APT_UPDATED:-}" ] || { apt-get update >"$LOG_DIR/apt-update.log" 2>&1; APT_UPDATED=1; }
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}" \
    >>"$LOG_DIR/apt.log" 2>&1
}

# --- 1. apt -----------------------------------------------------------------------------------
log "apt packages"
PY=/usr/bin/python3
PY_VER=$($PY -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')
apt_missing build-essential cmake ninja-build git curl xz-utils rsync gdb \
  python3-dev "python$PY_VER-venv" zlib1g-dev libzstd-dev libxml2-dev libcrypt-dev \
  bison flex texinfo libboost-dev "$JDK_PACKAGE"
# libboost-dev: KAMain vendors only part of boost; its unordered_flat_map needs Boost >= 1.81 headers.
RESULT[apt]=ok

# --- 2. LLVM 14 ---------------------------------------------------------------------------------
# Reuse an existing LLVM 14 (apt layout first); otherwise build everything into /opt/llvm-14.
if [ -z "${LLVM_PREFIX:-}" ]; then
  LLVM_PREFIX=/opt/llvm-$LLVM_MAJOR
  for cand in /usr/lib/llvm-$LLVM_MAJOR /opt/llvm-$LLVM_MAJOR /usr/local; do
    if [ -x "$cand/bin/llvm-config" ] && "$cand/bin/llvm-config" --version | grep -q "^$LLVM_MAJOR\."; then
      LLVM_PREFIX=$cand; break
    fi
  done
fi
if [ -x "$LLVM_PREFIX/bin/llvm-config" ]; then
  LLVM_VERSION=$("$LLVM_PREFIX/bin/llvm-config" --version | sed 's/[^0-9.].*//')
  EXISTING_LLVM=1
else
  LLVM_VERSION=14.0.6
  EXISTING_LLVM=0
fi
echo "  LLVM prefix $LLVM_PREFIX (version $LLVM_VERSION, existing=$EXISTING_LLVM)"

has_clang()  { [ -x "$LLVM_PREFIX/bin/clang" ]; }
has_rt()     { ls "$LLVM_PREFIX"/lib/clang/*/lib/linux/libclang_rt.fuzzer-x86_64.a >/dev/null 2>&1; }
has_lld()    { [ -x "$LLVM_PREFIX/bin/ld.lld" ]; }
has_lldb()   { [ -x "$LLVM_PREFIX/bin/lldb" ] || command -v "lldb-$LLVM_MAJOR" >/dev/null; }

SRC=$BUILD_ROOT/llvm-project-$LLVM_VERSION.src
fetch_source() {
  [ -d "$SRC" ] && return 0
  log "fetching llvm-project $LLVM_VERSION source"
  as_user curl -fL --retry 3 -o "$BUILD_ROOT/llvm.tar.xz" \
    "https://github.com/llvm/llvm-project/releases/download/llvmorg-$LLVM_VERSION/llvm-project-$LLVM_VERSION.src.tar.xz"
  as_user tar -C "$BUILD_ROOT" -xf "$BUILD_ROOT/llvm.tar.xz"
  rm -f "$BUILD_ROOT/llvm.tar.xz"
}

# Common cmake flags. `-include cstdint`: LLVM 14 does not compile against GCC 13's libstdc++
# headers without it. gold + 2 link jobs keeps peak RAM bounded.
COMMON=(-G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++
        -DCMAKE_CXX_FLAGS="-include cstdint" -DCMAKE_INSTALL_PREFIX="$LLVM_PREFIX"
        -DLLVM_USE_LINKER=gold -DLLVM_PARALLEL_LINK_JOBS=2 -DLLVM_INCLUDE_TESTS=OFF)

# build_component <name> <source dir> <cmake args...>: configure+build+stage as the user, then
# copy into / without replacing anything that already exists.
build_component() {
  local name=$1 src=$2; shift 2
  local bld=$BUILD_ROOT/build-$name stage=$BUILD_ROOT/build-$name/stage
  log "building $name from source"
  as_user mkdir -p "$bld"
  if as_user cmake -S "$src" -B "$bld" "${COMMON[@]}" "$@" >"$LOG_DIR/$name-configure.log" 2>&1 \
     && as_user ninja -C "$bld" -j "$JOBS" >"$LOG_DIR/$name-build.log" 2>&1 \
     && as_user rm -rf "$stage" \
     && as_user env DESTDIR="$stage" ninja -C "$bld" install >"$LOG_DIR/$name-install.log" 2>&1; then
    (cd "$stage" && find . \( -type f -o -type l \) | sed 's|^\.||' | while read -r f; do
       [ -e "$f" ] || [ -L "$f" ] || echo "$f"; done) >"$LOG_DIR/installed-$name.txt"
    rsync -a --ignore-existing "$stage"/ /
    RESULT[$name]="built from source ($(wc -l <"$LOG_DIR/installed-$name.txt") files added)"
    return 0
  fi
  RESULT[$name]="FAILED (see $LOG_DIR/$name-*.log)"
  return 1
}

if [ "$EXISTING_LLVM" = 0 ]; then
  # No LLVM 14 at all: build the toolchain in-tree (clang, lld, compiler-rt) into /opt/llvm-14.
  fetch_source
  build_component llvm "$SRC/llvm" -DLLVM_TARGETS_TO_BUILD=X86 \
    -DLLVM_ENABLE_PROJECTS="clang;lld;compiler-rt" -DLLVM_ENABLE_RTTI=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INSTALL_UTILS=ON \
    || { echo "LLVM toolchain build failed — required; see $LOG_DIR" >&2; exit 1; }
fi

has_clang && RESULT[clang]="present ($LLVM_PREFIX/bin/clang)" || RESULT[clang]=MISSING
if has_rt; then RESULT[compiler-rt]=present
else apt_missing "libclang-rt-$LLVM_MAJOR-dev" && has_rt && RESULT[compiler-rt]="installed (apt)" || RESULT[compiler-rt]=MISSING
fi

if has_lld; then
  RESULT[lld]="present ($LLVM_PREFIX/bin/ld.lld)"
else
  fetch_source
  # Standalone lld against the existing LLVM: needs its static libs + llvm-tblgen (llvm-N-dev).
  build_component lld "$SRC/lld" -DLLVM_DIR="$LLVM_PREFIX/lib/cmake/llvm" \
    -DLLVM_CONFIG_PATH="$LLVM_PREFIX/bin/llvm-config" -DLLVM_MAIN_SRC_DIR="$SRC/llvm" \
    -DLLVM_TABLEGEN_EXE="$LLVM_PREFIX/bin/llvm-tblgen" \
    || { echo "lld build failed — required for the LTO rebuild; see $LOG_DIR" >&2; exit 1; }
fi

if [ "$SKIP_LLDB" = 1 ]; then
  RESULT[lldb]="skipped (SKIP_LLDB=1)"
elif has_lldb; then
  RESULT[lldb]=present
else
  fetch_source
  # Standalone lldb needs the clang dev package (ClangConfig + static clang libs), swig, libedit.
  apt_missing "libclang-$LLVM_MAJOR-dev" swig libedit-dev libncurses-dev
  PY_EXT=$($PY -c 'import sysconfig; print(sysconfig.get_config_var("EXT_SUFFIX"))')
  # Python 3.12 removed distutils, which LLDB 14 uses to locate its install paths — pass them.
  build_component lldb "$SRC/lldb" -DLLVM_DIR="$LLVM_PREFIX/lib/cmake/llvm" \
    -DClang_DIR="$LLVM_PREFIX/lib/cmake/clang" -DLLVM_MAIN_SRC_DIR="$SRC/llvm" \
    -DLLVM_TABLEGEN_EXE="$LLVM_PREFIX/bin/llvm-tblgen" \
    -DLLDB_ENABLE_PYTHON=ON -DPython3_EXECUTABLE=$PY \
    -DLLDB_PYTHON_RELATIVE_PATH="lib/python$PY_VER/site-packages" \
    -DLLDB_PYTHON_EXE_RELATIVE_PATH=bin/python3 -DLLDB_PYTHON_EXT_SUFFIX="$PY_EXT" \
    -DLLDB_ENABLE_LIBEDIT=ON -DLLDB_ENABLE_CURSES=ON -DLLDB_INCLUDE_TESTS=OFF \
  || { apt_missing "lldb-$LLVM_MAJOR" "python3-lldb-$LLVM_MAJOR" \
       && RESULT[lldb]="${RESULT[lldb]}; fallback: apt lldb-$LLVM_MAJOR"; } || true
fi

# Debian-style versioned names (clang -fuse-ld=lld-14 looks for ld.lld-14 on PATH), only if absent.
for t in ld.lld lldb; do
  if [ -x "$LLVM_PREFIX/bin/$t" ] && [ ! -e "/usr/bin/$t-$LLVM_MAJOR" ]; then
    ln -s "$LLVM_PREFIX/bin/$t" "/usr/bin/$t-$LLVM_MAJOR"; echo "  linked /usr/bin/$t-$LLVM_MAJOR"
  fi
done

# --- summary -----------------------------------------------------------------------------------
log "summary"
for k in apt clang compiler-rt lld lldb; do printf '  %-12s %s\n' "$k" "${RESULT[$k]:-n/a}"; done
for t in clang ld.lld llvm-config llvm-nm lldb; do
  printf '  %-12s ' "$t"
  # `|| true`: under pipefail a tool whose --version output lacks a match must not abort the summary.
  if [ -x "$LLVM_PREFIX/bin/$t" ]; then "$LLVM_PREFIX/bin/$t" --version 2>/dev/null | grep -v '^$' | head -1 || true
  elif command -v "$t-$LLVM_MAJOR" >/dev/null; then "$t-$LLVM_MAJOR" --version 2>/dev/null | head -1 || true
  else echo missing; fi
done
printf '  %-12s %s\n' java "$(java -version 2>&1 | head -1)"
printf '  %-12s %s\n' venv "$($PY -c 'import ensurepip' 2>/dev/null && echo ok || echo missing)"
echo "LLVM prefix: $LLVM_PREFIX   (kanalyzer auto-detects /usr/lib/llvm-14; set install.llvmPrefix otherwise)"
