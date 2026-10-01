# Sourced by build.sh. Makes sure Node >= 22.19, pnpm and Python >= 3.11 are usable.
# Anything missing or too old is installed under <repo>/.local (Node tarball, pyenv, pnpm) and put
# on PATH for this script only — the system's node/python are never replaced and no shell rc is
# edited. `rm -rf .local` undoes it. The only system-level change is `apt-get install` of
# build libraries, and only when pyenv has to compile Python.
LOCAL=$PWD/.local
NODE_MIN_MAJOR=22; NODE_MIN_MINOR=19
PY_WANT=3.11

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "'$1' is required (sudo apt install $2)"; }

node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)'
}

ensure_node() {
  node_ok && return 0
  log "Node.js >= $NODE_MIN_MAJOR.$NODE_MIN_MINOR not found ($(node -v 2>/dev/null || echo none)); installing locally to .local/node"
  need curl curl
  local dir=$LOCAL/node
  if [ ! -x "$dir/bin/node" ]; then
    local base=https://nodejs.org/dist/latest-v22.x tar
    tar=$(curl -fsSL "$base/SHASUMS256.txt" | grep -oE 'node-v[0-9.]+-linux-x64\.tar\.xz' | head -1)
    [ -n "$tar" ] || die "could not resolve a Node 22 download from nodejs.org"
    mkdir -p "$dir"
    curl -fsSL "$base/$tar" | tar -xJ -C "$dir" --strip-components=1
  fi
  export PATH=$dir/bin:$PATH
  node_ok || die "local Node install failed"
}

ensure_pnpm() {
  command -v pnpm >/dev/null && return 0
  log "pnpm not found; installing locally to .local/bin"
  mkdir -p "$LOCAL/bin"
  if command -v corepack >/dev/null; then
    corepack enable --install-directory "$LOCAL/bin"
  else
    npm install --silent --no-audit --no-fund --prefix "$LOCAL/pnpm" pnpm@11
    ln -sf "$LOCAL/pnpm/node_modules/.bin/pnpm" "$LOCAL/bin/pnpm"
  fi
  export PATH=$LOCAL/bin:$PATH
  command -v pnpm >/dev/null || die "local pnpm install failed"
}

py_ok() { command -v "$1" >/dev/null && "$1" -c 'import sys,venv; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; }

ensure_python() {
  PY=${PBFUZZ_PYTHON:-python3}
  py_ok "$PY" && return 0
  # A previous run may already have built one.
  local cand
  for cand in "$LOCAL"/pyenv/versions/$PY_WANT.*/bin/python; do
    [ -x "$cand" ] && py_ok "$cand" && { PY=$cand; return 0; }
  done
  log "Python >= $PY_WANT not found; installing $PY_WANT with pyenv into .local/pyenv (compiles from source, a few minutes)"
  need git git; need curl curl
  local libs=(build-essential libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev
              libffi-dev liblzma-dev libncurses-dev xz-utils) missing=() p
  for p in "${libs[@]}"; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q '^install ok installed' || missing+=("$p")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "  build libraries needed: ${missing[*]}"
    if [ "$(id -u)" -eq 0 ]; then apt-get update -qq && apt-get install -y -qq "${missing[@]}"
    elif sudo -n true 2>/dev/null || [ -t 0 ]; then sudo apt-get update -qq && sudo apt-get install -y -qq "${missing[@]}"
    else die "need sudo to install: ${missing[*]}  (sudo apt install ${missing[*]})"
    fi
  fi
  export PYENV_ROOT=$LOCAL/pyenv
  [ -x "$PYENV_ROOT/bin/pyenv" ] || { rm -rf "$PYENV_ROOT"; git clone -q --depth 1 https://github.com/pyenv/pyenv.git "$PYENV_ROOT"; }
  PYENV_VERSION= "$PYENV_ROOT/bin/pyenv" install -s "$PY_WANT"
  for cand in "$PYENV_ROOT"/versions/$PY_WANT.*/bin/python; do
    [ -x "$cand" ] && py_ok "$cand" && { PY=$cand; return 0; }
  done
  die "pyenv could not build Python $PY_WANT (see output above)"
}
