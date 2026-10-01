---
name: kanalyzer
description: Static reachability analysis of C/C++ programs with kernel-analyzer (KAMain) through the kanalyzer_* tools — producing analysable LLVM bitcode in an isolated `.kanalyzer/tree/` analysis-tree copy of the repo (wllvm by default, lto as an explicit option), with long builds running as a notified background job, then running target/entry reachability and reading distances, critical branches and the call graph. Use when you need to know whether and how a source line is reachable from an entry point.
---

# kanalyzer

KAMain is an LLVM 10–16 whole-program analysis (14 is the verified version). Given bitcode, a
list of target `file:line` locations and entry functions, it computes which basic blocks can
reach a target, their distance, and the **critical branches** — branches where one side can
still reach the target and the other can only reach an exit.

## Workflow

1. `kanalyzer_prepare` — rebuild the project to get whole-program bitcode (`*.0.0.preopt.bc` in
   `lto` mode; wllvm's `extract-bc` in `wllvm` mode, the default).
2. `kanalyzer_analyze` — targets + (optionally) entries → status, resolved targets, critical branches.
3. `kanalyzer_query` — `callers` / `callees` / `functionAt` / `critical` / `branches` /
   `distances` / `functions` on the same bitcode.

Start analysing immediately. Do **not** open a session with `kanalyzer_doctor`: it compiles and
analyses a sample from scratch, costs the user a minute of waiting, and the settings card's
**Self-test** button and `/kanalyzer doctor` already exist for the operator.

`kanalyzer_doctor` is a *debugging* tool. Call it only when the run itself looks broken — for
example `kanalyzer_prepare` cannot produce bitcode, `kanalyzer_analyze` returns `error`, an
`unreachable`/`no_target` contradicts the source you just read, the bitcode will not load, or the
status says KAMain is missing — or when the user asks for it. In a pbfuzz campaign the self-check
(`pbfuzz_campaign selfcheck`) already runs this same self-test once, so do not repeat it there.

## Hard rules

- **Use the tools, never the binary or the dumps.** KAMain is driven exclusively through the
  `kanalyzer_*` tools. Do not hand-roll the LTO build in bash, invoke the `KAMain` binary, or open
  and hand-join the raw dump files (`distance.cfg.txt`, `critical_BBs.txt`, `bid_loc_mapping.txt`,
  …) yourself — the tools own the caching, the status derivation (the exit code is always 0) and
  the result layout. `kanalyzer_query`'s `branches`, `distances` and `functions` ops answer
  exactly the questions those dumps hold — see "Reading results" — alongside the existing
  `callers` / `callees` / `functionAt` / `critical`. If a `kanalyzer_*` tool cannot answer what you
  need, that is a gap to report to the user, not a licence to read the dump by hand. If the
  `kanalyzer_*` tools are missing from your toolset, stop and tell the user the kanalyzer plugin is
  not loaded for this session; never work around it by driving the underlying binary.
- **Bound filesystem search.** Never run `find /`, and never run `find` or `grep -r` outside the
  session workspace. Use the `glob` tool within the workspace instead.
- **No deliverable files unless the user asks.** The analysis output is the dump files the tools
  deliver to the workspace. Do not write reports, summaries or copies anywhere, and do not call
  `present` — the user asked for an analysis, not a document.
- **Answer briefly, in chat.** Report the status, resolved targets, distances and critical
  branches concisely — no report file. Close with one or two sentences: where the dumps are (the
  `outputDir` the tool returned, by default the current workspace directory, and the file names in
  `dumpFiles`) and what is worth asking next — which way a branch goes, the distance at a line, or
  which functions are reachable (`branches` / `distances` / `functions`).
- **Reachability only.** Constructing trigger inputs or PoV files is pbfuzz's job; do not
  volunteer one here. Do not ask the user questions about how to store or deliver results — the
  default (current directory) is the answer.

## Producing bitcode (`kanalyzer_prepare`)

Parameters: `repo`, `buildCmd`, `cwd`, `mode` (`'wllvm'`, the default, or `'lto'`), `program`
(required in `wllvm` mode — the basename of the linked binary to extract bitcode from), `ltoLibs`,
`env`, `isolate` (boolean, default `true`), `force` (boolean, rebuild from scratch) and `waitSec`
(integer, default `10` — how long to wait before returning a job id instead of a finished result).

A finished result carries `bitcode`, `allBitcode`, `entries`, `nFuncs`, the isolated copy's path
`tree`, `mode`, `profile` (`'analysis'` or `'passthrough'`), any `warnings`, a one-sentence `note`
for the user, `cached` and `jobId`. If the build is still running after `waitSec`, you instead get
`{ jobId, status: 'running', tree, hint }` — see "Long builds" below.

`kanalyzer_prepare` runs your `buildCmd` in a subprocess with an environment it constructs —
`CC`/`CXX` (the analyser's own clang; same LLVM major as KAMain, since bitcode from another major
fails to load), `AR`/`RANLIB`/`NM`/`PATH`, and, in `lto` mode, `-O0 -g -fPIC -flto` appended to
`CFLAGS`/`CXXFLAGS` and `-g -fuse-ld=lld -Wl,-plugin-opt=save-temps` appended to `LDFLAGS`. When
`isolate` is true (the default), a compiler shim backs these up: it's named `clang`/`clang++`/
`cc`/`c++`/`gcc`/`g++` and sits first on the build subprocess's `PATH`, so a build script that
hardcodes `export CC=clang` / `CXX=clang++` / `CFLAGS=...` — overwriting everything `prepare`
injected — is fine, the shim still intercepts it. The one thing the shim can't intercept is an
absolute compiler path, e.g. `CC=/usr/bin/clang`.

These variables are **not visible in your own shell** — they exist only inside the build
subprocess `kanalyzer_prepare` spawns. `echo $CXX` from your own bash tool prints nothing; that's
expected, not a sign the toolchain is missing. Don't burn tool calls chasing it. The build
subprocess inherits the host `PATH` with the analyser's LLVM bin and the shim prepended: if
`which wllvm` works in your own bash, it works in `prepare`. Don't investigate further, and never
read the plugin's own source (`lib/index.js`) to find out.

Concrete recipes:

- Single C++ file: `$CXX $CXXFLAGS foo.cpp -o foo $LDFLAGS`
- Single C file: `$CC $CFLAGS foo.c -o foo $LDFLAGS`
- Autotools/make project: plain `./configure && make` is already correct — these build systems
  pick up `CC`/`CXX`/`CFLAGS`/`CXXFLAGS`/`LDFLAGS` from the environment by convention.

Isolation, in detail:

- With `isolate: true` (the default), `prepare` copies the repo with `rsync` into
  `<repo>/.kanalyzer/tree/` — full the first time, incremental afterwards, the copy itself
  excluded from what it copies, and a `.gitignore` written there — and builds **there** with an
  analysis profile that strips every sanitizer flag and forces `-O0 -g -fPIC`. The user's own
  build tree and binaries are never touched. Always relay the result's `note` in your answer and
  say where `tree` is — the user needs to hear that their tree was left alone.
- Run the user's build script **as-is**, from its own directory — set `cwd` to the directory the
  script lives in. Never copy it, never sed-patch it, and never prepend an `rm -rf` of a directory
  you didn't create: the isolated tree is clean the first time you use it and incremental after
  that; pass `force: true` when you actually want to rebuild from scratch.
- `buildCmd` paths are relative to `cwd`, or absolute paths inside `repo` (`prepare` remaps those
  into the copy for you); an absolute path outside `repo` escapes the isolation, and `prepare`
  reports that as an error.
- The tool sets `MAKEFLAGS=-j<nproc>` and `CMAKE_BUILD_PARALLEL_LEVEL` itself — don't add `-j`
  yourself; pass `env: ['MAKEFLAGS=']` for a Makefile that isn't parallel-safe.

`mode` defaults to `'wllvm'`; pass `mode: 'lto'` as an explicit choice — it's faster per compiled
file and needs no `extract-bc` step, but `wllvm` stays the default because it tolerates build
systems that drop or override `LDFLAGS`. `mode: 'wllvm'` **requires `program`** (the basename of
the linked binary to extract bitcode from) — omitting it fails immediately, before the build runs,
with guidance. In `lto` mode, lld writes `<link-output>.0.0.preopt.bc` next to every link output;
pass `program` too when the build produces several link outputs.

- **Static dependency libraries** (zlib, readline, a vendored lib…) that the program links
  statically must themselves be LTO archives built with the same flags, and listed in
  `ltoLibs`. A native archive links fine and silently removes its functions from the call
  graph — the classic symptom is `unreachable` or a `[WARN] No caller for …` on a function you
  know is called.
- **wllvm** (`mode: "wllvm"`, the default): the compiler is wrapped, bitcode is embedded in each
  object, and `extract-bc` recovers the whole-program module from the binary named by `program`.
  Needs the `wllvm`, `wllvm++` and `extract-bc` executables on `PATH` — if the settings card's
  Self-test goes red for wllvm, its **Install wllvm** button starts an agent that installs them.
- Entries are inferred with `llvm-nm`: `LLVMFuzzerTestOneInput` if defined, else `main`.

### Sanitizer noise

Bitcode built with `-fsanitize=address` turns almost every "critical branch" KAMain finds into an
ASan check trap, not a decision that matters to your target — measured on a real nginx run,
37,634 of 37,678 critical branches (99.9%) were `call @__asan_report_*` guards immediately
followed by `unreachable`. Distances and critical branches computed from such bitcode are
unusable. `prepare` strips sanitizer flags by default (the analysis profile above); the only way
to keep the user's original flags is `isolate: false` — and that also builds in the user's own
tree, so avoid it unless the user specifically asks for it. A result built with `isolate: false`
carries a `warnings` entry about this; relay it.

### Long builds

`prepare` waits up to `waitSec` (default 10s) for the build to finish, then returns
`{ jobId, status: 'running', tree, hint }` if it hasn't. Don't call `prepare` again for the same
tree while it's running — you'll just get the same `jobId` back — and don't busy-poll: DSH wakes
you when the job finishes. While it runs, `job_output` shows progress (objects compiled so far,
the last file, a tail of build output); once it's done, `job_output`'s final line is
`RESULT {...json...}` with the same fields as a finished `prepare` result, or `ERROR ...` on
failure — continue with `kanalyzer_analyze` from there. Calling `prepare` again with identical
arguments after it finished returns the cached result (`cached: true`) in seconds, unless the
sources changed since or you pass `force: true`.

## Choosing targets

- A target must be a line that **carries an instruction**. Comments, blank lines, braces,
  declarations without initializer and function signatures resolve to nothing. KAMain still
  exits 0 — kanalyzer reports `no_target` and gives `unresolved[].nearbyCandidates`; use one.
- Matching is **basename substring + exact line** (`util.c:40` matches `src/util.c` and
  `lib/myutil.c`). If the basename is not unique in the repo, results may mix files; check
  `targets[].location`.
- Code under `#ifdef` branches not compiled, or in functions inlined away… at `-O0` nothing is
  inlined, but macros expand onto the *invocation* line.

## Reading results

| status | meaning | what to do |
|---|---|---|
| `ok` | target resolved and an entry reaches it | use `targets`, `criticalBranches` |
| `no_target` | no line resolved | pick from `nearbyCandidates`; check `-g` |
| `unreachable` | resolved, but no entry reaches it | missing LTO lib, wrong entry, `callStackLen` too small, indirect call not resolved (try `typeBasedCallgraph: true`) |
| `error` | failed/timeout/unloadable bitcode | read `reason` |

Never trust KAMain's exit code yourself — it is 0 in every case above.

- Distances are KAMain's × 1000; 0 is the target block itself; `-1` in the raw distance dump marks blocks that lead to an exit.

### Answering "can line X reach the target?"

Use **`kanalyzer_query op=reach`** with `location` (or `fn`). One call, and it returns the verdict,
the block coverage behind it, and — when there is no distance — the call-graph evidence. Read its
`verdict` as follows, and relay the result's `note`:

| verdict | what it proves | how to say it |
|---|---|---|
| `reaches(d)` | a static path exists | "reaches the target, distance d" |
| `exit_only` | every block is `-1`: leads to a program exit, and the target-backward search did not include it | "only reaches an exit" — strong negative, still depth-bounded |
| `no_distance` | blocks exist, none carries a distance | **"KAMain found no static path"** — never "unreachable" |
| `no_block` | the line owns no instruction after optimisation | says *nothing* about reachability; the answer is for the covering block |

**Absence from the distance table is not unreachability.** KAMain assigns a distance only along the
edges its own bounded pass follows: it skips indirect call sites with more than 50 type-compatible
candidates (nginx's `rc = ph->handler(r)` phase dispatch is one, so the real caller of a phase
handler has no distance at all), never propagates through return edges (a helper called from the
target's own loop gets nothing), stops at `callStackLen` hops, and lists a function's type-based
callers only when it has no direct one. An empty `distances` result is one of those cases at least
as often as it is a genuine dead end — say what the evidence shows and name the limitation.

Two more traps the ops now flag for you: `functionAt` falls back to `function_info`'s line spans,
which are a min/max over every block *including inlined callees*, so several functions can appear
to "contain" one line; and `callers`/`callees` are a type-compatible superset, never a path proof.
- `kanalyzer_analyze`'s `criticalBranches` in the tool result is capped at 150 entries, nearest
  the target first, alongside `criticalBranchesTotal` / `criticalBranchesShown` /
  `criticalBranchesUnresolved` / `criticalBranchesTruncated` counters; when it's truncated, use
  `kanalyzer_query`'s `branches`, `distances` or `critical` ops for the rest.
- `outputDir` holds the raw dumps: `distance.cfg.txt` (`bid,hash,file:line,dist` + `fun:` list),
  `policy.txt`, `critical_BBs.txt`, `bid_loc_mapping.txt` (absolute paths), `function_info.txt`,
  `caller-callee.txt` / `callee-caller.txt` (64-bit GUIDs; map via function_info). Dump order is
  meaningless; the tools sort. `kanalyzer_analyze` delivers them to the current workspace
  directory by default — the result's `outputDir` names the exact directory and `dumpFiles`
  lists exactly which dump files are in it.
- `kanalyzer_query`'s `branches` (args `{ bitcode, fn? }`), `distances` (args
  `{ bitcode, fn?, file?, limit? }`) and `functions` (args `{ bitcode, limit? }`) ops read these
  same dumps for you: `branches` gives each critical branch's function and `file:line`, which
  successor still reaches the target and at what distance, and which successor only reaches an
  exit; `distances` gives the per-basic-block distance-to-target table, nearest the target first;
  `functions` gives every reached function with its minimum distance to the target. All three read
  the dumps of the most recent targeted `kanalyzer_analyze` of that bitcode, exactly like
  `critical`, and cap at 500 rows by default — 200 for `distances`, whose rows are long —
  (`truncated: true` when more exist; pass `limit` to raise it). On a large program, narrow with
  `fn` or `file` rather than pulling the whole table. When one of them comes back empty, the result
  carries a `note` and (for a narrowed query) a `coverage` count saying which of the cases above it
  is; quote that rather than concluding unreachability.
- There is **no CFG edge dump**: only the function-level call graph, block locations, critical
  blocks and distances.

## Cost

Large projects (openssl, php) take tens of minutes and write multi-GB dumps. Analyses run as
background jobs with a timeout and memory limit, and are cached on
`sha256(bitcode + KAMain commit + options)`; pass `force: true` only when you mean to re-run.
