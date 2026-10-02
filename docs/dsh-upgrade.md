# Upgrading to a new DeepSeek Harness release

DSH changes its plugin APIs between releases (0.1.x → 0.2 touched settings, jobs, message sources and
the whole web client). This is how pbfuzz keeps up, and what to check when it does not.

## How compatibility is checked

| What | Where |
|---|---|
| The real DSH, newest from npm, booted in-process with both plugins installed; every push and PR | `dsh-tests/`, CI job `dsh-latest` in `.github/workflows/ci.yml`, locally `pnpm run test:dsh` |
| Weekly check against npm's `latest`, opens a `dsh-compat` issue on failure | `.github/workflows/dsh-compat.yml` |
| Claude diagnoses it and opens a fix **PR** (needs `ANTHROPIC_API_KEY`) | `.github/workflows/claude-autofix.yml` |
| The check itself — run it locally to reproduce | `scripts/compat-check.sh [version \| --current]` |
| Re-pin every DSH version in the repo in one go | `node scripts/bump-dsh.mjs [version]` |
| Real `dsh web` + Chromium: UI boots, both settings pages render | `scripts/smoke-web.mjs` |

`compat-check.sh` runs: forced typecheck → unit tests → real-DSH tests → client bundles → build and install into a
scratch DSH profile → web smoke. Add `DEEPSEEK_API_KEY` and run `examples/readelf-c/run.sh` for the
model-driven end-to-end (the weekly job does this when the secret exists).

## Why each layer exists

- **`tsc -b` is incremental** and only compares the *sources*; after a DSH upgrade it reports "up to date"
  while the new typings would fail. `dsh-pbfuzz`'s `typecheck` therefore uses `--force`.
- **Unit tests mock DSH.** They pass against APIs that no longer exist (the 0.2 migration kept 414 tests
  green while `installSection` was gone). `dsh-tests/` is the layer that does not: it runs the real DSH.
- **The web client has no typecheck** (it needs DSH's client packages). A wrong import compiles to a bundle
  and fails in the browser — twice during the 0.2 migration (a removed icon, a deleted `useState` import).
  Only `smoke-web.mjs` sees those.
- **The headless run is the real proof** that PLAN → IMPLEMENT → EXECUTE → REFLECT works end to end.

## The real-DSH tests (`dsh-tests/`)

They answer one question with no mocks: **do the built plugins, installed the way a user installs them, work
inside the newest DSH?**

- `global-setup.ts` installs `@deepseek-ai/dsh` at npm's `latest` (never the lockfile's version; cached under
  `.dsh-real/`, keyed by version), builds and packs both plugins, and runs the real `dsh plugin add` into a scratch
  profile (the packed plugin carries its engine, so the run uses that copy, not the repo's). DSH's own peer-range admission happens there, so a latest DSH outside the plugins' declared range fails
  the run with `would not install ... run node scripts/bump-dsh.mjs <version>`.
- `harness.ts` boots that profile in-process with the same `runProfile()` the `dsh` binary calls. Each spec gets
  its own copy of the DSH home (and `HOME`), so nothing touches the machine's real `~/.dsh`.
- **Only the model is scripted** (`scripted-llm.ts`: a subclass of DSH's real `LlmAdapter` registered with the
  real `ctx.llm`). The agent loop, ToolRuntime and its guard chain, CommandRuntime, user questions, the jobs
  registry, the settings provider and the session log are all DSH's. No API key is read (they are stripped from
  the environment) and nothing leaves the machine except the npm install.

| Spec | What it proves in the real DSH |
|---|---|
| `load.spec.ts` | both plugins mount; every tool, command and skill registers; pbfuzz picks up kanalyzer's service |
| `settings.spec.ts` | an edit via `settings.update` reaches the running plugin and the profile patch; the self-check cache is merged without clobbering other fields |
| `guard.spec.ts` | the guard, DSH's argument validation and the phase gate, state-write and bash-tamper denials, through `tools.execute` |
| `turn.spec.ts` | what the agent loop sends the model, a denial reaching it, the PIER driver's nudge and its headless cap |
| `pier.spec.ts` | a whole round: campaign draft and approval, PLAN, a fuzz session as a DSH job by the real engine, the job's notice waking the agent, REFLECT, SUCCESS |
| `kanalyzer.spec.ts` | kanalyzer's tool and command through DSH's runtimes |

Run it: `pnpm run test:dsh` (needs the network and a `python3` >= 3.11; the plugin ships its own engine, so nothing is pip-installed, exactly as for a user).
`PBFUZZ_DSH_VERSION=<version or dist-tag>` reproduces a failure on another release; `PBFUZZ_DSH_DIR` moves the
install; `PBFUZZ_SKIP_BUILD=1` skips the plugin build when you have just built.

When it goes red on a new DSH: the first lines of the failure name the spec and, for a stuck round, print what
the scripted model was last told (`transcript()`), which is usually enough to see which DSH API moved. Fix the
plugin, not the test. If DSH gained behaviour the plugins now depend on, add a spec for it here.

What it does not cover: the web client (that is `scripts/smoke-web.mjs`), a real model, and the LLVM toolchain.

## What 0.1.5 → 0.2.0 changed, and what we did

| DSH 0.2 | pbfuzz / kanalyzer |
|---|---|
| `settings.installSection()` removed. A plugin's settings are its own Loader entry; only `.volatile()` config fields are editable and arrive as `Volatile<T>` references. Settings live in the profile's `cordis.patch.yml`, not `~/.dsh/settings.yaml` (imported once, then renamed). | Every settings leaf is `.volatile()`; `resolveSettings()` / `resolveConfig()` unwrap the references; `loader/volatile-update` replaces `onChange`; `install.sh` writes `execution.pythonPath` into the profile patch. |
| Settings namespace = Loader entry id | kanalyzer's row id is now `kanalyzer` (was `dsh-kanalyzer`) so it equals its namespace. |
| No shared `{kind: 'plugin'}` message source; each producer declares its own `kind` (`MessageSourceMap`). | `{ kind: 'pbfuzz' }`, `{ kind: 'kanalyzer' }`. |
| `JobSpec.owner` is a `SessionId`; the producer feeds output with `job.append()`; `jobs.onJobDone` is gone → `jobs.events.subscribe()`. | `owner: agent.id`; progress via `append`; the PIER driver subscribes to `settled` events and defers one tick so `dsh-tool-jobs` wakes the owner first. |
| `agent/created` handlers must return `undefined`. | Explicit `return undefined`. |
| cordis `~4.0.4`, schemastery `~3.18.4` are required by DSH itself. | Peer/dev pins raised. |
| Web client: `ctx.settingsScope` → `ctx.configForms`; the Settings page's `settings.plugin.item` slot → the Plugins page's `plugins.row.config` slot (key `<package>#<row id>`, `view: 'summary' \| 'page'`); icons `IconXxx14` → `IconXxxRegular size={14}`. | Cards register under `plugins.row.config`; the collapsible header is gone (the page draws title and crumb). |
| `dsh-code-runtime` no longer exists. | Dropped from the pnpm overrides. |

## When the weekly check fails

1. `scripts/compat-check.sh <version>` — reproduces it and re-pins to that release.
2. Read the new typings and READMEs under `node_modules/@deepseek-ai/*/` (`lib/types/*.d.ts`, `README.md`).
   They are the source of truth; a changelog does not exist.
3. Fix the plugins; do not weaken tests. If the break was invisible to every check, extend a check.
4. `scripts/compat-check.sh --current`, `pnpm run test:engine`, and (with a key) `examples/readelf-c/run.sh`.

## Verified on DSH 0.2.0-rc.2 (2026-10-02)

- `pnpm -r typecheck` (forced), `pnpm -r test` (pbfuzz 419, kanalyzer 242), `check:clients`, `codegen:check`: pass.
- `pnpm run test:engine`: 262 pass; 1 fails — `test_corpus_unreadable_seed_is_skipped_not_fatal`, which cannot hold
  under root (`chmod 000` does not deny root) and predates this work.
- `scripts/compat-check.sh --current`: `COMPAT-OK`. Against an old release (`0.1.5-rc.1`) it fails with
  `COMPAT-FAILED-AT: typecheck (forced)`, so a red result is reachable.
- Web UI: both settings pages render under Plugins → Configure; editing `Max PIER rounds` and saving lands in the
  profile's `cordis.patch.yml` while keeping `pythonPath`; no console errors.
- Headless, real model (`examples/readelf-c/run.sh`, fresh profile from the final `install.sh`, clean workspace):
  `SUCCESS` in PIER round 1, ~70 s, PoC reproduced 3/3 by the engine and by hand (exit 134).

**Not verified:** the campaign *dashboard* on the session page (slot `conversation.session.header.utilities`;
`smoke-web.mjs` does not open a session yet — its one known break, a removed icon, is fixed), a Magma run on 0.2
(the Magma record in `examples/magma/README.md` is from 0.1.5), the kanalyzer toolchain itself (LLVM 14 build and
`/kanalyzer doctor`; only its plugin loading and settings page were exercised), and the two GitHub workflows
(linted with `actionlint`, `compat-check.sh` run locally, but never run on GitHub).
