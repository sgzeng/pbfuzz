/**
 * `state-writer.ts` is the only place `state/*.json` is ever written once `guard-policy.ts`
 * denies a direct agent `write`/`edit` under the state directory (P3). These tests exercise it
 * against a real temp-directory campaign, mirroring `host-active.spec.ts`'s harness.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { campaignToYaml } from '../src/core/campaign-yaml.ts'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { PbfuzzHost, type ActiveCampaign, type AgentLike } from '../src/host.ts'
import { advancePhase, IllegalTransitionError, writeFuzzPlan, writeHypothesisBlocks } from '../src/state-writer.ts'
import { settings } from './fixtures.ts'

function agentIn(cwd: string, denied: string[][] = []): AgentLike {
  return {
    id: `agent:${cwd}`,
    session: { header: { cwd } },
    ctx: { tools: { restrict: ({ deny }) => { denied.push([...(deny ?? [])].sort()); return () => {} } } },
  }
}

const newHost = (over: Parameters<typeof settings>[0] = {}): PbfuzzHost =>
  new PbfuzzHost(() => settings(over), { info() {}, warn() {} }, () => new Set<string>(PBFUZZ_TOOLS))

/** A confirmed, bound campaign with an INIT state.json — the shape every advancePhase() call
 * starts from. */
function confirmedCampaign(host: PbfuzzHost, agent: AgentLike): ActiveCampaign {
  const root = agent.session.header.cwd!
  const dir = join(root, '.pbfuzz', 'sw1')
  mkdirSync(join(dir, 'state'), { recursive: true })
  const active = host.save(agent, {
    version: 1,
    id: 'sw1',
    confirmed: true,
    target: { repo: root, language: 'c' },
    bug: { targets: [{ location: 'toy.c:1' }] },
    entry: { kind: 'executable', run_cmd: './toy @@', input_channel: 'file' },
    oracle: { mode: 'canary', reached_pattern: 'REACHED', triggered_pattern: 'TRIGGERED' },
    tracer: 'off',
    output: { dir },
  } as never, [])
  host.ensureInitState(active)
  return active
}

function workspace(): { root: string; agent: AgentLike } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-statewriter-')))
  return { root, agent: agentIn(root) }
}

describe('writeHypothesisBlocks', () => {
  it('writes a valid single block and leaves the others untouched', () => {
    const host = newHost()
    const { agent } = workspace()
    const active = confirmedCampaign(host, agent)
    const result = writeHypothesisBlocks(active, {
      bugPredicates: [{ id: 'BP1', location: 'toy.c:10', bug_condition: 'len > size' }],
    })
    expect(result).toEqual({ ok: true, issues: [] })
    const written = JSON.parse(readFileSync(join(active.layout.stateDir, 'bug_predicates.json'), 'utf8'))
    expect(written).toEqual([{ id: 'BP1', location: 'toy.c:10', bug_condition: 'len > size' }])
  })

  it('rejects a structurally invalid block and writes nothing', () => {
    const host = newHost()
    const { agent } = workspace()
    const active = confirmedCampaign(host, agent)
    const result = writeHypothesisBlocks(active, { bugPredicates: [{ id: 'not-a-valid-id', location: 'bad' }] })
    expect(result.ok).toBe(false)
    expect(result.issues.some(i => i.path.startsWith('bugPredicates'))).toBe(true)
  })

  it('upserts by id: an entry left out is kept, and a revision carries only what changed', () => {
    // RULE_SAFE_UPDATE (never drop an id) now holds by construction. Replacing the whole file
    // meant re-sending every precondition to correct one — 1,549 output tokens in session ea916c42.
    const host = newHost()
    const { agent } = workspace()
    const active = confirmedCampaign(host, agent)
    expect(writeHypothesisBlocks(active, {
      preconditions: [{ id: 'R1', statement: 'a', status: 'unknown', evidence: [] }, { id: 'R2', statement: 'b', status: 'unknown', evidence: [] }],
    }).ok).toBe(true)
    const revised = writeHypothesisBlocks(active, { preconditions: [{ id: 'R1', status: 'verified', evidence: ['seen'] }] })
    expect(revised).toEqual({ ok: true, issues: [] })
    const onDisk = JSON.parse(readFileSync(join(active.layout.stateDir, 'preconditions.json'), 'utf8'))
    expect(onDisk).toEqual([
      { id: 'R1', statement: 'a', status: 'verified', evidence: ['seen'] },
      { id: 'R2', statement: 'b', status: 'unknown', evidence: [] },
    ])
  })

  it('a new entry must still be complete, and the issue names it by id', () => {
    const host = newHost()
    const { agent } = workspace()
    const active = confirmedCampaign(host, agent)
    const result = writeHypothesisBlocks(active, { preconditions: [{ id: 'R7', status: 'unknown' }] })
    expect(result.ok).toBe(false)
    expect(result.issues.map(i => i.path)).toContain('preconditions[R7].statement')
    expect(() => readFileSync(join(active.layout.stateDir, 'preconditions.json'), 'utf8')).toThrow()
  })

  it('an entry without an id cannot be merged, and says so', () => {
    const host = newHost()
    const { agent } = workspace()
    const active = confirmedCampaign(host, agent)
    const result = writeHypothesisBlocks(active, { preconditions: [{ statement: 'x', status: 'unknown', evidence: [] }] })
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.message).toMatch(/needs a string `id`/)
  })

  it('a multi-block call with one bad block rejects the whole call, not just the bad block', () => {
    const host = newHost()
    const { agent } = workspace()
    const active = confirmedCampaign(host, agent)
    const result = writeHypothesisBlocks(active, {
      bugPredicates: [{ id: 'BP1', location: 'toy.c:1', bug_condition: 'x' }],
      rootCauses: [{ id: 'not-valid', description: 'd', category: 'c', evidence: [] }],
    })
    expect(result.ok).toBe(false)
    // Neither block landed.
    expect(() => readFileSync(join(active.layout.stateDir, 'bug_predicates.json'), 'utf8')).toThrow()
  })
})

describe('writeFuzzPlan', () => {
  it('writes a valid plan whose next_batch_plan is in-domain', () => {
    const host = newHost()
    const { agent } = workspace()
    const active = confirmedCampaign(host, agent)
    const plan = {
      parameter_space: { entry_addr: { type: 'int_range', min: 0, max: 100 } },
      next_batch_plan: [{ plan_description: 'boundary', entry_addr: 50 }],
      breakpoints: [{ location: 'toy.c:20' }],
    }
    expect(writeFuzzPlan(active, plan)).toEqual({ ok: true, issues: [] })
    expect(JSON.parse(readFileSync(active.layout.fuzzPlanFile, 'utf8'))).toEqual(plan)
  })

  it('rejects a batch entry pinning a value outside its declared domain (the incident bug)', () => {
    const host = newHost()
    const { agent } = workspace()
    const active = confirmedCampaign(host, agent)
    const plan = {
      parameter_space: { entry_addr: { type: 'int_range', min: 0, max: 100 } },
      next_batch_plan: [{ plan_description: 'wrong', entry_addr: 8048000 }],
      breakpoints: [{ location: 'toy.c:20' }],
    }
    const result = writeFuzzPlan(active, plan)
    expect(result.ok).toBe(false)
    expect(result.issues.some(i => i.path === 'next_batch_plan[0].entry_addr')).toBe(true)
  })
})

describe('advancePhase', () => {
  it('a legal transition writes state.json and refreshes tool visibility for the agent', () => {
    const host = newHost()
    const denied: string[][] = []
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-statewriter-')))
    const agent = agentIn(root, denied)
    const active = confirmedCampaign(host, agent)
    const state = advancePhase(host, agent, active, 'PLAN', { status: 's', current_task: 't', next_action: 'n' })
    expect(state.phase).toBe('PLAN')
    expect(host.state(active)?.phase).toBe('PLAN')
    expect(denied.length).toBeGreaterThan(0) // refresh() ran and recomputed the restriction
  })

  it('throws IllegalTransitionError for a transition the FSM does not permit', () => {
    const host = newHost()
    const { agent } = workspace()
    const active = confirmedCampaign(host, agent)
    expect(() => advancePhase(host, agent, active, 'EXECUTE', { status: 's', current_task: 't', next_action: 'n' }))
      .toThrow(IllegalTransitionError)
  })

  it('REFLECT->PLAN past maxPierRounds is redirected to STOPPED with an auto stop_reason', () => {
    const host = newHost({ budget: { maxPierRounds: 1 } })
    const { agent } = workspace()
    const active = confirmedCampaign(host, agent)
    // Walk INIT -> PLAN -> IMPLEMENT -> EXECUTE -> REFLECT, completing round 1.
    advancePhase(host, agent, active, 'PLAN', { status: 's', current_task: 't', next_action: 'n' })
    advancePhase(host, agent, active, 'IMPLEMENT', { status: 's', current_task: 't', next_action: 'n' })
    advancePhase(host, agent, active, 'EXECUTE', { status: 's', current_task: 't', next_action: 'n' })
    const reflected = advancePhase(host, agent, active, 'REFLECT', { status: 's', current_task: 't', next_action: 'n' })
    // Reaching REFLECT completes round 1 (pier_round is bumped there, not on the REFLECT->PLAN
    // hop), so this REFLECT->PLAN request is already at the maxPierRounds:1 budget.
    expect(reflected.pier_round).toBe(1)
    const requestedPlanAgain = advancePhase(host, agent, active, 'PLAN', { status: 's', current_task: 't', next_action: 'n' })
    expect(requestedPlanAgain.phase).toBe('STOPPED')
    expect(requestedPlanAgain.stop_reason).toMatch(/PIER round budget exhausted/)
  })

  it('REFLECT->PLAN within budget proceeds normally and bumps pier_round for the new round', () => {
    const host = newHost({ budget: { maxPierRounds: 2 } })
    const { agent } = workspace()
    const active = confirmedCampaign(host, agent)
    advancePhase(host, agent, active, 'PLAN', { status: 's', current_task: 't', next_action: 'n' })
    advancePhase(host, agent, active, 'IMPLEMENT', { status: 's', current_task: 't', next_action: 'n' })
    advancePhase(host, agent, active, 'EXECUTE', { status: 's', current_task: 't', next_action: 'n' })
    advancePhase(host, agent, active, 'REFLECT', { status: 's', current_task: 't', next_action: 'n' })
    const second = advancePhase(host, agent, active, 'PLAN', { status: 's', current_task: 't', next_action: 'n' })
    expect(second.phase).toBe('PLAN')
    expect(second.pier_round).toBe(1)
  })

  it('REFLECT->PLAN past the wall-clock budget is redirected to STOPPED', () => {
    const host = newHost({ budget: { campaignWallTimeMin: 1 } })
    const { agent } = workspace()
    const active = confirmedCampaign(host, agent)
    advancePhase(host, agent, active, 'PLAN', { status: 's', current_task: 't', next_action: 'n' })
    advancePhase(host, agent, active, 'IMPLEMENT', { status: 's', current_task: 't', next_action: 'n' })
    advancePhase(host, agent, active, 'EXECUTE', { status: 's', current_task: 't', next_action: 'n' })
    advancePhase(host, agent, active, 'REFLECT', { status: 's', current_task: 't', next_action: 'n' })
    // Back-date started_at so the 1-minute wall clock has already elapsed.
    const staleState = { ...host.state(active)!, started_at: new Date(Date.now() - 2 * 60_000).toISOString() }
    writeFileSync(active.layout.stateFile, `${JSON.stringify(staleState, null, 2)}\n`)
    const requestedPlanAgain = advancePhase(host, agent, active, 'PLAN', { status: 's', current_task: 't', next_action: 'n' })
    expect(requestedPlanAgain.phase).toBe('STOPPED')
    expect(requestedPlanAgain.stop_reason).toMatch(/wall-clock budget exhausted/)
  })

  it('SUCCESS carries the poc field through', () => {
    const host = newHost()
    const { agent } = workspace()
    const active = confirmedCampaign(host, agent)
    advancePhase(host, agent, active, 'PLAN', { status: 's', current_task: 't', next_action: 'n' })
    advancePhase(host, agent, active, 'IMPLEMENT', { status: 's', current_task: 't', next_action: 'n' })
    advancePhase(host, agent, active, 'EXECUTE', { status: 's', current_task: 't', next_action: 'n' })
    advancePhase(host, agent, active, 'REFLECT', { status: 's', current_task: 't', next_action: 'n' })
    const poc = { input_path: '/tmp/poc.bin', reproduced_times: 3, run_cmd: './toy @@' }
    const state = advancePhase(host, agent, active, 'SUCCESS', { status: 'done', current_task: 't', next_action: 'n', poc })
    expect(state.poc).toEqual(poc)
  })
})
