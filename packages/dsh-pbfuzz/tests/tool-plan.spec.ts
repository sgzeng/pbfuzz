/**
 * `pbfuzz_plan` (tools.ts): writes the PLAN hypothesis blocks via `state-writer.ts`'s
 * `writeHypothesisBlocks` and advances PLAN->IMPLEMENT via `advancePhase` — the agent never
 * hand-writes `state/*.json` (P3). A validation failure throws, listing every issue, and writes
 * nothing (mirrors `pbfuzz_campaign draft`'s standardized failure signaling, B3).
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { campaignToYaml } from '../src/core/campaign-yaml.ts'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { PbfuzzHost, type ActiveCampaign, type AgentLike } from '../src/host.ts'
import { settings } from './fixtures.ts'
import { captureTools, fakeExec } from './tool-harness.ts'

function agentIn(cwd: string): AgentLike {
  return { id: `agent:${cwd}`, session: { header: { cwd } }, ctx: { tools: { restrict: () => () => {} } } }
}

const newHost = (): PbfuzzHost => new PbfuzzHost(() => settings(), { info() {}, warn() {} }, () => new Set<string>(PBFUZZ_TOOLS))

/** A confirmed, bound campaign with an INIT state.json already advanced to PLAN. */
function planPhaseCampaign(host: PbfuzzHost, agent: AgentLike): ActiveCampaign {
  const root = agent.session.header.cwd!
  const dir = join(root, '.pbfuzz', 'tp1')
  mkdirSync(join(dir, 'state'), { recursive: true })
  const active = host.save(agent, {
    version: 1,
    id: 'tp1',
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-plan-tool-')))
  return { root, agent: agentIn(root) }
}

describe('pbfuzz_plan tool', () => {
  it('writes the supplied blocks and advances PLAN->IMPLEMENT', async () => {
    const host = newHost()
    const { agent } = workspace()
    const active = planPhaseCampaign(host, agent)
    // ensureInitState leaves phase INIT; the tool itself only asserts against the FSM via
    // advancePhase, so drive it to PLAN first with the same mechanism a real session would.
    const { advancePhase } = await import('../src/state-writer.ts')
    advancePhase(host, agent, active, 'PLAN', { status: 's', current_task: 't', next_action: 'n' })

    const tools = captureTools(host)
    const plan = tools.get('pbfuzz_plan')!
    const result = await plan.execute({
      bug_predicates: [{ id: 'BP1', location: 'toy.c:10', bug_condition: 'len > size' }],
      preconditions: [{ id: 'R1', statement: 'reachable', status: 'verified', evidence: ['seen in trace'] }],
    }, fakeExec(agent)) as { phase: string; summary: string }

    expect(result.phase).toBe('IMPLEMENT')
    expect(result.summary).toContain('IMPLEMENT')
    expect(host.state(active)?.phase).toBe('IMPLEMENT')
    const written = JSON.parse(readFileSync(join(active.layout.stateDir, 'bug_predicates.json'), 'utf8'))
    expect(written).toEqual([{ id: 'BP1', location: 'toy.c:10', bug_condition: 'len > size' }])
  })

  it('throws listing every issue and writes nothing on a validation failure', async () => {
    const host = newHost()
    const { agent } = workspace()
    const active = planPhaseCampaign(host, agent)
    const { advancePhase } = await import('../src/state-writer.ts')
    advancePhase(host, agent, active, 'PLAN', { status: 's', current_task: 't', next_action: 'n' })

    const tools = captureTools(host)
    const plan = tools.get('pbfuzz_plan')!
    await expect(plan.execute({
      bug_predicates: [{ id: 'not-a-valid-id', location: 'bad', bug_condition: 'x' }],
    }, fakeExec(agent))).rejects.toThrow(/bugPredicates\[not-a-valid-id\]\.id: must match/)
    // Nothing landed, and the phase did not advance.
    expect(() => readFileSync(join(active.layout.stateDir, 'bug_predicates.json'), 'utf8')).toThrow()
    expect(host.state(active)?.phase).toBe('PLAN')
  })

  it('throws IllegalTransitionError-shaped rejection when called outside PLAN (defensive; the guard is the real gate)', async () => {
    const host = newHost()
    const { agent } = workspace()
    const active = planPhaseCampaign(host, agent) // still INIT: PLAN was never entered
    const tools = captureTools(host)
    const plan = tools.get('pbfuzz_plan')!
    await expect(plan.execute({ bug_predicates: [{ id: 'BP1', location: 'toy.c:1', bug_condition: 'x' }] }, fakeExec(agent)))
      .rejects.toThrow(/illegal PIER transition/)
  })

  it('rejects an unconfirmed/no-campaign workspace the same way every other pbfuzz tool does', async () => {
    const host = newHost()
    const { agent } = workspace()
    const tools = captureTools(host)
    const plan = tools.get('pbfuzz_plan')!
    await expect(plan.execute({}, fakeExec(agent))).rejects.toThrow(/no active pbfuzz campaign/)
  })
})
