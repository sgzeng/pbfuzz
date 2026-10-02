/**
 * `pbfuzz_fuzz` (tools.ts) and its shared `finishFuzz` helper: validates the plan and the generator
 * (with a real preflight) in ONE pass and reports every problem together, writes fuzz_plan.json only
 * once all of it passes, drives the IMPLEMENT->EXECUTE hop itself, then runs `fuzz.run` foreground or background
 * — both paths share `finishFuzz` so the EXECUTE->REFLECT phase-advance logic is never duplicated.
 * The engine is stubbed (`vi.spyOn(host.engine, 'call'/'onProgress')`); no real Python sidecar.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { PbfuzzHost, type ActiveCampaign, type AgentLike } from '../src/host.ts'
import { advancePhase } from '../src/state-writer.ts'
import { ENGINE_CANCELLED, finishFuzz } from '../src/tools.ts'
import { settings } from './fixtures.ts'
import { captureTools, fakeExec } from './tool-harness.ts'

/** The producer face DSH >= 0.2 hands `JobSpec.run()`; `append()` is how a producer feeds the output ring. */
interface FakeJobHandle { id: string; append(text: string, options?: unknown): void; updateProgress(line: string): void }
function fakeJobHandle(): { handle: FakeJobHandle; appended: string[] } {
  const appended: string[] = []
  return { appended, handle: { id: 'pbfuzz_fuzz-1', append: (text) => { appended.push(text) }, updateProgress() {} } }
}

function agentIn(cwd: string): AgentLike {
  return { id: `agent:${cwd}`, session: { header: { cwd } }, ctx: { tools: { restrict: () => () => {} } } }
}

const newHost = (over: Parameters<typeof settings>[0] = {}): PbfuzzHost =>
  new PbfuzzHost(() => settings(over), { info() {}, warn() {} }, () => new Set<string>(PBFUZZ_TOOLS))

/** A confirmed campaign walked to IMPLEMENT (PLAN blocks are not this tool's concern). */
function implementPhaseCampaign(host: PbfuzzHost, agent: AgentLike, id = 'tf1'): ActiveCampaign {
  const root = agent.session.header.cwd!
  const dir = join(root, '.pbfuzz', id)
  mkdirSync(join(dir, 'state'), { recursive: true })
  const active = host.save(agent, {
    version: 1,
    id,
    confirmed: true,
    target: { repo: root, language: 'c' },
    bug: { targets: [{ location: 'toy.c:1' }] },
    entry: { kind: 'executable', run_cmd: './toy @@', input_channel: 'file' },
    oracle: { mode: 'canary', reached_pattern: 'REACHED', triggered_pattern: 'TRIGGERED' },
    tracer: 'off',
    output: { dir },
  } as never, [])
  host.ensureInitState(active)
  advancePhase(host, agent, active, 'PLAN', { status: 's', current_task: 't', next_action: 'n' })
  advancePhase(host, agent, active, 'IMPLEMENT', { status: 's', current_task: 't', next_action: 'n' })
  return active
}

function workspace(): { root: string; agent: AgentLike } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-fuzz-tool-')))
  return { root, agent: agentIn(root) }
}

const VALID_PLAN = {
  parameter_space: { n: { type: 'int_range', min: 0, max: 100 } },
  next_batch_plan: [],
  breakpoints: [],
}

const fuzzRunOk = (triggered = 0) => ({
  summary: { totalIterations: 10, reachedCount: 5, triggeredCount: triggered, stoppedBy: 'completed' },
  metricsPath: '/tmp/metrics.json',
})

describe('finishFuzz', () => {
  it('on success advances EXECUTE->REFLECT and reports completed', async () => {
    const host = newHost()
    const { agent } = workspace()
    const active = implementPhaseCampaign(host, agent)
    advancePhase(host, agent, active, 'EXECUTE', { status: 's', current_task: 't', next_action: 'n' })
    vi.spyOn(host.engine, 'call').mockResolvedValue(fuzzRunOk(1))

    const outcome = await finishFuzz(host, agent, active, {
      campaignPath: active.path, planPath: active.layout.fuzzPlanFile, generatorPath: '/g.py',
      runtime: {} as never, pierRound: 0, debuggerPaths: {},
    } as never, new AbortController().signal)

    expect(outcome.status).toBe('completed')
    expect(outcome.phase).toBe('REFLECT')
    expect(host.state(active)?.phase).toBe('REFLECT')
  })

  it('on a fuzz.cancel-style failure (ENGINE_CANCELLED) also advances to REFLECT, status killed', async () => {
    const host = newHost()
    const { agent } = workspace()
    const active = implementPhaseCampaign(host, agent)
    advancePhase(host, agent, active, 'EXECUTE', { status: 's', current_task: 't', next_action: 'n' })
    const err = Object.assign(new Error('cancelled'), { code: ENGINE_CANCELLED })
    vi.spyOn(host.engine, 'call').mockRejectedValue(err)

    const outcome = await finishFuzz(host, agent, active, {} as never, new AbortController().signal)
    expect(outcome.status).toBe('killed')
    expect(outcome.phase).toBe('REFLECT')
    expect(host.state(active)?.phase).toBe('REFLECT')
  })

  it('on an aborted signal, treats it as killed even without ENGINE_CANCELLED', async () => {
    const host = newHost()
    const { agent } = workspace()
    const active = implementPhaseCampaign(host, agent)
    advancePhase(host, agent, active, 'EXECUTE', { status: 's', current_task: 't', next_action: 'n' })
    const controller = new AbortController()
    vi.spyOn(host.engine, 'call').mockImplementation(async () => { controller.abort(); throw new Error('aborted mid-call') })

    const outcome = await finishFuzz(host, agent, active, {} as never, controller.signal)
    expect(outcome.status).toBe('killed')
    expect(host.state(active)?.phase).toBe('REFLECT')
  })

  it('on a genuine engine failure, stays in EXECUTE (retryable), status failed', async () => {
    const host = newHost()
    const { agent } = workspace()
    const active = implementPhaseCampaign(host, agent)
    advancePhase(host, agent, active, 'EXECUTE', { status: 's', current_task: 't', next_action: 'n' })
    vi.spyOn(host.engine, 'call').mockRejectedValue(new Error('generator crashed'))

    const outcome = await finishFuzz(host, agent, active, {} as never, new AbortController().signal)
    expect(outcome.status).toBe('failed')
    expect(outcome.phase).toBe('EXECUTE')
    expect(host.state(active)?.phase).toBe('EXECUTE') // never advanced
  })
})

describe('pbfuzz_fuzz tool', () => {
  it('reports an invalid plan TOGETHER with what the engine found, and persists nothing', async () => {
    // Recorded in session ea916c42: the plan check threw before the engine was ever called, so the
    // generator's own failure (and then the preflight's) each cost another full resubmission.
    const host = newHost()
    const { agent } = workspace()
    const active = implementPhaseCampaign(host, agent)
    vi.spyOn(host.engine, 'call').mockImplementation(async (method) => {
      if (method === 'generator.validate') return { ok: false, issues: ['`generate` cannot take width, which the plan supplies'], samples: [] }
      throw new Error(`unexpected call: ${method}`)
    })
    const fuzz = captureTools(host).get('pbfuzz_fuzz')!

    const failure = fuzz.execute({
      plan: { parameter_space: { n: { type: 'int_range', min: 0, max: 100 } }, next_batch_plan: [{ plan_description: 'x', n: 999 }] },
      generator_code: 'def generate(**p): return b""',
    }, fakeExec(agent))
    await expect(failure).rejects.toThrow(/next_batch_plan\[0\]\.n[\s\S]*cannot take width/)
    expect(existsSync(active.layout.fuzzPlanFile)).toBe(false)
    expect(host.state(active)?.phase).toBe('IMPLEMENT')
  })

  it('names where the generator was saved, and accepts that path back after an edit', async () => {
    const host = newHost({ execution: { fuzzBackground: false } })
    const { agent } = workspace()
    implementPhaseCampaign(host, agent)
    let validates = 0
    vi.spyOn(host.engine, 'call').mockImplementation(async (method) => {
      if (method === 'generator.validate') return ++validates === 1 ? { ok: false, samples: [{ source: 'sample(seed=1)', error: 'boom' }] } : { ok: true, samples: [] }
      if (method === 'fuzz.run') return fuzzRunOk(0)
      throw new Error(`unexpected call: ${method}`)
    })
    const fuzz = captureTools(host).get('pbfuzz_fuzz')!
    const rejected = await fuzz.execute({ plan: VALID_PLAN, generator_code: 'def generate(**p): return b""' }, fakeExec(agent)).catch((e: Error) => e.message)
    const saved = /saved at (\S+\.py)\./.exec(rejected as string)?.[1]
    expect(saved).toBeDefined()
    expect(existsSync(saved!)).toBe(true)
    // The retry sends a path, not the code again.
    const result = await fuzz.execute({ plan: VALID_PLAN, generator_path: saved }, fakeExec(agent)) as { kind: string; generatorPath: string }
    expect(result.kind).toBe('completed')
    expect(result.generatorPath).toBe(saved)
  })

  it('refuses both or neither of generator_code / generator_path', async () => {
    const host = newHost()
    const { agent } = workspace()
    implementPhaseCampaign(host, agent)
    const fuzz = captureTools(host).get('pbfuzz_fuzz')!
    await expect(fuzz.execute({ plan: VALID_PLAN }, fakeExec(agent))).rejects.toThrow(/exactly one of generator_code/)
    await expect(fuzz.execute({ plan: VALID_PLAN, generator_code: 'x', generator_path: '/x.py' }, fakeExec(agent))).rejects.toThrow(/exactly one of generator_code/)
  })

  it('a preflight miss states what the target was actually fed: the size is usually the answer', async () => {
    // session ea916c42: the engine knew the input was 56 bytes; the model only saw the stderr, and
    // spent five bash steps compiling a probe to discover sizeof(ELFHeader) is 64.
    const host = newHost()
    const { agent } = workspace()
    implementPhaseCampaign(host, agent)
    vi.spyOn(host.engine, 'call').mockImplementation(async (method) => {
      if (method === 'generator.validate') return {
        ok: false,
        samples: [{
          source: 'next_batch_plan[0]', params: { ei_class: 2 }, size: 56, preview: '7f454c46020201',
          reach: { ranTarget: true, reached: false, exitCode: 1, durationMs: 12, stderrTail: 'Error: Cannot read ELF header' },
        }],
      }
      throw new Error(`unexpected call: ${method}`)
    })
    const fuzz = captureTools(host).get('pbfuzz_fuzz')!
    await expect(fuzz.execute({ plan: VALID_PLAN, generator_code: 'def generate(**p): return b""' }, fakeExec(agent)))
      .rejects.toThrow(/56 bytes \(7f454c46020201…\) → exit 1 in 12 ms; stderr: Error: Cannot read ELF header/)
  })

  it('surfaces a TARGET_FAILED reach.error/diagnosis (target could not be run) even with no top-level sample.error', async () => {
    const host = newHost()
    const { agent } = workspace()
    implementPhaseCampaign(host, agent)
    vi.spyOn(host.engine, 'call').mockImplementation(async (method) => {
      if (method === 'generator.validate') return {
        ok: false,
        samples: [{
          source: 'next_batch_plan[0]',
          params: { n: 5 },
          size: 4,
          reach: { ranTarget: false, error: 'binary not found', diagnosis: 'build the target first' },
        }],
      }
      throw new Error(`unexpected call: ${method}`)
    })
    const fuzz = captureTools(host).get('pbfuzz_fuzz')!
    await expect(fuzz.execute({ plan: VALID_PLAN, generator_code: 'def generate(**p): return b""' }, fakeExec(agent)))
      .rejects.toThrow(/binary not found.*build the target first/s)
  })

  it('passes campaignPath to generator.validate for the real preflight', async () => {
    const host = newHost({ execution: { fuzzBackground: false } })
    const { agent } = workspace()
    const active = implementPhaseCampaign(host, agent)
    let sentParams: Record<string, unknown> | undefined
    vi.spyOn(host.engine, 'call').mockImplementation(async (method, params) => {
      if (method === 'generator.validate') { sentParams = params as Record<string, unknown>; return { ok: true, samples: [] } }
      if (method === 'fuzz.run') return fuzzRunOk(0)
      throw new Error(`unexpected call: ${method}`)
    })
    const fuzz = captureTools(host).get('pbfuzz_fuzz')!
    await fuzz.execute({ plan: VALID_PLAN, generator_code: 'def generate(**p): return b""' }, fakeExec(agent))
    expect(sentParams?.campaignPath).toBe(active.path)
  })

  it('foreground when execution.fuzzBackground is off: resolves synchronously with the completed result and advances to REFLECT', async () => {
    const host = newHost({ execution: { fuzzBackground: false } })
    const { agent } = workspace()
    const active = implementPhaseCampaign(host, agent)
    vi.spyOn(host.engine, 'call').mockImplementation(async (method) => {
      if (method === 'generator.validate') return { ok: true, samples: [] }
      if (method === 'fuzz.run') return fuzzRunOk(2)
      throw new Error(`unexpected call: ${method}`)
    })
    const fuzz = captureTools(host).get('pbfuzz_fuzz')!
    const result = await fuzz.execute({ plan: VALID_PLAN, generator_code: 'def generate(**p): return b""' }, fakeExec(agent)) as { kind: string; phase: string }
    expect(result.kind).toBe('completed')
    expect(result.phase).toBe('REFLECT')
    expect(host.state(active)?.phase).toBe('REFLECT')
  })

  it('foreground when headless, even with fuzzBackground on', async () => {
    const host = newHost({ execution: { fuzzBackground: true }, onboarding: { interviewPolicy: 'never' } })
    const { agent } = workspace()
    implementPhaseCampaign(host, agent)
    vi.spyOn(host.engine, 'call').mockImplementation(async (method) => {
      if (method === 'generator.validate') return { ok: true, samples: [] }
      if (method === 'fuzz.run') return fuzzRunOk(0)
      throw new Error(`unexpected call: ${method}`)
    })
    const fuzz = captureTools(host).get('pbfuzz_fuzz')!
    const result = await fuzz.execute({ plan: VALID_PLAN, generator_code: 'def generate(**p): return b""' }, fakeExec(agent)) as { kind: string }
    expect(result.kind).toBe('completed')
  })

  it('background when interactive and fuzzBackground is on: starts a job and returns immediately (advance happens once the job settles)', async () => {
    const host = newHost({ execution: { fuzzBackground: true } })
    const { agent } = workspace()
    const active = implementPhaseCampaign(host, agent)
    let resolveFuzzRun!: (v: unknown) => void
    vi.spyOn(host.engine, 'call').mockImplementation(async (method) => {
      if (method === 'generator.validate') return { ok: true, samples: [] }
      if (method === 'fuzz.run') return new Promise(resolve => { resolveFuzzRun = resolve })
      throw new Error(`unexpected call: ${method}`)
    })
    vi.spyOn(host.engine, 'onProgress').mockReturnValue(() => {})
    type Spec = { kind: string; label: string; owner?: unknown; run(job: FakeJobHandle): { done: Promise<unknown> } }
    const started: Spec[] = []
    const jobs = {
      start: (spec: Spec) => {
        started.push(spec)
        spec.run(fakeJobHandle().handle) // exercise the producer closure the way the real registry would
        return 'pbfuzz_fuzz-1'
      },
    }
    const fuzz = captureTools(host, { jobs }).get('pbfuzz_fuzz')!
    const result = await fuzz.execute({ plan: VALID_PLAN, generator_code: 'def generate(**p): return b""' }, fakeExec(agent)) as { kind: string; jobId: string }

    expect(result.kind).toBe('background')
    expect(result.jobId).toBe('pbfuzz_fuzz-1')
    expect(started).toHaveLength(1)
    // DSH >= 0.2: a job is owned by a session id, not by the Agent object.
    expect(started[0]!.owner).toBe(agent.id)
    // The tool call itself already moved IMPLEMENT->EXECUTE before starting the job.
    expect(host.state(active)?.phase).toBe('EXECUTE')

    resolveFuzzRun(fuzzRunOk(1))
    await new Promise(r => setTimeout(r, 0))
    expect(host.state(active)?.phase).toBe('REFLECT')
  })

  it('a finished background job states what the round found — in its detail (which the completion notice quotes) and in job_output', async () => {
    // session ea916c42: the job's output shadowed its final result, so job_output could never
    // return it, and the notice carried only counts. The model spent five steps polling and then
    // reading metrics.json / crashes/ / iterations.jsonl by hand.
    const host = newHost({ execution: { fuzzBackground: true } })
    const { agent } = workspace()
    const active = implementPhaseCampaign(host, agent)
    let resolveFuzzRun!: (v: unknown) => void
    vi.spyOn(host.engine, 'call').mockImplementation(async (method) => {
      if (method === 'generator.validate') return { ok: true, samples: [] }
      if (method === 'fuzz.run') return new Promise(resolve => { resolveFuzzRun = resolve })
      throw new Error(`unexpected call: ${method}`)
    })
    let progress!: (n: { method: string; params: unknown }) => void
    vi.spyOn(host.engine, 'onProgress').mockImplementation((cb) => { progress = cb as typeof progress; return () => {} })
    let producer!: { done: Promise<{ detail: string }> }
    const output = fakeJobHandle()
    const jobs = { start: (spec: { run(job: FakeJobHandle): typeof producer }) => { producer = spec.run(output.handle); return 'pbfuzz_fuzz-1' } }
    const fuzz = captureTools(host, { jobs }).get('pbfuzz_fuzz')!
    await fuzz.execute({ plan: VALID_PLAN, generator_code: 'def generate(**p): return b""' }, fakeExec(agent))

    // What the engine leaves on disk for a round that triggered on its first iteration.
    const poc = join(active.layout.dir, 'crashes', 'poc_round0_s1_stage1_iter1')
    writeFileSync(active.layout.metricsFile, JSON.stringify({
      campaign_id: active.campaign.id, pier_round: 0, triggered_count: 1,
      last_session: { iterations: 1, reached: 1, triggered: 1, stopped_by: 'trigger', first_triggering_input: poc, reproduced_times: 3, reproduced_ok: 3 },
    }))
    mkdirSync(join(active.layout.dir, 'runs', 'session-0001'), { recursive: true })
    writeFileSync(join(active.layout.dir, 'runs', 'session-0001', 'iterations.jsonl'), `${JSON.stringify({
      type: 'iter_result', iter: 1, stage: 1, parameters: { n: 7 }, reached: 1, triggered: 1, size: 64, signal: 'SIGABRT', exit_code: -6,
      trace: { breakpoints: [{ location: 'toy.c:1', hitTimes: 1, resolved: true }, { location: 'toy.c:9', hitTimes: 0, resolved: false }] },
    })}\n`)
    // Engine progress streams into the job's output ring through the producer handle (DSH >= 0.2).
    progress({ method: 'iteration', params: { n: 1 } })
    progress({ method: 'log', params: 'engine chatter' })
    expect(output.appended.join('')).toBe('iteration: {"n":1}\n')
    resolveFuzzRun(fuzzRunOk(1))
    const settled = await producer.done

    // `detail` is what both the completion notice and every job_output read (`[status: ...,
    // <detail>]`) carry, so it is the one place the digest goes — not also the progress buffer,
    // which made a job_output read in session 06151e3f state it twice.
    const text = settled.detail
    expect(text).toContain(`PoC: ${poc} — the engine re-ran it: 3/3 reproduced`)
    expect(text).toContain('64 bytes, SIGABRT (exit -6), params {"n":7}')
    expect(text).toContain('breakpoints hit: toy.c:1 ×1')
    expect(text).toContain('never bound')
    expect(text).toContain('next: pbfuzz_reflect')
    expect(output.appended.join('')).not.toContain('PoC:')
  })

  it('throws when background is selected but no job registry is available', async () => {
    const host = newHost({ execution: { fuzzBackground: true } })
    const { agent } = workspace()
    implementPhaseCampaign(host, agent)
    vi.spyOn(host.engine, 'call').mockImplementation(async (method) => {
      if (method === 'generator.validate') return { ok: true, samples: [] }
      throw new Error(`unexpected call: ${method}`)
    })
    const fuzz = captureTools(host).get('pbfuzz_fuzz')! // no `jobs` service supplied
    await expect(fuzz.execute({ plan: VALID_PLAN, generator_code: 'def generate(**p): return b""' }, fakeExec(agent)))
      .rejects.toThrow(/background jobs unavailable/)
  })

  it('a retry call already in EXECUTE does not re-request the IMPLEMENT->EXECUTE transition', async () => {
    const host = newHost({ execution: { fuzzBackground: false } })
    const { agent } = workspace()
    const active = implementPhaseCampaign(host, agent)
    advancePhase(host, agent, active, 'EXECUTE', { status: 's', current_task: 't', next_action: 'n' })
    vi.spyOn(host.engine, 'call').mockImplementation(async (method) => {
      if (method === 'generator.validate') return { ok: true, samples: [] }
      if (method === 'fuzz.run') return fuzzRunOk(0)
      throw new Error(`unexpected call: ${method}`)
    })
    const fuzz = captureTools(host).get('pbfuzz_fuzz')!
    const result = await fuzz.execute({ plan: VALID_PLAN, generator_code: 'def generate(**p): return b""' }, fakeExec(agent)) as { kind: string }
    expect(result.kind).toBe('completed') // did not throw IllegalTransitionError
  })
})
