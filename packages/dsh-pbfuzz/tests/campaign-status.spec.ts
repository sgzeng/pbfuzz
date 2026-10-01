/**
 * `status()` (campaign-flow.ts) must return a value that survives DSH's lossless-JSON tool-result
 * snapshot (`snapshotJsonValue`, `@deepseek-ai/dsh-values`): a single `undefined` anywhere in the
 * returned tree — even as an existing key's value, not just a missing key — makes the *whole*
 * snapshot fail, and the harness answers with `tool "pbfuzz_campaign" returned invalid output:
 * value is not lossless JSON`. Found live, independently, in two unrelated sessions (V1's
 * readelf-c, V4's toy-java-jazzer), where an optional field was mapped through as an explicit
 * `undefined`. The shape has changed since; the invariant has not.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { status, type FlowContext } from '../src/campaign-flow.ts'
import { campaignToYaml } from '../src/core/campaign-yaml.ts'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { PbfuzzHost, type AgentLike } from '../src/host.ts'
import { settings } from './fixtures.ts'

/** The exact rule DSH's `snapshotJsonValue` enforces (`packages/util/values/src/index.ts` in the
 * pinned DSH checkout): every value in the tree must be `null`, a boolean, a string, a finite
 * non-`-0` number, a plain array, or a plain object — `undefined` anywhere fails the whole walk,
 * an explicit key with an `undefined` value included. */
function findUndefined(value: unknown, path = '$'): string | undefined {
  if (value === undefined) return path
  if (value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findUndefined(item, `${path}[${index}]`)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const found = findUndefined(item, `${path}.${key}`)
    if (found !== undefined) return found
  }
  return undefined
}

function agentIn(cwd: string): AgentLike {
  return { id: `agent:${cwd}`, session: { header: { cwd } }, ctx: { tools: { restrict: () => () => {} } } }
}

function flowFor(root: string, agent: AgentLike): FlowContext {
  const host = new PbfuzzHost(() => settings(), { info() {}, warn() {} }, () => new Set(PBFUZZ_TOOLS))
  return { host, agent, asker: undefined, signal: new AbortController().signal }
}

describe('status() returns a losslessly JSON-serializable value', () => {
  function workspace(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-status-')))
    const dir = join(root, '.pbfuzz', 'c1')
    mkdirSync(join(dir, 'state'), { recursive: true })
    writeFileSync(join(dir, 'pbfuzz.campaign.yaml'), campaignToYaml({
      version: 1,
      id: 'c1',
      confirmed: true,
      target: { repo: root, language: 'c' },
      bug: { targets: [{ location: 'toy.c:1' }] },
      entry: { kind: 'executable', run_cmd: './toy @@', input_channel: 'file' },
      oracle: { mode: 'canary', reached_pattern: 'REACHED', triggered_pattern: 'TRIGGERED' },
      output: { dir },
    } as never))
    writeFileSync(join(dir, 'state', 'state.json'), JSON.stringify({
      campaign_id: 'c1', phase: 'PLAN', status: 's', current_task: 't', next_action: 'n', pier_round: 0,
    }))
    writeFileSync(join(root, '.pbfuzz', 'active'), `${dir}\n`)
    return root
  }

  it('has no undefined anywhere, with an active campaign', () => {
    const root = workspace()
    const value = status(flowFor(root, agentIn(root)))
    expect(findUndefined(value)).toBeUndefined()
    expect(value.phase).toBe('PLAN')
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  })

  it('has no undefined anywhere with no campaign at all, and offers the interview instead', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-status-none-')))
    const value = status(flowFor(root, agentIn(root)))
    expect(findUndefined(value)).toBeUndefined()
    expect(value.campaign).toBeNull()
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  })
})
