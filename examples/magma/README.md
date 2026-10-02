# magma

Reproduce any [Magma](https://hexhive.epfl.ch/magma/) benchmark bug as an engine-verified PoV,
headless, no interactive setup. Magma already ships each bug's location, oracle and seed corpus,
so `engine/pbfuzz_engine/adapters/magma.py` writes a confirmed campaign straight from Magma's own
files and `/pbfuzz run` drives PIER unattended to `SUCCESS` or `STOPPED`.

**What the agent gets:** the bug's `file:line` and the trigger condition read off Magma's own
`MAGMA_LOG` canary — the same two things a real crash report or CVE advisory gives you. **What it
never gets:** Magma's bug patch (the diff that shows the buggy code next to the fix). It has to
find the triggering input itself — `build-target.sh` deletes the patch from the built tree once
applied, and `run-campaign.sh` (given `MAGMA_ROOT`) also hides it at the source Magma checkout for
the session's duration, so nothing on disk can hand it over even if the agent goes looking.

## Setup (once)

```bash
# from the repo root — pins DSH to HARNESS_COMMIT's version, not npm `latest`
./build.sh && ./install.sh --profile headless
git clone -b pbfuzz https://github.com/R-Fuzz/magma.git /path/to/magma
export DEEPSEEK_API_KEY=...
```

Needs Ubuntu 22.04/24.04 x86-64 with `clang`, `make`, `git`, `gdb`, plus the target's own build
deps (`INSTALL_DEPS=1` below runs Magma's preinstall scripts for you).

## Reproduce any bug

```bash
cd examples/magma
export MAGMA_ROOT=/path/to/magma WORK=$PWD/magma-work
TARGET_NAME=lua BUG_ID=LUA001          # any Magma target/bug id — e.g. TARGET_NAME=libpng BUG_ID=PNG001

INSTALL_DEPS=1 ./build-target.sh       # fetch + patch + build the target natively, canaries on
./generate-campaign.sh                 # confirmed campaign.yaml, from Magma's own ground truth
./run-campaign.sh "$WORK/$TARGET_NAME/campaigns/$BUG_ID.campaign.yaml"   # headless PIER
```

On `SUCCESS`, `state/state.json` (under the campaign's `output.dir`, printed at the end of
`run-campaign.sh`) names the PoC input and the exact command to reproduce it — run that command
and stderr shows `MAGMA: Bug <ID> reached`/`triggered`. `budget.*` under the `pbfuzz` entry of your profile's `cordis.patch.yml` (web UI: Plugins → @pbfuzz/dsh-pbfuzz → Configure)
(`maxPierRounds`, `campaignWallTimeMin`, ...) is the only brake on an unattended run; re-running
the same campaign resumes from its saved phase, and deleting `output.dir` starts over.

| Script | Does |
|---|---|
| `build-target.sh` | fetch, patch and build one Magma target with canaries and `-g` |
| `generate-campaign.sh` | write a confirmed campaign yaml for one bug of a built target |
| `run-campaign.sh` | run that campaign headless in DSH and print the final state |

Both scripts take overrides for every path (`REPO`, `BINARY`, `SEEDS_DIR`, `PROGRAM`, ...) — see
their headers. These build and run targets **natively, without Docker**; the Docker integration
in the Magma fork (`fuzzers/pbfuzz/`) runs the earlier, Cursor-based PBFuzz, not this DSH plugin.

## How this maps to Magma

- **Oracle.** `magma_log()` (`magma/src/canary.c`) always prints `MAGMA: Bug <ID> reached` to
  stderr, plus `triggered` when the bug's condition holds — before touching the shared-memory
  storage that needs Magma's monitor. `oracle.mode: preexisting` reuses those two lines as is.
- **Target.** `bug.targets` is the bug's `MAGMA_LOG` call site(s) (`BBtargets.txt`), each with the
  condition read off the built source at that line — never from the patch.
- **Static analysis** is off by default (PIER runs on gdb traces alone). To add kanalyzer's call
  graph: `PREBUILT_DIR=<KAMain output dir> ./generate-campaign.sh` (no LLVM needed), or
  `./install.sh --profile headless --with-kanalyzer` once, then `STATIC_ANALYSIS=1
  ./generate-campaign.sh`. `instrument.sh` lists bug ids statically unreachable from the harness
  (`PNG002`, `PDF001`, `SSL002`, ...) — skip those.

## Verification status (2026-10-02)

Ubuntu 24.04, clang 18, DSH `0.1.5-rc.1`, R-Fuzz/magma `pbfuzz` @ `a6ec7b91`, real
`DEEPSEEK_API_KEY`, LUA001, with the bug's patch verified absent from disk for the whole session
(`$WORK/lua/patches` deleted, `$MAGMA_ROOT/targets/lua/patches` moved aside and restored after):

- Full headless PIER run: `SUCCESS` in round 1, ~105s wall-clock, 1 fuzz iteration — the agent
  derived the trigger (`debug.getlocal` with an index that integer-overflows to `INT_MIN`) from
  `ldebug.c:197`'s condition alone — it looked for a patch on disk and found none.
- PoC is engine-verified (`metrics.json`'s own `first_triggering_input`, reproduced 3/3), not
  model-claimed. Hand-reproduced: stderr prints `MAGMA: Bug LUA001 reached`/`triggered`, segfaults.
- `pnpm -r test` (414 tests) and `pnpm run test:engine` (262 tests) pass; the one remaining
  failure (`test_corpus_unreadable_seed_is_skipped_not_fatal`) is expected under root (`chmod 000`
  doesn't deny root read access) and pre-existing, not a regression.
- Fixed along the way: (1) `build.sh` built `engine/.venv` without the `dev` extra and
  `test:engine` defaulted to a bare `python3`, so `pnpm run test:engine` failed fresh out of the
  box with no pytest anywhere; (2) the campaign's provenance header named the bug patch's path and
  `build-target.sh` left it sitting next to `repo/`, so an earlier run read it straight away
  instead of reasoning from the location — closed by removing the adapter's `bug_patch` field
  entirely and by the two deletions/hides described above.
