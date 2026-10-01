/**
 * `/pbfuzz` (command.ts). The channels it sends on are the point: the user's own notes go back as a
 * real user turn (which is also the only thing `dsh-session-title` will title the session from),
 * and pbfuzz's procedure goes as plugin-sourced context, which the client renders as a collapsed
 * row rather than as something the human typed.
 *
 * The ORDER and the CHANNEL of those two are load-bearing, not cosmetic. The loop claims the whole
 * `next-step` queue but exactly one `next-turn` message per turn, so a procedure sent with
 * `followup` lands a full turn behind the request it describes — which is exactly what a recorded
 * session did: the campaign ran to completion with no procedure in context at all. Hence
 * `stageInstructions` (step inbox, no wake) BEFORE `sendUser` (opens the turn).
 *
 * `/pbfuzz run` is the ONE place a failure sets `process.exitCode`.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerCommand } from '../src/command.ts'
import { campaignToYaml } from '../src/core/campaign-yaml.ts'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { PbfuzzHost, type AgentLike } from '../src/host.ts'
import { settings } from './fixtures.ts'

function agentIn(cwd: string): AgentLike {
  return { id: `agent:${cwd}`, session: { header: { cwd } }, ctx: { tools: { restrict: () => () => {} } } }
}

const newHost = (): PbfuzzHost => new PbfuzzHost(() => settings(), { info() {}, warn() {} }, () => new Set<string>(PBFUZZ_TOOLS))

interface Registered {
  handler(inv: { agent: unknown; rawInput: string; signal: AbortSignal }): Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
}

/** Which channel a message went out on. `staged` is the step inbox; the other two open a turn. */
type Channel = 'user' | 'instructions' | 'staged'

/** Every channel, kept apart AND in order — which is exactly what this command has to get right. */
interface Sent {
  user: string[]
  /** Procedure text however it was delivered, so assertions about content ignore the channel. */
  instructions: string[]
  /** `[channel, text]` in call order, for the assertions that are about ordering. */
  log: [Channel, string][]
}

function register(host: PbfuzzHost, sent: Sent, skillBody = '# pbfuzz skill body'): Registered {
  let def: Registered | undefined
  registerCommand({ register: d => { def = d as Registered; return () => {} } }, {
    host,
    sendUser: (_agent, text) => { sent.user.push(text); sent.log.push(['user', text]) },
    sendInstructions: (_agent, text) => { sent.instructions.push(text); sent.log.push(['instructions', text]) },
    stageInstructions: (_agent, text) => { sent.instructions.push(text); sent.log.push(['staged', text]) },
    skillBody,
  })
  return def!
}

const empty = (): Sent => ({ user: [], instructions: [], log: [] })

describe('/pbfuzz <notes>: two channels, never one', () => {
  it("sends the user's own words back as their turn, and pbfuzz's procedure separately", async () => {
    const sent = empty()
    const cmd = register(newHost(), sent, '# how to run a campaign')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-cmd-')))
    const result = await cmd.handler({
      agent: agentIn(root),
      rawInput: 'There is a bug in readelf.cpp. The bug is at line 96. Produce PoCs for me.',
      signal: new AbortController().signal,
    })
    expect(result.kind).toBe('success')
    // Exactly the user's text, verbatim: it is their request, and the session title comes from it.
    expect(sent.user).toEqual(['There is a bug in readelf.cpp. The bug is at line 96. Produce PoCs for me.'])
    // The procedure goes on the other channel, and never leaks into the user's message.
    expect(sent.instructions).toHaveLength(1)
    expect(sent.instructions[0]).toContain('# how to run a campaign')
    expect(sent.user.join('\n')).not.toContain('how to run a campaign')
  })

  it('injects the skill body rather than telling the model to go load it', async () => {
    const sent = empty()
    const cmd = register(newHost(), sent, '# body\nstep one\nstep two')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-cmd-')))
    await cmd.handler({ agent: agentIn(root), rawInput: '', signal: new AbortController().signal })
    expect(sent.user).toEqual([])
    expect(sent.instructions[0]).toContain('step two')
  })

  it('sends no interview-plan JSON: the model can call pbfuzz_campaign status itself', async () => {
    const sent = empty()
    const cmd = register(newHost(), sent)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-cmd-')))
    await cmd.handler({ agent: agentIn(root), rawInput: 'go', signal: new AbortController().signal })
    const all = [...sent.user, ...sent.instructions].join('\n')
    expect(all).not.toContain('"interview"')
    expect(all).not.toContain('```json')
    expect(sent.instructions[0]!.length).toBeLessThan(1500)
  })
})

describe('/pbfuzz status', () => {
  it('returns the campaign status as JSON', async () => {
    const host = newHost()
    const sent = empty()
    const cmd = register(host, sent)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-cmd-')))
    const result = await cmd.handler({ agent: agentIn(root), rawInput: 'status', signal: new AbortController().signal })
    expect(result.kind).toBe('success')
    expect(JSON.parse(result.text!)).toMatchObject({ campaign: null })
  })
})

describe('/pbfuzz run <path>: the one legitimate place for process.exitCode (D5)', () => {
  it('a failing run sets process.exitCode = 1 and returns the diagnosis', async () => {
    const host = newHost()
    const sent = empty()
    const cmd = register(host, sent)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-cmd-run-')))
    const before = process.exitCode
    try {
      const result = await cmd.handler({ agent: agentIn(root), rawInput: 'run nope.yaml', signal: new AbortController().signal })
      expect(result.kind).toBe('error')
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = before
    }
  })

  it('usage error (no path) does not touch process.exitCode', async () => {
    const host = newHost()
    const sent = empty()
    const cmd = register(host, sent)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-cmd-run-')))
    const before = process.exitCode
    const result = await cmd.handler({ agent: agentIn(root), rawInput: 'run', signal: new AbortController().signal })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('usage')
    expect(process.exitCode).toBe(before)
  })

  it('an unconfirmed campaign is refused before the engine, and the command still reports it as a plain error (setting exitCode, matching every other run failure)', async () => {
    const host = newHost()
    const sent = empty()
    const cmd = register(host, sent)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-cmd-run-')))
    const dir = join(root, '.pbfuzz', 'cmdrun1')
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(join(dir, 'pbfuzz.campaign.yaml'), campaignToYaml({
      version: 1,
      id: 'cmdrun1',
      confirmed: false,
      target: { repo: root, language: 'c' },
      bug: { targets: [{ location: 'toy.c:1' }] },
      entry: { kind: 'executable', run_cmd: './toy @@', input_channel: 'file' },
      oracle: { mode: 'canary', reached_pattern: 'REACHED', triggered_pattern: 'TRIGGERED' },
      tracer: 'off',
      output: { dir },
    } as never))
    const before = process.exitCode
    try {
      const result = await cmd.handler({ agent: agentIn(root), rawInput: `run ${join(dir, 'pbfuzz.campaign.yaml')}`, signal: new AbortController().signal })
      // Unconfirmed campaign: runHeadless refuses before the engine, same failure path as above.
      expect(result.kind).toBe('error')
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = before
    }
  })
})

describe('the procedure reaches the turn it describes (the one-followup-per-turn trap)', () => {
  it('stages the procedure on the step inbox and only THEN opens the turn, so both arrive together', async () => {
    const sent = empty()
    const cmd = register(newHost(), sent, '# how to run a campaign')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-cmd-order-')))
    await cmd.handler({ agent: agentIn(root), rawInput: 'reproduce the bug at readelf.cpp:96', signal: new AbortController().signal })
    // `ReactLoopInbox.claim` takes ALL of next-step but only ONE next-turn message, so the
    // procedure MUST be staged (no wake) and the request MUST be the thing that opens the turn.
    // Two `followup`s — the previous shape — put them a whole turn apart.
    expect(sent.log.map(([channel]) => channel)).toEqual(['staged', 'user'])
  })

  it('with no request to ride along with, the procedure opens its own turn instead of stalling in the step inbox', async () => {
    const sent = empty()
    const cmd = register(newHost(), sent, '# body')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-cmd-order-')))
    await cmd.handler({ agent: agentIn(root), rawInput: '', signal: new AbortController().signal })
    // Staging without a following `sendUser` would never wake the agent at all.
    expect(sent.log.map(([channel]) => channel)).toEqual(['instructions'])
  })

  it('does not invite the model to spend a step re-fetching the skill it was just handed', async () => {
    const sent = empty()
    const cmd = register(newHost(), sent, '# body')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-cmd-order-')))
    await cmd.handler({ agent: agentIn(root), rawInput: 'go', signal: new AbortController().signal })
    const header = sent.instructions[0]!
    expect(header).toContain('do not call `skill`')
    expect(header).not.toContain('has the same text')
  })
})
