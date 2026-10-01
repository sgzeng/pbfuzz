import { describe, expect, it } from 'vitest'
import { KanalyzerCardController, type CommandOutcome, type KanalyzerCardHost } from './controller.ts'

/** A fake settings scope applying path ops the way the Host's applyPathOp does. */
function fakeScope(initialUser: Record<string, unknown> = {}, initialStatus: Record<string, unknown> = {}) {
  const defaults = {
    install: { installDir: '~/.dsh/kanalyzer', repoUrl: 'https://github.com/sgzeng/kernel-analyzer.git', branch: 'mzt', llvmPrefix: '', buildType: 'Release', jobs: 0 },
    defaults: { verbose: 1, callStackLen: 20, useTypeBasedCallGraph: true, dumps: { policy: true, distance: true, criticalBranch: true, bidMappingAndFuncInfo: true, callerCalleeBothWays: true, annotatedIr: false }, timeoutSec: 1800, memLimitMB: 16384, cacheEnabled: true },
    standalone: { inputFilenames: [], targetList: [], entryList: [] },
    status: {
      installed: false, binaryPath: '', commit: '', llvmVersion: '',
      lastDoctor: '', lastDoctorAt: '', lastDoctorMessage: '',
      lastWllvm: '', lastWllvmAt: '', lastWllvmMessage: '',
      ...initialStatus,
    },
  }
  let user: Record<string, unknown> = structuredClone(initialUser)
  const listeners = new Set<() => void>()
  const merge = (a: unknown, b: unknown): unknown => {
    if (b === undefined) return a
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
      for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v)
      return out
    }
    return b
  }
  let snapshot = build()
  function build() {
    return { status: 'ready' as const, value: merge(defaults, user) as never, base: undefined, user, revision: 1, writable: true, mode: 'host' as const }
  }
  const apply = (node: Record<string, unknown>, path: string[], op: { op: 'set'; value: unknown } | { op: 'unset' }): Record<string, unknown> => {
    const [head, ...rest] = path as [string, ...string[]]
    if (rest.length === 0) {
      const next = { ...node }
      if (op.op === 'set') next[head] = op.value
      else delete next[head]
      return next
    }
    return { ...node, [head]: apply((node[head] as Record<string, unknown>) ?? {}, rest, op) }
  }
  const mutations: unknown[] = []
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    mutate: async (ops: readonly { op: 'set' | 'unset'; path: string[]; value?: unknown }[]) => {
      mutations.push(ops)
      for (const o of ops) user = apply(user, o.path, o.op === 'set' ? { op: 'set', value: o.value } : { op: 'unset' })
      snapshot = build()
      for (const l of listeners) l()
    },
    set: async () => { throw new Error('card must not use top-level set') },
    unset: async () => { throw new Error('card must not use top-level unset') },
    /** Test hook: the Host writes status. */
    hostWriteStatus: (status: Record<string, unknown>) => {
      defaults.status = { ...defaults.status, ...status }
      snapshot = build()
      for (const l of listeners) l()
    },
  }
  return { scope, mutations }
}

function fakeHost(outcome: CommandOutcome, opts: { rejectCwd?: boolean; onExecute?: () => void } = {}) {
  const calls: string[] = []
  const host: KanalyzerCardHost = {
    createSession: async (cwd) => {
      calls.push(`create:${cwd ?? '<default>'}`)
      if (cwd !== undefined && opts.rejectCwd === true) throw new Error('ENOENT')
      return 's1'
    },
    executeCommand: async (id, line) => { calls.push(`exec:${id}:${line}`); opts.onExecute?.(); return outcome },
    openSession: (id) => { calls.push(`open:${id}`) },
    reloadSettings: async () => { calls.push('reload'); return true },
  }
  return { host, calls }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('KanalyzerCardController form', () => {
  it('writes nested fields as one atomic path-op mutation', async () => {
    const { scope, mutations } = fakeScope()
    const c = new KanalyzerCardController(scope as never, fakeHost({ kind: 'unknown' }).host)
    const face = c.inject()
    face.edit('install.jobs', '8')
    face.edit('defaults.dumps.annotatedIr', true)
    face.edit('standalone.targetList', ['a.c:10', ' '])
    expect(c.getState().dirty).toBe(true)
    await c.save()
    expect(mutations).toEqual([[
      { op: 'set', path: ['install', 'jobs'], value: 8 },
      { op: 'set', path: ['defaults', 'dumps', 'annotatedIr'], value: true },
      { op: 'set', path: ['standalone', 'targetList'], value: ['a.c:10'] },
    ]])
    const s = c.getState()
    expect(s.dirty).toBe(false)
    expect(s.saveFailed).toBe(false)
    expect(s.fields['install.jobs']).toMatchObject({ value: '8', overridden: true })
  })

  it('blocks saving an invalid draft and never writes status', async () => {
    const { scope, mutations } = fakeScope()
    const c = new KanalyzerCardController(scope as never, fakeHost({ kind: 'unknown' }).host)
    c.inject().edit('defaults.memLimitMB', '100')
    expect(c.getState().invalid).toBe(true)
    await c.save()
    expect(mutations).toEqual([])
    expect(() => { c.inject().edit('status.installed', true) }).toThrow()
  })

  it('resets an override with an unset op', async () => {
    const { scope, mutations } = fakeScope({ install: { branch: 'dev' } })
    const c = new KanalyzerCardController(scope as never, fakeHost({ kind: 'unknown' }).host)
    expect(c.getState().fields['install.branch']?.overridden).toBe(true)
    c.inject().resetField('install.branch')
    await c.save()
    expect(mutations).toEqual([[{ op: 'unset', path: ['install', 'branch'] }]])
  })
})

describe('KanalyzerCardController actions', () => {
  it('build: create(cwd=installDir) → execute /kanalyzer build → open, then succeeds only on Host status', async () => {
    const { scope } = fakeScope()
    const { host, calls } = fakeHost({ kind: 'admitted', failed: false, text: '' })
    const c = new KanalyzerCardController(scope as never, host)
    await c.runBuild()
    expect(calls.slice(0, 3)).toEqual(['create:~/.dsh/kanalyzer', 'exec:s1:/kanalyzer build', 'open:s1'])
    expect(c.getState().build).toMatchObject({ phase: 'pending', messageKey: 'actBuildRunning', sessionId: 's1' })
    scope.hostWriteStatus({ installed: true, binaryPath: '/x/KAMain', commit: 'abc' })
    expect(c.getState().build).toMatchObject({ phase: 'success', messageKey: 'actBuildDone', detail: '/x/KAMain' })
  })

  it('build: falls back to the default cwd when installDir cannot be used', async () => {
    const { scope } = fakeScope()
    const { host, calls } = fakeHost({ kind: 'admitted', failed: false, text: '' }, { rejectCwd: true })
    const c = new KanalyzerCardController(scope as never, host)
    await c.runBuild()
    expect(calls.slice(0, 2)).toEqual(['create:~/.dsh/kanalyzer', 'create:<default>'])
    expect(c.getState().buildCwdFallback).toBe(true)
  })

  it('build: reports a missing /kanalyzer command honestly', async () => {
    const { scope } = fakeScope()
    const c = new KanalyzerCardController(scope as never, fakeHost({ kind: 'unknown' }).host)
    await c.runBuild()
    expect(c.getState().build).toMatchObject({ phase: 'failure', messageKey: 'actCommandMissing' })
  })

  it('doctor: verdict comes from the Host-stamped status', async () => {
    const { scope } = fakeScope({}, { installed: true })
    const holder: { scope?: typeof scope } = { scope }
    const { host } = fakeHost({ kind: 'admitted', failed: false, text: 'ok' }, {
      onExecute: () => { holder.scope?.hostWriteStatus({ lastDoctor: 'pass', lastDoctorAt: '2026-09-13T00:00:00Z', lastDoctorMessage: 'distance 0' }) },
    })
    const c = new KanalyzerCardController(scope as never, host)
    await c.runDoctor()
    await flush()
    expect(c.getState().doctor).toMatchObject({ phase: 'success', messageKey: 'actDoctorPass', detail: 'distance 0' })
  })

  it('doctor: binary not found yet when nothing is installed and no verdict was stamped', async () => {
    const { scope } = fakeScope()
    const c = new KanalyzerCardController(scope as never, fakeHost({ kind: 'admitted', failed: true, text: 'KAMain not found' }).host)
    await c.runDoctor()
    expect(c.getState().doctor).toMatchObject({ phase: 'failure', messageKey: 'actBinaryNotFound', detail: 'KAMain not found' })
  })

  it('installDeps: create(cwd=installDir) → execute /kanalyzer install-deps → open, then succeeds only on Host status', async () => {
    const { scope } = fakeScope()
    const { host, calls } = fakeHost({ kind: 'admitted', failed: false, text: '' })
    const c = new KanalyzerCardController(scope as never, host)
    await c.runInstallDeps()
    expect(calls.slice(0, 3)).toEqual(['create:~/.dsh/kanalyzer', 'exec:s1:/kanalyzer install-deps', 'open:s1'])
    expect(c.getState().installDeps).toMatchObject({ phase: 'pending', messageKey: 'actInstallingDeps', sessionId: 's1' })
    scope.hostWriteStatus({ lastWllvm: 'pass', lastWllvmAt: '2026-09-17T00:00:00Z', lastWllvmMessage: 'wllvm 1.3.1' })
    expect(c.getState().installDeps).toMatchObject({ phase: 'success', messageKey: 'actInstallDepsPass', detail: 'wllvm 1.3.1' })
  })

  it('installDeps: settles only once lastWllvmAt actually changes', async () => {
    const { scope } = fakeScope({}, { lastWllvm: 'fail', lastWllvmAt: '2026-09-01T00:00:00Z', lastWllvmMessage: 'no wllvm' })
    const { host } = fakeHost({ kind: 'admitted', failed: false, text: '' })
    const c = new KanalyzerCardController(scope as never, host)
    await c.runInstallDeps()
    expect(c.getState().installDeps.phase).toBe('pending')
    // A status write that leaves lastWllvmAt unchanged must not settle the pending action.
    scope.hostWriteStatus({ lastWllvmMessage: 'still installing' })
    expect(c.getState().installDeps.phase).toBe('pending')
    scope.hostWriteStatus({ lastWllvm: 'fail', lastWllvmAt: '2026-09-17T00:00:00Z', lastWllvmMessage: 'still fails' })
    expect(c.getState().installDeps).toMatchObject({ phase: 'failure', messageKey: 'actInstallDepsFail', detail: 'still fails' })
  })

  it('installDeps: reports a missing /kanalyzer command honestly', async () => {
    const { scope } = fakeScope()
    const c = new KanalyzerCardController(scope as never, fakeHost({ kind: 'unknown' }).host)
    await c.runInstallDeps()
    expect(c.getState().installDeps).toMatchObject({ phase: 'failure', messageKey: 'actCommandMissing' })
  })
})
