/**
 * `pbfuzz_reflect` (tools.ts): concludes one PIER round. `success` requires real engine evidence
 * FROM THIS ROUND (metrics.json's last_session.triggered > 0, matching campaign_id/pier_round, and
 * a poc.input_path matching last_session.first_triggering_input) before it will advance to SUCCESS
 * — fsm-attack F3: a bare lifetime triggered_count > 0 would still pass on a stale, earlier round's
 * evidence; `stop` ends the campaign; `next_round` requests PLAN and reports back whatever
 * `advancePhase`'s budget enforcement actually produced (possibly STOPPED) without re-implementing
 * that check here.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { PbfuzzHost, type ActiveCampaign, type AgentLike } from '../src/host.ts'
import { advancePhase } from '../src/state-writer.ts'
import { settings } from './fixtures.ts'
import { captureTools } from './tool-harness.ts'

function agentIn(cwd: string): AgentLike {
  return { id: `agent:${cwd}`, session: { header: { cwd } }, ctx: { tools: { restrict: () => () => {} } } }
}

const newHost = (over: Parameters<typeof settings>[0] = {}): PbfuzzHost =>
  new PbfuzzHost(() => settings(over), { info() {}, warn() {} }, () => new Set<string>(PBFUZZ_TOOLS))

/** A confirmed campaign walked all the way to REFLECT (round 1 just completed). */
function reflectPhaseCampaign(host: PbfuzzHost, agent: AgentLike): ActiveCampaign {
  const root = agent.session.header.cwd!
  const dir = join(root, '.pbfuzz', 'tr1')
  mkdirSync(join(dir, 'state'), { recursive: true })
  const active = host.save(agent, {
    version: 1,
    id: 'tr1',
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
  advancePhase(host, agent, active, 'EXECUTE', { status: 's', current_task: 't', next_action: 'n' })
  advancePhase(host, agent, active, 'REFLECT', { status: 's', current_task: 't', next_action: 'n' })
  return active
}

function workspace(): { root: string; agent: AgentLike } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-reflect-tool-')))
  return { root, agent: agentIn(root) }
}

/** A minimal exec with a spyable `concludeTurn`. */
function execWithConcludeSpy(agent: AgentLike): { agent: AgentLike; signal: AbortSignal; concludeTurn(): void; deferContext(): void; calls: number } {
  const state = { calls: 0 }
  return {
    agent,
    signal: new AbortController().signal,
    concludeTurn: () => { state.calls++ },
    deferContext: () => {},
    get calls() { return state.calls },
  }
}

/** `metrics.json` as the caller wants it: `triggeredCount` is the lifetime cumulative counter
 * (`triggered_count`), and `round` optionally attaches a `last_session`/`campaign_id`/`pier_round`
 * matching one real fuzz session, exactly what fsm-attack F3's cross-check now requires — omitting
 * it (the old fixture shape) leaves `last_session` absent, i.e. "no evidence for any round". */
function writeMetrics(active: ActiveCampaign, triggeredCount: number, round?: {
  pierRound: number
  campaignId?: string
  triggered: number
  firstTriggeringInput?: string
  reproducedOk?: number
}): void {
  writeFileSync(active.layout.metricsFile, JSON.stringify({
    total_iterations: 10,
    total_reached_count: 5,
    triggered_count: triggeredCount,
    ...round === undefined ? {} : {
      campaign_id: round.campaignId ?? active.campaign.id,
      pier_round: round.pierRound,
      last_session: {
        triggered: round.triggered,
        ...round.firstTriggeringInput === undefined ? {} : { first_triggering_input: round.firstTriggeringInput },
        ...round.reproducedOk === undefined ? {} : { reproduced_times: 3, reproduced_ok: round.reproducedOk },
      },
    },
  }))
}

describe('pbfuzz_reflect tool', () => {
  it('success with no poc: every field comes from the engine\'s own record of the trigger', async () => {
    // The model used to supply input_path/run_cmd/parameters — which meant reading metrics.json,
    // crashes/ and iterations.jsonl by hand first (three bash steps in session ea916c42), only for
    // this tool to cross-check the path against metrics.json anyway.
    const host = newHost()
    const { agent } = workspace()
    const active = reflectPhaseCampaign(host, agent)
    const pocPath = join(active.layout.dir, 'crashes', 'poc_round0_s1_stage1_iter1')
    writeMetrics(active, 1, { pierRound: 0, triggered: 1, firstTriggeringInput: pocPath, reproducedOk: 3 })
    const session = join(active.layout.dir, 'runs', 'session-0001')
    mkdirSync(session, { recursive: true })
    writeFileSync(join(session, 'iterations.jsonl'), [
      JSON.stringify({ type: 'iter_result', iter: 1, stage: 1, parameters: { n: 7, seed: 1 }, reached: 1, triggered: 1, size: 64, signal: 'SIGABRT' }),
      '{"torn": ',
    ].join('\n'))
    const reflect = captureTools(host).get('pbfuzz_reflect')!
    const result = await reflect.execute({ decision: 'success' }, execWithConcludeSpy(agent)) as { phase: string; poc: unknown }
    expect(result.phase).toBe('SUCCESS')
    expect(result.poc).toEqual({ input_path: pocPath, run_cmd: `./toy ${pocPath}`, parameters: { n: 7, seed: 1 }, reproduced_times: 3 })
  })

  it.each([
    ['metrics.json records no trigger', (active: ActiveCampaign) => { writeMetrics(active, 0) }],
    ['no metrics.json at all', () => {}],
  ])('success: refuses to advance without real engine evidence (%s)', async (_case, seedMetrics) => {
    const host = newHost()
    const { agent } = workspace()
    const active = reflectPhaseCampaign(host, agent)
    seedMetrics(active)
    const reflect = captureTools(host).get('pbfuzz_reflect')!
    await expect(reflect.execute({
      decision: 'success',
      poc: { input_path: '/tmp/poc.bin', run_cmd: './toy @@' },
    }, execWithConcludeSpy(agent))).rejects.toThrow(/triggered_count=0/)
    expect(host.state(active)?.phase).toBe('REFLECT')
  })

  it('success: advances to SUCCESS with the poc and calls concludeTurn when metrics show a real trigger', async () => {
    const host = newHost()
    const { agent } = workspace()
    const active = reflectPhaseCampaign(host, agent) // round 1 just completed: state.pier_round === 1
    const poc = { input_path: '/tmp/poc.bin', run_cmd: './toy @@' }
    // The fuzz.run that produced this REFLECT read pier_round off state.json BEFORE the
    // EXECUTE->REFLECT bump (state-writer.ts's advancePhase), so round 1's own metrics carry
    // pier_round=0 even though state.json now reads pier_round=1 — see tools.ts's `expectedRound`.
    writeMetrics(active, 3, { pierRound: 0, triggered: 3, firstTriggeringInput: poc.input_path, reproducedOk: 3 })
    const reflect = captureTools(host).get('pbfuzz_reflect')!
    const exec = execWithConcludeSpy(agent)
    const result = await reflect.execute({ decision: 'success', poc }, exec) as { phase: string; poc: { reproduced_times?: number } }
    expect(result.phase).toBe('SUCCESS')
    // `reproduced_times` is not an input — the agent used to run the target by hand to invent one.
    // The engine re-ran the triggering input itself and that count is stamped on here.
    expect(result.poc).toEqual({ ...poc, reproduced_times: 3 })
    expect(host.state(active)?.phase).toBe('SUCCESS')
    expect(host.state(active)?.poc).toEqual({ ...poc, reproduced_times: 3 })
    expect(exec.calls).toBe(1)
  })

  it('success: rejects a fabricated success call backed by stale metrics from an earlier round (fsm-attack F3)', async () => {
    const host = newHost({ budget: { maxPierRounds: 10 } })
    const { agent } = workspace()
    const active = reflectPhaseCampaign(host, agent) // round 1 completed, state.pier_round === 1
    const realRound1Poc = '/tmp/round1-poc.bin'
    // Round 1 genuinely triggered: metrics.json shows a real trigger for round 1 (pier_round=0).
    writeMetrics(active, 1, { pierRound: 0, triggered: 1, firstTriggeringInput: realRound1Poc })
    const reflect = captureTools(host).get('pbfuzz_reflect')!
    // The agent takes next_round instead of claiming success — round 2 starts, but metrics.json
    // is never touched again (the model never calls pbfuzz_fuzz for round 2, so the file is
    // still round 1's).
    await reflect.execute({ decision: 'next_round' }, execWithConcludeSpy(agent)) // REFLECT -> PLAN
    advancePhase(host, agent, active, 'IMPLEMENT', { status: 's', current_task: 't', next_action: 'n' })
    advancePhase(host, agent, active, 'EXECUTE', { status: 's', current_task: 't', next_action: 'n' })
    advancePhase(host, agent, active, 'REFLECT', { status: 's', current_task: 't', next_action: 'n' }) // now state.pier_round === 2
    // The model calls success in round 2, honestly reusing round 1's own (real) poc — the stale
    // last_session.triggered=1 and matching first_triggering_input alone would pass; only the
    // pier_round cross-check catches that this evidence is not from the round that just concluded.
    await expect(reflect.execute({
      decision: 'success',
      poc: { input_path: realRound1Poc, run_cmd: './toy @@' },
    }, execWithConcludeSpy(agent))).rejects.toThrow(/CURRENT campaign and round/)
    expect(host.state(active)?.phase).toBe('REFLECT')
  })

  it('success: rejects when poc.input_path does not match the engine\'s own recorded evidence', async () => {
    const host = newHost()
    const { agent } = workspace()
    const active = reflectPhaseCampaign(host, agent)
    writeMetrics(active, 1, { pierRound: 0, triggered: 1, firstTriggeringInput: '/tmp/real-poc.bin' })
    const reflect = captureTools(host).get('pbfuzz_reflect')!
    await expect(reflect.execute({
      decision: 'success',
      poc: { input_path: '/tmp/fabricated-poc.bin', run_cmd: './toy @@' },
    }, execWithConcludeSpy(agent))).rejects.toThrow(/poc matching the engine's own evidence/)
    expect(host.state(active)?.phase).toBe('REFLECT')
  })

  it.each([
    ['the given reason', { stop_reason: 'gave up: no reaching input after 5 rounds' }, 'gave up: no reaching input after 5 rounds'],
    ['"agent-requested stop" when none is given', {}, 'agent-requested stop'],
  ])('stop: advances to STOPPED recording %s', async (_case, extra, expected) => {
    const host = newHost()
    const { agent } = workspace()
    const active = reflectPhaseCampaign(host, agent)
    const reflect = captureTools(host).get('pbfuzz_reflect')!
    const result = await reflect.execute({ decision: 'stop', ...extra }, execWithConcludeSpy(agent)) as { phase: string; stop_reason: string }
    expect(result.phase).toBe('STOPPED')
    expect(result.stop_reason).toBe(expected)
    expect(host.state(active)?.stop_reason).toBe(expected)
  })

  it('next_round: within budget, moves back to PLAN and bumps nothing extra beyond what advancePhase does', async () => {
    const host = newHost({ budget: { maxPierRounds: 5 } })
    const { agent } = workspace()
    const active = reflectPhaseCampaign(host, agent)
    const reflect = captureTools(host).get('pbfuzz_reflect')!
    const result = await reflect.execute({ decision: 'next_round' }, execWithConcludeSpy(agent)) as { phase: string }
    expect(result.phase).toBe('PLAN')
    expect(host.state(active)?.phase).toBe('PLAN')
  })

  it('next_round: past the round budget, reports STOPPED without the tool re-implementing the check', async () => {
    const host = newHost({ budget: { maxPierRounds: 1 } })
    const { agent } = workspace()
    const active = reflectPhaseCampaign(host, agent) // this REFLECT completed round 1, already at budget
    const reflect = captureTools(host).get('pbfuzz_reflect')!
    const result = await reflect.execute({ decision: 'next_round' }, execWithConcludeSpy(agent)) as { phase: string; stop_reason: string }
    expect(result.phase).toBe('STOPPED')
    expect(result.stop_reason).toMatch(/PIER round budget exhausted/)
    expect(host.state(active)?.phase).toBe('STOPPED')
  })

  it('rejects when called with no active campaign', async () => {
    const host = newHost()
    const { agent } = workspace()
    const reflect = captureTools(host).get('pbfuzz_reflect')!
    await expect(reflect.execute({ decision: 'stop' }, execWithConcludeSpy(agent))).rejects.toThrow(/no active pbfuzz campaign/)
  })
})
