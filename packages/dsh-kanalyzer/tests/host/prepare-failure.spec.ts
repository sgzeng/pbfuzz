/**
 * `prepare()` failure paths through `src/host/runtime.ts`'s `doPrepare()`: each must surface as a
 * real error rather than a success-shaped result.
 *
 * - A build that exits 0 but leaves no bitcode behind — the real LTO case where the build system
 *   drops `LDFLAGS`, so `lld` never runs with `-plugin-opt=save-temps` and no `*.0.0.preopt.bc`
 *   is produced.
 * - `llvm-nm` exiting nonzero. The build and `extract-bc` steps both check `exitCode`; the
 *   `llvm-nm` step used to feed `nm.stdout` straight into `inferEntries()` regardless, so a failed
 *   invocation silently produced the same `{entries: [], nFuncs: 0}` as a run that found nothing.
 *
 * Only the subprocess boundary is faked (see `prepare-harness.ts`), so the real `walk()` /
 * `doPrepare()` logic on top observes a genuine absence of output.
 *
 * @module @pbfuzz/dsh-kanalyzer/tests/host/prepare-failure
 */
import { Context } from '@deepseek-ai/cordis'
import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import { config, fakeRun, okResult, workspace, type RunCall } from './prepare-harness.ts'

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }))

vi.mock('../../src/host/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/exec.ts')>()
  return { ...actual, run: runMock }
})

describe('prepare(): failures that must not look like success', () => {
  let ws: ReturnType<typeof workspace>
  let calls: RunCall[]
  let runtime: KanalyzerRuntime

  beforeEach(() => {
    // An LLVM prefix whose name carries no version: the one place the unversioned shim names are built.
    ws = workspace('kanalyzer-failure-', 'llvm')
    calls = []
    runMock.mockReset()
    runtime = new KanalyzerRuntime(new Context(), {
      config: () => config(ws.installDir, ws.llvmPrefix), writeStatus: async () => {}, packageRoot: ws.tmp,
    })
  })

  afterEach(() => { rmSync(ws.tmp, { recursive: true, force: true }) })

  it('throws the no-bitcode diagnostic when an LTO build exits 0 without producing any', async () => {
    runMock.mockImplementation(fakeRun(calls, () => okResult({ stdout: 'make: Nothing to be done.\n' })))
    await expect(runtime.prepare({
      repo: ws.repo, buildCmd: 'make clean && make -f Makefile.noldflags', mode: 'lto',
    })).rejects.toThrow(/produced no \*\.0\.0\.preopt\.bc/)
  })

  it('throws a real error, distinct from an empty success, when llvm-nm exits nonzero', async () => {
    runMock.mockImplementation(async (command: string, args: string[], opts = {}) => (
      command.endsWith('llvm-nm')
        ? okResult({ exitCode: 1, stderr: `${command}: error: 'app.0.0.preopt.bc': The file was not recognized as a valid object file\n` })
        : fakeRun(calls)(command, args, opts)
    ))
    await expect(runtime.prepare({
      repo: ws.repo, buildCmd: 'true', mode: 'wllvm', program: 'app',
    })).rejects.toThrow(/llvm-nm/i)
  })
})
