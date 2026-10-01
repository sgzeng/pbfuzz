/**
 * TypeScript face of the frozen `contracts/` schemas, mirrored into this package.
 *
 * `contracts/` is the source of truth and this file must never diverge from it. Two of the
 * contracts are plain `.ts` (`analysis-provider.ts`, `kanalyzer-api.ts`) and therefore are NOT
 * covered by `scripts/codegen.mjs`, which only reads `*.schema.json`; a package outside
 * `contracts/` cannot import them without reaching across its own `rootDir`. So the interfaces
 * are restated here verbatim, and the JSON-schema-derived shapes are restated only as far as the
 * host half actually consumes them. Once `pnpm codegen` has been run and
 * `src/generated/contracts.ts` is committed, the schema-derived half of this module should be
 * replaced by re-exports from it (see the integration note in the W1 report).
 *
 * @module @pbfuzz/dsh-pbfuzz/core/contracts
 */

/** Source location as `file:line`. `common.schema.json#/$defs/Location`. */
export type Location = string

/** Where a campaign value came from. `common.schema.json#/$defs/ValueSource`. */
export type ValueSource = 'user' | 'inferred' | 'default' | 'agent_built'

/** Per-field record of how a campaign value was decided, keyed by dotted field path. */
export interface ProvenanceEntry {
  source: ValueSource
  /** The concrete observation behind the value, not a restatement of the value. */
  evidence?: string
  /** True once the user explicitly approved this inferred value. */
  confirmed?: boolean
}

/** `common.schema.json#/$defs/Provenance`. */
export type Provenance = Record<string, ProvenanceEntry>

/** One dimension of the generator's parameter space. `common.schema.json#/$defs/ParameterSpec`. */
export type ParameterSpec =
  | { type: 'int_range'; min: number; max: number }
  | { type: 'float_range'; min: number; max: number }
  | { type: 'categorical'; values: unknown[] }
  | { type: 'bool' }
  | { type: 'base_seed'; seed_file_path: string }
  | {
    type: 'segments'
    count_range: { min: number; max: number }
    segment_params: Record<string, ParameterSpec>
  }

/** Named parameter dimensions keyed by the generator's keyword arguments. */
export type ParameterSpace = Record<string, ParameterSpec>

/** `common.schema.json#/$defs/Breakpoint`. */
export interface Breakpoint {
  location: Location
  hit_limit?: number
  inline_expr?: string[]
  print_call_stack?: boolean
}

/** Target-project language. Drives tracer selection and provider applicability. */
export type CampaignLanguage = 'c' | 'cpp' | 'python' | 'java' | 'other'

/** Which form of bug information the user supplied (questionnaire step S2). */
export type BugKind = 'trigger_condition' | 'patch' | 'cve' | 'crash_trace'

/** Breakpoint tracer selection. `auto` picks by `target.language`. */
export type TracerKind = 'auto' | 'gdb' | 'lldb' | 'pymon' | 'jdb' | 'off'

/** One target location plus the predicate that must hold there. */
export interface CampaignTargetLocation {
  location: Location
  condition?: string
}

/** `campaign.schema.json` — the target-project facts one run needs. */
export interface PbfuzzCampaign {
  version: 1
  id: string
  confirmed?: boolean
  target: { repo: string; language?: CampaignLanguage }
  bug: { targets: CampaignTargetLocation[] }
  /** How to build the target. `dir` defaults to `target.repo`. */
  build?: { cmd?: string; dir?: string }
  entry: {
    kind: 'api' | 'executable'
    harness?: string
    harness_function?: string
    run_cmd: string
    input_channel: 'file' | 'stdin'
    cwd?: string
    env?: Record<string, string>
  }
  oracle: {
    mode: 'canary' | 'preexisting'
    reached_pattern: string
    triggered_pattern: string
    canary_on_trigger?: 'abort' | 'log'
    canary_patch?: string
  }
  /** Absent means `tools.tracer` from settings. */
  tracer?: TracerKind
  analysis?: {
    static?: {
      enabled?: boolean
      disabled_reason?: string
      mode?: 'lto' | 'wllvm' | 'prebuilt'
      program?: string
      bitcode?: string
      entries?: string[]
      lto_libs?: string[]
      prebuilt_dir?: string
    }
    corpus?: { enabled?: boolean; disabled_reason?: string; seeds_dir?: string }
    deviation?: { enabled?: boolean; disabled_reason?: string; mode?: 'critical_bb' | 'target_only' }
  }
  /** Always set in memory; on disk it is omitted when it is the directory holding the file. */
  output: { dir: string }
}

/** The PIER cursor. `state/state.schema.json`. */
export type PbfuzzPhase = 'INIT' | 'PLAN' | 'IMPLEMENT' | 'EXECUTE' | 'REFLECT' | 'SUCCESS' | 'STOPPED'

/** `.pbfuzz/<id>/state/state.json`. */
export interface PbfuzzState {
  campaign_id: string
  phase: PbfuzzPhase
  status: string
  current_task: string
  next_action: string
  pier_round: number
  started_at?: string
  updated_at?: string
  poc?: {
    input_path?: string
    parameters?: Record<string, unknown>
    reproduced_times?: number
    run_cmd?: string
  }
  stop_reason?: string
}

/** `.pbfuzz/<id>/state/metrics.json`, written only by the Python engine. */
export interface PbfuzzMetrics {
  campaign_id?: string
  pier_round?: number
  total_iterations: number
  total_reached_count: number
  triggered_count: number
  last_reached_count?: number
  timeout_count?: number
  error_count?: number
  last_session?: {
    iterations?: number
    reached?: number
    triggered?: number
    timeouts?: number
    errors?: number
    elapsed_sec?: number
    stopped_by?: 'completed' | 'timeout' | 'trigger' | 'error' | 'cancelled'
    first_triggering_input?: string
    best_reaching_input?: string
    reproduced_times?: number
    reproduced_ok?: number
  }
  last_updated?: string
}

/** What choosing a remedy option does. */
export type RemedyEffect = 'retry' | 'edit_campaign' | 'disable_tool' | 'run_command' | 'manual'

/**
 * One concrete option offered to the user when a step failed. Failure recovery is a first-class
 * step everywhere in the pipeline: the agent diagnoses, then offers choices.
 */
export interface Remedy {
  id: string
  label: string
  detail?: string
  effect?: RemedyEffect
}

/** Which auxiliary tool a self-check item covers. */
export type SelfcheckItemName = 'engine' | 'oracle' | 'static_analysis' | 'corpus' | 'tracer' | 'deviation'

/** `warn` and `disabled` pass the INIT gate; only `fail` blocks it. */
export type SelfcheckStatus = 'pass' | 'warn' | 'fail' | 'disabled' | 'skipped'

/** One self-check item: what was really run against this target, and what came back. */
export interface SelfcheckItem {
  name: SelfcheckItemName
  status: SelfcheckStatus
  /** The command line, the parsed result, the counts — the proof the check was real. */
  evidence?: string[]
  reason?: string
  remedies?: Remedy[]
  duration_ms?: number
}

/** `pbfuzz-settings.schema.json` — pbfuzz's OWN behaviour, never the target project's. */
export interface PbfuzzSettings {
  tools: {
    staticAnalysis: 'off' | 'kanalyzer'
    corpusAnalysis: boolean
    deviationDetection: boolean
    tracer: TracerKind
    interactiveDebug: boolean
  }
  budget: {
    maxPierRounds: number
    campaignWallTimeMin: number
    autoContinue: boolean
    maxConsecutiveForcedContinues: number
  }
  fuzzing: {
    maxIters: number
    execTimeoutSec: number
    fuzzTimeoutSec: number
    generatorTimeoutSec: number
    stage1MinConcreteParams: number
    enableDebuggerForAll: boolean
  }
  onboarding: {
    interviewPolicy: 'always' | 'when-missing' | 'never'
    deriveTargetFrom: ('patch' | 'cve' | 'crashTrace')[]
    defaultOutputRoot: string
    confirmTimeoutMin: number
  }
  oracleDefaults: {
    canaryOnTrigger: 'abort' | 'log'
    reachedPattern: string
    triggeredPattern: string
  }
  execution: {
    pythonPath: string
    gdbPath: string
    generatorMemLimitMB: number
    generatorCpuLimitSec: number
    logLevel: 'error' | 'warn' | 'info' | 'debug'
    fuzzBackground: boolean
  }
  guards: {
    bashGuard: boolean
    tamperLedger: boolean
    hideToolsWithoutCampaign: boolean
  }
  status: {
    envSelfcheck?: {
      checkedAt?: string
      ttlExpiresAt?: string
      overall?: '' | 'pass' | 'warn' | 'fail'
      items?: { name: string; status: SelfcheckStatus; reason?: string }[]
    }
  }
}

/* -------------------------------------------------------------------------- */
/* contracts/analysis-provider.ts — restated verbatim (not covered by codegen). */
/* -------------------------------------------------------------------------- */

/** What a provider can do, so pbfuzz can decide which tools to expose and how to degrade. */
export interface ProviderCapabilities {
  /** Stable provider id, e.g. `kanalyzer`. Recorded in `campaign.analysis.static.provider`. */
  id: string
  displayName: string
  languages: CampaignLanguage[]
  /** Whether `criticalLocations` is meaningful; deviation degrades to target-only without it. */
  criticalLocations: boolean
  callGraph: boolean
  requiresPrepare: boolean
}

/** A source location this provider reports, normalised to the target repo's paths. */
export interface ProviderLocation {
  location: string
  function?: string
  distance?: number
}

/** Outcome of bringing the target into an analysable state. */
export interface PrepareOutcome {
  ok: boolean
  /** Provider-specific handle passed back to later queries (for kanalyzer, the bitcode path). */
  handle?: string
  /** Campaign fields the prepare step discovered, to be merged back with provenance. */
  discovered?: Record<string, unknown>
  evidence: string[]
  reason?: string
}

/** Result of bringing a provider into a queryable state for one campaign. */
export interface ProviderReady {
  ok: boolean
  /** What was actually done/observed — prepare output, analysis status, counts. */
  evidence: string[]
  reason?: string
  /** Concrete options to offer the user when `ok` is false. */
  remedies?: { id: string; label: string; detail?: string; effect: RemedyEffect }[]
}

/** One auxiliary analysis backend. No method throws for "found nothing". */
export interface AnalysisProvider {
  describe(): ProviderCapabilities
  prepare(campaign: PbfuzzCampaign): Promise<PrepareOutcome>
  callers(fn: string, handle?: string): Promise<string[]>
  callees(fn: string, handle?: string): Promise<string[]>
  functionAt(location: string, handle?: string): Promise<string | undefined>
  criticalLocations(handle?: string): Promise<ProviderLocation[]>
  /**
   * Bring the provider into a queryable state for this campaign, if it is not already: build or
   * import the bitcode and run the analysis. Idempotent and memoized, so every query path can
   * call it unconditionally. Nothing else prepares a provider — there is no campaign self-check.
   */
  ensureReady(campaign: PbfuzzCampaign): Promise<ProviderReady>
}

/** The registry pbfuzz keeps; registration is an effect on the registering fiber. */
export interface AnalysisProviderRegistry {
  register(provider: AnalysisProvider): { dispose(): void }
  active(): AnalysisProvider | undefined
  list(): ProviderCapabilities[]
}

/* -------------------------------------------------------------------------- */
/* contracts/kanalyzer-api.ts — the consumed subset, restated verbatim.         */
/* -------------------------------------------------------------------------- */

/** Whether KAMain is present and usable right now. */
export interface KanalyzerStatus {
  installed: boolean
  binaryPath?: string
  commit?: string
  llvmVersion?: string
}

/** Result of a real end-to-end check against the bundled self-test sample. */
export interface KanalyzerDoctor {
  ok: boolean
  status: KanalyzerStatus
  evidence: string[]
  reason?: string
}

/** How a project's bitcode is produced. */
export type PrepareMode = 'lto' | 'wllvm'

/** Inputs for producing analysable bitcode from a source checkout. */
export interface KanalyzerPrepareRequest {
  repo: string
  buildCmd: string
  cwd?: string
  program?: string
  mode: PrepareMode
  ltoLibs?: string[]
  env?: Record<string, string>
}

/** Bitcode discovered by a prepare run. */
export interface KanalyzerPrepareResult {
  bitcode: string
  allBitcode: string[]
  entries: string[]
  nFuncs: number
}

/** Which KAMain dumps an analysis should produce. */
export interface DumpSelection {
  policy?: boolean
  distance?: boolean
  criticalBranch?: boolean
  bidMappingAndFuncInfo?: boolean
  callerCalleeBothWays?: boolean
  annotatedIr?: boolean
}

/** One analysis request. */
export interface AnalyzeRequest {
  bitcode: string
  targets: string[]
  entries?: string[]
  callStackLen?: number
  typeBasedCallgraph?: boolean
  dumps?: DumpSelection
  timeoutSec?: number
  force?: boolean
}

/** KAMain exits 0 in every case, so this status comes from stderr plus the outputs. */
export type AnalyzeStatus = 'ok' | 'no_target' | 'unreachable' | 'error'

/** A basic block KAMain resolved for a requested target. */
export interface ResolvedTarget {
  requested: string
  function: string
  location: string
  distance: number
}

/** A branch whose outcome decides whether the target stays reachable. */
export interface CriticalBranch {
  function: string
  location: string
  distance: number
}

/** Outcome of one analysis. */
export interface AnalyzeResult {
  status: AnalyzeStatus
  targets: ResolvedTarget[]
  criticalBranches: CriticalBranch[]
  reachableFunctions: number
  totalFunctions: number
  entriesUsed: string[]
  outputDir: string
  elapsedMs: number
  cached: boolean
  reason?: string
  unresolved?: { requested: string; nearbyCandidates: string[] }[]
}

/** A call-graph / location query against an already-analysed bitcode. */
export type QueryRequest =
  | { op: 'callers'; bitcode: string; fn: string }
  | { op: 'callees'; bitcode: string; fn: string }
  | { op: 'functionAt'; bitcode: string; location: string }
  | { op: 'critical'; bitcode: string; fn?: string }

/** Sorted query results; KAMain's own output order is not stable. */
export interface QueryResult {
  op: QueryRequest['op']
  results: string[]
  truncated: boolean
}

/** The service published at `ctx.kanalyzer` by the standalone dsh-kanalyzer plugin. */
export interface KanalyzerService {
  status(): Promise<KanalyzerStatus>
  doctor(): Promise<KanalyzerDoctor>
  prepare(request: KanalyzerPrepareRequest): Promise<KanalyzerPrepareResult>
  analyze(request: AnalyzeRequest): Promise<AnalyzeResult>
  index(bitcode: string): Promise<AnalyzeResult>
  query(request: QueryRequest): Promise<QueryResult>
}
