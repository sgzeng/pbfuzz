/**
 * The host must find the same campaign the guards find (engine/hooks/pbfuzz_hooks/context.py):
 * `.pbfuzz/active` may hold an id, a path relative to the workspace, or an absolute directory, and
 * a hand-written yaml may sit in the workspace root. Found live in C4: the hooks reported
 * "campaign c4 — phase INIT" while `pbfuzz_campaign status` said `campaign: null`.
 */
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { campaignToYaml } from '../src/core/campaign-yaml.ts'
import type { AnalysisProvider } from '../src/core/contracts.ts'
import { KANALYZER_TOOLS, PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { PbfuzzHost, type AgentLike } from '../src/host.ts'
import { settings } from './fixtures.ts'

function workspace(
  pointer: (root: string, dir: string) => string | undefined,
  yamlAt: 'root' | 'dir',
  confirmed = false,
): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-active-')))
  const dir = join(root, '.pbfuzz', 'c4')
  mkdirSync(join(dir, 'state'), { recursive: true })
  const yaml = campaignToYaml({
    version: 1,
    id: 'c4',
    confirmed,
    target: { repo: root, language: 'c' },
    bug: { targets: [{ location: 'toy.c:1' }] },
    entry: { kind: 'executable', run_cmd: './toy @@', input_channel: 'file' },
    oracle: { mode: 'canary', reached_pattern: 'REACHED', triggered_pattern: 'TRIGGERED' },
    tracer: 'off',
    output: { dir },
  } as never)
  writeFileSync(yamlAt === 'root' ? join(root, 'pbfuzz.campaign.yaml') : join(dir, 'pbfuzz.campaign.yaml'), yaml)
  const named = pointer(root, dir)
  if (named !== undefined) writeFileSync(join(root, '.pbfuzz', 'active'), `${named}\n`)
  return root
}

function agentIn(cwd: string, denied: string[][] = []): AgentLike {
  return {
    id: `agent:${cwd}`,
    session: { header: { cwd } },
    ctx: { tools: { restrict: ({ deny }) => { denied.push([...(deny ?? [])].sort()); return () => {} } } },
  }
}

const newHost = (): PbfuzzHost => new PbfuzzHost(() => settings(), { info() {}, warn() {} }, () => new Set<string>(PBFUZZ_TOOLS))

describe('host.active() resolves the campaign exactly as the guards do', () => {
  it('an id pointer with the yaml in the workspace root (hand-written / headless layout)', () => {
    const root = workspace(() => 'c4', 'root')
    expect(newHost().active(agentIn(root))?.campaign.id).toBe('c4')
  })
  it('an absolute directory pointer with the yaml in the campaign directory', () => {
    const root = workspace((_, dir) => dir, 'dir')
    expect(newHost().active(agentIn(root))?.campaign.id).toBe('c4')
  })
  it('a pointer relative to the workspace', () => {
    const root = workspace(() => '.pbfuzz/c4', 'dir')
    expect(newHost().active(agentIn(root))?.campaign.id).toBe('c4')
  })
  it('no pointer, or a pointer naming nothing, is no campaign', () => {
    expect(newHost().active(agentIn(workspace(() => undefined, 'dir')))).toBeUndefined()
    expect(newHost().active(agentIn(workspace(() => 'nope', 'dir')))).toBeUndefined()
  })
  it('denies nothing for an unconfirmed campaign: the visible set no longer depends on one', () => {
    const root = workspace(() => 'c4', 'root')
    const denied: string[][] = []
    const host = newHost()
    host.refresh(agentIn(root, denied))
    // The only denial is the provider-backed `pbfuzz_callgraph`, because the fixture's settings
    // have static analysis off — not because the campaign is unconfirmed.
    expect(denied.at(-1)).toEqual(['pbfuzz_callgraph'])
  })

  /**
   * Found live in V1 (readelf-c): the confirm panel kept showing a stale value after the agent
   * hand-edited the yaml (a direct `Edit` of the file is the documented fallback for anything
   * `pbfuzz_campaign draft` has no input for). `active()` was returning its in-memory cache
   * from the first load/draft without ever noticing the file on disk had changed underneath it —
   * so approving would have silently written the stale value straight back over the user's edit.
   */
  it('active() notices a direct edit to the yaml on disk and drops the stale cache', () => {
    const root = workspace(() => 'c4', 'root')
    const yamlPath = join(root, 'pbfuzz.campaign.yaml')
    const host = newHost()
    const agent = agentIn(root)

    const first = host.active(agent)
    expect(first?.campaign.entry.cwd).toBeUndefined()

    const edited = campaignToYaml({ ...first!.campaign, entry: { ...first!.campaign.entry, cwd: '/edited/on/disk' } } as never)
    writeFileSync(yamlPath, edited)
    // Force a distinct mtime regardless of filesystem timestamp resolution.
    const future = new Date(Date.now() + 60_000)
    utimesSync(yamlPath, future, future)

    expect(host.active(agent)?.campaign.entry.cwd).toBe('/edited/on/disk')
  })

  /**
   * N6: `refresh()` only tracks an agent in `restrictions` when it has at least one denial, and
   * `refreshAll()` used to walk only `restrictions.values()` — so an agent that started fully
   * visible (zero denials) was silently skipped forever, even after the settings/provider state
   * that made it fully visible changed. Reproduces "kanalyzer gets uninstalled after an agent
   * already started with full visibility": the agent must go from zero denials to being denied
   * the provider-backed tool once `refreshAll()` runs.
   *
   * The observed tool is `pbfuzz_callgraph`, not the `kanalyzer_*` names this test originally
   * watched: pbfuzz no longer gates another plugin's read-only tools at all — not by phase, by
   * `tools.staticAnalysis`, by self-check or by provider presence — so a `kanalyzer_*` name can no
   * longer appear in a pbfuzz deny list. `pbfuzz_callgraph` is pbfuzz's own static-analysis tool
   * and genuinely does need a provider, so it exercises the same `refreshAll()` path.
   */
  it('refreshAll() revisits an agent that started with zero denials once a provider disappears', () => {
    const root = workspace(() => 'c4', 'root', true)
    // PLAN, so pbfuzz_callgraph is in the phase's permitted set and can be seen appearing/going.
    writeFileSync(join(root, '.pbfuzz', 'c4', 'state', 'state.json'), JSON.stringify({
      campaign_id: 'c4', phase: 'PLAN', status: 's', current_task: 't', next_action: 'n', pier_round: 0,
    }))
    const host = new PbfuzzHost(
      () => settings({ tools: { staticAnalysis: 'kanalyzer' } }),
      { info() {}, warn() {} },
      // Exactly the tools PLAN permits while a provider is present, so the first refresh really
      // does deny nothing — which is the precondition this regression is about.
      () => new Set<string>(['pbfuzz_campaign', 'pbfuzz_plan', 'pbfuzz_callgraph', ...KANALYZER_TOOLS]),
    )
    const provider = { describe: () => ({ name: 'kanalyzer', languages: ['c'] }) } as unknown as AnalysisProvider
    const registration = host.providers.register(provider)

    const denied: string[][] = []
    host.refresh(agentIn(root, denied))
    // Fully visible: zero denials, so `restrict()` is never even called.
    expect(denied).toEqual([])

    // Uninstalling kanalyzer: the provider disappears, which notifies the host and runs refreshAll().
    registration.dispose()

    expect(denied.at(-1)).toEqual(['pbfuzz_callgraph'])
    // And the point of the decoupling: no kanalyzer tool is ever denied by pbfuzz. When kanalyzer
    // really is uninstalled its tools are simply not registered, so there is nothing to hide.
    for (const list of denied) expect(list.some(t => t.startsWith('kanalyzer_'))).toBe(false)
  })
})

describe('host.guardView()', () => {
  it('undefined without an active campaign — the guard is then a zero-cost no-op', () => {
    const host = newHost()
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-guardview-')))
    expect(host.guardView(agentIn(root), [])).toBeUndefined()
  })

  it('reflects phase, confirmed, stateDir and settings for an active campaign', () => {
    const root = workspace(() => 'c4', 'root', true)
    const host = newHost()
    const agent = agentIn(root)
    const active = host.active(agent)!
    const view = host.guardView(agent, ['terminal_open'])
    expect(view).toBeDefined()
    expect(view!.phase).toBe('INIT') // no state.json written yet in this fixture
    expect(view!.confirmed).toBe(true)
    expect(view!.stateDir).toBe(active.layout.stateDir)
    expect(view!.terminalToolNames).toEqual(['terminal_open'])
    expect(view!.settings.guards.bashGuard).toBe(true)
  })
})
