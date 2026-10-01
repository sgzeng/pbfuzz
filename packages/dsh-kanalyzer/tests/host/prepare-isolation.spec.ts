/**
 * `kanalyzer_prepare` must not build in the user's own tree.
 *
 * The session this came from asked for a reachability analysis of an nginx fuzzer and got a
 * prepare that deleted the user's object files, rebuilt `build/out/http_request_fuzzer` in place
 * through wllvm, and produced bitcode still carrying the project's `-fsanitize=address` — which
 * made 37,634 of KAMain's 37,678 critical branches ASan check traps rather than real branches.
 * These tests pin the three things that fixes it: the build runs in a copy, the copy is what the
 * compiler shim and the build command see, and opting out says so out loud.
 *
 * @module @pbfuzz/dsh-kanalyzer/tests/host/prepare-isolation
 */
import { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KANALYZER_DIR } from '../../src/core/isolation.ts'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import { config, fakeRun, okResult, workspace, type RunCall } from './prepare-harness.ts'

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }))

vi.mock('../../src/host/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/exec.ts')>()
  return { ...actual, run: runMock }
})

describe('prepare(): the analysis build is isolated from the caller\'s tree', () => {
  let ws: ReturnType<typeof workspace>
  let calls: RunCall[]
  let runtime: KanalyzerRuntime

  beforeEach(() => {
    ws = workspace()
    calls = []
    runMock.mockReset()
    runMock.mockImplementation(fakeRun(calls))
    runtime = new KanalyzerRuntime(new Context(), {
      config: () => config(ws.installDir, ws.llvmPrefix), writeStatus: async () => {}, packageRoot: ws.tmp,
    })
  })

  afterEach(() => { rmSync(ws.tmp, { recursive: true, force: true }) })

  const request = () => ({ repo: ws.repo, buildCmd: 'bash build.sh', mode: 'wllvm' as const, program: 'app' })

  it('copies the checkout and builds in the copy, leaving the original alone', async () => {
    const before = statSync(join(ws.repo, 'src', 'main.c')).mtimeMs
    const result = await runtime.prepare(request())

    const tree = join(ws.repo, KANALYZER_DIR, 'tree')
    expect(result.tree).toBe(tree)
    expect(result.bitcode.startsWith(tree)).toBe(true)
    expect(result.profile).toBe('analysis')
    expect(result.cached).toBe(false)
    expect(result.note).toContain('were not modified')

    // The build's link output landed in the copy, not in the checkout.
    expect(existsSync(join(tree, 'app'))).toBe(true)
    expect(existsSync(join(ws.repo, 'app'))).toBe(false)
    expect(statSync(join(ws.repo, 'src', 'main.c')).mtimeMs).toBe(before)

    const rsync = calls.find(c => c.command === 'rsync')
    expect(rsync?.args).toContain(`--exclude=/${KANALYZER_DIR}/`)
    expect(rsync?.args).not.toContain('--delete') // the copy stays warm for incremental rebuilds
    const build = calls.find(c => c.command === '/bin/sh')
    expect(build?.opts.cwd).toBe(tree)
  })

  it('puts the compiler shim first on the build PATH, under every common compiler name', async () => {
    await runtime.prepare(request())
    const shim = join(ws.repo, KANALYZER_DIR, 'shim')
    const build = calls.find(c => c.command === '/bin/sh')
    expect(build?.opts.env?.PATH?.startsWith(`${shim}:`)).toBe(true)
    for (const name of ['clang', 'clang++', 'cc', 'c++', 'gcc', 'g++']) {
      expect(existsSync(join(shim, name))).toBe(true)
    }
  })

  it('keeps its own directory out of git and out of the copy', async () => {
    await runtime.prepare(request())
    const root = join(ws.repo, KANALYZER_DIR)
    expect(readFileSync(join(root, '.gitignore'), 'utf8').trim()).toBe('*')
    expect(existsSync(join(root, 'tree', KANALYZER_DIR))).toBe(false)
  })

  it('maps a cwd inside the checkout to the same place in the copy', async () => {
    await runtime.prepare({ ...request(), cwd: join(ws.repo, 'src') })
    const build = calls.find(c => c.command === '/bin/sh')
    expect(build?.opts.cwd).toBe(join(ws.repo, KANALYZER_DIR, 'tree', 'src'))
  })

  it('rewrites absolute checkout paths in the build command so the copy\'s script runs', async () => {
    await runtime.prepare({ ...request(), buildCmd: `bash ${ws.repo}/build.sh` })
    const build = calls.find(c => c.command === '/bin/sh')
    expect(build?.args[1]).toBe(`bash ${join(ws.repo, KANALYZER_DIR, 'tree')}/build.sh`)
  })

  it('refuses a cwd outside the checkout instead of quietly building there', async () => {
    await expect(runtime.prepare({ ...request(), cwd: ws.tmp })).rejects.toThrow(/outside the project checkout/)
    expect(calls.some(c => c.command === '/bin/sh')).toBe(false)
  })

  it('names the isolation when the build produced no link output, so the cause is not guessed at', async () => {
    runMock.mockImplementation(fakeRun(calls, () => okResult({ stdout: 'nothing built\n' })))
    await expect(runtime.prepare(request())).rejects.toThrow(/no file named app was found/)
    await expect(runtime.prepare(request())).rejects.toThrow(/isolated copy/)
  })

  it('isolate: false builds in the caller\'s own tree and warns that the results carry sanitizer noise', async () => {
    const result = await runtime.prepare(request(), undefined, { isolate: false })
    expect(result.tree).toBeUndefined()
    expect(result.profile).toBe('passthrough')
    expect(calls.some(c => c.command === 'rsync')).toBe(false)
    expect(calls.find(c => c.command === '/bin/sh')?.opts.cwd).toBe(ws.repo)
    expect(existsSync(join(ws.repo, 'app'))).toBe(true)
    expect(result.warnings.join(' ')).toMatch(/sanitizer/i)
    expect(result.note).not.toContain('were not modified')
  })

  it('still refuses an lto build command that cannot produce bitcode when the shim is opted out of', async () => {
    // With the shim installed the flags reach the compiler whatever the command says, so this
    // pre-flight only applies to an in-tree build — but there it is still the right answer.
    writeFileSync(join(ws.repo, 'x.c'), 'int main(void){return 0;}\n')
    await expect(runtime.prepare(
      { repo: ws.repo, buildCmd: '$CC x.c -o x', mode: 'lto' }, undefined, { isolate: false },
    )).rejects.toThrow(/references none of \$CFLAGS/)
  })
})
