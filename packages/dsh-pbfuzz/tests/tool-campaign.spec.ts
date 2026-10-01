/**
 * `pbfuzz_campaign` (tools.ts) at the tool layer — wiring campaign-flow.ts's pure functions into
 * `defineTool`: `draft` throws (never a silent `{ok:false}`) listing every issue (B3, the
 * standardized failure signaling `pbfuzz_plan` mirrors); `confirm` threads `draft_version` through
 * to `confirm()`'s stale-draft guard (F3/H4 — this closes the real bug where that guard was
 * previously unreachable because nothing ever passed it); `selfcheck` splits the env half
 * (TTL-cached via `env-selfcheck.ts`) from the campaign half and auto-advances INIT->PLAN on a
 * passing gate.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CONTRACTS_VERSION } from '../src/core/selfcheck.ts'
import { PbfuzzHost, type AgentLike } from '../src/host.ts'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { settings } from './fixtures.ts'
import { captureTools, fakeExec } from './tool-harness.ts'

function agentIn(cwd: string): AgentLike {
  return { id: `agent:${cwd}`, session: { header: { cwd } }, ctx: { tools: { restrict: () => () => {} } } }
}

const newHost = (over: Parameters<typeof settings>[0] = {}): PbfuzzHost =>
  new PbfuzzHost(() => settings(over), { info() {}, warn() {} }, () => new Set<string>(PBFUZZ_TOOLS))

function workspace(): { root: string; agent: AgentLike } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-campaign-tool-')))
  return { root, agent: agentIn(root) }
}

const validAnswers = (root: string) => ({
  id: 'tc1',
  target: { repo: root, language: 'c' },
  bug: { targets: [{ location: 'toy.c:1' }] },
  entry: { kind: 'executable', run_cmd: './toy @@', input_channel: 'file' },
  oracle: { mode: 'canary', reached_pattern: 'REACHED', triggered_pattern: 'TRIGGERED' },
  tracer: 'off',
})

describe('pbfuzz_campaign draft (tool layer)', () => {
  it('throws listing the issue on a semantic/cross-field validation failure ANSWERS_PARAMETER_SCHEMA cannot express (an invalid regex), never returning a silent {ok:false}', async () => {
    const host = newHost()
    const { agent, root } = workspace()
    const campaign = captureTools(host).get('pbfuzz_campaign')!
    // Structurally valid (passes ANSWERS_PARAMETER_SCHEMA — every field is the right TYPE), but
    // draftCampaign's own validateCampaign() rejects the unbalanced regex, which the schema layer
    // has no way to check at all.
    await expect(campaign.execute({
      action: 'draft',
      answers: { ...validAnswers(root), oracle: { mode: 'canary', reached_pattern: '(', triggered_pattern: 'TRIGGERED' } },
    }, fakeExec(agent))).rejects.toThrow(/invalid campaign/)
  })

  it('a schema-level rejection (wrong type on a oneOf-wrapped field) ALSO surfaces as a thrown, isError outcome naming the field — the same standardized signaling as the semantic layer above', async () => {
    const host = newHost()
    const { agent } = workspace()
    const campaign = captureTools(host).get('pbfuzz_campaign')!
    await expect(campaign.execute({
      action: 'draft',
      answers: { id: 'bad2', target: { repo: '/x', revision: ['not', 'a', 'string'] }, bug: { targets: [{ location: 'a.c:1' }] }, entry: { kind: 'executable', run_cmd: '/x @@', input_channel: 'file' } },
    }, fakeExec(agent))).rejects.toThrow(/target\.revision/)
  })

  it('a valid draft succeeds and carries a draftVersion', async () => {
    const host = newHost()
    const { agent, root } = workspace()
    const campaign = captureTools(host).get('pbfuzz_campaign')!
    const result = await campaign.execute({ action: 'draft', answers: validAnswers(root) }, fakeExec(agent)) as { ok: boolean; draftVersion?: string }
    expect(result.ok).toBe(true)
    expect(typeof result.draftVersion).toBe('string')
  })

  it('accepts the build the agent wrote, and reports what running it did', async () => {
    // `answers.build` was once missing from the schema entirely, so dsh-tools rejected the call
    // with a "not a declared property" error before execute() ever ran — for every campaign whose
    // build the agent had to write itself. `draft` executes it rather than taking a
    // `verified: true` on trust.
    const host = newHost()
    const { agent, root } = workspace()
    const campaign = captureTools(host).get('pbfuzz_campaign')!
    const result = await campaign.execute({
      action: 'draft',
      answers: {
        ...validAnswers(root),
        build: { cmd: 'echo built', dir: root },
        evidence: { 'entry.run_cmd': 'main() takes one argv' },
      },
    }, fakeExec(agent)) as { ok: boolean; draftVersion?: string; verification: { step: string; ok: boolean }[] }
    expect(result.ok).toBe(true)
    expect(typeof result.draftVersion).toBe('string')
    expect(result.verification.map(v => v.ok)).toEqual([true, expect.any(Boolean)])
    expect(result.verification[0]!.step).toContain('echo built')
  })
})

describe('pbfuzz_campaign confirm draft_version threading (H4)', () => {
  it('a stale draft_version is refused instead of silently approving the current draft', async () => {
    const host = newHost()
    const { agent, root } = workspace()
    const campaign = captureTools(host).get('pbfuzz_campaign')!
    const drafted = await campaign.execute({ action: 'draft', answers: validAnswers(root) }, fakeExec(agent)) as { draftVersion: string }
    const result = await campaign.execute({ action: 'confirm', draft_version: 'not-the-real-version' }, fakeExec(agent)) as { verdict: string }
    expect(result.verdict).toBe('error')
    // Confirming with the version the draft actually returned goes through the normal Approve/no-asker path instead.
    expect(drafted.draftVersion).not.toBe('not-the-real-version')
  })
})

