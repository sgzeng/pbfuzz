# pbfuzz-dsh

**PBFuzz** (the CCS'26 agentic directed fuzzer) as plugins for
[DeepSeek Harness (DSH)](https://deepseek-harness.github.io/deepseek-harness/).
Point the agent at a target repo and a bug (a CVE, a patch, a crash trace, or just `file:line`);
it runs a directed-fuzzing loop until it produces a **verified Proof-of-Vulnerability** — input.

## Quick start

Ubuntu 22.04/24.04 x86-64, Node.js ≥ 22, Python ≥ 3.11 on `PATH` (the plugin picks the first of
`python3`, `python3.15` … `python3.11` that is new enough, so Ubuntu 22.04's default 3.10 is fine
next to an installed `python3.11`/`python3.12`; or set **Settings → pbfuzz → Python interpreter**).

**1. Set up DeepSeek Harness** (skip if you already have it) — follow the
[official docs](https://deepseek-harness.github.io/deepseek-harness/) to install DSH and configure
your DeepSeek API key. Use the DSH version these plugins are verified against (`DSH_VERSION` in
[`HARNESS_COMMIT`](HARNESS_COMMIT)); npm's `latest` can be outside their peer range.

**2. Install pbfuzz from npm**

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add @pbfuzz/dsh-pbfuzz
```

That is all: the package ships the Python engine, its schemas and PyYAML, so there is nothing to
build or `pip install`. Then start DSH with `npx @deepseek-ai/dsh@0.2.0-rc.2 web`.

Optional static analysis (C/C++ reachability; needs an LLVM 14 toolchain, see
[`packages/dsh-kanalyzer`](packages/dsh-kanalyzer)):

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add @pbfuzz/dsh-kanalyzer
```

Every push to `master` is published to npm as `0.1.<commit count>` (tag `latest`) by
[`ci.yml`](.github/workflows/ci.yml), so `add` always installs the current `master`.

### From source

```sh
git clone <this-repo-url> pbfuzz-dsh && cd pbfuzz-dsh
./install.sh
```

That builds the plugins and the Python engine and adds the local build to DSH. Restart
`npx @deepseek-ai/dsh@0.2.0-rc.2 web` and you're done.

| Script | Does |
|---|---|
| `./install.sh` | build + install into DSH (profile `web`; `--profile NAME` to change) |
| `./install.sh --with-kanalyzer` | also the static-analysis plugin and its LLVM 14 toolchain (slow, uses `sudo`) |
| `./build.sh` | build only — no changes to your DSH install |

## Use

Open a session in the target repository and describe the bug in plain language — pbfuzz's skill
triggers automatically:

> There's a bug in `src/http/modules/ngx_http_rewrite_module.c:178` (nginx). Reproduce it as a
> verified PoV.

The agent probes the repo, proposes a campaign (target, build command, oracle) and shows you a
one-screen summary to **Approve** or **Revise**. Once approved it drives PLAN → IMPLEMENT → EXECUTE
→ REFLECT on its own — writing a fuzzing plan, a generator, running it, and reflecting on the
result — until it reports a triggering input or gives up and explains why.

Useful commands inside a session:

| Command | Does |
|---|---|
| `/pbfuzz [notes]` | start a new campaign, with `notes` as the bug report |
| `/pbfuzz run <campaign.yaml>` | headless: load a hand-written, already-confirmed campaign and start PIER with no prompts |
| `/pbfuzz status` | print the current campaign's phase and metrics |
| `/pbfuzz selfcheck` | run the environment self-check (LLVM, tracers, Python) now |

Settings (tracer, budget caps, oracle defaults, which auxiliary analyses are on) live under
**Plugins → @pbfuzz/dsh-pbfuzz → Configure** in the web UI, or under the `pbfuzz` entry's `config:` in
your profile's `cordis.patch.yml`. Three budgets —
`budget.maxPierRounds`, `budget.campaignWallTimeMin`, `budget.maxConsecutiveForcedContinues` — are
the only brake on an unattended run; reaching one stops the campaign for real (`phase: STOPPED`).

Worked examples for C/C++, Python and Java targets are in [`examples/`](examples/); headless runs
on Magma benchmark bugs are in [`examples/magma/`](examples/magma/).

## How it works

- **`@pbfuzz/dsh-pbfuzz`** — the campaign FSM (PLAN → IMPLEMENT → EXECUTE → REFLECT, "PIER"),
  its tools (`pbfuzz_campaign`, `pbfuzz_plan`, `pbfuzz_fuzz`, `pbfuzz_reflect`, …), the state
  guards that keep the model from tampering with engine-owned evidence, and the settings/dashboard
  UI. It runs as a native Cordis plugin — no Claude-Code-style hooks, no compatibility layer.
- **`@pbfuzz/dsh-kanalyzer`** *(optional)* — a general-purpose LLVM static-analysis plugin
  (reachability, call graphs) that `dsh-pbfuzz` consumes when static analysis is turned on.
- **`engine/`** — the Python sidecar that actually runs the target: generates inputs, executes
  them, judges the oracle, and is the sole writer of `metrics.json`. It speaks JSON-RPC over
  stdio and never runs model-written code outside a resource-bounded sandbox.

## Repository layout

```
packages/dsh-pbfuzz/     the pbfuzz plugin: src/, skills/, canaries/, tests/
packages/dsh-kanalyzer/  the static-analysis plugin
engine/                  the Python fuzzing sidecar (pbfuzz_engine/)
contracts/               JSON Schemas shared by both plugins and the engine (pnpm codegen)
examples/                worked targets: C/C++, Python (atheris), Java (Jazzer)
docs/                    DSH upgrade playbook, verification records
```

## Development

```sh
pnpm -r typecheck
pnpm -r test                 # vitest, both packages
pnpm run test:engine         # pytest, the Python engine
pnpm run check:clients       # settings-card ⇔ schema parity, client bundle self-checks
pnpm run codegen:check       # contracts/ generated files are up to date
```

`pnpm run codegen` regenerates the TypeScript/Python types under `contracts/` after any schema
change; commit the generated diff together with the schema.

### DeepSeek Harness compatibility

DSH changes its plugin APIs between releases, so a [weekly workflow](.github/workflows/dsh-compat.yml) checks
pbfuzz against the newest DSH and opens an issue (plus a fix PR, if `ANTHROPIC_API_KEY` is set) when it breaks.
Reproduce or check by hand with `scripts/compat-check.sh [version | --current]`; what changed in 0.2 and how to
fix the next break is in [`docs/dsh-upgrade.md`](docs/dsh-upgrade.md).

## License

[PolyForm Noncommercial License 1.0.0](LICENSE)

## Citation

```bibtex
@misc{zeng2025pbfuzzagenticdirectedfuzzing,
      title={PBFuzz: Agentic Directed Fuzzing for PoV Generation},
      author={Haochen Zeng and Andrew Bao and Jiajun Cheng and Chengyu Song},
      year={2025},
      eprint={2512.04611},
      archivePrefix={arXiv},
      primaryClass={cs.CR},
      url={https://arxiv.org/abs/2512.04611},
}
```
