/**
 * A repeat prepare against an unchanged checkout must not rebuild.
 *
 * In the recorded session the one successful prepare cost 24.6 minutes; nothing in the plugin
 * remembered it, so asking again — a new turn, a new session, a second campaign — would have paid
 * the whole thing a second time. The memo is keyed on the build's identity and invalidated by the
 * checkout's own mtimes, which is cheap but has blind spots, so `force` has to work too.
 *
 * @module @pbfuzz/dsh-kanalyzer/tests/host/prepare-reuse
 */
import { Context } from '@deepseek-ai/cordis'
import { existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KANALYZER_DIR } from '../../src/core/isolation.ts'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import { config, fakeRun, workspace, type RunCall } from './prepare-harness.ts'

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }))

vi.mock('../../src/host/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/exec.ts')>()
  return { ...actual, run: runMock }
})

/** How many real builds happened so far. */
const builds = (calls: RunCall[]): number => calls.filter(c => c.command === '/bin/sh').length

/** Push a file's mtime into the future, the way an edit would. */
function touch(path: string): void {
  const when = new Date(Date.now() + 5_000)
  utimesSync(path, when, when)
}

describe('prepare(): reuse by source freshness', () => {
  let ws: ReturnType<typeof workspace>
  let calls: RunCall[]
  let runtime: KanalyzerRuntime

  beforeEach(() => {
    ws = workspace('kanalyzer-reuse-')
    calls = []
    runMock.mockReset()
    runMock.mockImplementation(fakeRun(calls))
    runtime = new KanalyzerRuntime(new Context(), {
      config: () => config(ws.installDir, ws.llvmPrefix), writeStatus: async () => {}, packageRoot: ws.tmp,
    })
  })

  afterEach(() => { rmSync(ws.tmp, { recursive: true, force: true }) })

  const request = () => ({ repo: ws.repo, buildCmd: 'bash build.sh', mode: 'wllvm' as const, program: 'app' })

  it('reuses the previous bitcode when nothing in the checkout changed', async () => {
    const first = await runtime.prepare(request())
    expect(first.cached).toBe(false)
    expect(builds(calls)).toBe(1)

    const second = await runtime.prepare(request())
    expect(second.cached).toBe(true)
    expect(second.bitcode).toBe(first.bitcode)
    expect(builds(calls)).toBe(1)
    // The memo survives a fresh runtime, because it is written into the checkout.
    expect(existsSync(join(ws.repo, KANALYZER_DIR, 'prepare.json'))).toBe(true)
  })

  it('is remembered across runtime instances, not just within one session', async () => {
    await runtime.prepare(request())
    const fresh = new KanalyzerRuntime(new Context(), {
      config: () => config(ws.installDir, ws.llvmPrefix), writeStatus: async () => {}, packageRoot: ws.tmp,
    })
    expect((await fresh.prepare(request())).cached).toBe(true)
    expect(builds(calls)).toBe(1)
  })

  it('rebuilds after a source edit', async () => {
    await runtime.prepare(request())
    touch(join(ws.repo, 'src', 'main.c'))
    expect((await runtime.prepare(request())).cached).toBe(false)
    expect(builds(calls)).toBe(2)
  })

  it('rebuilds after a build-system edit, not only a source edit', async () => {
    await runtime.prepare(request())
    writeFileSync(join(ws.repo, 'Makefile'), 'all:\n\t@true\n')
    touch(join(ws.repo, 'Makefile'))
    expect((await runtime.prepare(request())).cached).toBe(false)
  })

  it('is never invalidated by its own build output inside the isolated tree', async () => {
    await runtime.prepare(request())
    // The copy's link output is newer than the memo by construction; if the freshness walk saw it,
    // every prepare would rebuild for ever.
    touch(join(ws.repo, KANALYZER_DIR, 'tree', 'app'))
    expect((await runtime.prepare(request())).cached).toBe(true)
  })

  it('force: true rebuilds from a wiped tree', async () => {
    await runtime.prepare(request())
    const result = await runtime.prepare(request(), undefined, { force: true })
    expect(result.cached).toBe(false)
    expect(builds(calls)).toBe(2)
  })

  it('does not reuse across a different build', async () => {
    await runtime.prepare(request())
    expect((await runtime.prepare({ ...request(), buildCmd: 'bash build.sh --release' })).cached).toBe(false)
    expect((await runtime.prepare({ ...request(), mode: 'lto' }).catch(() => ({ cached: 'threw' }))).cached).not.toBe(true)
  })

  it('rebuilds when the remembered bitcode is gone', async () => {
    const first = await runtime.prepare(request())
    rmSync(first.bitcode)
    expect((await runtime.prepare(request())).cached).toBe(false)
  })
})
