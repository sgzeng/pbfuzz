/**
 * Model-facing `kanalyzer_*` tools: thin wrappers over `ctx.kanalyzer`.
 *
 * @module @pbfuzz/dsh-kanalyzer/host/tools
 */

import type { Context } from '@deepseek-ai/cordis'
// Named, not just an ambient merge: dsh-agent's own declaration merge (this import pulls it in)
// is what makes the imported `Agent` the real live-runtime shape — `session`, `ctx`, `status`, … —
// rather than the bare `{ id }` its own public type alone declares; `dsh-tools` imports it the
// same way for `ToolRunContext.agent`, which is why that field is already typed as `Agent` there.
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type InferArgs, type InferValue, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AnalyzeRequest, AnalyzeResult, PrepareRequest, QueryRequest } from '../api.ts'
import { criticalBranchesForDisplay } from '../core/status.ts'
import type { JobCaller } from './runtime.ts'

const OPEN_OBJECT = { type: 'object', additionalProperties: true } as const

/** The value `defineTool` infers for {@link OPEN_OBJECT}: a JSON object. */
type JsonObject = InferValue<typeof OPEN_OBJECT>

const jsonOutput = {
  schema: OPEN_OBJECT,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

/**
 * Normalise a service result into the tool's JSON output. The round trip drops `undefined`
 * fields and anything else non-JSON, so the value really is what the output schema claims.
 * @param value - a `ctx.kanalyzer` result (a plain object by contract).
 * @returns the JSON object.
 */
function toJsonObject(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

const STRING_LIST = { type: 'array', items: { type: 'string' } } as const

/**
 * The calling tool's agent and cancellation signal, in the shape `KanalyzerRuntime.prepare()` /
 * `.analyze()` take as {@link JobCaller} — so the job those methods register is owned by the
 * caller's session (visible/killable/disposal-cleaned as theirs) and aborts if the tool call does.
 * @param exec - the tool's run context.
 * @returns the caller identity to thread into `asJob()`.
 */
function jobCaller(exec: ToolRunContext): JobCaller {
  return { agent: exec.agent, signal: exec.signal }
}

/**
 * The workspace directory the calling agent's session was created in — `kanalyzer_analyze`'s
 * default for `outputDir` — via the real `Session`/`SessionHeader` shape `Agent.session` carries
 * (no session-package import needed: it is not among this package's peer dependencies, and this
 * plugin only ever reads it through the already-typed `Agent`).
 * @param agent - the calling tool execution's agent, when there is one.
 * @returns the session's absolute cwd, when the store recorded one.
 */
function sessionCwd(agent: Agent | undefined): string | undefined {
  return agent?.session.header.cwd
}

const PREPARE_PARAMS = {
  repo: { type: 'string', required: true, description: 'Absolute path to the project checkout.' },
  buildCmd: { type: 'string', required: true, description: 'Shell command that builds the project, run as-is (e.g. "bash build.sh" or "./configure && make"). Do not add -j; do not prepend a clean step.' },
  mode: { type: 'string', required: true, enum: ['lto', 'wllvm'] },
  cwd: { type: 'string', description: 'Directory to run buildCmd in; defaults to repo. Must be inside repo.' },
  program: { type: 'string', description: 'Basename of the link output of interest.' },
  ltoLibs: { ...STRING_LIST, description: 'Absolute paths of static LTO dependency archives.' },
  env: { ...STRING_LIST, description: 'Extra environment as KEY=VALUE strings. "MAKEFLAGS=" turns off the automatic -j.' },
  isolate: { type: 'boolean', description: 'Build in an isolated copy at <repo>/.kanalyzer/tree with sanitizers stripped (default true). false builds in your own tree with the project\'s own flags, which overwrites its binaries and leaves sanitizer noise in the analysis.' },
  force: { type: 'boolean', description: 'Ignore the source-freshness cache and rebuild the isolated tree from scratch.' },
  waitSec: { type: 'integer', description: 'How long to wait before detaching and returning a job id instead of the result (default 10).' },
} as const

/**
 * Parse `KEY=VALUE` environment strings (`kanalyzer_prepare`'s `env` parameter) into a plain
 * record; a pair with no `=` becomes an empty-valued entry.
 * @param pairs - `KEY=VALUE` strings.
 * @returns the parsed environment.
 */
function parseEnvPairs(pairs: readonly string[]): Record<string, string> {
  return Object.fromEntries(pairs.map((kv) => {
    const i = kv.indexOf('=')
    return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]
  }))
}

/**
 * Build the `ctx.kanalyzer.prepare()` request from `kanalyzer_prepare`'s validated arguments.
 * `defineTool` already validated everything here — the one real transform left is `env`'s
 * `KEY=VALUE` strings becoming a record.
 * @param args - validated arguments (see {@link PREPARE_PARAMS}).
 * @returns the prepare request.
 */
function toPrepareRequest(args: InferArgs<typeof PREPARE_PARAMS>): PrepareRequest {
  return {
    repo: args.repo, buildCmd: args.buildCmd, mode: args.mode,
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    ...(args.program !== undefined ? { program: args.program } : {}),
    ...(args.ltoLibs !== undefined ? { ltoLibs: args.ltoLibs } : {}),
    ...(args.env !== undefined ? { env: parseEnvPairs(args.env) } : {}),
  }
}

/**
 * Default `kanalyzer_analyze`'s `outputDir` to the calling session's workspace when the model
 * left it unset. `args` already matches {@link AnalyzeRequest} field-for-field — see the
 * `parameters` schema on the tool below — so this is the one real transform: folding in a value
 * the schema itself cannot supply.
 * @param request - the validated request.
 * @param cwd - the calling session's workspace directory, when known.
 * @returns the request `ctx.kanalyzer.analyze()` receives.
 */
function withDefaultOutputDir(request: AnalyzeRequest, cwd: string | undefined): AnalyzeRequest {
  return request.outputDir === undefined && cwd !== undefined && cwd !== '' ? { ...request, outputDir: cwd } : request
}

const QUERY_PARAMS = {
  op: { type: 'string', required: true, enum: ['callers', 'callees', 'functionAt', 'critical', 'branches', 'distances', 'functions', 'reach'] },
  bitcode: { type: 'string', required: true },
  fn: { type: 'string' },
  location: { type: 'string' },
  file: { type: 'string' },
  limit: { type: 'integer' },
} as const

/**
 * Build the `ctx.kanalyzer.query()` discriminated request from `kanalyzer_query`'s validated,
 * flat arguments. This is a genuine transform, not a cast: each `op` needs a different field
 * subset, which the flat parameter schema (one `op` sibling, not an `oneOf` keyed by it) cannot
 * itself express.
 * @param args - validated arguments (see {@link QUERY_PARAMS}).
 * @returns the discriminated query request.
 * @throws when the op's required field (`location` for `functionAt`, `fn` for callers/callees) is missing.
 */
function toQueryRequest(args: InferArgs<typeof QUERY_PARAMS>): QueryRequest {
  if (args.op === 'reach') {
    if (args.location === undefined && args.fn === undefined) throw new Error('reach needs `location` (file:line) or `fn`')
    return {
      op: args.op,
      bitcode: args.bitcode,
      ...(args.location !== undefined ? { location: args.location } : {}),
      ...(args.fn !== undefined ? { fn: args.fn } : {}),
    }
  }
  if (args.op === 'functionAt') {
    if (args.location === undefined) throw new Error('functionAt needs `location` (file:line)')
    return { op: args.op, bitcode: args.bitcode, location: args.location }
  }
  if (args.op === 'critical') {
    return args.fn !== undefined ? { op: args.op, bitcode: args.bitcode, fn: args.fn } : { op: args.op, bitcode: args.bitcode }
  }
  if (args.op === 'branches') {
    return {
      op: args.op,
      bitcode: args.bitcode,
      ...(args.fn !== undefined ? { fn: args.fn } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    }
  }
  // `distances`/`functions` scan the whole distance dump; every narrowing field is optional, so
  // omit rather than pass `undefined` — the request union spells these as optional properties.
  if (args.op === 'distances') {
    return {
      op: args.op,
      bitcode: args.bitcode,
      ...(args.fn !== undefined ? { fn: args.fn } : {}),
      ...(args.file !== undefined ? { file: args.file } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    }
  }
  if (args.op === 'functions') {
    return { op: args.op, bitcode: args.bitcode, ...(args.limit !== undefined ? { limit: args.limit } : {}) }
  }
  if (args.fn === undefined) throw new Error(`${args.op} needs \`fn\``)
  return { op: args.op, bitcode: args.bitcode, fn: args.fn }
}

/** How long `kanalyzer_prepare` blocks before handing back a job id instead of a result. */
const DEFAULT_PREPARE_WAIT_SEC = 10

/** What {@link settleWithin} observed: the value, or that the work is still running. */
type Settled<T> = { done: true; value: T } | { done: false }

/**
 * Wait for `work`, but give up waiting after `ms`.
 *
 * A failure *before* the deadline still rejects, so a broken build is reported exactly as it was
 * before; one *after* it is already owned by the job, which reports it through its own completion
 * notice — hence the detached catch, which exists only so a late rejection is not unhandled.
 * @param work - the in-flight result.
 * @param ms - how long to wait.
 * @returns the value when it arrived in time.
 */
async function settleWithin<T>(work: Promise<T>, ms: number): Promise<Settled<T>> {
  const tracked = work.then((value): Settled<T> => ({ done: true, value }))
  tracked.catch(() => { /* a late failure is reported through the job */ })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      tracked,
      new Promise<Settled<T>>((settle) => { timer = setTimeout(() => { settle({ done: false }) }, ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The analysis as the model should see it.
 *
 * `criticalBranches` is the whole point of an analysis and also, on a real target, 22,020 entries
 * sorted by file name — so the tool result's first 50 KB used to be nothing but unresolved
 * `bid:` placeholders while the target's own branches sat in the omitted middle. The service
 * result is untouched: only this rendering is capped, nearest-to-target first, with counts so the
 * model knows what it is not seeing and can ask `kanalyzer_query` for the rest.
 * @param result - the full analysis.
 * @returns the payload the tool returns.
 */
function forDisplay(result: AnalyzeResult): object {
  const shown = criticalBranchesForDisplay(result.criticalBranches)
  return {
    ...result,
    criticalBranches: shown.branches,
    criticalBranchesTotal: shown.total,
    criticalBranchesShown: shown.shown,
    criticalBranchesUnresolved: shown.unresolved,
    criticalBranchesTruncated: shown.truncated,
  }
}

/**
 * Register the four tools against a context that has `tools` and `kanalyzer`.
 * @param ctx - context from `ctx.inject(['tools', 'kanalyzer'], …)`.
 */
export function registerTools(ctx: Context): void {
  const k = ctx.kanalyzer

  ctx.tools.register(defineTool({
    name: 'kanalyzer_doctor',
    description: 'Debug a failing or suspect analysis: compiles the bundled sample with LTO, analyses it, and verifies target resolution, the call graph, critical branches and no-target detection. Also refreshes the kanalyzer status shown in settings. This is NOT a routine first step — it costs a full sample build+analysis, the settings card\'s Self-test button and /kanalyzer doctor run it for the operator, and pbfuzz campaigns run it once inside pbfuzz_campaign selfcheck. Call it when a run looks broken (prepare produces no bitcode, analyze errors, an unreachable/no_target verdict contradicts the source, KAMain looks missing) or when the user asks.',
    parameters: {},
    output: jsonOutput,
    async execute() { return toJsonObject(await k.doctor()) },
  }))

  ctx.tools.register(defineTool({
    name: 'kanalyzer_prepare',
    description: 'Build a C/C++ project into the whole-program LLVM bitcode KAMain analyses (it reads neither source nor executables). By default the build runs in an isolated copy at <repo>/.kanalyzer/tree with every sanitizer flag stripped and -O0 -g -fPIC forced, so your own build tree and binaries are untouched and the analysis is not swamped by sanitizer check branches; a compiler-name shim on PATH means a build script that hardcodes CC=clang works unpatched, so pass the project\'s own build command as-is and never prepend a clean step. Parallelism is set for you. mode "wllvm" (default) wraps the compiler and needs `program`; mode "lto" is faster and needs no extract-bc. Static libraries the program links must be LTO archives listed in ltoLibs, or the call graph is silently truncated. Returns the bitcode path, inferred entries (LLVMFuzzerTestOneInput, else main), the tree it built in and a note to relay to the user. Waits waitSec (default 10) and then returns {jobId, status:"running"}: follow it with job_output, which streams compile progress and finally the same result as RESULT {json}. An identical repeat call against an unchanged tree returns the previous bitcode in seconds (cached: true).',
    parameters: PREPARE_PARAMS,
    output: jsonOutput,
    async execute(args, exec) {
      const started = k.prepareJob(toPrepareRequest(args), jobCaller(exec), {
        ...(args.isolate !== undefined ? { isolate: args.isolate } : {}),
        ...(args.force !== undefined ? { force: args.force } : {}),
      })
      // With no job registry there is nothing to detach to, so the only honest option is to wait.
      if (started.jobId === undefined) return toJsonObject(await started.result)
      const settled = await settleWithin(started.result, Math.max(1, args.waitSec ?? DEFAULT_PREPARE_WAIT_SEC) * 1000)
      if (settled.done) return toJsonObject(settled.value)
      return toJsonObject({
        jobId: started.jobId,
        status: 'running',
        ...(started.tree !== undefined ? { tree: started.tree } : {}),
        hint: `The build is still running as job ${started.jobId}. You are notified when it finishes; job_output ${started.jobId} shows compile progress now and the final RESULT {json} afterwards. Do not start it again — get on with something else in the meantime.`,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kanalyzer_analyze',
    description: 'Run KAMain reachability analysis. targets are file:line locations that must carry an instruction (not a comment/declaration/brace); matching is basename-substring + exact line. Returns status ok | no_target | unreachable | error (derived from verbose stderr and the dumps, never the exit code), resolved target blocks, critical branches with source locations, function counts, and unresolved[].nearbyCandidates when a line resolved to nothing. The raw dump files are delivered to outputDir — by default the session workspace (current directory) — and the result names that directory in outputDir and lists exactly which files are there in dumpFiles. criticalBranches here is capped at the 150 nearest the target (criticalBranchesTotal/Shown/Unresolved/Truncated say what was left out); use kanalyzer_query critical/branches/distances for the rest. Cached; long-running (runs as a job).',
    parameters: {
      bitcode: { type: 'string', required: true, description: 'Absolute path to a *.0.0.preopt.bc from kanalyzer_prepare.' },
      targets: { ...STRING_LIST, required: true, description: 'Target locations as file:line.' },
      entries: { ...STRING_LIST, description: 'Entry functions; default is KAMain\'s main / LLVMFuzzerTestOneInput inference.' },
      callStackLen: { type: 'integer' },
      typeBasedCallgraph: { type: 'boolean', description: 'true = signature-based call graph (default), false = TyPM/MLTA (precise, slow).' },
      dumps: {
        type: 'object', additionalProperties: false,
        properties: {
          policy: { type: 'boolean' }, distance: { type: 'boolean' }, criticalBranch: { type: 'boolean' },
          bidMappingAndFuncInfo: { type: 'boolean' }, callerCalleeBothWays: { type: 'boolean' }, annotatedIr: { type: 'boolean' },
        },
      },
      timeoutSec: { type: 'integer' },
      force: { type: 'boolean', description: 'Ignore the cache.' },
      outputDir: { type: 'string', description: 'Absolute directory the raw dump files are delivered to; defaults to this session\'s workspace (current directory).' },
    },
    output: jsonOutput,
    async execute(args, exec) {
      const request = withDefaultOutputDir(args, sessionCwd(exec.agent))
      return toJsonObject(forDisplay(await k.analyze(request, jobCaller(exec))))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'kanalyzer_query',
    description: 'Query the call graph, block locations and distance-to-target of analysed bitcode. **To answer "can this line reach the target?", use op=reach (location or fn) — one call, and it distinguishes the three things an empty distance table can mean.** Its verdicts: reaches(d) = KAMain computed a distance, a static path exists; exit_only = every block is marked -1 (leads to a program exit; with sanitizer-instrumented bitcode usually its own abort stub); no_distance = blocks exist but carry no distance — NOT proof of unreachability, because the distance pass skips indirect call sites with >50 type-compatible candidates (nginx\'s `ph->handler(r)` dispatch is one), never propagates through return edges, and stops at the call-stack-length limit; no_block = the line owns no instruction after optimisation, which says nothing about reachability. reach also reports block coverage and, when there is no distance, call-graph evidence. Other ops: callers/callees (fn) — a type-based superset, not a path proof; functionAt (file:line); critical (critical-branch locations, optionally within fn); branches (branch polarity — which successor still reaches the target and at what distance, which only reaches an exit); distances (per-block table nearest-first; narrow with fn and/or file); functions (every reached function with its nearest distance). An empty result carries a note saying what it does and does not prove — relay that, never report "unreachable" from an empty table. Results are capped (default 500 rows, 200 for distances) with truncated:true; pass limit to change that. Read the answers from here rather than opening the dump files.',
    parameters: QUERY_PARAMS,
    output: jsonOutput,
    async execute(args) {
      return toJsonObject(await k.query(toQueryRequest(args)))
    },
  }))
}
