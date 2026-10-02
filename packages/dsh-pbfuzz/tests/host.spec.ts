/**
 * Unit coverage for `host.ts`'s own file-I/O primitives (`resolvePath`, `writeFile`,
 * `ensureInitState`) that `guards.spec.ts`/`state-writer.spec.ts` exercise only indirectly.
 * Three of these are Wave D fsm-attack regression tests (F1, F4, F5) — see each `it`'s comment.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { PbfuzzHost, writeFile, type ActiveCampaign, type AgentLike } from '../src/host.ts'
import { settings } from './fixtures.ts'

function agentIn(cwd: string): AgentLike {
  return { id: `agent:${cwd}`, session: { header: { cwd } }, ctx: { tools: { restrict: () => () => {} } } }
}

const newHost = (): PbfuzzHost => new PbfuzzHost(() => settings(), { info() {}, warn() {} }, () => new Set<string>(PBFUZZ_TOOLS))

function tmpRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** A confirmed, saved (not yet `ensureInitState`d) campaign at `<root>/.pbfuzz/<id>`. */
function saved(host: PbfuzzHost, agent: AgentLike, id: string): ActiveCampaign {
  const root = agent.session.header.cwd!
  const dir = join(root, '.pbfuzz', id)
  return host.save(agent, {
    version: 1,
    id,
    confirmed: true,
    target: { repo: root, language: 'c' },
    bug: { targets: [{ location: 'toy.c:1' }] },
    entry: { kind: 'executable', run_cmd: './toy @@', input_channel: 'file' },
    oracle: { mode: 'canary', reached_pattern: 'REACHED', triggered_pattern: 'TRIGGERED' },
    tracer: 'off',
    output: { dir },
  } as never, [])
}

describe('resolvePath (Wave D fsm-attack F1)', () => {
  it('a `..`-laden absolute path that lexically re-enters a directory resolves inside it, not as the raw string', () => {
    const root = tmpRoot('pbfuzz-resolve-')
    const host = newHost()
    const stateDir = join(root, '.pbfuzz', 'c1', 'state')
    // Built by string concatenation, not `join()` — `join()` itself normalizes `..` away, which
    // would defeat the point of this test: a model-supplied `file_path` argument arrives as a raw,
    // un-normalized string exactly like this one.
    const raw = `${join(root, '.pbfuzz', 'c1', 'testcases')}/../state/state.json`
    const resolved = host.resolvePath(agentIn(root), raw)
    expect(resolved).toBe(join(stateDir, 'state.json'))
    expect(resolved.startsWith(`${stateDir}/`)).toBe(true)
    // Before the fix, resolvePath returned `raw` completely unmodified for an absolute path —
    // which does NOT start with `${stateDir}/`, defeating guard-policy.ts's isUnderDir() prefix
    // check while the real write/edit tool (which normalizes via node:path resolve()) landed
    // inside state/ anyway.
    expect(raw.startsWith(`${stateDir}/`)).toBe(false)
  })

  it('still resolves a relative path against the agent workspace', () => {
    const root = tmpRoot('pbfuzz-resolve-')
    const host = newHost()
    expect(host.resolvePath(agentIn(root), 'notes.txt')).toBe(join(root, 'notes.txt'))
  })
})

describe('writeFile: atomic temp-file + rename (Wave D fsm-attack F4)', () => {
  it('a rewrite fully replaces the previous content — never truncated, never merged, no temp file left behind', () => {
    const root = tmpRoot('pbfuzz-writefile-')
    const target = join(root, 'state', 'state.json')
    writeFile(target, JSON.stringify({ phase: 'PLAN', pier_round: 0 }))
    writeFile(target, JSON.stringify({ phase: 'REFLECT', pier_round: 3 }))
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ phase: 'REFLECT', pier_round: 3 })
    expect(readdirSync(join(root, 'state'))).toEqual(['state.json'])
  })
})

describe('ensureInitState: does not trust a foreign campaign\'s state.json (Wave D fsm-attack F5)', () => {
  it('writes a fresh INIT cursor when none exists yet', () => {
    const root = tmpRoot('pbfuzz-init-')
    const host = newHost()
    const agent = agentIn(root)
    const active = saved(host, agent, 'c1')
    host.ensureInitState(active)
    const state = host.state(active)
    expect(state?.phase).toBe('INIT')
    expect(state?.pier_round).toBe(0)
    expect(state?.campaign_id).toBe('c1')
  })

  it('is a no-op when the on-disk state.json already belongs to this same campaign', () => {
    const root = tmpRoot('pbfuzz-init-')
    const host = newHost()
    const agent = agentIn(root)
    const active = saved(host, agent, 'c1')
    mkdirSync(active.layout.stateDir, { recursive: true })
    writeFileSync(active.layout.stateFile, JSON.stringify({
      campaign_id: 'c1', phase: 'REFLECT', status: 's', current_task: 't', next_action: 'n', pier_round: 4,
    }))
    host.ensureInitState(active)
    expect(host.state(active)?.phase).toBe('REFLECT')
    expect(host.state(active)?.pier_round).toBe(4)
  })

  it('reinitializes to INIT rather than inheriting a stale state.json from a different campaign_id (directory reuse / pre-planted state)', () => {
    const root = tmpRoot('pbfuzz-init-')
    const host = newHost()
    const agent = agentIn(root)
    const active = saved(host, agent, 'c2')
    // A foreign/stale state.json under the SAME output.dir — e.g. left over from a prior,
    // unrelated campaign that reused this directory, or planted via an unguarded `write` before
    // this campaign was ever confirmed. A hostile pier_round is included to show the budget-brake
    // neutralization the finding describes.
    mkdirSync(active.layout.stateDir, { recursive: true })
    writeFileSync(active.layout.stateFile, JSON.stringify({
      campaign_id: 'some-other-campaign', phase: 'PLAN', status: 's', current_task: 't', next_action: 'n',
      pier_round: -1_000_000_000,
    }))
    host.ensureInitState(active)
    const state = host.state(active)
    expect(state?.campaign_id).toBe('c2')
    expect(state?.phase).toBe('INIT')
    expect(state?.pier_round).toBe(0)
  })

  it('reinitializes to INIT when the on-disk state.json is corrupt/unparsable', () => {
    const root = tmpRoot('pbfuzz-init-')
    const host = newHost()
    const agent = agentIn(root)
    const active = saved(host, agent, 'c3')
    mkdirSync(active.layout.stateDir, { recursive: true })
    writeFileSync(active.layout.stateFile, '{not valid json')
    host.ensureInitState(active)
    const state = host.state(active)
    expect(state?.campaign_id).toBe('c3')
    expect(state?.phase).toBe('INIT')
  })
})
