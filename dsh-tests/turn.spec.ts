/**
 * A whole agent turn on DSH's real agent loop, with a scripted model in place of the provider.
 * `/pbfuzz run` starts the first turn itself (the headless bootstrap), so the script is queued
 * before the command. What the loop sends the model, what comes back from the tools, and what the
 * PIER driver does when the model stops are all the real thing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootRealDsh, type RealDsh } from './harness.ts'
import { openSession, plain, stayedTrue, waitUntil } from './helpers.ts'

let dsh: RealDsh
beforeAll(async () => { dsh = await bootRealDsh() })
afterAll(async () => { await dsh?.dispose() })

const lastMessage = (request: any): { role: string; source?: string; text: string } => {
  const message = request.messages.at(-1)
  return { role: message.role, source: message.source?.kind, text: JSON.stringify(message.content) }
}

describe('an agent turn', () => {
  it("offers the model the phase's tools, and a denied call reaches it with the next legal action", async () => {
    const session = await openSession(dsh)
    session.llm.enqueue({ toolCalls: [{ name: 'pbfuzz_fuzz', arguments: { plan: {} } }] }, { text: 'understood' })

    await session.command(`/pbfuzz run ${session.workspace.campaignPath}`)
    await waitUntil('the model to be asked twice', () => session.llm.requests.length >= 2)

    const offered = session.llm.requests[0].tools.map((tool: { name: string }) => tool.name)
    expect(offered).toContain('pbfuzz_plan')
    expect(offered, 'static analysis is off, so the call-graph tool is not offered').not.toContain('pbfuzz_callgraph')
    const answer = lastMessage(session.llm.requests[1])
    expect(answer.role).toBe('tool')
    expect(answer.text).toMatch(/DENIED.*pbfuzz_fuzz is not legal in phase PLAN.*pbfuzz_plan/)
  })

  it('the PIER driver nudges a model that stops mid-campaign, and in a headless run stops the campaign at the cap', async () => {
    await dsh.ctx.get('settings').update('pbfuzz', { budget: { maxConsecutiveForcedContinues: 1 } })
    const session = await openSession(dsh)
    session.llm.enqueue({ text: 'I will stop here.' }, { text: 'still stopping' }, { text: 'never asked for' })

    await session.command(`/pbfuzz run ${session.workspace.campaignPath}`)
    await waitUntil('the nudge', () => session.llm.requests.length >= 2)
    await stayedTrue(() => session.llm.requests.length === 2)

    const nudge = lastMessage(session.llm.requests[1])
    expect(nudge).toEqual(expect.objectContaining({ role: 'user', source: 'pbfuzz' }))
    expect(nudge.text).toMatch(/continue the PIER loop.*campaign itest.*phase PLAN.*pbfuzz_plan/)

    // A second stop exceeds the cap of 1; nobody can re-arm a headless run, so it ends for real.
    const status = plain(JSON.parse((await session.command('/pbfuzz status')).text))
    expect(status.phase).toBe('STOPPED')
    expect(status.state.stop_reason).toContain('forced-continue cap')
  })
})
