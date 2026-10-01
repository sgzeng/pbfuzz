/**
 * F17 — a `prepare()` failure path through `src/host/runtime.ts`'s `doPrepare()`.
 *
 * Mirrors a real scenario the L1 kanalyzer subagent hit manually:
 * `acceptance-run/work/L1-kanalyzer/b1d_prepare_lto_dropped_ldflags.mjs` — an LTO build whose
 * build system drops `LDFLAGS`, so `lld` never runs with `-plugin-opt=save-temps` and no
 * `*.0.0.preopt.bc` is produced, even though the build command itself exits 0
 * (`logs/b1d_prepare_lto_dropped_ldflags.log` records the exact error message asserted below).
 *
 * Only the subprocess boundary (`run()` in `../../src/host/exec.ts`) is mocked, the same way
 * F18's `runtime.spec.ts` does it: the build command "succeeds" but — as in the real dropped-
 * LDFLAGS case — writes no bitcode next to it, so the real `walk()`/`doPrepare()` logic on top
 * observes a genuine absence of output.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunResult } from '../../src/host/exec.ts'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import { Config } from '../../src/host/settings.ts'

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }))

vi.mock('../../src/host/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/exec.ts')>()
  return { ...actual, run: runMock }
})

function okResult(over: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', elapsedMs: 1, ...over }
}

describe('prepare(): LTO build that drops LDFLAGS produces no bitcode', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kanalyzer-prepare-'))
    runMock.mockReset()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('throws the LDFLAGS-dropped diagnostic, not a silent empty success', async () => {
    const llvmPrefix = join(tmp, 'llvm')
    mkdirSync(join(llvmPrefix, 'bin'), { recursive: true })
    writeFileSync(join(llvmPrefix, 'bin', 'clang'), '')

    const repo = join(tmp, 'toyproj')
    mkdirSync(repo, { recursive: true })

    // The build "succeeds" (exit 0) but — as in the real dropped-LDFLAGS case — never invokes
    // lld with -plugin-opt=save-temps, so no *.0.0.preopt.bc lands anywhere under repo/cwd.
    runMock.mockImplementation(async (command: string): Promise<RunResult> => {
      // The isolated copy prepare now builds in; nothing else about this case changes.
      if (command === 'rsync') return okResult()
      if (command === '/bin/sh') return okResult({ stdout: 'make: Nothing to be done.\n' })
      throw new Error(`unexpected run(): ${command}`)
    })

    const base = Config()
    const cfg = { ...base, install: { ...base.install, llvmPrefix, installDir: join(tmp, 'no-kanalyzer-install') } }
    const runtime = new KanalyzerRuntime(new Context(), {
      config: () => cfg,
      writeStatus: async () => {},
      packageRoot: tmp,
    })

    await expect(runtime.prepare({
      repo, buildCmd: 'make clean && make -f Makefile.noldflags', mode: 'lto',
    })).rejects.toThrow(/produced no \*\.0\.0\.preopt\.bc/)
  })
})
