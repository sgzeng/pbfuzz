/**
 * Task 1 (job owner/signal, at the tool layer) + Task 2 (typed `exec.agent`/`args` access,
 * no structural casts) for `host/tools.ts`.
 *
 * `registerTools()` is exercised through the real `defineTool()` wrapper (real JSON-schema
 * validation, then the real `execute` closure this module builds) against a minimal fake
 * `ctx.tools`/`ctx.kanalyzer` — not a mock of `registerTools()` itself. Only `ctx.kanalyzer`
 * (the service under I/O this suite doesn't own) and `exec.agent`'s live-runtime shape are
 * doubles; every assertion is on what the real `execute()` closures compute and forward.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import type {
  AnalyzeRequest, AnalyzeResult, PreparedBitcode, PrepareRequest, QueryRequest, QueryResult,
} from '../../src/api.ts'
import { registerTools } from '../../src/host/tools.ts'
import type { JobCaller } from '../../src/host/runtime.ts'

/** One recorded `ctx.kanalyzer` call: the request it received, plus the `JobCaller` (owner/signal) `asJob()`-backed methods received. */
interface Recorded<Req> { req: Req, caller?: JobCaller }

/** What a finished `prepareJob()` resolves to, minus the parts these tests do not assert on. */
function preparedBitcode(): PreparedBitcode {
  return {
    bitcode: '/b.bc', allBitcode: ['/b.bc'], entries: ['main'], nFuncs: 1,
    mode: 'wllvm', profile: 'analysis', warnings: [], cached: false, tree: '/repo/.kanalyzer/tree',
    note: 'built in an isolated copy',
  }
}

/** A `KanalyzerRuntime`-shaped double: only the methods the tested tools call, each recording its call. */
function fakeKanalyzer(): {
  service: {
    prepareJob: (req: PrepareRequest, caller?: JobCaller) => { jobId?: string; tree?: string; result: Promise<PreparedBitcode> }
    analyze: (req: AnalyzeRequest, caller?: JobCaller) => Promise<AnalyzeResult>
    query: (req: QueryRequest) => Promise<QueryResult>
  }
  prepareCalls: Recorded<PrepareRequest>[]
  analyzeCalls: Recorded<AnalyzeRequest>[]
  queryCalls: QueryRequest[]
} {
  const prepareCalls: Recorded<PrepareRequest>[] = []
  const analyzeCalls: Recorded<AnalyzeRequest>[] = []
  const queryCalls: QueryRequest[] = []
  return {
    prepareCalls, analyzeCalls, queryCalls,
    service: {
      prepareJob(req, caller) {
        prepareCalls.push({ req, caller })
        return { jobId: 'kanalyzer-1', tree: '/repo/.kanalyzer/tree', result: Promise.resolve(preparedBitcode()) }
      },
      async analyze(req, caller) {
        analyzeCalls.push({ req, caller })
        return { status: 'ok', targets: [], criticalBranches: [], reachableFunctions: 0, totalFunctions: 0, entriesUsed: [], outputDir: req.outputDir ?? '', dumpFiles: [], elapsedMs: 0, cached: false }
      },
      async query(req) { queryCalls.push(req); return { op: req.op, results: [], truncated: false } },
    },
  }
}

/** Registers the tools against a fake `ctx` and returns them by name. */
function registered(kanalyzer: ReturnType<typeof fakeKanalyzer>['service']): Map<string, ToolDefinition> {
  const defs = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: (def: ToolDefinition) => { defs.set(def.name, def); return () => {} } },
    kanalyzer,
  } as unknown as Context
  registerTools(ctx)
  return defs
}

/** A minimal `Agent` double: `host/tools.ts` only ever reads `.session.header.cwd` off it. */
function agentWithCwd(cwd: string | undefined): Agent {
  return { id: 'session-test', session: { header: { cwd } } } as unknown as Agent
}

/** A minimal `ToolRunContext`: `host/tools.ts`'s `execute()`s only read `.agent` and `.signal`. */
function execWith(agent: Agent | undefined, signal: AbortSignal = new AbortController().signal): ToolRunContext {
  return { agent, signal } as unknown as ToolRunContext
}

describe('kanalyzer_prepare: typed args, env transform, job owner/signal', () => {
  it('builds the PrepareRequest from validated args (parsing env KEY=VALUE pairs) and threads agent+signal', async () => {
    const k = fakeKanalyzer()
    const def = registered(k.service).get('kanalyzer_prepare')
    expect(def).toBeDefined()
    const agent = agentWithCwd(undefined)
    const signal = new AbortController().signal
    const value = await def?.execute({
      repo: '/repo', buildCmd: 'make', mode: 'lto', ltoLibs: ['/l/libz.a'], env: ['FOO=bar', 'BARE_KEY'],
    }, execWith(agent, signal))

    expect(k.prepareCalls).toHaveLength(1)
    expect(k.prepareCalls[0]?.req).toEqual({
      repo: '/repo', buildCmd: 'make', mode: 'lto', ltoLibs: ['/l/libz.a'], env: { FOO: 'bar', BARE_KEY: '' },
    })
    expect(k.prepareCalls[0]?.caller).toEqual({ agent, signal })
    expect(value).toMatchObject({ bitcode: '/b.bc' })
  })

  it('omits optional PrepareRequest fields the model left unset, rather than sending them as undefined', async () => {
    const k = fakeKanalyzer()
    const def = registered(k.service).get('kanalyzer_prepare')
    await def?.execute({ repo: '/repo', buildCmd: 'make', mode: 'wllvm' }, execWith(undefined))

    expect(k.prepareCalls[0]?.req).toEqual({ repo: '/repo', buildCmd: 'make', mode: 'wllvm' })
    expect('cwd' in (k.prepareCalls[0]?.req ?? {})).toBe(false)
    expect('env' in (k.prepareCalls[0]?.req ?? {})).toBe(false)
    expect(k.prepareCalls[0]?.caller).toEqual({ agent: undefined, signal: expect.any(AbortSignal) })
  })
})

describe('kanalyzer_analyze: typed args match AnalyzeRequest, cwd default, job owner/signal', () => {
  it('defaults outputDir from the calling session cwd when the model left it unset', async () => {
    const k = fakeKanalyzer()
    const def = registered(k.service).get('kanalyzer_analyze')
    const agent = agentWithCwd('/workspace')
    const signal = new AbortController().signal
    await def?.execute({ bitcode: '/b.bc', targets: ['a.c:1'] }, execWith(agent, signal))

    expect(k.analyzeCalls[0]?.req).toMatchObject({ bitcode: '/b.bc', targets: ['a.c:1'], outputDir: '/workspace' })
    expect(k.analyzeCalls[0]?.caller).toEqual({ agent, signal })
  })

  it('never overrides an outputDir the model set explicitly', async () => {
    const k = fakeKanalyzer()
    const def = registered(k.service).get('kanalyzer_analyze')
    await def?.execute({ bitcode: '/b.bc', targets: ['a.c:1'], outputDir: '/explicit' }, execWith(agentWithCwd('/workspace')))

    expect(k.analyzeCalls[0]?.req.outputDir).toBe('/explicit')
  })

  it('leaves outputDir unset when there is no agent (no session cwd to default from)', async () => {
    const k = fakeKanalyzer()
    const def = registered(k.service).get('kanalyzer_analyze')
    await def?.execute({ bitcode: '/b.bc', targets: ['a.c:1'] }, execWith(undefined))

    expect('outputDir' in (k.analyzeCalls[0]?.req ?? {})).toBe(false)
    expect(k.analyzeCalls[0]?.caller).toEqual({ agent: undefined, signal: expect.any(AbortSignal) })
  })
})

describe('kanalyzer_query: discriminated request built from flat validated args', () => {
  it('builds a functionAt request and requires location', async () => {
    const k = fakeKanalyzer()
    const def = registered(k.service).get('kanalyzer_query')
    await def?.execute({ op: 'functionAt', bitcode: '/b.bc', location: 'a.c:9' }, execWith(undefined))
    expect(k.queryCalls[0]).toEqual({ op: 'functionAt', bitcode: '/b.bc', location: 'a.c:9' })

    await expect(def?.execute({ op: 'functionAt', bitcode: '/b.bc' }, execWith(undefined))).rejects.toThrow(/location/)
  })

  it('builds a critical request with fn optional', async () => {
    const k = fakeKanalyzer()
    const def = registered(k.service).get('kanalyzer_query')
    await def?.execute({ op: 'critical', bitcode: '/b.bc' }, execWith(undefined))
    expect(k.queryCalls[0]).toEqual({ op: 'critical', bitcode: '/b.bc' })

    await def?.execute({ op: 'critical', bitcode: '/b.bc', fn: 'foo' }, execWith(undefined))
    expect(k.queryCalls[1]).toEqual({ op: 'critical', bitcode: '/b.bc', fn: 'foo' })
  })

  it('requires fn for callers/callees', async () => {
    const k = fakeKanalyzer()
    const def = registered(k.service).get('kanalyzer_query')
    await def?.execute({ op: 'callers', bitcode: '/b.bc', fn: 'foo' }, execWith(undefined))
    expect(k.queryCalls[0]).toEqual({ op: 'callers', bitcode: '/b.bc', fn: 'foo' })

    await expect(def?.execute({ op: 'callees', bitcode: '/b.bc' }, execWith(undefined))).rejects.toThrow(/fn/)
  })
})
