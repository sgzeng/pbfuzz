/**
 * F18 — `doPrepare()` (via the public `prepare()`) must not ignore `llvm-nm`'s exit code.
 *
 * Neighbouring steps in the same method (the build command, `extract-bc`) both check `exitCode`
 * and throw a real error on failure; the `llvm-nm` step used to feed `nm.stdout` straight into
 * `inferEntries()` regardless of `nm.exitCode`, so a failed invocation (wrong path, corrupt
 * binary) silently produced the same success-shaped `{entries: [], nFuncs: 0}` as a run that
 * genuinely found nothing.
 *
 * This mocks the subprocess boundary (`run()` in `../../src/host/exec.ts`) so the build and
 * `extract-bc` steps "succeed" and only the final `llvm-nm` call fails, the way a corrupt or
 * missing binary would in reality.
 */
import { Context } from '@deepseek-ai/cordis'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunResult } from '../../src/host/exec.ts'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import type { Config } from '../../src/host/settings.ts'

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }))

vi.mock('../../src/host/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/exec.ts')>()
  return { ...actual, run: runMock }
})

function okResult(over: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', elapsedMs: 1, ...over }
}

function config(installDir: string, llvmPrefix: string): Config {
  return {
    install: { installDir, repoUrl: '', branch: 'mzt', llvmPrefix, buildType: 'Release', jobs: 0, wllvmBinDir: '' },
    defaults: {
      verbose: 1, callStackLen: 20, useTypeBasedCallGraph: true, timeoutSec: 1800, memLimitMB: 16384, cacheEnabled: true, prepareMode: 'wllvm',
      dumps: { policy: true, distance: true, criticalBranch: true, bidMappingAndFuncInfo: true, callerCalleeBothWays: true, annotatedIr: false },
    },
    standalone: { inputFilenames: [], targetList: [], entryList: [] },
    status: { installed: false, binaryPath: '', commit: '', llvmVersion: '', lastDoctor: '', lastDoctorAt: '', lastDoctorMessage: '', lastWllvm: '', lastWllvmAt: '', lastWllvmMessage: '', wllvmBinDir: '' },
  }
}

describe('doPrepare(): llvm-nm exit code', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kanalyzer-nm-'))
    runMock.mockReset()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('throws a real error, distinct from an empty success, when llvm-nm exits nonzero', async () => {
    // A fake LLVM install: just enough (`bin/clang` present) for toolchain() to accept it.
    const llvmPrefix = join(tmp, 'llvm')
    mkdirSync(join(llvmPrefix, 'bin'), { recursive: true })
    writeFileSync(join(llvmPrefix, 'bin', 'clang'), '')

    const repo = join(tmp, 'repo')
    mkdirSync(repo, { recursive: true })
    // wllvm mode's link output — what the (mocked) build "produces".
    writeFileSync(join(repo, 'app'), '')

    runMock.mockImplementation(async (command: string, args: string[]): Promise<RunResult> => {
      // prepare() now builds in an isolated copy of the checkout, so the copy has to happen for
      // the build's link output to exist where doPrepare() looks for it.
      if (command === 'rsync') {
        const from = (args[args.length - 2] ?? '').replace(/\/$/, '')
        const to = (args[args.length - 1] ?? '').replace(/\/$/, '')
        mkdirSync(to, { recursive: true })
        for (const entry of readdirSync(from)) {
          if (entry === '.kanalyzer') continue
          cpSync(join(from, entry), join(to, entry), { recursive: true })
        }
        return okResult()
      }
      if (command === '/bin/sh') return okResult() // the build command
      if (command === 'extract-bc') {
        // extract-bc's real job is writing the *.0.0.preopt.bc next to the binary.
        const out = args[1]
        if (out !== undefined) writeFileSync(out, 'not really bitcode')
        return okResult()
      }
      if (command.endsWith('llvm-nm')) {
        // A corrupt/nonexistent binary: llvm-nm exits nonzero with a diagnostic, no stdout.
        return okResult({ exitCode: 1, stdout: '', stderr: `${command}: error: 'app.0.0.preopt.bc': The file was not recognized as a valid object file\n` })
      }
      throw new Error(`unexpected run(): ${command} ${args.join(' ')}`)
    })

    const service = new KanalyzerRuntime(new Context(), {
      config: () => config(join(tmp, 'no-kanalyzer-install'), llvmPrefix),
      writeStatus: async () => {},
      packageRoot: tmp,
    })

    await expect(service.prepare({
      repo, buildCmd: 'true', mode: 'wllvm', program: 'app',
    })).rejects.toThrow(/llvm-nm/i)
  })
})
