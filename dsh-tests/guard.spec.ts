/**
 * pbfuzz's single `ctx.tools.guard()` registration, exercised the way the agent loop does it: a
 * real agent, a real `/pbfuzz run`, and every call dispatched through the real ToolRuntime, so
 * DSH's own argument validation and guard chain are in the path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootRealDsh, type RealDsh } from './harness.ts'
import { openSession, type Session } from './helpers.ts'

let dsh: RealDsh
beforeAll(async () => { dsh = await bootRealDsh() })
afterAll(async () => { await dsh?.dispose() })

describe('without a campaign', () => {
  it('stays out of the way: ordinary tools run, pbfuzz tools say how to start', async () => {
    const session = await openSession(dsh)
    const written = await session.call('write', { file_path: `${session.workspace.root}/notes.txt`, content: 'hi' })
    expect(written.isError).toBe(false)
    const plan = await session.call('pbfuzz_plan')
    expect(plan.isError).toBe(true)
    expect(plan.error.message).toContain('/pbfuzz')
  })
})

describe('in PLAN of a started campaign', () => {
  let session: Session
  beforeAll(async () => {
    session = await openSession(dsh)
    expect(await session.command(`/pbfuzz run ${session.workspace.campaignPath}`)).toEqual({ kind: 'success', text: 'campaign itest: confirmed, PIER started' })
  })

  it("DSH's argument validation rejects a malformed call to a legal tool before its body runs", async () => {
    const result = await session.call('pbfuzz_plan', { bug_predicates: 'not an array' })
    expect(result.error.info).toEqual(expect.objectContaining({ code: 'INVALID_ARGS' }))
  })

  it('denies a tool that is illegal in this phase and names the next legal action', async () => {
    const result = await session.call('pbfuzz_fuzz', { plan: {} })
    expect(result.isError).toBe(true)
    expect(result.error.message).toMatch(/phase-gate.*pbfuzz_fuzz is not legal in phase PLAN/s)
    expect(result.error.message).toContain('call pbfuzz_plan')
  })

  it('denies a write to state/metrics.json (only the engine may write it)', async () => {
    const result = await session.call('write', { file_path: `${session.workspace.campaignDir}/state/metrics.json`, content: '{}' })
    expect(result.error.message).toContain('state-write/metrics-engine-only')
  })

  it('denies a shell command that would modify the state directory', async () => {
    const result = await session.call('bash', { command: `echo '{}' > ${session.workspace.campaignDir}/state/state.json` })
    expect(result.error.message).toContain('bash-guard/state-tamper')
  })

  it('lets a phase-legal call through', async () => {
    const result = await session.call('pbfuzz_campaign', { action: 'status' })
    expect(result.isError).toBe(false)
  })
})
