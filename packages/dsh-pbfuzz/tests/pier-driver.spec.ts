import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { campaignToYaml } from '../src/core/campaign-yaml.ts'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { PbfuzzHost, type AgentLike } from '../src/host.ts'
import { installPierDriver } from '../src/pier-driver.ts'
import { settings } from './fixtures.ts'

// ---- fakes ----------------------------------------------------------------

interface FakeJobs {
  onJobDone(cb: (snapshot: unknown, owner: unknown) => void): () => void
  list(agent: unknown): { kind: string; status: string }[]
  fire(snapshot: unknown, owner: unknown): void
}
function fakeJobs(running: { kind: string; status: string }[] = []): FakeJobs {
  let doneCb: ((snapshot: unknown, owner: unknown) => void) | undefined
  return {
    onJobDone: (cb) => { doneCb = cb; return () => {} },
    list: () => running,
    fire: (snapshot, owner) => { doneCb?.(snapshot, owner) },
  }
}

interface FakeCommands {
  calls: { agent: unknown; line: string }[]
  execute(agent: unknown, line: string, attachments: unknown[], signal: AbortSignal): Promise<unknown>
}
function fakeCommands(): FakeCommands {
  const calls: { agent: unknown; line: string }[] = []
  return { calls, execute: async (agent, line) => { calls.push({ agent, line }); return undefined } }
}

/** A `commands.execute()` fake whose promise settles only when the test calls `settle()`/`reject()`
 * — lets a test mutate `host` between "dispatch" (the `execute()` call) and "delivery" (the promise
 * settling), exactly the gap `installPierDriver`'s headless-bootstrap listener has to guard. */
interface DeferredCommands extends FakeCommands {
  /** Resolve the oldest still-pending `execute()` call. */
  settle(result?: unknown): void
  /** Reject the oldest still-pending `execute()` call. */
  reject(error: Error): void
}
function deferredCommands(): DeferredCommands {
  const calls: { agent: unknown; line: string }[] = []
  const pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []
  return {
    calls,
    execute: (agent, line) => {
      calls.push({ agent, line })
      return new Promise((resolve, reject) => { pending.push({ resolve, reject }) })
    },
    settle: (result = { commandId: 'c1', result: { kind: 'success' } }) => { pending.shift()?.resolve(result) },
    reject: (error) => { pending.shift()?.reject(error) },
  }
}

type Listener = (payload: never) => unknown
function fakeCtx(jobs?: FakeJobs, commands?: FakeCommands): { ctx: unknown; emit(event: string, payload: unknown): void; warnings: string[] } {
  const listeners = new Map<string, Listener[]>()
  const warnings: string[] = []
  const ctx = {
    on(event: string, cb: Listener) {
      const arr = listeners.get(event) ?? []
      arr.push(cb)
      listeners.set(event, arr)
      return () => {}
    },
    get(name: string) {
      if (name === 'jobs') return jobs
      if (name === 'commands') return commands
      return undefined
    },
    inject(deps: string[], cb: (jctx: unknown) => void) {
      if (deps[0] === 'jobs' && jobs !== undefined) cb({ jobs })
    },
    logger: { info() {}, warn: (msg: string) => { warnings.push(msg) } },
  }
  return { ctx, emit: (event, payload) => { for (const l of listeners.get(event) ?? []) l(payload as never) }, warnings }
}

/** Flush the microtask queue so a `.then()` chained onto a fake command's promise has run. */
async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function fakeAgent(cwd: string, status: 'idle' | 'running' = 'idle'): { agent: unknown; steered: unknown[]; followedUp: unknown[] } {
  const steered: unknown[] = []
  const followedUp: unknown[] = []
  const agent = {
    id: `agent:${cwd}`,
    session: { header: { cwd } },
    status,
    ctx: { systemPrompt: { section: (def: { text: () => string }) => { agentSections.set(agent, def); return () => {} } } },
    steer: (m: unknown) => { steered.push(m) },
    followup: (m: unknown) => { followedUp.push(m) },
  }
  return { agent, steered, followedUp }
}
const agentSections = new WeakMap<object, { name: string; order: number; text: () => string }>()

// ---- workspace --------------------------------------------------------------

/** A campaign directory (yaml + state cursor) under an existing root, without touching the
 * workspace's `active` pointer — lets a test add a *second* campaign to a workspace that already
 * has one bound and active, to simulate the active campaign changing out from under an agent. */
function campaignAt(root: string, id: string, phase: string, confirmed = true): { dir: string; stateFile: string; yamlPath: string } {
  const dir = join(root, '.pbfuzz', id)
  mkdirSync(join(dir, 'state'), { recursive: true })
  const yamlPath = join(dir, 'pbfuzz.campaign.yaml')
  writeFileSync(yamlPath, campaignToYaml({
    version: 1,
    id,
    confirmed,
    target: { repo: root, language: 'c' },
    bug: { targets: [{ location: 'toy.c:1' }] },
    entry: { kind: 'executable', run_cmd: './toy @@', input_channel: 'file' },
    oracle: { mode: 'canary', reached_pattern: 'REACHED', triggered_pattern: 'TRIGGERED' },
    tracer: 'off',
    output: { dir },
  } as never))
  const stateFile = join(dir, 'state', 'state.json')
  writeFileSync(stateFile, JSON.stringify({ campaign_id: id, phase, status: 's', current_task: 't', next_action: 'n', pier_round: 0 }))
  return { dir, stateFile, yamlPath }
}

function workspace(phase: string, confirmed = true): { root: string; dir: string; stateFile: string; yamlPath: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-pier-')))
  const { dir, stateFile, yamlPath } = campaignAt(root, 'p1', phase, confirmed)
  writeFileSync(join(root, '.pbfuzz', 'active'), `${dir}\n`)
  return { root, dir, stateFile, yamlPath }
}

const newHost = (over: Parameters<typeof settings>[0] = {}): PbfuzzHost =>
  new PbfuzzHost(() => settings(over), { info() {}, warn() {} }, () => new Set<string>(PBFUZZ_TOOLS), {})

const agentLike = (v: unknown): AgentLike => v as AgentLike

describe('installPierDriver: agent/turn-stopping nudge', () => {
  it('steers with a next-step instruction for an active, confirmed, non-terminal campaign', () => {
    const { root } = workspace('PLAN')
    const host = newHost()
    const fake = fakeCtx()
    installPierDriver(fake.ctx as never, host)
    const { agent, steered } = fakeAgent(root)
    fake.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    expect(steered).toHaveLength(1)
    const message = steered[0] as { content: { text: string }[]; source: { form: string } }
    expect(message.content[0]?.text).toContain('continue the PIER loop')
    expect(message.source.form).toBe('instructions')
  })

  it('names the campaign id and the pier round the nudge was computed for', () => {
    const { root } = workspace('PLAN')
    const host = newHost()
    const fake = fakeCtx()
    installPierDriver(fake.ctx as never, host)
    const { agent, steered } = fakeAgent(root)
    fake.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    const message = steered[0] as { content: { text: string }[] }
    // workspace('PLAN') writes state.json with campaign_id 'p1' and pier_round 0.
    expect(message.content[0]?.text).toContain('campaign p1')
    expect(message.content[0]?.text).toContain('round 0')
  })

  it('does nothing with no active campaign', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-pier-none-')))
    const host = newHost()
    const fake = fakeCtx()
    installPierDriver(fake.ctx as never, host)
    const { agent, steered } = fakeAgent(root)
    fake.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    expect(steered).toHaveLength(0)
  })

  it('does nothing when budget.autoContinue is off', () => {
    const { root } = workspace('PLAN')
    const host = newHost({ budget: { autoContinue: false } })
    const fake = fakeCtx()
    installPierDriver(fake.ctx as never, host)
    const { agent, steered } = fakeAgent(root)
    fake.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    expect(steered).toHaveLength(0)
  })

  it('does nothing in a terminal phase (SUCCESS/STOPPED)', () => {
    for (const phase of ['SUCCESS', 'STOPPED']) {
      const { root } = workspace(phase)
      const host = newHost()
      const fake = fakeCtx()
      installPierDriver(fake.ctx as never, host)
      const { agent, steered } = fakeAgent(root)
      fake.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
      expect(steered).toHaveLength(0)
    }
  })

  it('does nothing in INIT while the campaign is not yet confirmed', () => {
    const { root } = workspace('INIT', false)
    const host = newHost()
    const fake = fakeCtx()
    installPierDriver(fake.ctx as never, host)
    const { agent, steered } = fakeAgent(root)
    fake.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    expect(steered).toHaveLength(0)
  })

  it('does nothing while a pbfuzz_fuzz job is running for this agent', () => {
    const { root } = workspace('EXECUTE')
    const host = newHost()
    const jobs = fakeJobs([{ kind: 'pbfuzz_fuzz', status: 'running' }])
    const fake = fakeCtx(jobs)
    installPierDriver(fake.ctx as never, host)
    const { agent, steered } = fakeAgent(root)
    fake.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    expect(steered).toHaveLength(0)
  })
})

describe('installPierDriver: consecutive-forced-continue cap', () => {
  it('interactive: stops nudging after the cap, without writing STOPPED', () => {
    const { root, stateFile } = workspace('PLAN')
    const host = newHost({ budget: { maxConsecutiveForcedContinues: 2 } })
    const fake = fakeCtx()
    installPierDriver(fake.ctx as never, host)
    const { agent, steered } = fakeAgent(root)
    for (let i = 0; i < 5; i++) fake.emit('agent/turn-stopping', { agent, turn: i, signal: new AbortController().signal })
    expect(steered).toHaveLength(2) // 1st and 2nd nudge; 3rd exceeds the cap and stops nudging
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).phase).toBe('PLAN') // never rewritten to STOPPED
  })

  it('headless: writes STOPPED once the cap is exceeded', () => {
    const { root, stateFile, yamlPath } = workspace('PLAN')
    const host = newHost({ budget: { maxConsecutiveForcedContinues: 1 } })
    const fake = fakeCtx()
    installPierDriver(fake.ctx as never, host)
    const { agent, steered } = fakeAgent(root)
    // Bind this workspace's campaign as headless (mirrors runHeadless()'s own host.load(..., true)).
    host.load(agentLike(agent), yamlPath, true)
    for (let i = 0; i < 4; i++) fake.emit('agent/turn-stopping', { agent, turn: i, signal: new AbortController().signal })
    expect(steered).toHaveLength(1)
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { phase: string; stop_reason: string }
    expect(state.phase).toBe('STOPPED')
    expect(state.stop_reason).toContain('consecutive forced-continue cap')
  })

  it('a real user message re-arms the counter', () => {
    const { root } = workspace('PLAN')
    const host = newHost({ budget: { maxConsecutiveForcedContinues: 1 } })
    const fake = fakeCtx()
    installPierDriver(fake.ctx as never, host)
    const { agent, steered } = fakeAgent(root)
    fake.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal }) // count 1: nudges
    fake.emit('agent/turn-stopping', { agent, turn: 2, signal: new AbortController().signal }) // count 2 > cap: stops
    expect(steered).toHaveLength(1)
    fake.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } })
    fake.emit('agent/turn-stopping', { agent, turn: 3, signal: new AbortController().signal }) // re-armed: count 1 again
    expect(steered).toHaveLength(2)
  })

  it('agent/error also re-arms the counter', () => {
    const { root } = workspace('PLAN')
    const host = newHost({ budget: { maxConsecutiveForcedContinues: 1 } })
    const fake = fakeCtx()
    installPierDriver(fake.ctx as never, host)
    const { agent, steered } = fakeAgent(root)
    fake.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    fake.emit('agent/turn-stopping', { agent, turn: 2, signal: new AbortController().signal })
    expect(steered).toHaveLength(1)
    fake.emit('agent/error', { agent, turn: 2, step: 1, error: new Error('x') })
    fake.emit('agent/turn-stopping', { agent, turn: 3, signal: new AbortController().signal })
    expect(steered).toHaveLength(2)
  })
})

describe('installPierDriver: job-done wakeup fallback', () => {
  it('follows up an idle, unreported, still-active owner', () => {
    const { root } = workspace('EXECUTE')
    const host = newHost()
    const jobs = fakeJobs()
    const fake = fakeCtx(jobs)
    installPierDriver(fake.ctx as never, host)
    const { agent, followedUp } = fakeAgent(root, 'idle')
    jobs.fire({ kind: 'pbfuzz_fuzz', reported: false }, agent)
    expect(followedUp).toHaveLength(1)
    const message = followedUp[0] as { source: { form: string; summary: string } }
    expect(message.source.form).toBe('notice')
  })

  it('ignores a non-pbfuzz_fuzz job, an unowned job, an already-reported one, or a non-idle owner', () => {
    const { root } = workspace('EXECUTE')
    const host = newHost()
    const jobs = fakeJobs()
    const fake = fakeCtx(jobs)
    installPierDriver(fake.ctx as never, host)
    const { agent: idleAgent, followedUp: f1 } = fakeAgent(root, 'idle')
    const { agent: runningAgent, followedUp: f2 } = fakeAgent(root, 'running')
    jobs.fire({ kind: 'bash', reported: false }, idleAgent)
    jobs.fire({ kind: 'pbfuzz_fuzz', reported: false }, undefined)
    jobs.fire({ kind: 'pbfuzz_fuzz', reported: true }, idleAgent)
    jobs.fire({ kind: 'pbfuzz_fuzz', reported: false }, runningAgent)
    expect(f1).toHaveLength(0)
    expect(f2).toHaveLength(0)
  })
})

describe('installPierDriver: headless /pbfuzz run bootstrap', () => {
  it('dispatches "/pbfuzz run <path>" through the real command registry, once per user message', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-pier-headless-')))
    const host = newHost()
    const commands = fakeCommands()
    const fake = fakeCtx(undefined, commands)
    installPierDriver(fake.ctx as never, host)
    const { agent } = fakeAgent(root)
    fake.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: [{ type: 'text', text: '/pbfuzz run /abs/c.yaml' }] } })
    expect(commands.calls).toEqual([{ agent, line: '/pbfuzz run /abs/c.yaml' }])
  })

  it('translates the natural-language "run campaign <path>" into the same command line', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-pier-headless-')))
    const host = newHost()
    const commands = fakeCommands()
    const fake = fakeCtx(undefined, commands)
    installPierDriver(fake.ctx as never, host)
    const { agent } = fakeAgent(root)
    fake.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'run campaign /abs/c.yaml' }] } })
    expect(commands.calls).toEqual([{ agent, line: '/pbfuzz run /abs/c.yaml' }])
  })

  it('never dispatches for a non-matching message or a non-user source', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-pier-headless-')))
    const host = newHost()
    const commands = fakeCommands()
    const fake = fakeCtx(undefined, commands)
    installPierDriver(fake.ctx as never, host)
    const { agent } = fakeAgent(root)
    fake.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello there' }] } })
    fake.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'tool', callId: 'x' }, content: [{ type: 'text', text: '/pbfuzz run /abs/c.yaml' }] } })
    expect(commands.calls).toHaveLength(0)
  })
})

describe('installPierDriver: headless dispatch staleness guard', () => {
  it('drops the settlement and logs when a different campaign became active while the dispatch was in flight', async () => {
    const { root } = workspace('PLAN') // binds 'p1' as this workspace's active campaign
    const p2 = campaignAt(root, 'p2', 'PLAN')
    const host = newHost()
    const commands = deferredCommands()
    const fake = fakeCtx(undefined, commands)
    installPierDriver(fake.ctx as never, host)
    const { agent } = fakeAgent(root)
    fake.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: [{ type: 'text', text: '/pbfuzz run /abs/c.yaml' }] } })
    expect(commands.calls).toHaveLength(1) // dispatched — this is where `host.active(agent)` snapshots 'p1'
    host.load(agentLike(agent), p2.yamlPath, true) // the workspace's active campaign changes mid-flight
    commands.settle() // "delivery": runHeadless's self-check finally finishes
    await flushMicrotasks()
    expect(fake.warnings.some(w => w.includes('active campaign changed from p1 to p2'))).toBe(true)
  })

  it('drops the settlement and logs when the active campaign disappears while the dispatch was in flight', async () => {
    const { root, yamlPath } = workspace('PLAN')
    const host = newHost()
    const commands = deferredCommands()
    const fake = fakeCtx(undefined, commands)
    installPierDriver(fake.ctx as never, host)
    const { agent } = fakeAgent(root)
    fake.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: [{ type: 'text', text: '/pbfuzz run /abs/c.yaml' }] } })
    expect(commands.calls).toHaveLength(1)
    rmSync(yamlPath) // the workspace's active campaign disappears mid-flight
    commands.settle()
    await flushMicrotasks()
    expect(fake.warnings.some(w => w.includes('active campaign changed from p1 to none'))).toBe(true)
  })

  it('does nothing when the active campaign is unchanged at settlement', async () => {
    const { root } = workspace('PLAN')
    const host = newHost()
    const commands = deferredCommands()
    const fake = fakeCtx(undefined, commands)
    installPierDriver(fake.ctx as never, host)
    const { agent } = fakeAgent(root)
    fake.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: [{ type: 'text', text: '/pbfuzz run /abs/c.yaml' }] } })
    commands.settle()
    await flushMicrotasks()
    expect(fake.warnings).toHaveLength(0)
  })

  it('drops the older settlement when a second run dispatch supersedes it before the first settles', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-pier-headless-')))
    const host = newHost()
    const commands = deferredCommands()
    const fake = fakeCtx(undefined, commands)
    installPierDriver(fake.ctx as never, host)
    const { agent } = fakeAgent(root)
    fake.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: [{ type: 'text', text: '/pbfuzz run /abs/first.yaml' }] } })
    fake.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: [{ type: 'text', text: '/pbfuzz run /abs/second.yaml' }] } })
    expect(commands.calls).toHaveLength(2)
    commands.settle() // second dispatch's promise (FIFO queue) settles first
    commands.settle() // first dispatch's promise settles last, after being superseded
    await flushMicrotasks()
    expect(fake.warnings.some(w => w.includes('superseded by a later run dispatch'))).toBe(true)
  })

  it('logs a rejected dispatch instead of swallowing it', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-pier-headless-')))
    const host = newHost()
    const commands = deferredCommands()
    const fake = fakeCtx(undefined, commands)
    installPierDriver(fake.ctx as never, host)
    const { agent } = fakeAgent(root)
    fake.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'user' }, content: [{ type: 'text', text: '/pbfuzz run /abs/c.yaml' }] } })
    commands.reject(new Error('registry unavailable'))
    await flushMicrotasks()
    expect(fake.warnings.some(w => w.includes('registry unavailable'))).toBe(true)
  })
})

describe('installPierDriver: no system-prompt section', () => {
  /**
   * The driver used to register a `ctx.systemPrompt.section()` whose text carried the phase and
   * PIER round. That text changed at every transition, and DSH re-projects the whole system
   * prompt (and starts a new request series) when it does — six such transitions in one recorded
   * single-round campaign cost ~470k fully-uncached input tokens. Phase and next step already
   * reach the model through every phase-owning tool's result, the job-completion notice, and the
   * nudge below, so the section is gone and must stay gone.
   */
  it('registers no systemPrompt section for a new agent, campaign or not', () => {
    const { root } = workspace('PLAN')
    const host = newHost()
    const fake = fakeCtx()
    installPierDriver(fake.ctx as never, host)
    const { agent } = fakeAgent(root)
    fake.emit('agent/created', { agent })
    expect(agentSections.get(agent)).toBeUndefined()
  })
})
