/**
 * The model-facing pbfuzz tools, registered with `defineTool`.
 *
 * `pbfuzz_probe` (no campaign needed, INIT) is a deterministic repo scan. `pbfuzz_campaign` owns
 * the draft/confirm/status/run lifecycle. `pbfuzz_plan` (PLAN),
 * `pbfuzz_fuzz` (IMPLEMENT/EXECUTE) and `pbfuzz_reflect` (REFLECT) drive the PIER loop; each
 * validates its input against `core/state-blocks.ts` (via `state-writer.ts`) and only then writes
 * `state/*.json` and advances the phase — the agent never hand-writes campaign state (P3).
 *
 * Failure signaling is standardized across this file: a structural/validation failure always
 * THROWS an `Error` listing every issue (never a silent `{ok:false,...}` success value) — the fix
 * for B3 (today's `pbfuzz_campaign draft` did both for the same class of failure, depending on
 * whether `normalizeDraftAnswers` or `draftCampaign`'s own validation caught it first).
 *
 * @module @pbfuzz/dsh-pbfuzz/tools
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ArrayValueSchemaSpec, type ObjectValueSchemaSpec, type StringValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JobRegistry } from '@deepseek-ai/dsh-jobs'
import { confirm, draft, runHeadless, status, type FlowContext } from './campaign-flow.ts'
import { ANSWERS_PARAMETER_SCHEMA, normalizeDraftAnswers } from './core/campaign.ts'
import type { AnalysisProvider, ParameterSpace, PbfuzzPhase } from './core/contracts.ts'
import { banner } from './core/digest.ts'
import {
  corpusAnalyzeParams,
  debuggerPaths,
  fuzzRunParams,
  generatorValidateParams,
  paramsExtractParams,
  type FuzzRunParams,
} from './core/engine-params.ts'
import { NEXT_STEP } from './core/fsm.ts'
import { fuzzRejection, type ValidationResult } from './core/fuzz-rejection.ts'
import { campaignRunDigest, latestIterationsPath, readIterations, reproduceCommand, triggeringIteration } from './core/run-digest.ts'
import { validateFuzzPlan } from './core/state-blocks.ts'
import { formatHeadlessDiagnosis } from './core/remedies.ts'
import { EngineRpcError, type RpcMethod } from './core/rpc.ts'
import type { ActiveCampaign, AgentLike, PbfuzzHost } from './host.ts'
import { engineToolError, type QuestionAsker } from './recovery.ts'
import { advancePhase, writeFuzzPlan, writeHypothesisBlocks, type WriteStateBlocksInput } from './state-writer.ts'

/** Types the `pbfuzz_fuzz` `kind: 'pbfuzz_fuzz'` job (precedent: kanalyzer's own `'kanalyzer'`
 * merge in `packages/dsh-kanalyzer/src/host/runtime.ts`). */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    pbfuzz_fuzz: 'pbfuzz_fuzz'
  }
}

/** Engine code for a `fuzz.run` stopped by `fuzz.cancel` (engine/pbfuzz_engine/errors.py). */
export const ENGINE_CANCELLED = -32005

/** `presentationMeta` marker the `pbfuzz` projection folds (see projection.ts). */
export const DASHBOARD_META_KEY = 'pbfuzzDashboard'

/**
 * Result field that carries the host-built dashboard view from `execute` to `presentationMeta`
 * (which sees only args and value). {@link renderJson} drops it, so the model never reads it.
 */
export const DASHBOARD_FIELD = 'pbfuzzDashboard'

const jsonOut = { schema: { type: 'json' } } as const

/** Bare string / string-array value schema, reused across every parameter schema below. */
const STR: StringValueSchemaSpec = { type: 'string' }
const STR_ARRAY: ArrayValueSchemaSpec = { type: 'array', items: { type: 'string' } }

/**
 * Build the completed-job result for a `fuzz.run` RPC result.
 *
 * F20: when the run stopped on a non-fatal mid-run error (`summary.stoppedBy === "error"`), the
 * engine now also returns `summary.errorPhase`/`errorMessage`/`errorDiagnosis` (F20-engine,
 * `engine/pbfuzz_engine/fuzzer.py`, `contracts/engine-rpc.schema.json`). Without folding those into
 * `detail`, a caller that inspects only the job's one-line status (not the full `output` JSON) would
 * see just the iteration counts and never learn *why* the run stopped early.
 * @param result - the raw `fuzz.run` RPC result.
 * @returns the job's `done` resolution for a successful `fuzz.run` call.
 */
export function summarizeFuzzRunResult(result: unknown): { status: 'completed'; detail: string; output: string } {
  const r = result as {
    summary?: {
      totalIterations?: number
      reachedCount?: number
      triggeredCount?: number
      stoppedBy?: string
      errorMessage?: string
      errorDiagnosis?: string
    }
    metricsPath?: string
    firstTriggeringInput?: string
  }
  const s = r.summary ?? {}
  const counts = `${s.totalIterations ?? 0} iterations, ${s.reachedCount ?? 0} reached, ${s.triggeredCount ?? 0} triggered (${s.stoppedBy ?? 'completed'})`
  const detail = s.stoppedBy === 'error' && s.errorMessage !== undefined
    ? `${counts}: ${s.errorMessage}${s.errorDiagnosis !== undefined ? ` — ${s.errorDiagnosis}` : ''}`
    : counts
  return {
    status: 'completed' as const,
    detail,
    output: JSON.stringify(r, null, 2),
  }
}

function withoutDashboard(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !(DASHBOARD_FIELD in value)) return value
  const { [DASHBOARD_FIELD]: _dashboard, ...rest } = value as Record<string, unknown>
  return rest
}

/**
 * Model-facing render for the JSON tools: the result without the dashboard field.
 * @param _args - tool arguments (unused).
 * @param value - the tool's value.
 * @returns one text block.
 */
export function renderJson(_args: unknown, value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(withoutDashboard(value), null, 2) }]
}

/**
 * `presentationMeta` for every pbfuzz tool: the dashboard view under {@link DASHBOARD_META_KEY},
 * which `tool/result.meta` persists and the projection folds.
 * @param _args - tool arguments (unused).
 * @param value - the tool's value.
 * @returns the meta object (`null` view when the result carries none).
 */
export function dashboardMeta(_args: unknown, value: unknown): never {
  const view = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[DASHBOARD_FIELD]
    : undefined
  return { [DASHBOARD_META_KEY]: view ?? null } as never
}

const jsonTool = { ...jsonOut, render: renderJson, presentationMeta: dashboardMeta }

/* -------------------------------------------------------------------------- */
/* pbfuzz_probe: deterministic repo scan (no LLM judgment).                   */
/* -------------------------------------------------------------------------- */

/** One deterministic scan finding: what was found and where. */
export interface ProbeFinding {
  kind: string
  /** `file:line`, or a bare path when there is no specific line. */
  evidence: string
}

/** One seed-corpus candidate directory that actually exists. */
export interface ProbeSeedCorpus {
  dir: string
  fileCount: number
}

/** `pbfuzz_probe`'s result. */
export interface ProbeResult {
  repo: string
  buildSystems: ProbeFinding[]
  harnesses: ProbeFinding[]
  binaries: ProbeFinding[]
  seedCorpora: ProbeSeedCorpus[]
  oracleMarkers: ProbeFinding[]
}

/** Basename → build-system kind, checked against every file the bounded walk visits. */
const BUILD_SYSTEM_MARKERS: Record<string, string> = {
  Makefile: 'make',
  makefile: 'make',
  GNUmakefile: 'make',
  'CMakeLists.txt': 'cmake',
  configure: 'autotools',
  'configure.ac': 'autotools',
  'configure.in': 'autotools',
  'meson.build': 'meson',
  'pom.xml': 'maven',
  'build.gradle': 'gradle',
  'build.gradle.kts': 'gradle',
  'setup.py': 'python-setuptools',
  'setup.cfg': 'python-setuptools',
  'pyproject.toml': 'python-pyproject',
  'Cargo.toml': 'cargo',
}

/** Directory basenames that themselves signal an existing fuzzing setup. */
const FUZZ_DIR_NAMES = new Set(['fuzz', 'oss-fuzz'])

/** Content patterns that mark a file as an existing fuzz harness. */
const HARNESS_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'LLVMFuzzerTestOneInput', re: /LLVMFuzzerTestOneInput/ },
  { kind: 'atheris.Setup', re: /atheris\.Setup\s*\(/ },
  { kind: 'fuzzerTestOneInput', re: /fuzzerTestOneInput/i },
]

/** Content patterns for an existing reach/trigger logging canary (MAGMA-style). */
const ORACLE_MARKER_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'MAGMA_LOG', re: /MAGMA_LOG/ },
  { kind: 'PBFUZZ_REACHED', re: /PBFUZZ_REACHED/ },
  { kind: 'PBFUZZ_TRIGGERED', re: /PBFUZZ_TRIGGERED/ },
]

/**
 * A project's own marker: a write to stderr whose string literal says "reached" or "triggered",
 * e.g. `std::cerr << "bug location reached"`. Recognising only the MAGMA/pbfuzz macro names made
 * the probe report no markers for such a target, and with a clean workspace the model then chose
 * inserted canaries — instrumenting a target that already reports both signals. The literal is
 * returned with the location, since it is exactly what the oracle's regex has to match.
 */
const STDERR_SINK = /\b(cerr|stderr|System\.err|eprint(ln)?!?|console\.error)\b/
const MARKER_LITERAL = /"([^"\n]*\b(reached|triggered)\b[^"\n]*)"|'([^'\n]*\b(reached|triggered)\b[^'\n]*)'/i

/** Seed-corpus candidate directories, relative to the repo root. */
const SEED_CORPUS_CANDIDATES = ['corpus', 'seeds', 'tests/data']

/** Directories the walk never descends into: noisy, huge, or irrelevant. */
const PROBE_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pbfuzz', '.mypy_cache', '.pytest_cache',
  '.tox', 'dist', 'target', '.hg', '.svn',
])

const PROBE_SOURCE_EXT = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|java|py|rs|go|js|mjs|cjs|ts)$/
const PROBE_MAX_ENTRIES = 20_000
const PROBE_MAX_FILE_BYTES = 1_000_000
const PROBE_MAX_CONTENT_SCAN_FILES = 3_000
const PROBE_MAX_FINDINGS_PER_KIND = 20
const PROBE_MAX_ELF_CHECKS = 2_000
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])

interface WalkEntry {
  /** Path relative to the scan root, POSIX-separated. */
  rel: string
  abs: string
  isDir: boolean
}

/**
 * Breadth-first, bounded directory walk: shallow entries first (so a build-system marker at the
 * repo root always wins over a same-named file buried in a vendor subtree), skips
 * {@link PROBE_SKIP_DIRS} and any other hidden directory, and stops once `limit` entries have been
 * visited so a huge tree cannot blow the scan's time budget.
 * @param root - directory to walk.
 * @param limit - maximum number of entries (files + directories) to collect.
 * @returns every visited entry, shallowest first.
 */
function walkBounded(root: string, limit: number): WalkEntry[] {
  const out: WalkEntry[] = []
  const queue: string[] = ['']
  let head = 0
  while (head < queue.length && out.length < limit) {
    const rel = queue[head++]!
    const abs = rel === '' ? root : join(root, rel)
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (out.length >= limit) break
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) {
        out.push({ rel: r, abs: join(root, r), isDir: true })
        if (!PROBE_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) queue.push(r)
      } else if (e.isFile()) {
        out.push({ rel: r, abs: join(root, r), isDir: false })
      }
    }
  }
  return out
}

/** Whether the 4-byte ELF magic number is at the start of `path`. */
function looksLikeElf(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    const buf = Buffer.alloc(4)
    const n = readSync(fd, buf, 0, 4, 0)
    return n === 4 && buf.equals(ELF_MAGIC)
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}

/**
 * Deterministic, synchronous repo scan (no LLM judgment) — what `pbfuzz_probe` returns. Bounded on
 * every axis (entries walked, file size, files content-scanned, ELF checks) so a huge repo cannot
 * blow the tool's time budget; skips `.git`/`node_modules`/build-output-style directories.
 * @param repo - absolute path to the target repo.
 * @returns the scan result.
 */
export function probeRepo(repo: string): ProbeResult {
  const entries = walkBounded(repo, PROBE_MAX_ENTRIES)
  const buildSystems: ProbeFinding[] = []
  const harnesses: ProbeFinding[] = []
  const binaries: ProbeFinding[] = []
  const oracleMarkers: ProbeFinding[] = []

  for (const e of entries) {
    if (e.isDir) {
      if (FUZZ_DIR_NAMES.has(basename(e.rel)) && harnesses.length < PROBE_MAX_FINDINGS_PER_KIND) {
        harnesses.push({ kind: 'fuzz_dir', evidence: e.rel })
      }
      continue
    }
    const kind = BUILD_SYSTEM_MARKERS[basename(e.rel)]
    if (kind !== undefined && buildSystems.length < PROBE_MAX_FINDINGS_PER_KIND) buildSystems.push({ kind, evidence: e.rel })
  }

  let contentScanned = 0
  for (const e of entries) {
    if (e.isDir || !PROBE_SOURCE_EXT.test(e.rel)) continue
    if (contentScanned >= PROBE_MAX_CONTENT_SCAN_FILES) break
    let size: number
    try {
      size = statSync(e.abs).size
    } catch {
      continue
    }
    if (size > PROBE_MAX_FILE_BYTES) continue
    contentScanned++
    let content: string
    try {
      content = readFileSync(e.abs, 'utf8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      for (const { kind, re } of HARNESS_PATTERNS) {
        if (harnesses.length < PROBE_MAX_FINDINGS_PER_KIND && re.test(line)) harnesses.push({ kind, evidence: `${e.rel}:${i + 1}` })
      }
      for (const { kind, re } of ORACLE_MARKER_PATTERNS) {
        if (oracleMarkers.length < PROBE_MAX_FINDINGS_PER_KIND && re.test(line)) oracleMarkers.push({ kind, evidence: `${e.rel}:${i + 1}` })
      }
      if (oracleMarkers.length < PROBE_MAX_FINDINGS_PER_KIND && STDERR_SINK.test(line)) {
        const m = MARKER_LITERAL.exec(line)
        if (m !== null) oracleMarkers.push({ kind: 'stderr_marker', evidence: `${e.rel}:${i + 1} ${JSON.stringify(m[1] ?? m[3])}` })
      }
    }
  }

  let elfChecked = 0
  for (const e of entries) {
    if (e.isDir || basename(e.rel).includes('.')) continue // an extension makes it an unlikely built executable
    if (elfChecked >= PROBE_MAX_ELF_CHECKS || binaries.length >= PROBE_MAX_FINDINGS_PER_KIND) break
    elfChecked++
    if (looksLikeElf(e.abs)) binaries.push({ kind: 'elf', evidence: e.rel })
  }

  const seedCorpora: ProbeSeedCorpus[] = []
  for (const rel of SEED_CORPUS_CANDIDATES) {
    try {
      const fileCount = readdirSync(join(repo, rel), { withFileTypes: true }).filter(e => e.isFile()).length
      seedCorpora.push({ dir: rel, fileCount })
    } catch {
      // Not present.
    }
  }

  return { repo, buildSystems, harnesses, binaries, seedCorpora, oracleMarkers }
}

// These three are read back through `InferValue` for `pbfuzz_probe`'s OUTPUT schema (execute()'s
// return type must structurally match), unlike every other schema in this file, which is only
// ever a PARAMETER schema (`InferArgs`, consumed loosely downstream). `ObjectValueSchemaSpec`'s
// `properties` field is a general index-signature type (`ParameterSchemaSpec`), so annotating a
// const with that interface (the pattern the rest of this file and `core/campaign.ts` both use for
// parameter schemas) erases exactly the per-key `required` literal info `InferValue` needs —
// `as const satisfies` keeps the literal inferred type while still checking it structurally.
const PROBE_FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { ...STR, required: true },
    evidence: { ...STR, required: true, description: '`file:line`, or a bare path when there is no specific line.' },
  },
} as const satisfies ObjectValueSchemaSpec

const PROBE_SEED_CORPUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dir: { ...STR, required: true },
    fileCount: { type: 'integer', required: true },
  },
} as const satisfies ObjectValueSchemaSpec

const PROBE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: { ...STR, required: true },
    buildSystems: {
      type: 'array', items: PROBE_FINDING_SCHEMA, required: true,
      description: 'Build systems detected (make/cmake/autotools/meson/maven/gradle/python-setuptools/python-pyproject/cargo).',
    },
    harnesses: {
      type: 'array', items: PROBE_FINDING_SCHEMA, required: true,
      description: 'Existing fuzz harness markers (LLVMFuzzerTestOneInput / atheris.Setup / fuzzerTestOneInput) and fuzz/oss-fuzz directories.',
    },
    binaries: { type: 'array', items: PROBE_FINDING_SCHEMA, required: true, description: 'Built ELF binaries found by magic-number sniffing.' },
    seedCorpora: {
      type: 'array', items: PROBE_SEED_CORPUS_SCHEMA, required: true,
      description: 'corpus/, seeds/, tests/data — present with a file count.',
    },
    oracleMarkers: {
      type: 'array', items: PROBE_FINDING_SCHEMA, required: true,
      description: 'Existing reach/trigger logging canaries (MAGMA_LOG-style).',
    },
  },
} as const satisfies ObjectValueSchemaSpec

/* -------------------------------------------------------------------------- */
/* pbfuzz_campaign: the `known` (status) parameter schema.                    */
/* -------------------------------------------------------------------------- */

const KNOWN_ANSWERS_PARAMETER_SCHEMA: ObjectValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  description: 'For status without an active campaign: what is already known, to plan the interview.',
  properties: {
    repo: STR,
    bug: STR,
    buildScript: STR,
    runScript: STR,
    entry: STR,
    target: STR,
    outputDir: STR,
    seedsDir: STR,
    staticGaps: { ...STR_ARRAY, description: 'Static-analysis inputs the agent could not infer. Non-empty triggers that question.' },
    preexistingMarkers: { ...STR, description: 'Existing reach/trigger markers found (e.g. from pbfuzz_probe). Present triggers the oracle-reuse question.' },
  },
}

/* -------------------------------------------------------------------------- */
/* pbfuzz_plan: the four hypothesis-block parameter schemas.                  */
/* -------------------------------------------------------------------------- */

const BUG_PREDICATE_SCHEMA: ObjectValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { ...STR, required: true, description: 'Must match ^BP[0-9]+$.' },
    location: { ...STR, description: '`file:line`.' },
    bug_condition: { ...STR, description: 'The condition extracted from the target source line.' },
  },
}

const PRECONDITION_SCHEMA: ObjectValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { ...STR, required: true, description: 'Must match ^R[0-9]+$.' },
    statement: { ...STR },
    status: { type: 'string', enum: ['verified', 'violated', 'unknown', 'impossible'] },
    evidence: { ...STR_ARRAY },
    input_constraints: { ...STR_ARRAY, description: 'Non-semantic constraints as math expressions (`width < 100`); semantic ones in natural language.' },
  },
}

const ROOT_CAUSE_SCHEMA: ObjectValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { ...STR, required: true, description: 'Must match ^RC[0-9]+$.' },
    description: { ...STR },
    category: { ...STR, description: 'Vulnerability category, e.g. buffer_overflow, use_after_free, type_confusion — any string (language-agnostic).' },
    evidence: { ...STR_ARRAY },
    input_constraints: STR_ARRAY,
    related_precondition_ids: STR_ARRAY,
  },
}

const TRIGGER_PLAN_SCHEMA: ObjectValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { ...STR, required: true },
    description: { ...STR },
    route_description: { ...STR },
    complexity: { type: 'integer', description: '1 (trivial) to 10 (hardest) — the agent works the lowest-complexity pending plan first.' },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
    evidence: STR_ARRAY,
    precondition_ids: STR_ARRAY,
    strategy: STR,
  },
}

/* -------------------------------------------------------------------------- */
/* pbfuzz_fuzz: the fuzz-plan parameter schema.                               */
/* -------------------------------------------------------------------------- */

const PARAMETER_SPACE_SCHEMA: ObjectValueSchemaSpec = {
  type: 'object',
  additionalProperties: true,
  description: 'Named generator keyword parameters, keyed by the generator\'s `generate(**params)` argument names. Each value is a '
    + 'ParameterSpec: {type:"int_range",min,max} | {type:"float_range",min,max} | {type:"categorical",values:[...]} | {type:"bool"} | '
    + '{type:"base_seed",seed_file_path} | {type:"segments",count_range:{min,max},segment_params:{<name>: <ParameterSpec>, ...}}.',
}

const BREAKPOINT_SCHEMA: ObjectValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    location: { ...STR, required: true, description: '`file:line`.' },
    hit_limit: { type: 'integer', description: 'Stop tracing this breakpoint after this many hits (default 10).' },
    inline_expr: { ...STR_ARRAY, description: 'Expressions evaluated in the tracer\'s language at each hit.' },
    print_call_stack: { type: 'boolean' },
  },
}

const BATCH_PLAN_ENTRY_SCHEMA: ObjectValueSchemaSpec = {
  type: 'object',
  additionalProperties: true,
  description: '`plan_description` plus one key per pinned generator parameter — each key must exist in `parameter_space`, with a value in-domain for its declared type.',
  properties: {
    plan_description: { ...STR, required: true },
  },
}

const FUZZ_PLAN_SCHEMA: ObjectValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  description: 'fuzz_plan.json: what EXECUTE runs.',
  properties: {
    parameter_space: { ...PARAMETER_SPACE_SCHEMA, required: true },
    next_batch_plan: { type: 'array', items: BATCH_PLAN_ENTRY_SCHEMA, description: 'Concrete parameter assignments to try first, before the sampler takes over.' },
    breakpoints: { type: 'array', items: BREAKPOINT_SCHEMA, description: 'Traced during stage 1.' },
    trigger_plan_id: STR,
    generator_path: STR,
  },
}

const FUZZ_RUNTIME_OVERRIDE_SCHEMA: ObjectValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  description: 'Per-run overrides of the fuzzing.* settings.',
  properties: {
    maxIters: { type: 'integer' },
    execTimeoutSec: { type: 'number' },
    fuzzTimeoutSec: { type: 'number' },
    generatorTimeoutSec: { type: 'number' },
    enableDebuggerForAll: { type: 'boolean' },
  },
}

/* -------------------------------------------------------------------------- */
/* pbfuzz_fuzz: the shared foreground/background phase-advance helper.        */
/* -------------------------------------------------------------------------- */

/** {@link finishFuzz}'s outcome. */
export interface FinishFuzzResult {
  status: 'completed' | 'killed' | 'failed'
  detail: string
  output: string
  /** The campaign's phase after this call — REFLECT on success/kill, unchanged (still EXECUTE) on
   * a genuine failure. */
  phase: PbfuzzPhase
  /** What the round found, in the lines REFLECT needs (`core/run-digest.ts`); absent on a failure. */
  digest?: string
}

/**
 * Run `fuzz.run` and advance the campaign's phase according to the outcome — the ONE place both
 * the foreground and background `pbfuzz_fuzz` paths do this, so the phase-advance logic is never
 * duplicated. Resolves, never rejects, mirroring the background job producer's own `done` contract
 * (a thrown `IllegalTransitionError` from a state-writer invariant violation is a real bug and is
 * deliberately let through uncaught, never mischaracterized as a fuzz outcome).
 * @param host - the plugin host.
 * @param agent - the calling agent, for the post-write visibility refresh; undefined headless.
 * @param active - the campaign being fuzzed.
 * @param params - the `fuzz.run` RPC parameters.
 * @param signal - cancellation (the tool's own `exec.signal` foreground; a job-owned controller background).
 * @returns the outcome, with the phase the campaign is in once this resolves.
 */
export async function finishFuzz(
  host: PbfuzzHost,
  agent: AgentLike | undefined,
  active: ActiveCampaign,
  params: FuzzRunParams,
  signal: AbortSignal,
): Promise<FinishFuzzResult> {
  let result: unknown
  try {
    result = await host.engine.call('fuzz.run', params as unknown as Record<string, unknown>, signal)
  } catch (error) {
    const e = error as Error & { code?: number; diagnosis?: string; remedies?: unknown }
    // -32005: the engine honoured a fuzz.cancel (possibly sent from elsewhere) — a kill, not a failure.
    const killed = signal.aborted || e.code === ENGINE_CANCELLED
    const output = JSON.stringify({ error: e.message, diagnosis: e.diagnosis, remedies: e.remedies }, null, 2)
    if (killed) {
      // Worth reflecting on partial results: advance exactly as a completed run would.
      const state = advancePhase(host, agent, active, 'REFLECT', {
        status: 'fuzz session interrupted; partial results available for reflection',
        current_task: 'analyse metrics.json and the run output so far',
        next_action: NEXT_STEP.REFLECT,
      })
      return { status: 'killed', detail: e.message, output, phase: state.phase, digest: campaignRunDigest(active.campaign, active.layout.dir, host.metrics(active)) }
    }
    // A genuine engine/infrastructure failure: stay in EXECUTE, retryable.
    const current = host.state(active)
    return { status: 'failed', detail: e.message, output, phase: current?.phase ?? 'EXECUTE' }
  }
  const summary = summarizeFuzzRunResult(result)
  const state = advancePhase(host, agent, active, 'REFLECT', {
    status: 'fuzz session finished; awaiting reflection',
    current_task: 'analyse metrics.json and the run output',
    next_action: NEXT_STEP.REFLECT,
  })
  return { ...summary, phase: state.phase, digest: campaignRunDigest(active.campaign, active.layout.dir, host.metrics(active)) }
}

/**
 * Register every pbfuzz tool on `ctx.tools`.
 * @param ctx - plugin context (host level).
 * @param host - the plugin's host state.
 */
export function registerTools(ctx: Context, host: PbfuzzHost): void {
  const asker = (): QuestionAsker | undefined => ctx.get('userQuestions')
  const agentOf = (exec: { agent?: unknown }): AgentLike | undefined => exec.agent as AgentLike | undefined
  const flowOf = (exec: { agent?: unknown; signal: AbortSignal }): FlowContext => ({
    host,
    agent: agentOf(exec),
    asker: asker(),
    signal: exec.signal,
  })
  /** Attach the fresh dashboard view to an object result. Visibility is session-constant
   * (`core/phases.ts`), so nothing is re-restricted here. */
  const withDashboard = (value: unknown, exec: { agent?: unknown }): never => {
    const agent = agentOf(exec)
    const base = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { result: value }
    return { ...base, [DASHBOARD_FIELD]: host.dashboard(agent) ?? null } as never
  }
  const activeOrThrow = (exec: { agent?: unknown }): ActiveCampaign => {
    const active = host.active(agentOf(exec))
    if (active === undefined) throw new Error('no active pbfuzz campaign in this workspace; run /pbfuzz first')
    return active
  }
  const headless = (exec: { agent?: unknown }): boolean =>
    host.active(agentOf(exec))?.headless === true || host.settings().onboarding.interviewPolicy === 'never'
  /** One engine call whose failure reaches the model with the engine's diagnosis and remedies. */
  const engineCall = async (method: RpcMethod, params: object, exec: { agent?: unknown; signal: AbortSignal }): Promise<unknown> => {
    try {
      return await host.engine.call(method, params as Record<string, unknown>, exec.signal)
    } catch (error) {
      if (!(error instanceof EngineRpcError) || exec.signal.aborted) throw error
      throw await engineToolError(`pbfuzz ${method}`, error, asker(), { agent: exec.agent, signal: exec.signal, headless: headless(exec) })
    }
  }
  /**
   * The active analysis provider, prepared for this campaign. Preparation is lazy and memoized
   * (`kanalyzer-provider.ts`'s `ensureReady`): the first static-analysis question pays the build
   * and the analysis, later ones are free, and a campaign that never asks one never pays at all.
   */
  const preparedProvider = async (active: ActiveCampaign): Promise<AnalysisProvider> => {
    const provider = host.providers.active()
    if (provider === undefined) throw new Error('no analysis provider is registered (static analysis off, or kanalyzer not installed)')
    const ready = await provider.ensureReady(active.campaign)
    if (!ready.ok) {
      throw new Error(formatHeadlessDiagnosis({
        step: 'static analysis',
        diagnosis: ready.reason ?? 'the analysis provider could not be prepared',
        evidence: ready.evidence,
        remedies: ready.remedies ?? [],
      }))
    }
    return provider
  }
  const seedsDirOf = (active: ActiveCampaign, exec: { agent?: unknown }): string | undefined => {
    const seeds = active.campaign.analysis?.corpus?.seeds_dir
    return seeds === undefined ? undefined : host.resolvePath(agentOf(exec), seeds)
  }
  const tools = ctx.tools as unknown as { register(def: unknown): () => void }

  tools.register(defineTool({
    name: 'pbfuzz_campaign',
    description: 'Manage the pbfuzz campaign. `draft` validates the answers, builds and verifies the target, and writes pbfuzz.campaign.yaml; `confirm` shows the summary for Approve/Revise and, on Approve, moves the campaign to PLAN; `status` reports the campaign, phase and metrics; `run` loads a hand-written, confirmed yaml (the headless entry point). Minimal draft answers: {"id": "libpng-png006", "target": {"repo": "/abs/path", "language": "c"}, "bug": {"targets": [{"location": "png.c:620", "condition": "..."}]}, "entry": {"kind": "executable", "run_cmd": "/abs/path/bin @@", "input_channel": "file"}, "oracle": {"mode": "preexisting", "reached_pattern": "...", "triggered_pattern": "..."}}.',
    parameters: {
      action: { type: 'string', enum: ['draft', 'confirm', 'status', 'run'], required: true },
      answers: ANSWERS_PARAMETER_SCHEMA,
      known: KNOWN_ANSWERS_PARAMETER_SCHEMA,
      draft_version: { type: 'string', description: 'For confirm: the draftVersion from the last draft (or a prior revise/approved outcome). When supplied and stale, confirm refuses rather than acting on an outdated draft.' },
      path: { type: 'string', description: 'For run: path to the confirmed campaign yaml (absolute, or relative to the workspace).' },
    },
    output: jsonTool,
    async execute(args, exec) {
      const flow = flowOf(exec)
      let value: Record<string, unknown>
      switch (args.action) {
        case 'draft': {
          // Both failure classes surface identically (thrown, isError): a wrong-shaped answer
          // from normalizeDraftAnswers, and a schema/cross-field violation from draftCampaign.
          const result = await draft(flow, normalizeDraftAnswers(args.answers))
          if (!result.ok) throw new Error(`pbfuzz_campaign draft: invalid campaign:\n${result.issues.map(i => `  - ${i.path}: ${i.message}`).join('\n')}`)
          value = { ...result }
          break
        }
        case 'confirm':
          value = { ...await confirm(flow, args.draft_version) }
          break
        case 'run': {
          if (typeof args.path !== 'string' || args.path === '') throw new Error('run needs `path`')
          const outcome = await runHeadless(flow, args.path)
          if (!outcome.ok) throw new Error(outcome.diagnosis ?? 'self-check failed')
          value = { ok: true, campaignId: outcome.campaignId, next_instruction: outcome.nextInstruction }
          break
        }
        default:
          value = status(flow, (args.known ?? {}) as never)
      }
      return withDashboard(value, exec)
    },
  }))

  tools.register(defineTool({
    name: 'pbfuzz_probe',
    description: 'Deterministic repo scan, no campaign needed: build system, existing fuzz harnesses, built binaries, seed corpora and existing reach/trigger markers, each with its file:line or path. Use it instead of running find or grep over the repo yourself.',
    parameters: {
      repo: { type: 'string', description: 'Target repo to scan (absolute, or relative to the workspace). Defaults to the workspace root.' },
    },
    output: {
      schema: PROBE_OUTPUT_SCHEMA,
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    async execute(args, exec) {
      const agent = agentOf(exec)
      const repo = args.repo === undefined || args.repo === '' ? host.cwdOf(agent) : host.resolvePath(agent, args.repo)
      return probeRepo(repo)
    },
  }))

  tools.register(defineTool({
    name: 'pbfuzz_plan',
    description: 'Write the PLAN hypothesis blocks (bug_predicates, preconditions, root_causes, trigger_plans) and advance to IMPLEMENT. Only legal in PLAN. Entries are upserted by id: a new id must be complete, a revision needs only its id and the fields that change, and entries left out stay as they are. A validation failure throws with every issue and writes nothing.',
    parameters: {
      bug_predicates: { type: 'array', items: BUG_PREDICATE_SCHEMA, description: 'Disjunctive branches of the triggering condition — satisfying ANY ONE triggers the bug.' },
      preconditions: { type: 'array', items: PRECONDITION_SCHEMA, description: 'Conditions that must hold to REACH the target.' },
      root_causes: { type: 'array', items: ROOT_CAUSE_SCHEMA, description: 'Why the bug triggers once reached.' },
      trigger_plans: { type: 'array', items: TRIGGER_PLAN_SCHEMA, description: 'High-level routes to the bug, each with a self-assessed complexity 1-10; work the lowest first.' },
    },
    output: jsonTool,
    async execute(args, exec) {
      const active = activeOrThrow(exec)
      const agent = agentOf(exec)
      const input: WriteStateBlocksInput = {
        ...args.bug_predicates !== undefined ? { bugPredicates: args.bug_predicates } : {},
        ...args.preconditions !== undefined ? { preconditions: args.preconditions } : {},
        ...args.root_causes !== undefined ? { rootCauses: args.root_causes } : {},
        ...args.trigger_plans !== undefined ? { triggerPlans: args.trigger_plans } : {},
      }
      const written = writeHypothesisBlocks(active, input)
      if (!written.ok) {
        throw new Error(`pbfuzz_plan: the hypothesis blocks failed validation, nothing was written:\n${written.issues.map(i => `  - ${i.path}: ${i.message}`).join('\n')}`)
      }
      const state = advancePhase(host, agent, active, 'IMPLEMENT', {
        status: 'PLAN blocks written; generator and fuzz plan pending',
        current_task: 'write the generator and the fuzz plan',
        next_action: NEXT_STEP.IMPLEMENT,
      })
      return withDashboard({
        phase: state.phase,
        summary: banner({ campaignId: active.campaign.id, phase: state.phase, pierRound: state.pier_round, maxPierRounds: host.settings().budget.maxPierRounds }),
        written: input,
      }, exec)
    },
  }))

  tools.register(defineTool({
    name: 'pbfuzz_fuzz',
    description: 'Run one fuzz session: validates the plan and the generator (including a real target preflight), then runs stage 1 traced and stage 2 sampling, writes metrics.json and moves the campaign to REFLECT. Returns a background job id unless headless or execution.fuzzBackground is off; a completed job wakes you on its own, so end your turn rather than waiting on job_output. A kill still lands in REFLECT (partial results are worth reflecting on); an engine failure leaves the campaign in EXECUTE, retryable.',
    parameters: {
      plan: { ...FUZZ_PLAN_SCHEMA, required: true },
      generator_code: { type: 'string', description: 'Python source exposing `generate(**params) -> bytes`. The engine also passes `seed` when `generate` accepts it. Give this or generator_path.' },
      generator_path: { type: 'string', description: 'A generator already saved by an earlier pbfuzz_fuzz call (named in its rejection), after fixing it with `edit`. Give this or generator_code.' },
      runtime: FUZZ_RUNTIME_OVERRIDE_SCHEMA,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['background', 'completed', 'killed', 'failed'], required: true },
          jobId: { type: 'string', description: 'Set when kind is background; read it with the job tools.' },
          phase: { type: 'string', description: 'The campaign phase after this call.' },
          detail: { type: 'string', description: 'One-line summary (foreground only).' },
          output: { type: 'string', description: 'The full engine result JSON, or the error payload (foreground only).' },
          generatorPath: { type: 'string', description: 'Where this run\'s generator is saved; edit it and pass it as generator_path next round.' },
          digest: { type: 'string', description: 'What the round found (foreground only; a background job states it when it finishes).' },
          [DASHBOARD_FIELD]: { type: 'json' },
        },
      },
      render: (_a, v) => [{
        type: 'text',
        text: `${v.kind === 'background' ? `started fuzz job ${v.jobId} — phase ${v.phase ?? '?'}` : `fuzz ${v.kind} — ${v.detail ?? ''} (phase ${v.phase ?? '?'})`}${v.generatorPath !== undefined ? `; generator saved at ${v.generatorPath}` : ''}${v.digest !== undefined ? `\n${v.digest}` : ''}`,
      }],
      presentationMeta: dashboardMeta,
    },
    async execute(args, exec) {
      const active = activeOrThrow(exec)
      const agent = agentOf(exec)
      const settings = host.settings()

      // 1. The generator source: inline the first time, or the saved file after a rejection (the
      // model edits that file rather than re-emitting a few hundred lines to change two).
      const generatorPath = resolveGenerator(active, args)

      // 2. Every check, and only then a verdict. Each layer used to throw on its own, so three
      // problems cost three resubmissions of the whole generator; now the plan's own issues, the
      // generator's signature, what it produced and what the target did with it all come back in
      // one message. The plan goes to the engine inline, so an invalid plan is never persisted.
      const planIssues = validateFuzzPlan(args.plan, planSpace(args.plan)).issues
      let validation: ValidationResult | undefined
      let engineError: string | undefined
      try {
        validation = await host.engine.call('generator.validate', {
          ...generatorValidateParams(generatorPath, args.plan),
          campaignPath: active.path,
        }, exec.signal) as ValidationResult
      } catch (error) {
        // A generator that does not parse, or a plan whose parameter space is malformed. Reported
        // with everything else — not turned into a question for the user: the fix is the model's.
        if (!(error instanceof EngineRpcError) || exec.signal.aborted) throw error
        engineError = `${error.message}${error.diagnosis !== undefined ? ` — ${error.diagnosis}` : ''}`
      }
      const rejection = fuzzRejection({
        planIssues,
        ...validation !== undefined ? { validation } : {},
        ...engineError !== undefined ? { engineError } : {},
        generatorPath,
      })
      if (rejection !== undefined) throw new Error(rejection)
      const planResult = writeFuzzPlan(active, args.plan)
      if (!planResult.ok) throw new Error(`pbfuzz_fuzz: the fuzz plan could not be written: ${planResult.issues.map(i => `${i.path}: ${i.message}`).join('; ')}`)

      // 3. IMPLEMENT->EXECUTE is this tool's own hop (NEXT_STEP.IMPLEMENT names it); a retry call
      // already in EXECUTE (a prior run failed) must not re-request the same transition.
      if ((host.state(active)?.phase ?? 'INIT') === 'IMPLEMENT') {
        advancePhase(host, agent, active, 'EXECUTE', {
          status: 'fuzz session starting',
          current_task: 'run the fuzz session',
          next_action: NEXT_STEP.EXECUTE,
        })
      }

      const round = host.state(active)?.pier_round ?? 0
      const params = fuzzRunParams({
        campaignPath: active.path,
        planPath: active.layout.fuzzPlanFile,
        generatorPath,
        pierRound: round,
        settings,
        ...args.runtime !== undefined ? { overrides: args.runtime as Record<string, unknown> } : {},
      })

      if (headless(exec) || !settings.execution.fuzzBackground) {
        const outcome = await finishFuzz(host, agent, active, params, exec.signal)
        return withDashboard({ kind: outcome.status, detail: outcome.detail, output: outcome.output, phase: outcome.phase, generatorPath, ...outcome.digest !== undefined ? { digest: outcome.digest } : {} }, exec)
      }

      const jobs: JobRegistry | undefined = ctx.get('jobs')
      if (jobs === undefined) throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
      const id = jobs.start({
        kind: 'pbfuzz_fuzz',
        label: `fuzz ${active.campaign.id} round ${round}`,
        ...exec.agent !== undefined ? { owner: exec.agent } : {},
        run: () => {
          const controller = new AbortController()
          let buffered = ''
          const stopProgress = host.engine.onProgress((n) => {
            if (n.method !== 'log') buffered += `${n.method}: ${JSON.stringify(n.params)}\n`
          })
          // The digest rides in `detail`, which is the one field every reader gets: dsh-tool-jobs'
          // completion notice quotes it verbatim, and `job_output` ends every read with
          // `[status: ..., <detail>]`. (`readOutput` shadows the job's final `output`, so that
          // field never reaches anyone; appending the digest to the progress buffer as well only
          // made a `job_output` read state it twice.)
          const done = finishFuzz(host, agent, active, params, controller.signal).then((outcome) => {
            stopProgress()
            const detail = `${outcome.detail} (phase ${outcome.phase})${outcome.digest !== undefined ? `\n${outcome.digest}` : ''}`
            return { status: outcome.status, detail, output: outcome.output }
          })
          return {
            cancel: (reason?: string) => {
              controller.abort(reason ?? 'fuzz job killed')
              void host.engine.call('fuzz.cancel', { campaignPath: active.path }).catch(() => undefined)
            },
            done,
            readOutput: () => { const out = buffered; buffered = ''; return out },
          }
        },
      })
      return withDashboard({ kind: 'background', jobId: id, phase: host.state(active)?.phase ?? 'EXECUTE', generatorPath }, exec)
    },
  }))

  tools.register(defineTool({
    name: 'pbfuzz_reflect',
    description: 'Conclude one PIER round. Only legal in REFLECT. `next_round` starts another PLAN, and may come back as STOPPED when the round or wall-clock budget is spent — that is the budget, not an error. `success` needs the engine\'s own trigger from THIS round (metrics.json last_session.triggered > 0); the PoC — input, reproduce command, generator parameters and the engine\'s reproduction count — is filled in from that evidence, so pass `poc` only to override a field. `stop` ends the campaign with a reason.',
    parameters: {
      decision: { type: 'string', enum: ['next_round', 'success', 'stop'], required: true },
      analysis: { type: 'string', description: 'What this round\'s evidence showed.' },
      poc: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional, for `success`: each field defaults to the engine\'s own record of this round\'s trigger.',
        properties: {
          input_path: { ...STR, description: 'Must be the engine\'s first triggering input when given.' },
          parameters: { type: 'object', additionalProperties: true, description: 'The generator parameters that produced this input.' },
          run_cmd: { ...STR, description: 'The command that reproduces it.' },
        },
      },
      stop_reason: { type: 'string', description: 'Why the campaign is being stopped.' },
    },
    output: jsonTool,
    async execute(args, exec) {
      const active = activeOrThrow(exec)
      const agent = agentOf(exec)
      switch (args.decision) {
        case 'success': {
          const metrics = host.metrics(active)
          // fsm-attack F3: `triggered_count` is CUMULATIVE for the whole campaign's life
          // (metrics.py's record_session() folds every session's `triggered` count forward from
          // the previous file and never resets it per PIER round), so a bare `triggered_count > 0`
          // check keeps passing for every round AFTER the first one that ever triggered — even a
          // round that found nothing new. `last_session.triggered` is this round's own delta and
          // is the only field that actually proves THIS round produced a trigger.
          const thisRoundTriggered = metrics?.last_session?.triggered ?? 0
          if (thisRoundTriggered <= 0) {
            throw new Error(`pbfuzz_reflect: claiming success needs real engine evidence — only pbfuzz_fuzz can produce a trigger, and metrics.json's last_session shows triggered=${thisRoundTriggered} for this round (lifetime triggered_count=${metrics?.triggered_count ?? 0})`)
          }
          // Cross-check the metrics really came from THIS campaign's THIS round, not a stale file
          // whose `last_session` still shows a genuine — but no-longer-current — trigger from an
          // earlier round (or a different campaign, if output.dir was ever reused). `pbfuzz_fuzz`
          // reads `pier_round` off state.json BEFORE the EXECUTE->REFLECT bump (state-writer.ts's
          // advancePhase increments `pier_round` only on entry to REFLECT), so the metrics a
          // round's fuzz session writes always carry `pier_round = state.pier_round - 1` by the
          // time that round reaches REFLECT and this tool runs.
          const currentState = host.state(active)
          const expectedRound = (currentState?.pier_round ?? 0) - 1
          if (metrics?.campaign_id !== active.campaign.id || metrics?.pier_round !== expectedRound) {
            throw new Error(`pbfuzz_reflect: claiming success needs evidence from the CURRENT campaign and round — metrics.json shows campaign_id=${metrics?.campaign_id ?? 'undefined'}, pier_round=${metrics?.pier_round ?? 'undefined'}, but this round is ${active.campaign.id}/${expectedRound}; run pbfuzz_fuzz again this round before claiming success`)
          }
          // The reported PoC must correspond to what the engine itself recorded as the trigger,
          // never a caller-supplied path that was never actually run.
          const firstTriggeringInput = metrics?.last_session?.first_triggering_input
          if (firstTriggeringInput !== undefined && args.poc?.input_path !== undefined && args.poc.input_path !== firstTriggeringInput) {
            throw new Error(`pbfuzz_reflect: claiming success needs a poc matching the engine's own evidence — metrics.json's last_session.first_triggering_input is ${firstTriggeringInput}, but poc.input_path is ${args.poc.input_path}`)
          }
          const inputPath = args.poc?.input_path ?? firstTriggeringInput
          if (inputPath === undefined) {
            throw new Error('pbfuzz_reflect: the engine recorded a trigger but no triggering input path; pass poc.input_path')
          }
          // Everything else the PoC needs is already on disk: asking the model for it meant it
          // first read the run files by hand to find out.
          const iterationsPath = latestIterationsPath(active.layout.dir)
          const trigger = iterationsPath === undefined ? undefined : triggeringIteration(readIterations(iterationsPath))
          const parameters = args.poc?.parameters ?? trigger?.parameters
          const poc = {
            input_path: inputPath,
            run_cmd: args.poc?.run_cmd ?? reproduceCommand(active.campaign, inputPath),
            ...parameters !== undefined ? { parameters } : {},
          }
          // The engine re-ran the triggering input after the session stopped; that is the only
          // reproduction count anyone can stand behind, so it is stamped on the PoC here rather
          // than asked of the agent (which previously meant running the target by hand).
          const reproduced = metrics?.last_session?.reproduced_ok
          const state = advancePhase(host, agent, active, 'SUCCESS', {
            status: 'trigger confirmed',
            current_task: 'report the PoC',
            next_action: NEXT_STEP.SUCCESS,
            poc: reproduced === undefined ? poc : { ...poc, reproduced_times: reproduced },
          })
          exec.concludeTurn()
          return withDashboard({ phase: state.phase, poc: state.poc ?? null }, exec)
        }
        case 'stop': {
          const state = advancePhase(host, agent, active, 'STOPPED', {
            status: 'stopped by the agent',
            current_task: 'report the stop reason and the best evidence gathered',
            next_action: NEXT_STEP.STOPPED,
            stopReason: args.stop_reason ?? 'agent-requested stop',
          })
          exec.concludeTurn()
          return withDashboard({ phase: state.phase, stop_reason: state.stop_reason ?? null }, exec)
        }
        default: {
          // Budget enforcement (maxPierRounds / campaignWallTimeMin) lives entirely inside
          // advancePhase(); it may silently redirect this PLAN request to STOPPED. Whatever it
          // actually produced is what gets reported back — never re-implement the check here.
          const state = advancePhase(host, agent, active, 'PLAN', {
            status: 'reflecting; next PLAN round pending',
            current_task: 'revise the hypothesis blocks',
            next_action: NEXT_STEP.PLAN,
          })
          return withDashboard({ phase: state.phase, stop_reason: state.stop_reason ?? null }, exec)
        }
      }
    },
  }))

  tools.register(defineTool({
    name: 'pbfuzz_callgraph',
    description: 'Query the static call graph through the active analysis provider: callers / callees of a function, the function at a `file:line`, or critical branch locations.',
    parameters: {
      op: { type: 'string', enum: ['callers', 'callees', 'function_at', 'critical'], required: true },
      fn: { type: 'string', description: 'Function name (callers/callees) or `file:line` (function_at).' },
    },
    output: jsonTool,
    async execute(args, exec) {
      const provider = await preparedProvider(activeOrThrow(exec))
      const needFn = (): string => { if (args.fn === undefined) throw new Error(`op ${args.op} needs \`fn\``); return args.fn }
      switch (args.op) {
        case 'callers': return withDashboard({ results: await provider.callers(needFn()) }, exec)
        case 'callees': return withDashboard({ results: await provider.callees(needFn()) }, exec)
        case 'function_at': return withDashboard({ results: [await provider.functionAt(needFn()) ?? null] }, exec)
        default: return withDashboard({ results: await provider.criticalLocations() }, exec)
      }
    },
  }))

  tools.register(defineTool({
    name: 'pbfuzz_corpus',
    description: 'Corpus analysis over the campaign seeds: how many seeds reach the target and by which call-stack routes (basis for base_seed parameters).',
    parameters: {},
    output: jsonTool,
    async execute(_args, exec) {
      const active = activeOrThrow(exec)
      return withDashboard(await engineCall('corpus.analyze', corpusAnalyzeParams(active.path, seedsDirOf(active, exec)), exec), exec)
    },
  }))

  tools.register(defineTool({
    name: 'pbfuzz_extract_parameters',
    description: 'Run model-written extractor code over reaching seeds (in a sandboxed subprocess) to derive a parameter space.',
    parameters: { extractor_code: { type: 'string', required: true, description: 'Python source defining `extract_parameters(file_path: str) -> dict` (a reaching seed\'s path in, a ParameterSpace dict out).' } },
    output: jsonTool,
    async execute(args, exec) {
      const active = activeOrThrow(exec)
      // Reaching seeds: the campaign's seeds directory, else the reaching inputs fuzzing produced.
      const seedsDir = seedsDirOf(active, exec)
      const reaching = seedsDir === undefined ? reachingTestcases(active.layout.testcasesDir) : []
      if (seedsDir === undefined && reaching.length === 0) {
        throw new Error('nothing to extract from: the campaign has no seeds directory (analysis.corpus.seeds_dir) and no fuzz session has produced a reaching input yet; run pbfuzz_fuzz first or add seeds')
      }
      const path = writeArtifact(active.layout.dir, 'extractors', 'py', args.extractor_code)
      const params = paramsExtractParams(path, seedsDir !== undefined ? { seedsDir } : { inputs: reaching })
      return withDashboard(await engineCall('params.extract', params, exec), exec)
    },
  }))

  tools.register(defineTool({
    name: 'pbfuzz_trace',
    description: 'Run one input under the breakpoint tracer and report per-breakpoint hits, call stacks and inline expressions.',
    parameters: {
      input: { type: 'string', required: true, description: 'Path to the input file.' },
      breakpoints: { type: 'json', required: true, description: 'Array of {location: "file:line", hit_limit?, inline_expr?, print_call_stack?}.' },
    },
    output: jsonTool,
    async execute(args, exec) {
      const active = activeOrThrow(exec)
      if (!Array.isArray(args.breakpoints)) throw new Error('`breakpoints` must be an array')
      return withDashboard(await engineCall('trace.run', {
        campaignPath: active.path,
        input: host.resolvePath(agentOf(exec), args.input),
        breakpoints: args.breakpoints,
        ...tracerParam(active.campaign.tracer ?? host.settings().tools.tracer),
        debuggerPaths: debuggerPaths(host.settings()),
      }, exec), exec)
    },
  }))

  tools.register(defineTool({
    name: 'pbfuzz_deviation',
    description: 'Find where an execution left the path toward the target: the first critical branch taken the wrong way (static analysis on), or how far it got (target_only).',
    parameters: {
      input: { type: 'string', required: true },
      extra_bp: { type: 'json', description: 'Optional extra breakpoints to trace.' },
    },
    output: jsonTool,
    async execute(args, exec) {
      const active = activeOrThrow(exec)
      // Deviation degrades to target_only without static analysis, so a provider that cannot be
      // prepared is reported as no critical locations rather than failing the whole call.
      const critical = await preparedProvider(active).then(async p => await p.criticalLocations()).catch(() => [])
      return withDashboard(await engineCall('deviation.run', {
        campaignPath: active.path,
        input: host.resolvePath(agentOf(exec), args.input),
        // DeviationRunParams: without criticalLocations the engine degrades to target_only itself.
        ...critical.length > 0 ? { criticalLocations: critical } : {},
        ...tracerParam(active.campaign.tracer ?? host.settings().tools.tracer),
        ...args.extra_bp !== undefined ? { extraBreakpoints: args.extra_bp } : {},
        debuggerPaths: debuggerPaths(host.settings()),
      }, exec), exec)
    },
  }))
}

/**
 * The `tracer` RPC parameter. The engine enum has no `off` (an off tracer hides these tools),
 * so `off` is omitted rather than sent.
 * @param tracer - campaign or settings tracer.
 * @returns a spreadable parameter fragment.
 */
export function tracerParam(tracer: string): { tracer?: string } {
  return tracer === 'off' ? {} : { tracer }
}

/**
 * Reaching inputs the engine saved (`testcases/…_reached` / `…_triggered`), oldest name first.
 * @param dir - the campaign's testcases directory.
 * @returns absolute paths; empty when none exist yet.
 */
export function reachingTestcases(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && /_(reached|triggered)$/.test(e.name))
      .map(e => join(dir, e.name))
      .sort()
  } catch {
    return []
  }
}

/** Write model-written code under the campaign dir with a unique name; returns its path. */
/**
 * The generator this `pbfuzz_fuzz` call runs: fresh inline source (saved as a new artifact), or a
 * file an earlier call saved and the model has since fixed with `edit`.
 * @param active - the campaign; inline source is saved under its `generators/`.
 * @param args - exactly one of `generator_code` / `generator_path`.
 * @returns the generator's absolute path.
 */
function resolveGenerator(active: ActiveCampaign, args: { generator_code?: string; generator_path?: string }): string {
  const code = args.generator_code
  const path = args.generator_path
  if ((code === undefined) === (path === undefined)) {
    throw new Error('pbfuzz_fuzz: give exactly one of generator_code (new source) or generator_path (a generator an earlier call saved, fixed in place)')
  }
  if (code !== undefined) return writeArtifact(active.layout.dir, 'generators', 'py', code)
  if (!existsSync(path!) || !statSync(path!).isFile()) throw new Error(`pbfuzz_fuzz: generator_path ${path!} is not a file`)
  return path!
}

/** `plan.parameter_space`, or an empty space when the plan does not have one (validation says so). */
function planSpace(plan: unknown): ParameterSpace {
  const space = typeof plan === 'object' && plan !== null ? (plan as { parameter_space?: unknown }).parameter_space : undefined
  return (typeof space === 'object' && space !== null ? space : {}) as ParameterSpace
}

function writeArtifact(dir: string, sub: string, ext: string, content: string): string {
  const target = join(dir, sub)
  mkdirSync(target, { recursive: true })
  const path = join(target, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
  writeFileSync(path, content)
  return path
}
