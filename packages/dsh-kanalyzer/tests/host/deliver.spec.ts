/**
 * `AnalyzeRequest.outputDir` delivery: the dump files one run produced (or a cache hit still
 * holds) are copied into the directory the caller asked for, so the user finds the results in
 * the session workspace instead of the cache directory. The cache directory stays the canonical
 * store — `query()` and future hits read it, never the delivered copy.
 *
 * Same harness as `runtime-reachability.spec.ts`: only the subprocess boundary (`run()`) is
 * mocked — it "runs" KAMain by copying the real reachable-toy fixture dumps into the computed
 * run directory. `interpret()`, the cache and `deliverDumps()` are the real code.
 *
 * @module @pbfuzz/dsh-kanalyzer/tests/host/deliver
 */
import { Context } from '@deepseek-ai/cordis'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DUMP_FILES } from '../../src/core/options.ts'
import type { RunResult } from '../../src/host/exec.ts'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import { config, okResult } from './prepare-harness.ts'

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }))

vi.mock('../../src/host/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/exec.ts')>()
  return { ...actual, run: runMock }
})

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '..', 'fixtures', 'unreachable-toy', 'reachable')

/** The dump files a default-selection run produces, in the plugin's canonical names. */
const DUMP_NAMES = [
  DUMP_FILES.policy, DUMP_FILES.distance, DUMP_FILES.criticalBranch,
  DUMP_FILES.bidMapping, DUMP_FILES.funcInfo, DUMP_FILES.callerCallee, DUMP_FILES.calleeCaller,
]

describe('analyze(): delivers the dump files to outputDir', () => {
  let tmp: string
  let installDir: string
  let llvmPrefix: string
  let kamainBinary: string
  let bitcode: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kanalyzer-deliver-'))
    installDir = join(tmp, 'install')
    llvmPrefix = join(tmp, 'llvm')
    mkdirSync(join(llvmPrefix, 'bin'), { recursive: true })
    writeFileSync(join(llvmPrefix, 'bin', 'clang'), '')
    kamainBinary = join(installDir, 'kernel-analyzer', 'build', 'lib', 'KAMain')
    mkdirSync(dirname(kamainBinary), { recursive: true })
    writeFileSync(kamainBinary, '')
    bitcode = join(tmp, 'toyfuzz.0.0.preopt.bc')
    writeFileSync(bitcode, 'not really bitcode, just needs to exist and hash')
    runMock.mockReset()
    mockKamainRun()
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Mock `run()` so the KAMain invocation "produces" the fixture dumps it was asked for. */
  function mockKamainRun(skip: string[] = []): void {
    runMock.mockImplementation(async (command: string, args: string[], opts: { cwd?: string } = {}): Promise<RunResult> => {
      if (command === 'git') return okResult({ exitCode: 1 })
      if (command.endsWith('llvm-config')) return okResult({ stdout: '14.0.0\n' })
      if (command === kamainBinary) {
        const cwd = opts.cwd
        if (cwd === undefined) throw new Error('expected a cwd for the KAMain run')
        for (const name of DUMP_NAMES) {
          if (!skip.includes(name)) copyFileSync(join(FIXTURES, name), join(cwd, name))
        }
        return okResult({ stderr: readFileSync(join(FIXTURES, 'kamain.stderr.log'), 'utf8') })
      }
      throw new Error(`unexpected run(): ${command} ${args.join(' ')}`)
    })
  }

  function service(): KanalyzerRuntime {
    return new KanalyzerRuntime(new Context(), {
      config: () => config(installDir, llvmPrefix, { cacheEnabled: true }),
      writeStatus: async () => {},
      packageRoot: tmp,
    })
  }

  function request(outputDir?: string): { bitcode: string; targets: string[]; entries: string[]; outputDir?: string } {
    return { bitcode, targets: ['helper.c:6'], entries: ['main'], ...(outputDir !== undefined ? { outputDir } : {}) }
  }

  it('copies every produced dump into outputDir and reports that directory', async () => {
    const deliverDir = join(tmp, 'workspace')
    const result = await service().analyze(request(deliverDir))
    expect(result.status).toBe('ok')
    expect(result.outputDir).toBe(deliverDir)
    expect(result.dumpFiles).toEqual(DUMP_NAMES)
    for (const name of DUMP_NAMES) expect(existsSync(join(deliverDir, name))).toBe(true)
    // The canonical store still lives in the cache, with result.json for future hits.
    const cacheEntries = readdirSync(join(installDir, 'cache'))
    expect(cacheEntries).toHaveLength(1)
    expect(existsSync(join(installDir, 'cache', cacheEntries[0]!, 'result.json'))).toBe(true)
  })

  it('re-delivers the dumps from the cache on a hit, to whatever directory the new call names', async () => {
    const svc = service()
    const first = await svc.analyze(request(join(tmp, 'workspace1')))
    expect(first.cached).toBe(false)
    const deliver2 = join(tmp, 'workspace2')
    const second = await svc.analyze(request(deliver2))
    expect(second.cached).toBe(true)
    expect(second.outputDir).toBe(deliver2)
    expect(second.dumpFiles).toEqual(DUMP_NAMES)
    for (const name of DUMP_NAMES) expect(existsSync(join(deliver2, name))).toBe(true)
  })

  it('keeps the cache directory as outputDir when the caller passes none', async () => {
    const result = await service().analyze(request())
    expect(result.status).toBe('ok')
    expect(result.outputDir).toContain(join(installDir, 'cache'))
    expect(result.dumpFiles).toEqual(DUMP_NAMES)
  })

  it('leaves an earlier analysis\'s files alone when this run fails', async () => {
    const deliverDir = join(tmp, 'workspace')
    mkdirSync(deliverDir, { recursive: true })
    // A dump left by an earlier successful analysis, which this run fails to produce.
    writeFileSync(join(deliverDir, DUMP_FILES.distance), 'earlier run')
    mockKamainRun([DUMP_FILES.distance])
    const result = await service().analyze(request(deliverDir))
    expect(result.status).toBe('error')
    expect(result.reason).toMatch(/not written/i)
    expect(readFileSync(join(deliverDir, DUMP_FILES.distance), 'utf8')).toBe('earlier run')
    expect(existsSync(join(deliverDir, DUMP_FILES.policy))).toBe(false)
  })

  it('rejects a malformed target before KAMain runs, delivering nothing', async () => {
    const deliverDir = join(tmp, 'workspace')
    const result = await service().analyze({ bitcode, targets: ['not-a-file:line'], entries: ['main'], outputDir: deliverDir })
    expect(result.status).toBe('error')
    expect(result.reason).toMatch(/malformed target/)
    expect(runMock.mock.calls.some(c => c[0] === kamainBinary)).toBe(false)
    expect(existsSync(deliverDir)).toBe(false)
  })
})
