/**
 * Root-caused live in V3 (toy-python-atheris), the third session to hit "unknown tool
 * pbfuzz_fuzz" (after V1's readelf-c and V2's headless Magma run): `host.refresh()` — the only
 * place `ctx.tools.restrict()` gets recomputed — ran on `agent/created`, a pbfuzz tool call's own
 * result handling (`tools.ts`'s `withDashboard()`), or a settings/provider change. None of those
 * observed PIER's own documented FSM-hop procedure: a plain `write` of `state.json`. So a session
 * that onboards (phase INIT, only `pbfuzz_campaign` visible) and then advances straight through
 * PLAN/IMPLEMENT into EXECUTE purely via direct `write`s — exactly what the `pbfuzz-pier` skill
 * used to instruct — never re-triggered a refresh, and the newly-legal `pbfuzz_fuzz` never became
 * callable until some unrelated pbfuzz tool call happened to run (or, in the live incident, until
 * the whole DSH server was restarted).
 *
 * Fixed structurally under this rewrite's P3 design change, not patched again the same way: a
 * direct agent `write`/`edit` under the campaign's state directory is now denied outright
 * (`core/guard-policy.ts::decide()`), so "PIER's own documented FSM-hop procedure" is no longer a
 * plain `write` at all — `state-writer.ts::advancePhase()` is the only thing that ever moves a
 * campaign's phase, and it calls `host.refresh()` itself on every transition (see
 * `state-writer.spec.ts`, "a legal transition writes state.json and refreshes tool visibility for
 * the agent"). `index.ts` no longer has a `tools/result` `write`-watching listener to patch this
 * gap with, because the gap it existed to patch can no longer open: this file keeps just the still
 * -relevant half (an `agent/created` visibility computation, exercised through the real
 * `@deepseek-ai/cordis` runtime end to end, mirroring `kanalyzer-inject.spec.ts`'s pattern) and
 * drops the write-triggers-refresh scenario instead of re-asserting behavior that no longer exists.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { campaignToYaml } from '../src/core/campaign-yaml.ts'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import * as pbfuzz from '../src/index.ts'
import { settings } from './fixtures.ts'

const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })
const settle = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await tick() }

/** Every dependency `index.ts`'s top-level `inject` map names — see `kanalyzer-inject.spec.ts`.
 * Unlike that file's stand-in, `schemas()` must answer with the real pbfuzz tool names: `deny` in
 * `host.refresh()` is intersected with the global registry, so an empty `schemas()` would make
 * every deny list empty regardless of visibility and hide this bug entirely. */
function provideHostServices(root: Context): void {
  root.provide('tools', {
    register: () => () => {},
    schemas: () => PBFUZZ_TOOLS.map(name => ({ name })),
    guard: () => () => {},
  } as never)
  root.provide('sessionProjections', { register: () => () => {} } as never)
  root.provide('userQuestions', { ask: async () => ({}) } as never)
  root.provide('jobs', { run: async () => ({}), onJobDone: () => () => {} } as never)
}

function workspace(): { root: string; stateFile: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-refresh-')))
  const dir = join(root, '.pbfuzz', 'c9')
  mkdirSync(join(dir, 'state'), { recursive: true })
  const yaml = campaignToYaml({
    version: 1,
    id: 'c9',
    confirmed: true,
    target: { repo: root, language: 'c' },
    bug: { targets: [{ location: 'toy.c:1' }] },
    entry: { kind: 'executable', run_cmd: './toy @@', input_channel: 'file' },
    oracle: { mode: 'canary', reached_pattern: 'REACHED', triggered_pattern: 'TRIGGERED' },
    tracer: 'off',
    output: { dir },
  } as never)
  writeFileSync(join(root, 'pbfuzz.campaign.yaml'), yaml)
  writeFileSync(join(root, '.pbfuzz', 'active'), 'c9\n')
  const stateFile = join(dir, 'state', 'state.json')
  writeFileSync(stateFile, `${JSON.stringify({ campaign_id: 'c9', phase: 'INIT', status: 's', current_task: 't', next_action: 'n', pier_round: 0 })}\n`)
  return { root, stateFile }
}

/** A fake agent structurally close enough for `agent/created`: a `restrict()` spy for visibility
 * assertions, and a `systemPrompt.section()` no-op stand-in for `pier-driver.ts`'s per-agent
 * campaign-banner registration (also fired on `agent/created`). */
function fakeAgent(cwd: string, denied: string[][]): unknown {
  return {
    id: 'agent:1',
    session: { header: { cwd } },
    ctx: {
      tools: { restrict: ({ deny }: { deny?: readonly string[] }) => { denied.push([...(deny ?? [])].sort()); return () => {} } },
      systemPrompt: { section: () => () => {} },
    },
  }
}

describe('tool visibility on agent/created (real cordis runtime)', () => {
  it('computes the session-constant visible set once, with no phase in it', async () => {
    const root = new Context()
    provideHostServices(root)
    await root.plugin(pbfuzz as never, settings() as never)

    const { root: workspaceRoot } = workspace()
    const denied: string[][] = []
    const agent = fakeAgent(workspaceRoot, denied)

    root.emit('agent/created' as never, { agent } as never)
    await settle()
    // The fixture's settings have static analysis off, so exactly one tool is denied — and it is
    // denied for that reason, not because of the campaign's phase. `pbfuzz_fuzz` stays visible in
    // INIT: the phase gate is `ctx.tools.guard()`'s job, and re-restricting per phase is what used
    // to invalidate the model's prompt prefix on every PIER transition.
    expect(denied.at(-1)).toEqual(['pbfuzz_callgraph'])
  })

  it('a plain tools/result write event no longer triggers any refresh (there is nothing left to watch for)', async () => {
    const root = new Context()
    provideHostServices(root)
    await root.plugin(pbfuzz as never, settings() as never)

    const { root: workspaceRoot, stateFile } = workspace()
    const denied: string[][] = []
    const agent = fakeAgent(workspaceRoot, denied)

    root.emit('agent/created' as never, { agent } as never)
    await settle()
    const afterCreate = denied.length

    // Even a `tools/result` naming state.json (the old trigger) is a no-op now: index.ts has no
    // `tools/result` listener left to react to it at all — refresh only ever happens through
    // `host.refresh()` itself (`agent/created`, a pbfuzz tool result, a settings/provider change,
    // or `state-writer.ts::advancePhase()`, covered by `state-writer.spec.ts`).
    root.emit('tools/result' as never, {
      name: 'write',
      arguments: { file_path: stateFile, content: '{}' },
      agent,
    } as never, { isError: false } as never)
    root.emit('tools/result' as never, { name: 'bash', arguments: {}, agent } as never, { isError: false } as never)
    await settle()

    expect(denied.length).toBe(afterCreate)
  })
})
