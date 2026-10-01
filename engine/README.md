# pbfuzz-engine

The Python sidecar behind `dsh-pbfuzz`. It speaks newline-delimited JSON-RPC 2.0 on
stdin/stdout (`contracts/engine-rpc.schema.json`); stderr is log only.

```sh
python3 -m venv .venv && .venv/bin/pip install -e 'engine[dev]'   # or: uv pip install -e 'engine[dev]'
.venv/bin/pytest engine/tests
.venv/bin/pbfuzz-engine            # or: python -m pbfuzz_engine
```

Launch forms (all equivalent NDJSON JSON-RPC servers): `pbfuzz-engine`, `python -m pbfuzz_engine`,
and `python3 -m pbfuzz_engine.rpc` — the form the TS bridge uses, with `PYTHONPATH=engine/` and no
install. That uninstalled form needs PyYAML importable by the interpreter
(`execution.pythonPath`).

`trace.run` / `deviation.run` / `selfcheck.tracer` accept the contract's `debuggerPaths`
object; the dispatcher flattens it into the `gdbPath`/`lldbPath`/`pythonPath`/`jdbPath` keys
W3's tracers read.

## Invariants

- **The engine is the only writer of `<output.dir>/state/metrics.json`** (`pbfuzz_engine/metrics.py`).
  Every `fuzz.run` session updates it — including sessions that fail or are cancelled — and
  cumulative counters come from the previous file, never from the caller.
- **Model-written code never runs in the engine process.** Generators and extractors run in
  `python -m pbfuzz_engine._generator_child` under `RLIMIT_AS`/`RLIMIT_CPU`/`RLIMIT_CORE`, in their
  own session, with a wall-clock timeout (`pbfuzz_engine/sandbox.py`).
- **Warning: this sandbox bounds resources only, not access.** The rlimits above correctly cap wall
  time, CPU and address-space size, but `pbfuzz_engine/sandbox.py` does **not** chroot, namespace or
  seccomp-filter the child. A generator or extractor can still read any file the host user can read
  (e.g. `/etc/passwd`), write outside its own output directory, and call `os.system()`/`subprocess`
  with this engine process's full privileges — including any `sudo` or `docker` group membership on
  the host running it. Treat generator/extractor code as *resource-bounded*, not *contained*; do not
  run it against untrusted code without adding real isolation (container, namespace, seccomp) first.
- **Every error carries `data.diagnosis` and non-empty `data.remedies`.**

## Methods

`FuzzRunParams`/`TraceRunParams` and all result shapes come from the contract. The contract does
not pin the params of the other methods; these are the shapes the engine accepts:

| Method | Params | Result |
|---|---|---|
| `ping` | – | `PingResult` |
| `campaign.load` | `{campaignPath}` | `{id, confirmed, language, outputDir, stateDir, inputChannel, runCmd, tracer, targets, corpusEnabled, seedsDir}` |
| `fuzz.run` | `FuzzRunParams`; `runtime` also accepts `generatorMemLimitMB`, `generatorCpuLimitSec`, `stage1MinConcreteParams` | `FuzzRunResult` |
| `fuzz.cancel` | `{}` | `{cancelled}`; the running `fuzz.run` then fails with `-32005` |
| `corpus.analyze` | `{campaignPath, seedsDir?, timeoutSec?, maxSeeds?, routes?}` | `CorpusAnalyzeResult` |
| `params.extract` | `{extractorPath` or `extractorCode, inputs?, seedsDir?, timeoutSec?}` | `{parameter_space, extracted, failed}` |
| `generator.validate` | `{generatorPath, planPath?` or `parameterSpace?, samples?, timeoutSec?}` | `{ok, samples[], unenforcedLimits}` |
| `selfcheck.engine` | `{contractsVersion?}` | one `selfcheck.schema.json` item |
| `selfcheck.oracle` | `{campaignPath, input?, timeoutSec?}` | one `selfcheck.schema.json` item |
| `trace.run`, `deviation.run`, `selfcheck.tracer` | contract | forwarded to W3 (`pbfuzz_engine/tracing.py`) |

Notifications: `progress` (throttled to one per second), `iteration` (stage-1, reaching, triggering
and error iterations), `log` (`{level, message}`).

Error codes: standard JSON-RPC codes plus `-32001` campaign invalid, `-32002` generator failed,
`-32003` target failed, `-32004` oracle failed, `-32005` cancelled, `-32006` not implemented
(W3 module absent), `-32007` corpus empty, `-32008` plan invalid, `-32009` tracer failed,
`-32010` busy.

## On-disk layout (under `output.dir`)

```
state/metrics.json                      engine-written only
runs/session-NNNN/iterations.jsonl      one record per iteration
testcases/round<R>_s<N>_stage<1|2>_iter<I>[_reached|_triggered]
crashes/poc_<same name>                 triggering inputs
```
