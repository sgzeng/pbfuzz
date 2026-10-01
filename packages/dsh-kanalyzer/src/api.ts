/**
 * The `ctx.kanalyzer` service interface, mirroring `contracts/kanalyzer-api.ts`.
 *
 * The contract file is frozen and lives outside this package's `rootDir`, so it cannot be
 * re-exported from published sources. This module restates it verbatim and
 * `tests/contract-parity.spec.ts` asserts, at type level and in both directions, that the two
 * stay assignable — a drift fails the test run rather than the next integration.
 *
 * Nothing here knows anything about pbfuzz: kanalyzer is a general-purpose LLVM
 * static-analysis plugin.
 *
 * @module @pbfuzz/dsh-kanalyzer/api
 */

/** Whether KAMain is present and usable right now. */
export interface KanalyzerStatus {
  installed: boolean
  /** Absolute path to the built `KAMain`, when installed. */
  binaryPath?: string
  /** Commit of the kernel-analyzer checkout the binary was built from. */
  commit?: string
  /** LLVM version the binary links against; bitcode must come from the same major version. */
  llvmVersion?: string
}

/** Result of a real end-to-end check against the bundled self-test sample. */
export interface KanalyzerDoctor {
  ok: boolean
  status: KanalyzerStatus
  /** What was run and what came back — the evidence that this was not a mere presence check. */
  evidence: string[]
  /** Actionable diagnosis when `ok` is false. */
  reason?: string
}

/** How a project's bitcode is produced. */
export type PrepareMode =
  /** Rebuild with `-flto` + `-fuse-ld=lld -Wl,-plugin-opt=save-temps`, then collect `*.0.0.preopt.bc`. */
  | 'lto'
  /** Fallback for build systems that drop LDFLAGS: wrap the compiler with wllvm and extract. */
  | 'wllvm'

/** Inputs for producing analysable bitcode from a source checkout. */
export interface PrepareRequest {
  /** Absolute path to the project checkout. */
  repo: string
  /** The build command to run under the instrumented toolchain. */
  buildCmd: string
  /** Directory to run `buildCmd` in; defaults to `repo`. */
  cwd?: string
  /** Link output of interest (basename). When omitted every produced bitcode is reported. */
  program?: string
  /**
   * How bitcode is produced. Optional: when omitted the host uses the deployment default
   * (`kanalyzer.defaults.prepareMode`, itself defaulting to `wllvm`, which copes with build
   * systems that drop or override `LDFLAGS`). `wllvm` requires {@link program}.
   */
  mode?: PrepareMode
  /**
   * Static dependency libraries that must also be LTO-built. Omitting one that the target
   * links statically silently truncates the call graph, which is why this is explicit.
   */
  ltoLibs?: string[]
  /** Extra environment for the build. */
  env?: Record<string, string>
}

export interface PrepareResult {
  /** Absolute path to the selected `*.0.0.preopt.bc`. */
  bitcode: string
  /** Every bitcode file the build produced, when several link outputs exist. */
  allBitcode: string[]
  /**
   * Entry symbols found in the bitcode, in the order KAMain should prefer them:
   * `LLVMFuzzerTestOneInput` when present, otherwise `main`.
   */
  entries: string[]
  nFuncs: number
}

/**
 * What `prepare()` reports **beyond** the frozen contract: where it built, with which flags, and
 * what the caller must tell the user.
 *
 * Deliberately not part of `PrepareResult` in `contracts/kanalyzer-api.ts`, which
 * `tests/contract-parity.spec.ts` pins verbatim in both directions. A consumer that only knows
 * the contract (pbfuzz's analysis provider) keeps compiling and behaving exactly as before;
 * a tool caller that wants to say "your own build tree was not touched" reads these.
 */
export interface PrepareResultExtras {
  /** The isolated copy the analysis build ran in; absent when the caller opted out of isolation. */
  tree?: string
  /** The mode actually used, after the deployment default was applied. */
  mode: PrepareMode
  /** `analysis` = sanitizers stripped and `-O0 -g -fPIC` forced; `passthrough` = the project's own flags. */
  profile: 'analysis' | 'passthrough'
  /** Things the caller must relay to the user — e.g. that an in-tree build kept its sanitizers. */
  warnings: string[]
  /** One sentence for the user: where the bitcode came from, and what was left untouched. */
  note: string
  /** True when an unchanged tree let this call reuse the previous build's bitcode. */
  cached: boolean
  /** The DSH job this prepare ran as, when a job registry was available. */
  jobId?: string
}

/** Everything `KanalyzerRuntime.prepare()` returns: the frozen contract plus {@link PrepareResultExtras}. */
export type PreparedBitcode = PrepareResult & PrepareResultExtras

/** Which KAMain dumps an analysis should produce. */
export interface DumpSelection {
  policy?: boolean
  distance?: boolean
  criticalBranch?: boolean
  /** `-dump-bid-mapping` + `-dump-func-info`; KAMain writes these only as a pair. */
  bidMappingAndFuncInfo?: boolean
  /** `-dump-caller-callee` + `-dump-callee-caller`; likewise a pair. */
  callerCalleeBothWays?: boolean
  annotatedIr?: boolean
}

export interface AnalyzeRequest {
  bitcode: string
  /**
   * Target locations as `file:line`. The line must carry an instruction — a comment or a
   * declaration resolves to nothing and KAMain reports it by finding no target, not by failing.
   */
  targets: string[]
  entries?: string[]
  callStackLen?: number
  /** true = signature-based call graph, false = TyPM/MLTA. */
  typeBasedCallgraph?: boolean
  dumps?: DumpSelection
  timeoutSec?: number
  /** Skip the cache and re-run. */
  force?: boolean
  /**
   * Directory the raw dump files are delivered to once the analysis settles (ok, no_target or
   * unreachable). KAMain still runs inside the cache directory — the dumps are copied out so the
   * caller owns a stable copy in a place the user knows. When omitted, the result files stay in
   * the cache directory and `AnalyzeResult.outputDir` names it. The `kanalyzer_analyze` tool
   * defaults this to the calling session's workspace (current directory).
   */
  outputDir?: string
}

/**
 * Outcome of one analysis. KAMain exits 0 in every one of these cases, so this status is
 * derived by parsing verbose stderr AND inspecting the produced outputs — never from the
 * exit code alone.
 */
export type AnalyzeStatus =
  /** Targets resolved and at least one is reachable from an entry. */
  | 'ok'
  /** No target location resolved to a basic block (usually a line with no instruction). */
  | 'no_target'
  /** Targets resolved but no entry reaches them in the call graph. */
  | 'unreachable'
  /** KAMain failed, timed out, or produced unparsable output. */
  | 'error'

/** A basic block KAMain resolved for a requested target. */
export interface ResolvedTarget {
  requested: string
  function: string
  /** Source location KAMain attributes to the block. */
  location: string
  distance: number
}

/** A branch whose outcome decides whether the target stays reachable. */
export interface CriticalBranch {
  function: string
  location: string
  /** Distance to the target from the reaching side of this branch. */
  distance: number
}

export interface AnalyzeResult {
  status: AnalyzeStatus
  /** Empty when `status` is not `ok`; `reason` then says what went wrong and what to try. */
  targets: ResolvedTarget[]
  criticalBranches: CriticalBranch[]
  reachableFunctions: number
  totalFunctions: number
  entriesUsed: string[]
  /** Directory holding the raw KAMain dumps, for callers that want the text outputs. */
  outputDir: string
  /**
   * The dump files actually present in {@link outputDir}, in this plugin's canonical names —
   * exactly what the caller can read there. Empty when the analysis failed or produced no dumps.
   */
  dumpFiles: string[]
  elapsedMs: number
  cached: boolean
  reason?: string
  /** Requested target lines that resolved to nothing, with nearby instruction-bearing lines to try. */
  unresolved?: { requested: string; nearbyCandidates: string[] }[]
  /**
   * Things about this analysis a caller would otherwise have to infer — above all a bitcode built
   * with sanitizers, where most "critical branches" and most `-1` blocks are the sanitizer's own
   * check-and-abort stubs rather than anything in the program.
   */
  notes?: string[]
}

/**
 * A call-graph / location / distance query against an already-analysed bitcode.
 *
 * Every op reads the dumps of the most recent targeted analysis of that same bitcode, so a
 * `kanalyzer_analyze` with real targets has to have run first; without one the distance-bearing ops
 * answer empty rather than erroring, exactly as `critical` already does.
 *
 * `branches`, `distances` and `functions` exist so that no caller ever has to open a dump file to
 * answer an ordinary reachability question. They are deliberately pull-based rather than folded
 * into {@link AnalyzeResult}: a per-block table is unbounded in program size, and making every
 * analysis carry one would put thousands of rows into a model's context whether or not anyone asked.
 */
export type QueryRequest =
  | { op: 'callers'; bitcode: string; fn: string }
  | { op: 'callees'; bitcode: string; fn: string }
  | { op: 'functionAt'; bitcode: string; location: string }
  | { op: 'critical'; bitcode: string; fn?: string }
  /**
   * Every branch with its polarity — which way still reaches the target, and how near. One row per
   * branch: the branch's own location, then each successor's location and its distance, with
   * `exit` standing in for a side that can only reach an exit, and a `[critical]` marker when that
   * is the case. This is the actionable form of `critical`, which names the branch blocks but not
   * which direction to steer; it also covers the branches KAMain does not call critical because
   * both sides can still reach the target, which is where the interesting predicates usually are.
   */
  | { op: 'branches'; bitcode: string; fn?: string; limit?: number }
  /**
   * The per-basic-block distance-to-target table, nearest the target first. Narrow with `fn`
   * and/or `file` on a large program instead of pulling everything.
   */
  | { op: 'distances'; bitcode: string; fn?: string; file?: string; limit?: number }
  /** Every function the analysis reached, with its own nearest block's distance to the target. */
  | { op: 'functions'; bitcode: string; limit?: number }
  /**
   * Whether one source line (or function) reaches the target, answered in one call with the
   * evidence and — decisively — with the difference between the three things a distance table can
   * say. KAMain records a distance only for the blocks its own bounded backward search assigned
   * one; a block it never assigned one is simply **not in the table**, which is not the same as a
   * block it marked as leading to an exit, and neither is a proof that the code cannot run before
   * the target. See {@link ReachVerdict}.
   */
  | { op: 'reach'; bitcode: string; location?: string; fn?: string }

/**
 * What the distance table says about a block or function, and what that does (not) prove.
 *
 * - `reaches` — KAMain computed a distance: a static path to the target exists. Positive evidence.
 * - `exit_only` — every block is marked `-1`: KAMain's exit-seeded search found it leads to a
 *   program exit (`unreachable`, a `noreturn` call — most often a sanitizer's own abort stub) and
 *   its target-backward search did not include it. Strong negative evidence, still bounded by the
 *   call-depth limit.
 * - `no_distance` — blocks exist but none carries a distance. **Not** a proof of unreachability:
 *   KAMain skips indirect call sites with more than 50 type-compatible candidates, never propagates
 *   distance through return edges, stops at `call-stack-len` hops, and lists a function's
 *   type-based callers only when it has no direct ones. nginx's own phase engine
 *   (`rc = ph->handler(r)`) lands in exactly this category while really calling the target.
 * - `no_block` — no basic block maps to that line at all: the line owns no instruction of its own
 *   after optimisation (a declaration, a brace, a `return` merged into a shared block). Says
 *   nothing whatever about reachability; `location` names the block that actually covers the line.
 */
export type ReachVerdict = 'reaches' | 'exit_only' | 'no_distance' | 'no_block'

/** How much of a function the distance table covers — the counts behind a {@link ReachVerdict}. */
export interface ReachCoverage {
  /** Basic blocks the block mapping has for the function. */
  blocks: number
  /** …of those, blocks with a distance ≥ 0. */
  withDistance: number
  /** …blocks marked `-1` (lead to an exit). */
  exitOnly: number
  /** …blocks the distance dump does not mention at all. */
  absent: number
  /** The nearest distance among `withDistance`, absent when there is none. */
  nearest?: number
  /** Whether the function appears in the distance dump's trailing `fun:` list. */
  inFunList: boolean
}

/** One `reach` answer: a function, its verdict, and the evidence for it. */
export interface ReachAnswer {
  function: string
  verdict: ReachVerdict
  /** The block the queried line resolved to, when the question was a location. */
  location?: string
  /** False when the requested line owns no block and `location` is the block covering it instead. */
  exact?: boolean
  coverage: ReachCoverage
  /**
   * Call-graph evidence, independent of the distance table: how this function relates to the
   * target's own function in KAMain's caller/callee dumps (itself a type-based over-approximation
   * when a function has no direct edges). Present when it says something — e.g. a caller path
   * KAMain's distance propagation did not follow, or that the function is called from code that
   * does reach the target and therefore returns into it.
   */
  callPath?: string[]
  callNote?: string
}

export interface QueryResult {
  op: QueryRequest['op']
  /**
   * Function names, or locations for `functionAt`/`critical`. The distance-bearing ops format one
   * row per line, nearest the target first: `function@file:line=distance` for `distances`,
   * `function=distance` for `functions`, and
   * `function@file:line -> target file:line=distance | exit file:line` for `branches`. Otherwise
   * sorted, because KAMain's output order is not stable.
   */
  results: string[]
  /** Whether rows were dropped to stay within the request's `limit` (default 500). */
  truncated: boolean
  /**
   * What an empty or surprising result means, when it means something a caller would otherwise
   * guess wrong. Set above all when a distance op answers nothing: absence from KAMain's distance
   * table is not a proof that the code cannot reach the target (see {@link ReachVerdict}).
   */
  note?: string
  /** `reach`'s structured answer — one entry per function the location resolved to. */
  answers?: ReachAnswer[]
  /**
   * Block coverage for the `fn`/`file` a distance op was narrowed to, so an empty `results` can be
   * read as what it is: no distance recorded, blocks marked exit-only, or no blocks at all.
   */
  coverage?: ReachCoverage
}

/** A KAMain dump kind, keyed like the core `DUMP_FILES` map. */
export type DumpKind = 'policy' | 'distance' | 'criticalBranch' | 'bidMapping' | 'funcInfo' | 'callerCallee' | 'calleeCaller'

/** For each dump kind, the file that carries it — as named inside the imported directory. */
export type DumpFiles = Partial<Record<DumpKind, string>>

/** Inputs for importing a directory of existing KAMain text dumps instead of running the analysis. */
export interface PrebuiltImportRequest {
  /**
   * Directory holding KAMain's text outputs. Both this plugin's canonical names
   * (`distance.cfg.txt`) and a link-output-prefixed set (`lua_distance.cfg.txt`, Magma's
   * `BBtargets/<BUG>/` layout) resolve.
   */
  dir: string
  /** Target locations as `file:line`, resolved against the imported distance dump. */
  targets?: string[]
  /** The link output whose prefixed dump set to prefer when the directory holds more than one. */
  program?: string
  /** Repo root, so imported paths are remapped to repo-relative ones exactly as after a live run. */
  repo?: string
}

/** What an import found, plus the handle later queries take. */
export interface PrebuiltImportResult extends AnalyzeResult {
  /** Pass this to `query()` in place of a bitcode path; it names the imported directory. */
  handle: string
  /** The file each dump kind resolved to, as named inside the imported directory. */
  files: DumpFiles
}

/**
 * The prebuilt-import extension the host runtime implements *in addition to* {@link KanalyzerService}.
 *
 * It is deliberately not a member of that interface: `contracts/kanalyzer-api.ts` is frozen and
 * shared, `tests/contract-parity.spec.ts` asserts the two are exactly the same type, and a
 * capability that only a host able to read an existing dump directory provides does not belong in
 * every consumer's view of the service. Consumers detect it structurally.
 */
export interface PrebuiltImporter {
  /**
   * Register a directory of existing KAMain text dumps as if a live analysis had produced it —
   * without invoking KAMain. Results are then queried through `query()` with the returned handle.
   */
  importPrebuilt(request: PrebuiltImportRequest): Promise<PrebuiltImportResult>
}

/**
 * The service published at `ctx.kanalyzer`. Presence of this service is what a consumer
 * detects to decide whether static analysis is available at all.
 */
export interface KanalyzerService {
  status(): Promise<KanalyzerStatus>
  /** Run the real self-test sample end to end. Never a mere `which KAMain`. */
  doctor(): Promise<KanalyzerDoctor>
  /** Long-running; runs as a DSH job. */
  prepare(request: PrepareRequest): Promise<PrepareResult>
  /** Long-running; runs as a DSH job. Results are cached on `sha(bitcode + KAMain commit + options)`. */
  analyze(request: AnalyzeRequest): Promise<AnalyzeResult>
  /** Analyse with an empty target list to build the function info and call graph only. */
  index(bitcode: string): Promise<AnalyzeResult>
  query(request: QueryRequest): Promise<QueryResult>
}
