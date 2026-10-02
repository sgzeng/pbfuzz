/**
 * One whole PIER round on the real DSH: campaign draft and approval, PLAN, a fuzz session run as a
 * DSH background job by the real engine, the job's completion waking the agent, REFLECT, SUCCESS.
 * Only the model is scripted. This is the path that crosses the most DSH APIs at once (the agent
 * loop, ToolRuntime, user questions, the jobs registry and its events, the session log), and the
 * one the unit tests cover only with a fake job handle.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootRealDsh, type RealDsh } from './harness.ts'
import { openSession, plain, transcript, waitUntil } from './helpers.ts'

let dsh: RealDsh
beforeAll(async () => { dsh = await bootRealDsh() })
afterAll(async () => { await dsh?.dispose() })

const GENERATOR = `def generate(**params):
    return {0: b'x', 1: b'R'}.get(int(params.get('n', 0)), b'RT')
`

/** What the last message of a request says, as one string (a tool result, a notice, a nudge). */
const lastText = (request: any): string => JSON.stringify(request.messages.at(-1).content)

describe('a PIER round', () => {
  it('runs PLAN -> IMPLEMENT -> EXECUTE (a DSH job) -> REFLECT -> SUCCESS', async () => {
    // The role the web UI plays: approve the campaign-review panel the plugin raises.
    const stopAnswering = dsh.ctx.on('user-questions/request', async (request: any) => ({
      answers: request.questions.map((question: any) => ({ id: question.id, selected: [question.options?.[0]?.label ?? 'Approve'] })),
    }))

    const session = await openSession(dsh)
    const { root, campaignDir } = session.workspace
    const answers = {
      id: 'itest',
      target: { repo: root, language: 'python' },
      bug: { targets: [{ location: 'target.py:5', condition: "b'T' in data" }] },
      entry: { kind: 'executable', run_cmd: `${dsh.python} ${root}/target.py @@`, input_channel: 'file' },
      oracle: { mode: 'preexisting', reached_pattern: 'PBFUZZ_REACHED:\\s*(\\S+)', triggered_pattern: 'PBFUZZ_TRIGGERED:\\s*(\\S+)' },
      tracer: 'off',
      output: { dir: campaignDir },
    }
    const draftVersion = (request: any): string => /"draftVersion":\s*"([^"]+)"/.exec(lastText(request).replace(/\\"/g, '"'))?.[1] ?? ''
    session.llm.enqueue(
      { toolCalls: [{ name: 'pbfuzz_campaign', arguments: { action: 'draft', answers } }] },
      request => ({ toolCalls: [{ name: 'pbfuzz_campaign', arguments: { action: 'confirm', draft_version: draftVersion(request) } }] }),
      { toolCalls: [{ name: 'pbfuzz_plan', arguments: {
        bug_predicates: [{ id: 'BP1', location: 'target.py:5', bug_condition: "b'T' in data" }],
        preconditions: [{ id: 'R1', statement: 'the input contains R', status: 'verified', evidence: ['target.py:3'] }],
      } }] },
      { toolCalls: [{ name: 'pbfuzz_fuzz', arguments: {
        plan: {
          parameter_space: { n: { type: 'int_range', min: 0, max: 3 } },
          next_batch_plan: [{ plan_description: 'miss', n: 0 }, { plan_description: 'reach only', n: 1 }, { plan_description: 'reach and trigger', n: 2 }],
          breakpoints: [],
        },
        generator_code: GENERATOR,
        runtime: { maxIters: 20, fuzzTimeoutSec: 60 },
      } }] },
      { text: 'The fuzz job is running; I will wait for it to finish.' },
      { toolCalls: [{ name: 'pbfuzz_reflect', arguments: { decision: 'success', analysis: 'n=2 produced RT, which triggers.' } }] },
      { text: 'The bug is reproduced.' },
      { text: 'spare' }, { text: 'spare' },
    )

    await session.say('Reproduce the bug at target.py:5.')
    const state = () => JSON.parse(readFileSync(join(campaignDir, 'state', 'state.json'), 'utf8')) as { phase: string; pier_round: number; poc?: unknown }
    await waitUntil('the campaign to reach SUCCESS', () => { try { return state().phase === 'SUCCESS' } catch { return false } }, 40_000, () => `${transcript(session.llm)}\n  state: ${(() => { try { return JSON.stringify(state()) } catch (e) { return String(e) } })()}`)
    stopAnswering()

    // The fuzz ran as a job owned by this agent's session, and DSH's own jobs service recorded it settling.
    const jobs = dsh.ctx.get('jobs')
    const [job] = plain<{ id: string }[]>(jobs.list(session.agent.id))
    expect(plain(jobs.list(session.agent.id))).toEqual([
      expect.objectContaining({ kind: 'pbfuzz_fuzz', owner: session.agent.id, status: 'completed' }),
    ])
    // The engine's live progress went through `job.append()`, so `job_output` has something to show.
    const output = plain<{ chunks: { text: string }[] }>(jobs.readAt(job!.id, 0, session.agent.id)).chunks.map(chunk => chunk.text).join('')
    expect(output).toMatch(/progress: \{"stage":1,"iteration":1,/)

    // DSH's tool-jobs plugin woke the agent with the completion notice, which carries the digest.
    const notice = session.llm.requests.map(request => request.messages.at(-1)).find(message => message.source?.kind === 'tool-jobs')
    expect(JSON.stringify(notice?.content)).toMatch(/background job pbfuzz_fuzz-1 .* finished \[status: completed, .*1 triggered/)

    // The engine's evidence is what let REFLECT claim success.
    const metrics = JSON.parse(readFileSync(join(campaignDir, 'state', 'metrics.json'), 'utf8'))
    expect(metrics).toMatchObject({ campaign_id: 'itest', triggered_count: 1 })
    expect(state().poc, 'the proof of concept is recorded').toBeDefined()
  })
})
