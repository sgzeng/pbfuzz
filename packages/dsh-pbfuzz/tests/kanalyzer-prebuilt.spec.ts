/**
 * The prebuilt-import branch of the kanalyzer provider — Bug #6 of the V2 verification notes.
 *
 * `analysis.static.mode: prebuilt` with `prebuilt_dir` is Magma's `SKIP_STATIC_ANALYSIS` path: the
 * analysis already ran, so the campaign has no build command *by design*. The provider used to fall
 * through to the LTO branch and diagnose exactly that as `no build command: set build.cmd …` —
 * a wrong, misleading failure. These tests pin the three-branch contract: import, reuse, rebuild.
 *
 * Two levels of test: the wiring (a fake service, asserting which calls the provider makes) and the
 * real thing — `@pbfuzz/dsh-kanalyzer`'s actual runtime, given a directory of the real captured
 * LUA001 dumps (`packages/dsh-kanalyzer/tests/fixtures.ts`) and an install directory with no KAMain
 * in it at all, which is the whole point of the mode.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { draftCampaign } from '../src/core/campaign.ts'
import type { AnalyzeResult, KanalyzerService, PbfuzzCampaign } from '../src/core/contracts.ts'
import { KanalyzerProvider, programFromRunCmd } from '../src/core/kanalyzer-provider.ts'
import { KanalyzerRuntime } from '../../dsh-kanalyzer/src/host/runtime.ts'
import * as KAF from '../../dsh-kanalyzer/tests/fixtures.ts'
import { draftInput, settings } from './fixtures.ts'

const PREBUILT_DIR = '/pb/LUA001'

/** A campaign with no build command and no bitcode: prebuilt results are its only input. */
function prebuiltCampaign(prebuiltDir = PREBUILT_DIR, extra: Record<string, unknown> = {}): PbfuzzCampaign {
  const s = settings({ tools: { staticAnalysis: 'kanalyzer' } })
  return draftCampaign(draftInput({
    bug: { targets: [{ location: 'ldebug.c:197' }] },
    analysis: { static: { mode: 'prebuilt', prebuilt_dir: prebuiltDir, program: 'lua', ...extra } },
  }), s, false).campaign
}

/** The shape `importPrebuilt` answers with, for the wiring tests. */
function importedResult(over: Partial<AnalyzeResult & { handle: string; files: Record<string, string> }> = {}) {
  return {
    status: 'ok' as const,
    targets: [{ requested: 'ldebug.c:197', function: 'findvararg', location: 'src/ldebug.c:197', distance: 0 }],
    criticalBranches: [{ function: 'luaD_throw', location: 'src/ldo.c:115', distance: 3000 }],
    reachableFunctions: 6,
    totalFunctions: 23,
    entriesUsed: [] as string[],
    outputDir: PREBUILT_DIR,
    elapsedMs: 2,
    cached: false,
    handle: PREBUILT_DIR,
    files: { distance: 'lua_distance.cfg.txt', criticalBranch: 'lua_critical_BBs.txt', bidMapping: 'lua_bid_loc_mapping.txt', funcInfo: 'lua_function_info.txt', callerCallee: 'lua_caller-callee.txt', calleeCaller: 'lua_callee-caller.txt' },
    ...over,
  }
}

/**
 * A kanalyzer service that *only* implements the import. Every method that would run KAMain throws,
 * so a test that passes proves the prebuilt path never consulted it.
 */
function fakePrebuilt(over: { importPrebuilt?: (dir: string) => Promise<ReturnType<typeof importedResult>> } = {}) {
  const calls: string[] = []
  const kamain = (what: string) => async (): Promise<never> => { calls.push(what); throw new Error(`${what} must not be called in prebuilt mode`) }
  const service = {
    calls,
    status: kamain('status'),
    doctor: kamain('doctor'),
    prepare: kamain('prepare'),
    analyze: kamain('analyze'),
    index: kamain('index'),
    query: async (req: { op: string; fn?: string; location?: string; bitcode: string }) => {
      calls.push(`query:${req.op}:${req.bitcode}`)
      const results = req.op === 'callers' ? ['luaG_findlocal']
        : req.op === 'callees' ? ['lua_getlocal']
          : req.op === 'functionAt' ? ['findvararg']
            : ['src/ldo.c:115']
      return { op: req.op, results, truncated: false }
    },
    importPrebuilt: async (req: { dir: string }) => {
      calls.push(`importPrebuilt:${req.dir}`)
      return over.importPrebuilt !== undefined ? over.importPrebuilt(req.dir) : importedResult()
    },
  }
  return { calls, service: service as unknown as KanalyzerService }
}

describe('KanalyzerProvider.prepare: prebuilt_dir import', () => {
  it('does not diagnose a prebuilt campaign as "no build command" (the V2 bug)', async () => {
    const k = fakePrebuilt()
    const prep = await new KanalyzerProvider(k.service).prepare(prebuiltCampaign())
    expect(prep.reason ?? '').not.toMatch(/no build command/)
    expect(prep.ok).toBe(true)
    expect(prep.handle).toBe(PREBUILT_DIR)
    expect(k.calls).toEqual([`importPrebuilt:${PREBUILT_DIR}`])
    expect(prep.evidence.join('\n')).toMatch(/no build, no KAMain run/)
    expect(prep.evidence.join('\n')).toMatch(/import status=ok, 1 targets resolved, 1 critical branches/)
  })

  it('wins over a bitcode the campaign also carries, and never runs the analysis', async () => {
    const k = fakePrebuilt()
    const campaign = prebuiltCampaign(PREBUILT_DIR, { bitcode: '/lua.0.0.preopt.bc' })
    const prep = await new KanalyzerProvider(k.service).prepare(campaign)
    expect(prep.ok).toBe(true)
    expect(k.calls).toEqual([`importPrebuilt:${PREBUILT_DIR}`])
  })

  it('treats `mode: prebuilt` without `prebuilt_dir` as a campaign error, not as a build problem', async () => {
    const s = settings({ tools: { staticAnalysis: 'kanalyzer' } })
    const campaign = draftCampaign(draftInput({ analysis: { static: { mode: 'prebuilt' } } }), s, false).campaign
    const prep = await new KanalyzerProvider(fakePrebuilt().service).prepare(campaign)
    expect(prep.ok).toBe(false)
    expect(prep.reason).toMatch(/prebuilt_dir` is not set/)
    expect(prep.reason).not.toMatch(/no build command/)
  })

  it('reports a kanalyzer build without the import capability instead of falling back to a rebuild', async () => {
    const { service } = fakePrebuilt()
    const withoutImport = { ...service } as Record<string, unknown>
    delete withoutImport.importPrebuilt
    const prep = await new KanalyzerProvider(withoutImport as unknown as KanalyzerService).prepare(prebuiltCampaign())
    expect(prep.ok).toBe(false)
    expect(prep.reason).toMatch(/importPrebuilt/)
    expect(prep.reason).not.toMatch(/no build command/)
  })

  it('leaves the bitcode-reuse and rebuild branches exactly as they were', async () => {
    const calls: string[] = []
    const kamain = (what: string) => async (): Promise<never> => { calls.push(what); throw new Error(`${what} must not be called`) }
    const service = {
      status: kamain('status'), doctor: kamain('doctor'), index: kamain('index'),
      analyze: kamain('analyze'), query: kamain('query'),
      prepare: async () => { calls.push('prepare'); return { bitcode: '/b/x.0.0.preopt.bc', allBitcode: ['/b/x.0.0.preopt.bc'], entries: ['main'], nFuncs: 3 } },
    } as unknown as KanalyzerService
    const provider = new KanalyzerProvider(service)
    const s = settings({ tools: { staticAnalysis: 'kanalyzer' } })

    const reused = await provider.prepare(draftCampaign(draftInput({
      analysis: { static: { mode: 'lto', bitcode: '/campaign/x.bc' } },
    }), s, false).campaign)
    expect(reused).toMatchObject({ ok: true, handle: '/campaign/x.bc' })
    expect(calls).toEqual([])

    const rebuilt = await provider.prepare({ ...draftCampaign(draftInput(), s, false).campaign, build: { cmd: 'make -j8' } })
    expect(rebuilt.ok).toBe(true)
    expect(calls).toEqual(['prepare'])

    const buildless = await provider.prepare(draftCampaign(draftInput(), s, false).campaign)
    expect(buildless.ok).toBe(false)
    expect(buildless.reason).toMatch(/no build command/)
  })
})

describe('KanalyzerProvider.ensureReady: prebuilt mode', () => {
  it('passes from imported results alone, with every query answered through the import handle', async () => {
    const k = fakePrebuilt()
    const provider = new KanalyzerProvider(k.service)
    const result = await provider.ensureReady(prebuiltCampaign())
    expect(result.ok).toBe(true)
    expect(result.remedies).toBeUndefined()
    // No status, no doctor, no analyze, and no probe queries: only the import. `ensureReady`
    // prepares and reports; it does not re-assert what the analysis status already says.
    expect(k.calls).toEqual([`importPrebuilt:${PREBUILT_DIR}`])
    const evidence = result.evidence.join('\n')
    expect(evidence).toMatch(/imported prebuilt KAMain results from/)
    expect(evidence).toMatch(/import status=ok, 1 targets resolved, 1 critical branches/)

    expect(await provider.callers('findvararg')).toEqual(['luaG_findlocal'])
    expect(await provider.callees('db_getlocal')).toEqual(['lua_getlocal'])
    expect(await provider.functionAt('ldebug.c:197')).toBe('findvararg')
    expect(await provider.criticalLocations()).toEqual([{ location: 'src/ldo.c:115', function: 'luaD_throw', distance: 3000 }])
  })

  it('fails with dump-side remedies when the import throws (missing or unreadable directory)', async () => {
    const k = fakePrebuilt({ importPrebuilt: async dir => { throw new Error(`prebuilt_dir ${dir} is not a readable directory: ENOENT`) } })
    const result = await new KanalyzerProvider(k.service).ensureReady(prebuiltCampaign('/pb/nope'))
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/prebuilt import failed: prebuilt_dir \/pb\/nope is not a readable directory/)
    expect(result.remedies?.[0]?.id).toBe('fix_prebuilt_dir')
    expect(result.remedies?.map(r => r.id)).toContain('use_bitcode')
  })

  it('fails on an unusable dump set instead of reporting a silent ok', async () => {
    const k = fakePrebuilt({ importPrebuilt: async () => importedResult({ status: 'error', reason: 'Requested dumps were not written: function_info.txt.', targets: [], criticalBranches: [] }) })
    const result = await new KanalyzerProvider(k.service).ensureReady(prebuiltCampaign())
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/prebuilt results in \/pb\/LUA001 are unusable: Requested dumps were not written: function_info\.txt\./)
    expect(result.evidence.join('\n')).toMatch(/import refused:/)
  })

  it('keeps the unresolved-target diagnosis, candidates included, when the dumps hold no such line', async () => {
    const k = fakePrebuilt({
      importPrebuilt: async () => importedResult({
        status: 'no_target', targets: [], criticalBranches: [],
        unresolved: [{ requested: 'ldebug.c:197', nearbyCandidates: ['ldebug.c:198', 'ldebug.c:190'] }],
      }),
    })
    const result = await new KanalyzerProvider(k.service).ensureReady(prebuiltCampaign())
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/ldebug\.c:197 carries no instruction/)
    // The candidates from the imported dumps come back as one-click campaign edits.
    expect(result.remedies?.map(r => r.id)).toEqual(expect.arrayContaining(['use_ldebug_c_198', 'use_ldebug_c_190']))
    expect(result.remedies?.find(r => r.id === 'use_ldebug_c_198')?.label).toBe('Use ldebug.c:198 instead')
    // A no_target import must not fall through to running KAMain either.
    expect(k.calls).toEqual([`importPrebuilt:${PREBUILT_DIR}`])
  })
})

describe('prebuilt import through the real kanalyzer runtime, with no KAMain installed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pbfuzz-prebuilt-'))
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }) })

  /** The real Magma LUA001 dump directory, materialised from the captured fixtures. */
  const dumps = join(tmp, 'BBtargets', 'LUA001')
  const repo = join(tmp, 'lua')
  mkdirSync(dumps, { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  for (const [name, text] of [
    ['BBtargets.txt', KAF.LUA001_TARGETS], // not a dump file: must be ignored, not misread
    ['lua_distance.cfg.txt', KAF.LUA001_DISTANCE],
    ['lua_critical_BBs.txt', KAF.LUA001_CRITICAL],
    ['lua_bid_loc_mapping.txt', KAF.LUA001_BID_MAPPING],
    ['lua_function_info.txt', KAF.LUA001_FUNC_INFO],
    ['lua_caller-callee.txt', KAF.LUA001_CALLER_CALLEE],
    ['lua_callee-caller.txt', KAF.LUA001_CALLEE_CALLER],
  ] as const) writeFileSync(join(dumps, name), text)
  for (const name of ['ldebug.c', 'ldblib.c', 'ldo.c']) writeFileSync(join(repo, 'src', name), '/* the real file is not needed: dumps carry the line numbers */\n')

  /** A runtime whose install directory holds no KAMain — `status()` must say so. */
  function runtime(noKanalyzerInstall: string): KanalyzerRuntime {
    return new KanalyzerRuntime(new Context(), {
      config: () => ({
        install: { installDir: noKanalyzerInstall, repoUrl: '', branch: 'mzt', llvmPrefix: '', buildType: 'Release', jobs: 0 },
        defaults: {
          verbose: 1, callStackLen: 20, useTypeBasedCallGraph: true, timeoutSec: 1800, memLimitMB: 16384, cacheEnabled: true,
          dumps: { policy: true, distance: true, criticalBranch: true, bidMappingAndFuncInfo: true, callerCalleeBothWays: true, annotatedIr: false },
        },
        standalone: { inputFilenames: [], targetList: [], entryList: [] },
        status: { installed: false, binaryPath: '', commit: '', llvmVersion: '', lastDoctor: '', lastDoctorAt: '', lastDoctorMessage: '' },
      }) as never,
      writeStatus: async () => {},
      packageRoot: join(__dirname, '..', '..', 'dsh-kanalyzer'),
    })
  }

  it('self-tests and answers call-graph, location and critical-branch queries from the dumps', async () => {
    const service = runtime(join(tmp, 'no-kanalyzer-install'))
    expect((await service.status()).installed).toBe(false)
    const calls: string[] = []
    for (const name of ['status', 'doctor', 'prepare', 'analyze', 'index'] as const) {
      const original = service[name].bind(service) as (...args: unknown[]) => Promise<unknown>
      ;(service as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => { calls.push(name); return original(...args) }
    }

    const provider = new KanalyzerProvider(service as unknown as KanalyzerService)
    const campaign: PbfuzzCampaign = { ...prebuiltCampaign(dumps), target: { repo, language: 'c' } }
    const result = await provider.ensureReady(campaign)
    const evidence = result.evidence.join('\n')

    expect(result.ok).toBe(true)
    expect(evidence).toMatch(/imported prebuilt KAMain results from .*BBtargets\/LUA001: lua_bid_loc_mapping\.txt, lua_callee-caller\.txt, lua_caller-callee\.txt, lua_critical_BBs\.txt, lua_distance\.cfg\.txt, lua_function_info\.txt \(6 dump files/)
    expect(evidence).toMatch(/import status=ok, \d+ targets resolved, \d+ critical branches/)
    // The import ran everything; the real KAMain path was never entered (and could not have been).
    expect(calls).toEqual([])

    expect(await provider.callers('findvararg')).toEqual(['luaG_findlocal'])
    expect(await provider.callees('db_getlocal')).toContain('lua_getlocal')
    expect(await provider.functionAt('ldebug.c:197')).toBe('findvararg')
    const critical = await provider.criticalLocations()
    expect(critical.length).toBeGreaterThan(0)
    // Repo-relative paths, exactly like a live run's remapping — and no `bid:` placeholders.
    expect(critical.map(c => c.location)).toContain('src/ldo.c:115')
    expect(critical.filter(c => c.location.startsWith('bid:'))).toEqual([])
  })
})

/**
 * kanalyzer's prepare now defaults to `wllvm` (it survives build systems that drop LDFLAGS, which
 * is what large projects do), and wllvm needs the name of the link output to extract bitcode from.
 * Requiring every existing campaign to grow an `analysis.static.program` field would break them
 * all at prepare, so pbfuzz reads it off the `entry.run_cmd` the campaign already has.
 */
describe('programFromRunCmd', () => {
  it('takes the basename of the executable a run_cmd runs', () => {
    expect(programFromRunCmd('/mnt/work/readelf @@')).toBe('readelf')
    expect(programFromRunCmd('./build/fuzz_target @@')).toBe('fuzz_target')
    expect(programFromRunCmd('  ./a.out  @@  ')).toBe('a.out')
    expect(programFromRunCmd('readelf @@')).toBe('readelf')
  })

  it('declines anything it cannot read off confidently, rather than guessing', () => {
    // An interpreter's own name is never the link output — the real program is the script.
    expect(programFromRunCmd('python3 harness.py @@')).toBeUndefined()
    expect(programFromRunCmd('/usr/bin/env ./run @@')).toBeUndefined()
    expect(programFromRunCmd('sh -c "./x @@"')).toBeUndefined()
    // Shell constructs mean the first token is not a path.
    expect(programFromRunCmd('$TARGET @@')).toBeUndefined()
    expect(programFromRunCmd('FOO=1 ./x @@')).toBeUndefined()
    expect(programFromRunCmd('cat @@ | ./x')).toBeUndefined()
    expect(programFromRunCmd('')).toBeUndefined()
    expect(programFromRunCmd(undefined)).toBeUndefined()
  })
})
