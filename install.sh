#!/usr/bin/env bash
# Build pbfuzz-dsh and install it into DeepSeek Harness (DSH must already be set up).
#   ./install.sh                    # pbfuzz plugin + Python engine
#   ./install.sh --with-kanalyzer   # also the static-analysis plugin + LLVM toolchain (slow, needs sudo)
#   ./install.sh --profile NAME     # DSH profile to install into (default: web)
set -euo pipefail
cd "$(dirname "$0")"

WITH_KANALYZER=0
PROFILE=web
while [ $# -gt 0 ]; do
  case "$1" in
    --with-kanalyzer) WITH_KANALYZER=1 ;;
    --profile) PROFILE=${2:?--profile needs a value}; shift ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

if [ "$WITH_KANALYZER" = 1 ]; then
  echo "==> LLVM toolchain (sudo)"
  sudo bash scripts/setup-linux.sh
fi

./build.sh

# build.sh may have installed a local Node under .local; use it for npx too.
. scripts/ensure-deps.sh
ensure_node

# Pin the DSH launcher to the version the plugins are verified against: a bare
# `npx @deepseek-ai/dsh` resolves npm `latest`, which can sit outside the plugins' peer range.
DSH_VERSION=$(sed -n 's/^DSH_VERSION=//p' HARNESS_COMMIT)
DSH=(npx --yes "@deepseek-ai/dsh@$DSH_VERSION")
add() { echo "==> dsh plugin add $1"; "${DSH[@]}" plugin --profile "$PROFILE" add "$PWD/$(ls dist/$1-*.tgz)"; }
add pbfuzz-dsh-pbfuzz
[ "$WITH_KANALYZER" = 0 ] || add pbfuzz-dsh-kanalyzer

# The plugin spawns the engine with `execution.pythonPath` (default: system python3, which has no
# engine). Point it at the venv built by build.sh — i.e. the Python that build.sh selected, the
# local pyenv 3.11 when the system one was too old. DSH >= 0.2 keeps plugin settings in the
# profile's own patch layer, so that is where the one key goes (a backup is kept); every other
# setting stays untouched and is edited from the web UI (Settings -> pbfuzz).
VENV_PY=$PWD/engine/.venv/bin/python
"$VENV_PY" -c 'import sys,yaml; sys.exit(sys.version_info < (3, 11))' \
  || { echo "error: engine venv is missing or not Python >= 3.11 with PyYAML; rerun ./build.sh" >&2; exit 1; }
PATCH=${DSH_HOME:-$HOME/.dsh}/profiles/$PROFILE/cordis.patch.yml
[ -f "$PATCH" ] || { echo "error: $PATCH not found - 'dsh plugin add' did not create the profile?" >&2; exit 1; }
cp -p "$PATCH" "$PATCH.pbfuzz-bak"
"$VENV_PY" - "$PATCH" "$VENV_PY" <<'PY'
import sys, yaml
path, py = sys.argv[1:]
text = open(path).read()
header = "".join(line for line in text.splitlines(keepends=True) if line.startswith("#"))
patch = yaml.safe_load(text) or []
entry = next((e for e in patch if isinstance(e, dict) and e.get("id") == "pbfuzz"), None)
if entry is None:
    entry = {"id": "pbfuzz", "name": "@pbfuzz/dsh-pbfuzz"}
    patch.append(entry)
entry.setdefault("config", {}).setdefault("execution", {})["pythonPath"] = py
with open(path, "w") as f:
    f.write(header + yaml.safe_dump(patch, default_flow_style=False, sort_keys=False))
PY
echo "==> pbfuzz.execution.pythonPath = $VENV_PY  (in $PATCH)"

cat <<MSG

Installed into DSH profile '$PROFILE'. Start (or restart) DSH with the same pinned version:

  npx @deepseek-ai/dsh@$DSH_VERSION --profile $PROFILE

Then open a session in your target repo and type:  /pbfuzz <describe the bug>
MSG
