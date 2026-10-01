# magma

The headless-onboarding example (PLAN.md §2.6, §4 V2): Magma (https://hexhive.epfl.ch/magma/) ships
its own bugs, its own oracle, and its own corpus, so a campaign for it never needs the interactive
questionnaire — `engine/pbfuzz_engine/adapters/magma.py` generates a confirmed
`pbfuzz.campaign.yaml` directly from Magma's own metadata:

- **Oracle.** Every injected bug calls `MAGMA_LOG("<BUG_ID>", <condition>)`
  (`magma/src/canary.h`), and `magma_log()` (`magma/src/canary.c`) unconditionally prints
  `MAGMA: Bug <BUG_ID> reached` to stderr, plus `MAGMA: Bug <BUG_ID> triggered` when the condition
  holds — before it ever touches the shared-memory canary storage that needs Magma's own monitor
  process. `oracle.mode: preexisting` with those two literal strings reuses it exactly; no canary
  insertion, no rebuild.
- **Target location.** `bug.targets` is the target's own `BBtargets.txt` (KAMain's `-target-list`
  input, produced by `magma/fuzzers/pbfuzz/instrument.sh`) verbatim, so kanalyzer's analysis and
  this campaign's target always agree.
- **Static analysis.** When a target has Magma's own pre-built KAMain outputs (or output from a
  previous `kanalyzer_analyze` run), `--prebuilt-dir` sets `analysis.static.mode: prebuilt` — the
  "Magma SKIP_STATIC_ANALYSIS path" `campaign.schema.json` names by name — and no fresh LTO
  rebuild or KAMain run is needed at all.

This directory does not vendor Magma itself, or any target's build output — those are large,
separately-licensed upstream artifacts. `generate-campaign.sh` documents the exact paths a real
Magma checkout needs and produces the campaign yaml from them.

## Running it

Point `MAGMA_ROOT` at a Magma checkout with the target already built — either a fresh native
build (LTO bitcode + the harness binary), or Magma's own pre-built image layout under
`fuzzers/pre-built/<target>/`, which `generate-campaign.sh`'s defaults assume:

```bash
export MAGMA_ROOT=/path/to/magma          # e.g. /mnt/work/pbfuzz/magma
export PBFUZZ_PYTHON=/path/to/pbfuzz-dsh/engine/.venv/bin/python
./generate-campaign.sh                    # TARGET_NAME=lua BUG_ID=LUA001 by default
```

Every `generate-campaign.sh` variable can be overridden individually (`TARGET_NAME`, `BUG_ID`,
`BINARY`, `BBTARGETS`, `PREBUILT_DIR`, `SEEDS_DIR`, `BUG_PATCH`, `OUTPUT`) — see the script for
what each one feeds into the adapter, or run
`python3 -m pbfuzz_engine.adapters.magma --help` to call it directly with full control (e.g. for a
target with no pre-built KAMain output, drop `--prebuilt-dir` and pass `--bitcode`/`--entries`
from a fresh LTO rebuild instead).

The written yaml already has `confirmed: true` — every field traces back to Magma's own,
already-reviewed ground truth (the patch, `BBtargets.txt`, the built binary), so a headless run
needs no interactive step:

```bash
dsh --profile pbfuzz-headless "/pbfuzz run $MAGMA_ROOT/targets/lua/pbfuzz.campaign.yaml"
```

V2 (docs/verification.md) runs exactly this for LUA001 against Magma's pre-built lua image
(`magma/fuzzers/pre-built/lua/clang_bc/lua/lua` — a real, running Lua interpreter with debug info;
`./lua <script.lua>` confirmed by hand first) — this script's defaults match that target.
