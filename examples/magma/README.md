# magma

Run pbfuzz headless on [Magma](https://hexhive.epfl.ch/magma/) bugs. Magma ships each bug's
patch, its oracle and a seed corpus, so a campaign needs no interactive onboarding:
`engine/pbfuzz_engine/adapters/magma.py` writes a confirmed campaign yaml straight from Magma's
own files, and `/pbfuzz run` drives PIER unattended.

- **Oracle.** Every injected bug calls `MAGMA_LOG("<BUG_ID>", <condition>)`, and `magma_log()`
  (`magma/src/canary.c`) always prints `MAGMA: Bug <BUG_ID> reached` to stderr, plus
  `MAGMA: Bug <BUG_ID> triggered` when the condition holds — before it touches the shared-memory
  storage that needs Magma's monitor. `oracle.mode: preexisting` with those two strings reuses it
  as is: no canary insertion, no rebuild, no monitor process.
- **Target.** `bug.targets` is the bug's `MAGMA_LOG` call sites (`BBtargets.txt`, the same grep
  `magma/fuzzers/pbfuzz/instrument.sh` feeds KAMain), each with the condition read from the
  patched source.
- **Static analysis** is optional: off by default, or `prebuilt` from existing KAMain output.

These scripts build and run targets **natively, without Docker**. The Docker integration in the
Magma fork (`fuzzers/pbfuzz/`) runs the earlier Cursor-based PBFuzz, not this DSH plugin.

| Script | Does |
|---|---|
| `build-target.sh` | fetch, patch and build one Magma target with canaries and `-g` |
| `generate-campaign.sh` | write a confirmed campaign yaml for one bug of a built target |
| `run-campaign.sh` | run that campaign headless in DSH and print the final state |

## Prerequisites

- Ubuntu 22.04/24.04 x86-64 with `clang`, `make`, `git`, `gdb`, plus the target's own build
  dependencies (`INSTALL_DEPS=1` below runs Magma's preinstall scripts; for lua that is just
  `libreadline-dev`).
- pbfuzz built and installed into DSH's `headless` profile, from the repository root:

  ```bash
  ./build.sh
  ./install.sh --profile headless
  ```

  `install.sh` uses the DSH version pinned in `HARNESS_COMMIT` (`0.1.5-rc.1`). A bare
  `npx @deepseek-ai/dsh` resolves npm's `latest` (`0.2.x`), which is outside the plugin's peer
  range — always run the pinned one.
- A DeepSeek API key in `DEEPSEEK_API_KEY` (the model that drives PIER).
- The Magma fork: `git clone -b pbfuzz https://github.com/R-Fuzz/magma.git`

## Running LUA001

```bash
cd examples/magma
export MAGMA_ROOT=/path/to/magma WORK=$PWD/magma-work

# 1. Build lua with every Magma lua bug patched in (-> $WORK/lua/{repo,out/lua,corpus,patches})
INSTALL_DEPS=1 ./build-target.sh

# 2. Write the campaign (-> $WORK/lua/campaigns/LUA001.campaign.yaml)
./generate-campaign.sh

# 3. Run it headless
DEEPSEEK_API_KEY=... ./run-campaign.sh $WORK/lua/campaigns/LUA001.campaign.yaml
```

Pick another bug or target with `TARGET_NAME` and `BUG_ID` (e.g. `TARGET_NAME=libpng
BUG_ID=PNG001`). Both scripts take overrides for every path; see their headers. For programs with
extra arguments, `generate-campaign.sh` builds `entry.run_cmd` from configrc's `<program>_ARGS`
(e.g. `tiffcp -M @@ tmp.out`), as Magma's own `run.sh` does; `PROGRAM` picks one when a target
has several. libFuzzer-style harnesses are linked with the same file-input `main()`
(`fuzzers/pbfuzz/src/afl_driver.cpp`) Magma's pbfuzz integration uses.

`run-campaign.sh` boots DSH in the campaign's `target.repo` (the agent reads the source from
there) and sends `/pbfuzz run <yaml>`; the plugin loads the campaign and drives PLAN → IMPLEMENT →
EXECUTE → REFLECT until `SUCCESS` or `STOPPED`. Everything lands in `output.dir`
(`$WORK/lua/repo/.pbfuzz/lua-lua001/`): `state/state.json` (phase, and on `SUCCESS` the PoC's
input path and reproduce command), `state/metrics.json` (the engine's own counts), and the
generator and inputs of each round. `pbfuzz.budget.*` in `~/.dsh/settings.yaml`
(`maxPierRounds`, `campaignWallTimeMin`, `maxConsecutiveForcedContinues`) are the only brake on an
unattended run. Re-running the same campaign resumes from its saved phase; delete `output.dir` to
start over.

## Static analysis

The default campaign records static analysis as disabled and uses `deviation.mode: target_only`;
PIER then works from gdb traces alone. To give it kanalyzer's call graph and critical branches:

- **Existing KAMain output** — `PREBUILT_DIR=<dir> ./generate-campaign.sh`, where `<dir>` holds
  one bug's dumps, e.g. the `BBtargets/<BUG_ID>/` directory `fuzzers/pbfuzz/instrument.sh`'s
  `static_analyze` writes (`lua_distance.cfg.txt`, ... — prefixed or plain names both work). No
  LLVM or rebuild is needed. (The fork's README and Dockerfile refer to such outputs under
  `fuzzers/pre-built/`, but that directory is not in the `pbfuzz` branch.)
- **Fresh analysis** — `./install.sh --profile headless --with-kanalyzer` (LLVM 14, sudo), then
  `STATIC_ANALYSIS=1 ./generate-campaign.sh`; kanalyzer builds its own bitcode on first use.

`instrument.sh` lists bug ids that are statically unreachable from the harness (`PNG002`,
`PDF001`, `SSL002`, ...); skip those.

## Verification status (2026-10-02)

Checked on Ubuntu 24.04, clang 18, DSH `0.1.5-rc.1`, R-Fuzz/magma `pbfuzz` @ `a6ec7b91`:

- `build-target.sh` builds lua from scratch; the binary prints the `MAGMA: Bug LUA001 ...`
  markers on the bug path and runs the shipped seeds normally.
- `generate-campaign.sh` output passes the plugin's own campaign validator (the check
  `/pbfuzz run` applies) in both the default and `PREBUILT_DIR` modes.
- In real DSH, the headless profile loads the plugin, `/pbfuzz run` loads the campaign and moves
  it to `PLAN`; re-running resumes cleanly.
- The engine runs Magma's 33 lua seeds against the binary: 2 reach LUA001's site, none trigger.
- **Not run here:** a full PIER round with a model — no `DEEPSEEK_API_KEY` was available, so DSH
  stops at the first model request (`MISSING_CREDENTIAL`). The earlier, pre-rewrite LUA001 run is
  recorded in `docs/verification.md` (V2).
- Other targets use the same scripts, but only lua was built in this pass.
