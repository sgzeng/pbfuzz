/**
 * F5 wiring regression: `host/runtime.ts`'s two callers of `analyzeFromDumps()` — `interpret()`
 * (the live `analyze()`, i.e. the `kanalyzer_analyze` tool path) and `importPrebuilt()` — never
 * read or forwarded the caller→callee call-graph dump, so the independent reachability cross-check
 * `core/status.ts`'s `deriveStatus` gained for F5 (see its module doc, and
 * `status-reachability.spec.ts`) only ever engaged in unit tests that supplied `callerCallee`
 * directly. It was inert on every real path.
 *
 * The first `describe` below exercises `interpret()` end to end against the real, unmodified
 * KAMain dumps captured under `tests/fixtures/unreachable-toy/` (see `status-reachability.spec.ts`
 * for their provenance and the ground truth they encode). Only the subprocess boundary (`run()` in
 * `../../src/host/exec.ts`) is mocked — it "runs" KAMain by copying a fixture case's dump files
 * into the computed output directory and returning its real stderr log, exactly what a live KAMain
 * invocation leaves behind. Dump parsing, `deriveStatus` and the cross-check are all the real,
 * unmocked code, so a pass here proves the fix end to end on the same path `kanalyzer_analyze` uses
 * — the fix_plan.md acceptance criterion for F5.
 *
 * `importPrebuilt()` cannot be driven to `unreachable` the same way: unlike `interpret()` it has no
 * `entries` of its own (`PrebuiltImportRequest` carries none, and there is no stderr to echo them
 * from), so `crossCheckReachability`'s entries guard always bails for an import regardless of this
 * wiring — a pre-existing gap, out of this fix's scope. The second `describe` instead proves the
 * fix directly: that the caller-callee dump is now read off disk and reaches `analyzeFromDumps` as
 * `texts.callerCallee`.
 *
 * @module @pbfuzz/dsh-kanalyzer/tests/host/runtime-reachability
 */
import { Context } from '@deepseek-ai/cordis'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DUMP_FILES } from '../../src/core/options.ts'
import type { RunResult } from '../../src/host/exec.ts'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import type { Config } from '../../src/host/settings.ts'

const { runMock, analyzeFromDumpsMock, runQueryMock } = vi.hoisted(
  () => ({ runMock: vi.fn(), analyzeFromDumpsMock: vi.fn(), runQueryMock: vi.fn() }),
)

vi.mock('../../src/host/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/exec.ts')>()
  return { ...actual, run: runMock }
})

// Wraps the real `analyzeFromDumps` so `interpret()`'s tests below still run the actual
// dump-parsing/status-derivation pipeline; only `importPrebuilt()`'s test inspects the calls.
vi.mock('../../src/core/result.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/result.ts')>()
  analyzeFromDumpsMock.mockImplementation(actual.analyzeFromDumps)
  return { ...actual, analyzeFromDumps: analyzeFromDumpsMock }
})

// Same wrapping trick for the query path: the real `runQuery` still answers, and the last
// describe below inspects what `runtime.ts` actually handed it.
vi.mock('../../src/core/query.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/query.ts')>()
  runQueryMock.mockImplementation(actual.runQuery)
  return { ...actual, runQuery: runQueryMock }
})

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '..', 'fixtures', 'unreachable-toy')

function okResult(over: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', elapsedMs: 1, ...over }
}

function config(installDir: string, llvmPrefix: string): Config {
  return {
    install: { installDir, repoUrl: '', branch: 'mzt', llvmPrefix, buildType: 'Release', jobs: 0, wllvmBinDir: '' },
    defaults: {
      verbose: 1, callStackLen: 20, useTypeBasedCallGraph: true, timeoutSec: 1800, memLimitMB: 16384, cacheEnabled: false, prepareMode: 'wllvm',
      dumps: { policy: true, distance: true, criticalBranch: true, bidMappingAndFuncInfo: true, callerCalleeBothWays: true, annotatedIr: false },
    },
    standalone: { inputFilenames: [], targetList: [], entryList: [] },
    status: { installed: false, binaryPath: '', commit: '', llvmVersion: '', lastDoctor: '', lastDoctorAt: '', lastDoctorMessage: '', lastWllvm: '', lastWllvmAt: '', lastWllvmMessage: '', wllvmBinDir: '' },
  }
}

/** Canonical dump file names a full-selection run writes — what `interpret()` reads back. */
const DUMP_NAMES = [
  DUMP_FILES.policy, DUMP_FILES.distance, DUMP_FILES.criticalBranch,
  DUMP_FILES.bidMapping, DUMP_FILES.funcInfo, DUMP_FILES.callerCallee, DUMP_FILES.calleeCaller,
]

/** Copy one fixture case's dump files (already canonically named — see F5's fixtures) into a run's output dir. */
function copyDumps(caseDir: string, destDir: string): void {
  for (const name of DUMP_NAMES) {
    const src = join(FIXTURES, caseDir, name)
    if (existsSync(src)) copyFileSync(src, join(destDir, name))
  }
}

describe('interpret(): live analyze() wires the caller-callee dump into the reachability cross-check', () => {
  let tmp: string
  let installDir: string
  let llvmPrefix: string
  let kamainBinary: string
  let bitcode: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kanalyzer-reach-'))
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
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function service(): KanalyzerRuntime {
    return new KanalyzerRuntime(new Context(), {
      config: () => config(installDir, llvmPrefix),
      writeStatus: async () => {},
      packageRoot: tmp,
    })
  }

  /** Mock `run()` so the KAMain invocation "produces" one fixture case's real dumps + stderr. */
  function mockKamainRun(caseDir: string): void {
    const stderr = readFileSync(join(FIXTURES, caseDir, 'kamain.stderr.log'), 'utf8')
    runMock.mockImplementation(async (command: string, args: string[], opts: { cwd?: string } = {}): Promise<RunResult> => {
      if (command === 'git') return okResult({ exitCode: 1 })
      if (command.endsWith('llvm-config')) return okResult({ stdout: '14.0.0\n' })
      if (command === kamainBinary) {
        if (opts.cwd === undefined) throw new Error('expected a cwd for the KAMain run')
        copyDumps(caseDir, opts.cwd)
        return okResult({ stderr })
      }
      throw new Error(`unexpected run(): ${command} ${args.join(' ')}`)
    })
  }

  it('downgrades a live analyze() to "unreachable" for the real unreachable-toy fixture (kanalyzer_analyze path)', async () => {
    mockKamainRun('unreachable')
    const result = await service().analyze({
      bitcode, targets: ['helper.c:6'], entries: ['LLVMFuzzerTestOneInput'], force: true,
    })
    expect(result.status).toBe('unreachable')
    expect(result.reason).toMatch(/call-graph|BFS|reachability/i)
  })

  it('keeps a live analyze() "ok" for the real reachable-toy fixture (no regression)', async () => {
    mockKamainRun('reachable')
    const result = await service().analyze({
      bitcode, targets: ['helper.c:6'], entries: ['main'], force: true,
    })
    expect(result.status).toBe('ok')
    expect(result.targets.some(t => t.function === 'helper_other')).toBe(true)
  })
})

describe('importPrebuilt(): reads and forwards the caller-callee dump', () => {
  beforeEach(() => {
    analyzeFromDumpsMock.mockClear()
  })

  it('passes the real caller-callee dump text through to analyzeFromDumps as texts.callerCallee', async () => {
    const dir = join(FIXTURES, 'unreachable')
    const service = new KanalyzerRuntime(new Context(), {
      config: () => config('/nonexistent', '/nonexistent'),
      writeStatus: async () => {},
      packageRoot: dir,
    })

    const result = await service.importPrebuilt({ dir, targets: ['helper.c:6'] })

    expect(analyzeFromDumpsMock).toHaveBeenCalledTimes(1)
    const input = analyzeFromDumpsMock.mock.calls[0]?.[0] as { texts: { callerCallee?: string } }
    expect(input.texts.callerCallee).toBe(readFileSync(join(dir, DUMP_FILES.callerCallee), 'utf8'))
    // importPrebuilt() has no `entries` channel (see this file's header), so the cross-check's
    // entries guard bails and the pre-existing "ok" (KAMain's own, unchecked verdict) is unchanged
    // — this test is about the wiring, not a status flip.
    expect(result.status).toBe('ok')
  })
})

/**
 * The same bug class as F5 above, one dump pair later: `core/dumps.ts` has always exported
 * `parseDistance` and `parsePolicy`, but `runtime.ts`'s two `runQuery()` callers passed neither, so
 * no query op could ever answer a distance question. That is what once drove an agent to open
 * `distance.cfg.txt`, `critical_BBs.txt` and `bid_loc_mapping.txt` and hand-join them — against the
 * kanalyzer skill's own hard rule — because the tools genuinely could not answer.
 *
 * `queryImported()` is the path exercised here because it needs no KAMain invocation at all: the
 * import's `handle` is the dump directory itself, so `query({bitcode: dir})` routes straight to it.
 */
describe('query(): the distance and policy dumps reach runQuery', () => {
  const dir = join(FIXTURES, 'reachable')

  function imported(): KanalyzerRuntime {
    return new KanalyzerRuntime(new Context(), {
      config: () => config('/nonexistent', '/nonexistent'),
      writeStatus: async () => {},
      packageRoot: dir,
    })
  }

  beforeEach(() => { runQueryMock.mockClear() })

  it('hands runQuery a parsed distance dump and a parsed policy dump', async () => {
    const service = imported()
    await service.importPrebuilt({ dir, targets: ['helper.c:6'] })
    await service.query({ op: 'distances', bitcode: dir })

    expect(runQueryMock).toHaveBeenCalledTimes(1)
    const data = runQueryMock.mock.calls[0]?.[1] as {
      distance?: { rows: unknown[] }
      policy?: unknown[]
    }
    expect(data.distance?.rows.length).toBeGreaterThan(0)
    // This toy has no conditional branches, so its real captured policy.txt is empty. `[]` rather
    // than `undefined` is exactly the distinction that proves the dump was read and parsed — an
    // unwired policy would arrive as `undefined` and look identical from inside runQuery.
    expect(data.policy).toEqual([])
  })

  it('answers a real distance question end to end, with no dump file read by the caller', async () => {
    const service = imported()
    await service.importPrebuilt({ dir, targets: ['helper.c:6'] })

    const distances = await service.query({ op: 'distances', bitcode: dir })
    expect(distances.results.length).toBeGreaterThan(0)
    expect(distances.results.every(r => /=\d+\.\d$/.test(r))).toBe(true)
    // Nearest the target first is the whole point of the op.
    const parsed = distances.results.map(r => Number(r.slice(r.lastIndexOf('=') + 1)))
    expect([...parsed].sort((a, b) => a - b)).toEqual(parsed)

    const functions = await service.query({ op: 'functions', bitcode: dir })
    expect(functions.results.length).toBeGreaterThan(0)
    expect(functions.results.some(r => r.startsWith('helper_other='))).toBe(true)
  })
})
