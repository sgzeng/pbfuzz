/**
 * Prebuilt-directory import: the dump file discovery that decides what a directory contains, and
 * the derivation that turns those dumps into the same result a live run reports.
 *
 * Fixtures are the real Magma LUA001 captures (`tests/fixtures.ts`, regenerate with
 * `scripts/capture-fixtures.mjs`), so the names, path styles and call-graph GUIDs under test are
 * KAMain's, not a mock's.
 */
import { describe, expect, it } from 'vitest'
import { DUMP_FILES } from '../src/core/options.ts'
import { RepoIndex } from '../src/core/paths.ts'
import { missingRequiredDumps, resolveDumpFiles } from '../src/core/prebuilt.ts'
import { analyzeFromDumps, type DumpAnalysisInput } from '../src/core/result.ts'
import { parseStderr } from '../src/core/stderr.ts'
import * as F from './fixtures.ts'

/** What Magma's `fuzzers/pre-built/lua/BBtargets/LUA001/` holds, names included. */
const MAGMA_NAMES = [
  'BBtargets.txt',
  'lua_bid_loc_mapping.txt',
  'lua_callee-caller.txt',
  'lua_caller-callee.txt',
  'lua_critical_BBs.txt',
  'lua_distance.cfg.txt',
  'lua_function_info.txt',
  'lua_policy.txt',
]

describe('prebuilt dump discovery', () => {
  it("resolves Magma's prefixed names, one file per kind", () => {
    const r = resolveDumpFiles(MAGMA_NAMES)
    expect(r.ambiguous).toEqual([])
    expect(r.files).toEqual({
      policy: 'lua_policy.txt',
      distance: 'lua_distance.cfg.txt',
      criticalBranch: 'lua_critical_BBs.txt',
      bidMapping: 'lua_bid_loc_mapping.txt',
      funcInfo: 'lua_function_info.txt',
      callerCallee: 'lua_caller-callee.txt',
      calleeCaller: 'lua_callee-caller.txt',
    })
  })

  it('resolves this plugin\'s own canonical names too, exact match first', () => {
    const bare = resolveDumpFiles([DUMP_FILES.distance, DUMP_FILES.funcInfo, 'notes.txt'])
    expect(bare.files).toEqual({ distance: DUMP_FILES.distance, funcInfo: DUMP_FILES.funcInfo })
    // A bare copy beside a prefixed one is the one to use: it is what a KAMain run wrote here.
    const both = resolveDumpFiles([`lua_${DUMP_FILES.distance}`, DUMP_FILES.distance])
    expect(both.files.distance).toBe(DUMP_FILES.distance)
  })

  it("ignores Magma's BBtargets.txt and reports the required kinds a directory lacks", () => {
    const r = resolveDumpFiles(['BBtargets.txt', 'lua_distance.cfg.txt'])
    expect(r.files).toEqual({ distance: 'lua_distance.cfg.txt' })
    expect(missingRequiredDumps(r.files)).toEqual([
      DUMP_FILES.criticalBranch, DUMP_FILES.bidMapping, DUMP_FILES.funcInfo, DUMP_FILES.callerCallee, DUMP_FILES.calleeCaller,
    ])
  })

  it("refuses to guess between two programs' dump sets, and lets `program` break the tie", () => {
    const names = ['lua_distance.cfg.txt', 'luac_distance.cfg.txt']
    const r = resolveDumpFiles(names)
    expect(r.files.distance).toBeUndefined()
    expect(r.ambiguous).toEqual([{ kind: 'distance', candidates: ['lua_distance.cfg.txt', 'luac_distance.cfg.txt'] }])
    expect(resolveDumpFiles(names, 'luac').files.distance).toBe('luac_distance.cfg.txt')
    expect(resolveDumpFiles(names, 'lua').ambiguous).toEqual([])
  })
})

describe('import derivation (analyzeFromDumps on real LUA001 dumps)', () => {
  const repo = new RepoIndex('/tmp/lua-repo', ['src/ldebug.c', 'src/ldblib.c', 'src/ldo.c'])
  const base: Omit<DumpAnalysisInput, 'requestedTargets' | 'missingDumps'> = {
    texts: {
      distance: F.LUA001_DISTANCE,
      criticalBranch: F.LUA001_CRITICAL,
      bidMapping: F.LUA001_BID_MAPPING,
      funcInfo: F.LUA001_FUNC_INFO,
    },
    // An import stands in for a run that exited cleanly; there is no stderr to read.
    process: { exitCode: 0, signal: null, timedOut: false },
    stderr: parseStderr(''),
    entries: [],
    outputDir: '/pb/LUA001',
    elapsedMs: 1,
    repo,
  }

  it('resolves the real target at distance 0, with repo-relative paths and real counts', async () => {
    const r = await analyzeFromDumps({ ...base, requestedTargets: ['ldebug.c:197'], missingDumps: [] })
    expect(r.status).toBe('ok')
    expect(r.targets).toEqual([{ requested: 'ldebug.c:197', function: 'findvararg', location: 'src/ldebug.c:197', distance: 0 }])
    expect(r.reachableFunctions).toBe(6)
    expect(r.totalFunctions).toBe(F.LUA001_FUNC_INFO.trim().split('\n').length)
    expect(r.reason).toBeUndefined()
  })

  it('maps every critical branch to a real location, not to a bare block id', async () => {
    const r = await analyzeFromDumps({ ...base, requestedTargets: ['ldebug.c:197'], missingDumps: [] })
    expect(r.criticalBranches.length).toBeGreaterThan(0)
    expect(r.criticalBranches.filter(b => b.location.startsWith('bid:'))).toEqual([])
    // ldo.c is in the repo, so its critical blocks come back repo-relative.
    expect(r.criticalBranches.filter(b => b.function === 'luaD_throw').map(b => b.location).sort())
      .toEqual(['src/ldo.c:115', 'src/ldo.c:128', 'src/ldo.c:130'])
  })

  it('a target that resolved to nothing is no_target with real nearby candidates', async () => {
    const r = await analyzeFromDumps({ ...base, requestedTargets: ['ldebug.c:1'], missingDumps: [] })
    expect(r.status).toBe('no_target')
    expect(r.targets).toEqual([])
    expect(r.reason).toMatch(/no requested location resolved/i)
    expect(r.unresolved?.[0]?.requested).toBe('ldebug.c:1')
    expect(r.unresolved?.[0]?.nearbyCandidates.length).toBeGreaterThan(0)
  })

  it('an incomplete dump set is an error that names what is missing, never an ok', async () => {
    const texts = { distance: F.LUA001_DISTANCE }
    const missing = missingRequiredDumps({ distance: 'lua_distance.cfg.txt' })
    const r = await analyzeFromDumps({ ...base, texts, requestedTargets: ['ldebug.c:197'], missingDumps: missing })
    expect(r.status).toBe('error')
    expect(r.reason).toMatch(/Requested dumps were not written/)
    expect(r.reason).toContain(DUMP_FILES.funcInfo)
    expect(r.targets).toEqual([])
  })

  it('without a repo the dumps\' own absolute paths pass through unchanged', async () => {
    const r = await analyzeFromDumps({ ...base, repo: undefined, requestedTargets: ['ldebug.c:197'], missingDumps: [] })
    expect(r.targets[0]?.location).toBe('/magma/targets/lua/repo/ldebug.c:197')
  })
})
