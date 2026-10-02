import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { campaignToYaml } from '../src/core/campaign-yaml.ts'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { installGuard, installTamperLedger } from '../src/guards.ts'
import { PbfuzzHost, type AgentLike } from '../src/host.ts'
import { settings } from './fixtures.ts'

function agentIn(cwd: string): AgentLike {
  return { id: `agent:${cwd}`, session: { header: { cwd } }, ctx: { tools: { restrict: () => () => {} } } }
}

/** A confirmed campaign with a `state.json` at the given phase. */
function workspace(phase: string): { root: string; dir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-guards-')))
  const dir = join(root, '.pbfuzz', 'g1')
  mkdirSync(join(dir, 'state'), { recursive: true })
  writeFileSync(join(dir, 'pbfuzz.campaign.yaml'), campaignToYaml({
    version: 1,
    id: 'g1',
    confirmed: true,
    target: { repo: root, language: 'c' },
    bug: { targets: [{ location: 'toy.c:1' }] },
    entry: { kind: 'executable', run_cmd: './toy @@', input_channel: 'file' },
    oracle: { mode: 'canary', reached_pattern: 'REACHED', triggered_pattern: 'TRIGGERED' },
    tracer: 'off',
    output: { dir },
  } as never))
  writeFileSync(join(dir, 'state', 'state.json'), JSON.stringify({
    campaign_id: 'g1', phase, status: 's', current_task: 't', next_action: 'n', pier_round: 0,
  }))
  writeFileSync(join(root, '.pbfuzz', 'active'), `${dir}\n`)
  return { root, dir }
}

type FakeExec = { name: string; arguments: unknown; agent: AgentLike }
type FakeResult = { isError: boolean }

/** A minimal fake `ctx` — just enough of `ctx.tools.guard/schemas` and `ctx.on` for guards.ts. */
function fakeCtx(toolNames: string[] = []): {
  ctx: { tools: { guard(cb: (exec: FakeExec) => string | undefined): () => void; schemas(): { name: string }[] }; on(event: string, cb: (...args: never[]) => void): () => void }
  guard(exec: FakeExec): string | undefined
  schemasCalls: { count: number }
  fireResult(exec: FakeExec, result: FakeResult): void
} {
  let guardCb: ((exec: FakeExec) => string | undefined) | undefined
  const resultListeners: ((exec: FakeExec, result: FakeResult) => void)[] = []
  const schemasCalls = { count: 0 }
  return {
    ctx: {
      tools: {
        guard: (cb) => { guardCb = cb; return () => {} },
        schemas: () => { schemasCalls.count++; return toolNames.map(name => ({ name })) },
      },
      on: (event, cb) => {
        if (event === 'tools/result') resultListeners.push(cb as (exec: FakeExec, result: FakeResult) => void)
        return () => {}
      },
    },
    guard: exec => guardCb!(exec),
    schemasCalls,
    fireResult: (exec, result) => { for (const l of resultListeners) l(exec, result) },
  }
}

const newHost = (over: Parameters<typeof settings>[0] = {}): PbfuzzHost =>
  new PbfuzzHost(() => settings(over), { info() {}, warn() {} }, () => new Set<string>(PBFUZZ_TOOLS), {})

describe('installGuard: the one native ctx.tools.guard() registration', () => {
  it('allows everything with no active campaign, without ever calling ctx.tools.schemas()', () => {
    const host = newHost()
    const fake = fakeCtx()
    installGuard(fake.ctx as never, host)
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-none-')))
    expect(fake.guard({ name: 'bash', arguments: { command: 'rm -rf /' }, agent: agentIn(root) })).toBeUndefined()
    expect(fake.schemasCalls.count).toBe(0)
  })

  it('denies a write under the state directory, and allows one elsewhere', () => {
    const { root, dir } = workspace('PLAN')
    const host = newHost()
    const fake = fakeCtx()
    installGuard(fake.ctx as never, host)
    const agent = agentIn(root)
    const denial = fake.guard({ name: 'write', arguments: { file_path: join(dir, 'state', 'state.json'), content: '{}' }, agent })
    expect(denial).toMatch(/^\[pbfuzz:state-write\/owned-by-tool\] DENIED \(write\)/)
    expect(fake.guard({ name: 'write', arguments: { file_path: join(root, 'notes.txt'), content: 'x' }, agent })).toBeUndefined()
  })

  it('denies a `..`-traversal write that lexically re-enters the state directory (Wave D fsm-attack F1)', () => {
    // A raw `file_path` that LOOKS like it escapes the state dir via a sibling segment, but which
    // `path.resolve()` (what the real write/edit tool's fs backend actually uses) collapses right
    // back inside it. Before the F1 fix, `host.resolvePath()` returned an already-absolute path
    // unmodified, so `isUnderDir()`'s string-prefix check saw the un-collapsed string and missed
    // this — the guard allowed it while the real tool wrote inside `state/`.
    const { root, dir } = workspace('PLAN')
    const host = newHost()
    const fake = fakeCtx()
    installGuard(fake.ctx as never, host)
    const agent = agentIn(root)
    const traversal = join(dir, 'testcases', '..', 'state', 'state.json')
    const denial = fake.guard({ name: 'write', arguments: { file_path: traversal, content: '{}' }, agent })
    expect(denial).toMatch(/^\[pbfuzz:state-write\/owned-by-tool\] DENIED \(write\)/)
  })

  it('resolves a `path` argument too (not only `file_path`)', () => {
    const { root, dir } = workspace('PLAN')
    const host = newHost()
    const fake = fakeCtx()
    installGuard(fake.ctx as never, host)
    const denial = fake.guard({ name: 'edit', arguments: { path: join(dir, 'state', 'metrics.json') }, agent: agentIn(root) })
    expect(denial).toMatch(/^\[pbfuzz:state-write\/metrics-engine-only\]/)
  })

  it('denies a bash command that mentions the state dir with a mutation', () => {
    const { root, dir } = workspace('PLAN')
    const host = newHost()
    const fake = fakeCtx()
    installGuard(fake.ctx as never, host)
    const denial = fake.guard({ name: 'bash', arguments: { command: `cat ${dir}/state/state.json > /tmp/x` }, agent: agentIn(root) })
    expect(denial).toMatch(/^\[pbfuzz:bash-guard\/state-tamper\]/)
  })

  it('gates a feature-detected terminal tool name only when it is actually registered', () => {
    const { root } = workspace('PLAN') // not REFLECT: terminal is illegal here regardless
    const host = newHost()
    const withTerminal = fakeCtx(['terminal_open'])
    installGuard(withTerminal.ctx as never, host)
    expect(withTerminal.guard({ name: 'terminal_open', arguments: {}, agent: agentIn(root) })).toMatch(/^\[pbfuzz:phase-gate\/terminal\]/)

    // Not registered at all in this deployment (the common case, verified against the installed
    // runtime): never gated, because it is never a `terminalToolNames` member.
    const withoutTerminal = fakeCtx([])
    installGuard(withoutTerminal.ctx as never, host)
    expect(withoutTerminal.guard({ name: 'terminal_open', arguments: {}, agent: agentIn(root) })).toBeUndefined()
  })
})

describe('installTamperLedger: audit-only tools/result observer', () => {
  it('records a matched bash command, with allowed mirroring whether the call was denied (isError) or ran anyway (e.g. bashGuard off)', () => {
    const { root, dir } = workspace('PLAN')
    const host = newHost()
    const fake = fakeCtx()
    installTamperLedger(fake.ctx as never, host)
    const agent = agentIn(root)
    const command = `cat ${dir}/state/state.json > /tmp/x`
    fake.fireResult({ name: 'bash', arguments: { command }, agent }, { isError: true })
    fake.fireResult({ name: 'bash', arguments: { command }, agent }, { isError: false })
    const lines = readFileSync(join(dir, 'tamper-ledger.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const entries = lines.map(line => JSON.parse(line) as { tool: string; command: string; allowed: boolean; target: string; mutation: string })
    expect(entries[0]).toMatchObject({ tool: 'bash', command, allowed: false })
    expect(entries[0]!.target).toContain('.pbfuzz') // the campaign root marker, matched before `/state.json` (both are protected)
    expect(entries[0]!.mutation).toBe('>')
    expect(entries[1]!.allowed).toBe(true)
  })

  it('never writes for a non-matching command, a non-bash tool, or with tamperLedger off', () => {
    const { root, dir } = workspace('PLAN')
    const ledger = join(dir, 'tamper-ledger.jsonl')
    const host = newHost()
    const fake = fakeCtx()
    installTamperLedger(fake.ctx as never, host)
    const agent = agentIn(root)
    fake.fireResult({ name: 'bash', arguments: { command: 'ls -la' }, agent }, { isError: false })
    fake.fireResult({ name: 'write', arguments: { file_path: join(dir, 'state', 'state.json'), content: '{}' }, agent }, { isError: true })
    expect(existsSync(ledger)).toBe(false)

    const offHost = newHost({ guards: { tamperLedger: false } })
    const fakeOff = fakeCtx()
    installTamperLedger(fakeOff.ctx as never, offHost)
    fakeOff.fireResult({ name: 'bash', arguments: { command: `cat ${dir}/state/state.json > /tmp/x` }, agent }, { isError: true })
    expect(existsSync(ledger)).toBe(false)
  })
})
