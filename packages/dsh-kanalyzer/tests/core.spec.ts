import { describe, expect, it } from 'vitest'
import { buildArgs, BUILTIN_DEFAULTS, resolveOptions, selectedDumpFiles, DUMP_FILES } from '../src/core/options.ts'
import { parseStderr } from '../src/core/stderr.ts'
import {
  parseBidMapping, parseCriticalBranches, parseDistance, parseFuncInfo, parseGuidEdges, parsePolicy,
} from '../src/core/dumps.ts'
import {
  blockIndex, criticalBranches, deriveStatus, heuristicInstructionLines, instructionLines, nearbyCandidates,
  resolveTargets, type RunEvidence,
} from '../src/core/status.ts'
import { RepoIndex, parseLocation, targetListEntry } from '../src/core/paths.ts'
import { runQuery } from '../src/core/query.ts'
import { cacheKey } from '../src/core/cache.ts'
import { inferEntries, ltoBuildCmdProblem, ltoEnv, selectBitcode, toolchainAt, programOf } from '../src/core/prepare.ts'
// Real KAMain captures (scripts/capture-fixtures.mjs). In the selftest, KAMain names blocks by
// their first line: target() is block 1000 @ sample.c:6, foo's `if` is 1001 @ :11, its exit(1)
// block 1002 @ :13, the call to target 1003 @ :15; main's blocks are 1004 @ :18 … 1007 @ :22.
import * as F from './fixtures.ts'

const ok = { exitCode: 0, timedOut: false }

function evidence(over: Partial<RunEvidence>): RunEvidence {
  return {
    process: ok,
    stderr: parseStderr(''),
    requestedTargets: ['sample.c:7'],
    missingDumps: [],
    ...over,
  }
}

describe('options / argv', () => {
  it('floors verbose at 1 even when settings say 0', () => {
    const o = resolveOptions({ bitcode: 'x.bc', targets: [] }, { ...BUILTIN_DEFAULTS, verbose: 0 })
    expect(o.verbose).toBe(1)
  })
  it('never requests half of a paired dump', () => {
    const o = resolveOptions({ bitcode: 'x.bc', targets: ['a.c:1'], dumps: { callerCalleeBothWays: false } })
    const args = buildArgs('/b/x.bc', o, { outputDir: '/o', targetListFile: '/o/t', entryListFile: '/o/e', stderrLog: '/o/l' })
    expect(args.some(a => a.startsWith('-dump-caller-callee'))).toBe(false)
    expect(args.some(a => a.startsWith('-dump-callee-caller'))).toBe(false)
    expect(args).toContain(`-dump-bid-mapping=/o/${DUMP_FILES.bidMapping}`)
    expect(args).toContain(`-dump-func-info=/o/${DUMP_FILES.funcInfo}`)
    expect(args.at(-1)).toBe('/b/x.bc')
    expect(args).toContain('-type-based-callgraph=1')
    expect(args).toContain('-call-stack-len=20')
    expect(args).not.toContain('-entry-list=/o/e')
  })
  it('lists the files a selection produces', () => {
    expect(selectedDumpFiles({ ...BUILTIN_DEFAULTS.dumps, policy: false, callerCalleeBothWays: false }))
      .toEqual([DUMP_FILES.distance, DUMP_FILES.criticalBranch, DUMP_FILES.bidMapping, DUMP_FILES.funcInfo])
  })
})

describe('cache key', () => {
  const a = resolveOptions({ bitcode: 'x', targets: ['b.c:2', 'a.c:1'], entries: ['main'] })
  const b = resolveOptions({ bitcode: 'x', targets: ['a.c:1', 'b.c:2', 'a.c:1'], entries: ['main'] })
  it('is independent of target order and duplicates', () => {
    expect(cacheKey('d', 'c', a)).toBe(cacheKey('d', 'c', b))
  })
  it('changes with bitcode, commit and options', () => {
    const k = cacheKey('d', 'c', a)
    expect(cacheKey('d2', 'c', a)).not.toBe(k)
    expect(cacheKey('d', 'c2', a)).not.toBe(k)
    expect(cacheKey('d', 'c', { ...a, callStackLen: 5 })).not.toBe(k)
  })
})

describe('stderr parser', () => {
  it('reads warnings at verbose 1', () => {
    expect(parseStderr(F.STDERR_NO_TARGET).noTargetFound).toBe(true)
    const u = parseStderr(F.STDERR_UNREACHABLE)
    expect(u.notReachable).toBe(true)
    expect(u.noCallerFunctions).toEqual(['main'])
    expect(parseStderr(F.STDERR_NO_ENTRY).noEntryBBs).toBe(true)
    // A successful verbose-1 run carries no positive marker at all.
    expect(parseStderr(F.STDERR_OK_V1)).toMatchObject({ noTargetFound: false, notReachable: false, reachableMarker: false, totalInputFiles: 1 })
  })
  it('reads verbose 2 markers', () => {
    const s = parseStderr(F.STDERR_OK_V2)
    expect(s.reachableMarker).toBe(true)
    expect(s.echoedTargets).toEqual(['sample.c:7'])
    expect(s.entryFunctions).toEqual(['main'])
    expect(s.totalInputFiles).toBe(1)
  })
  it('reads load and fatal errors', () => {
    expect(parseStderr(F.STDERR_LOAD_ERROR).loadErrors).toEqual(['/work/selftest/nope.bc'])
    expect(parseStderr(F.STDERR_FATAL).fatalErrors[0]).toContain('Failed to open target list')
    expect(F.FATAL_EXIT_CODE).not.toBe(0)
  })
})

describe('dump parsers', () => {
  it('parses and sorts the distance dump', () => {
    const d = parseDistance(F.DISTANCE)
    expect(d.rows.map(r => r.bid)).toEqual([1002, 1005, 1007, 1000, 1003, 1001, 1006, 1004])
    expect(d.rows[0]?.distance).toBe(-1)
    expect(d.rows[3]).toMatchObject({ bid: 1000, location: 'sample.c:6', distance: 0 })
    expect(d.reachedFunctions).toEqual(['foo', 'main', 'target'])
  })
  it('pairs each policy distance with its own successor', () => {
    const p = parsePolicy(F.POLICY)
    // foo's `if (s[0] != 'K')`: the true edge exits (1002, unreachable), the false edge calls target.
    expect(p[0]).toEqual({ bid: 1001, trueDistance: null, falseDistance: 0, falseBid: 1003, trueBid: 1002 })
    expect(p.map(r => r.bid)).toEqual([1001, 1004])
  })
  it('keeps 64-bit GUIDs exact', () => {
    const e = parseGuidEdges(F.CALLER_CALLEE)
    expect(e.get(F.GUID.foo)).toEqual([F.GUID.exit, F.GUID.dbgDeclare, F.GUID.target, F.GUID.strlen].sort())
    expect(parseFuncInfo(F.FUNC_INFO).find(f => f.name === 'main')?.guid).toBe(F.GUID.main)
  })
  it('parses bid mapping with absolute paths', () => {
    expect(parseBidMapping(F.BID_MAPPING)[0]).toEqual({ bid: 1000, bbHash: '1217533961', funcGuid: F.GUID.target, file: '/work/selftest/sample.c', line: 6 })
  })
})

describe('status derivation — never from the exit code', () => {
  const distance = parseDistance(F.DISTANCE)
  it('ok from outputs at verbose 1 (no positive stderr marker)', () => {
    expect(deriveStatus(evidence({ stderr: parseStderr(F.STDERR_OK_V1), distance })).status).toBe('ok')
  })
  it('no_target on exit 0', () => {
    const v = deriveStatus(evidence({ stderr: parseStderr(F.STDERR_NO_TARGET), distance: parseDistance(F.DISTANCE_NO_TARGET) }))
    expect(v.status).toBe('no_target')
    expect(v.reason).toMatch(/instruction/)
  })
  it('no_target when the distance dump has no zero row even without the warning', () => {
    expect(deriveStatus(evidence({ distance: parseDistance(F.DISTANCE_NO_TARGET) })).status).toBe('no_target')
  })
  it('unreachable on exit 0, although the target block itself is at distance 0', () => {
    const d = parseDistance(F.DISTANCE_UNREACHABLE)
    expect(d.rows.some(r => r.distance === 0)).toBe(true)
    expect(deriveStatus(evidence({ requestedTargets: ['sample.c:19'], stderr: parseStderr(F.STDERR_UNREACHABLE), distance: d })).status).toBe('unreachable')
    expect(deriveStatus(evidence({ stderr: parseStderr(F.STDERR_NO_ENTRY), distance })).status).toBe('unreachable')
  })
  it('error for load errors on exit 0, timeouts, signals, fatal', () => {
    expect(deriveStatus(evidence({ stderr: parseStderr(F.STDERR_LOAD_ERROR) })).status).toBe('error')
    expect(deriveStatus(evidence({ process: { exitCode: null, timedOut: true } })).status).toBe('error')
    expect(deriveStatus(evidence({ process: { exitCode: null, signal: 'SIGKILL', timedOut: false } })).reason).toMatch(/memLimitMB/)
    expect(deriveStatus(evidence({ process: { exitCode: F.FATAL_EXIT_CODE, timedOut: false }, stderr: parseStderr(F.STDERR_FATAL) })).status).toBe('error')
  })
  it('error when nothing interpretable was produced', () => {
    expect(deriveStatus(evidence({})).status).toBe('error')
    expect(deriveStatus(evidence({ distance, missingDumps: ['critical_BBs.txt'] })).status).toBe('error')
  })
  it('index runs succeed on function info alone', () => {
    expect(deriveStatus(evidence({ requestedTargets: [], funcInfo: parseFuncInfo(F.FUNC_INFO) })).status).toBe('ok')
  })
})

describe('target resolution, critical branches, remapping', () => {
  const blocks = blockIndex(parseBidMapping(F.BID_MAPPING), parseFuncInfo(F.FUNC_INFO))
  const repo = new RepoIndex('/work', ['selftest/sample.c', 'src/other.c'])
  it('resolves a line to the distance-0 block containing it, with function name and repo path', () => {
    const r = resolveTargets(['sample.c:7', 'sample.c:1'], parseDistance(F.DISTANCE), blocks, repo)
    // Line 7 lies in block 1000 (starts at :6). The distance-0 call site 1003 (:15) is not the target.
    expect(r.targets).toEqual([{ requested: 'sample.c:7', function: 'target', location: 'selftest/sample.c:7', distance: 0 }])
    expect(r.unresolved).toEqual(['sample.c:1'])
  })
  it('resolves a real project target (Magma LUA001) through its own bid mapping', () => {
    const luaBlocks = blockIndex(parseBidMapping(F.LUA001_BID_MAPPING), parseFuncInfo(F.LUA001_FUNC_INFO))
    const distance = parseDistance(F.LUA001_DISTANCE)
    // Magma's LUA001 list also names the patch backup (`ldebug.c.orig:193`); the real target is the first line.
    const target = F.LUA001_TARGETS.split('\n')[0] ?? ''
    expect(deriveStatus(evidence({ requestedTargets: [target], stderr: parseStderr(F.LUA001_STDERR), distance })).status).toBe('ok')
    const r = resolveTargets([target], distance, luaBlocks)
    expect(r.unresolved).toEqual([])
    // The LUA001 canary sits in the static findvararg (luaG_findlocal starts at :208 per func-info).
    expect(r.targets).toEqual([{ requested: target, function: 'findvararg', location: '/magma/targets/lua/repo/ldebug.c:197', distance: 0 }])
    expect(parseCriticalBranches(F.LUA001_CRITICAL).size).toBeGreaterThan(0)
  })
  it('maps critical blocks to locations', () => {
    expect(criticalBranches(parseCriticalBranches(F.CRITICAL), parseDistance(F.DISTANCE), blocks, repo)).toEqual([
      { function: 'foo', location: 'selftest/sample.c:11', distance: 1000 },
      { function: 'main', location: 'selftest/sample.c:18', distance: 2000 },
      { function: 'main', location: 'selftest/sample.c:21', distance: 1000 },
    ])
  })
  it('suggests nearby instruction lines', () => {
    const lines = instructionLines(parseBidMapping(F.BID_MAPPING), 'sample.c')
    expect(nearbyCandidates('sample.c:9', lines, 2)).toEqual(['sample.c:11', 'sample.c:6'])
  })
  it('heuristic fallback skips comments, braces, signatures and declarations', () => {
    const src = '/* c\n * d */\nint f(int x) {\n  int y;\n  y = x;\n}\n'
    expect(heuristicInstructionLines(src)).toEqual([5])
  })
  it('remaps every path style', () => {
    expect(repo.remapLocation('/work/selftest/sample.c:7')).toBe('selftest/sample.c:7')
    expect(repo.remapLocation('sample.c:7')).toBe('selftest/sample.c:7')
    expect(repo.remapLocation('./build/../selftest/sample.c:7')).toBe('selftest/sample.c:7')
    expect(repo.remapLocation('NoLoc:0')).toBe('NoLoc:0')
    expect(targetListEntry('/abs/x/util.c:40')).toBe('util.c:40')
    expect(parseLocation('a.c:3:9')).toEqual({ file: 'a.c', line: 3 })
  })
  it('flags basename ambiguity under substring matching', () => {
    const r = new RepoIndex('/r', ['a/util.c', 'b/util.c', 'c/myutil.c', 'd/x.c'])
    expect(r.ambiguous('util.c')).toEqual(['a/util.c', 'b/util.c', 'c/myutil.c'])
    expect(r.ambiguous('x.c')).toEqual([])
  })
})

describe('queries', () => {
  const data = {
    funcInfo: parseFuncInfo(F.FUNC_INFO),
    callerCallee: parseGuidEdges(F.CALLER_CALLEE),
    calleeCaller: parseGuidEdges(F.CALLEE_CALLER),
    bidMapping: parseBidMapping(F.BID_MAPPING),
    critical: parseCriticalBranches(F.CRITICAL),
    blocks: blockIndex(parseBidMapping(F.BID_MAPPING), parseFuncInfo(F.FUNC_INFO)),
  }
  const fooCallees = [`guid:${F.GUID.exit}`, `guid:${F.GUID.dbgDeclare}`, `guid:${F.GUID.strlen}`, 'target'].sort()
  it('callers / callees are sorted names; undefined functions stay visible as GUIDs', () => {
    expect(runQuery({ op: 'callers', bitcode: 'b', fn: 'foo' }, data).results).toEqual(['main'])
    expect(runQuery({ op: 'callees', bitcode: 'b', fn: 'foo' }, data).results).toEqual(fooCallees)
  })
  it('functionAt and critical', () => {
    expect(runQuery({ op: 'functionAt', bitcode: 'b', location: 'src/sample.c:14' }, data).results).toEqual(['foo'])
    expect(runQuery({ op: 'critical', bitcode: 'b', fn: 'foo' }, data).results).toEqual(['/work/selftest/sample.c:11'])
    expect(runQuery({ op: 'critical', bitcode: 'b', fn: 'main' }, data).results).toEqual(['/work/selftest/sample.c:18', '/work/selftest/sample.c:21'])
  })
  it('truncates', () => {
    const r = runQuery({ op: 'callees', bitcode: 'b', fn: 'foo' }, data, 1)
    expect(r).toMatchObject({ truncated: true, results: [fooCallees[0]] })
  })

  // The distance-bearing ops exist so nothing ever has to open a dump file to answer an ordinary
  // reachability question — the gap that once sent an agent hand-joining distance.cfg.txt,
  // critical_BBs.txt and bid_loc_mapping.txt by hand. They need two more dumps than the
  // call-graph ops, so they get their own `data` with `distance` and `policy` wired in.
  describe('distance-bearing ops', () => {
    const withDumps = { ...data, distance: parseDistance(F.DISTANCE), policy: parsePolicy(F.POLICY) }

    it('distances: nearest the target first, exit-only blocks omitted', () => {
      const r = runQuery({ op: 'distances', bitcode: 'b' }, withDumps)
      expect(r).toEqual({
        op: 'distances',
        truncated: false,
        results: [
          'target@/work/selftest/sample.c:6=0.0',
          'foo@/work/selftest/sample.c:15=0.0',
          'foo@/work/selftest/sample.c:11=1000.0',
          'main@/work/selftest/sample.c:21=1000.0',
          'main@/work/selftest/sample.c:18=2000.0',
        ],
      })
      // The three `-1` rows (1002 @ :13, 1005 @ :20, 1007 @ :22) never appear: they reach an exit,
      // not the target, so they have no distance to report. `branches` is where they are visible.
      expect(r.results.join()).not.toMatch(/sample\.c:(13|20|22)/)
    })

    it('distances: narrowed by fn and by file', () => {
      expect(runQuery({ op: 'distances', bitcode: 'b', fn: 'foo' }, withDumps).results)
        .toEqual(['foo@/work/selftest/sample.c:15=0.0', 'foo@/work/selftest/sample.c:11=1000.0'])
      expect(runQuery({ op: 'distances', bitcode: 'b', file: 'sample.c' }, withDumps).results).toHaveLength(5)
      expect(runQuery({ op: 'distances', bitcode: 'b', file: 'other.c' }, withDumps).results).toEqual([])
    })

    it('distances: the per-request limit truncates without re-sorting', () => {
      const r = runQuery({ op: 'distances', bitcode: 'b', limit: 2 }, withDumps)
      // Nearest-first order survives the cap — a lexical sort would have put `foo@…:11=1000.0`
      // ahead of `target@…:6=0.0` and made the truncated head the wrong two rows.
      expect(r).toEqual({
        op: 'distances',
        truncated: true,
        results: ['target@/work/selftest/sample.c:6=0.0', 'foo@/work/selftest/sample.c:15=0.0'],
      })
    })

    it('functions: every reached function with its nearest block, closest first', () => {
      expect(runQuery({ op: 'functions', bitcode: 'b' }, withDumps)).toEqual({
        op: 'functions',
        truncated: false,
        results: ['foo=0.0', 'target=0.0', 'main=1000.0'],
      })
      expect(runQuery({ op: 'functions', bitcode: 'b', limit: 1 }, withDumps))
        .toMatchObject({ truncated: true, results: ['foo=0.0'] })
    })

    it('branches: names where each side goes and which one only exits', () => {
      // Cross-checks against the distance dump: for foo's `if` (1001 @ :11) the reaching side is the
      // call to target() at :15 (distance 0) and the other side is the exit(1) block at :13, which
      // the distance dump independently marks `-1`. Same for main's 1004 @ :18 → :21 vs :20.
      // Both are in CRITICAL, so both carry the marker; critical rows sort first, nearest first.
      expect(runQuery({ op: 'branches', bitcode: 'b' }, withDumps)).toEqual({
        op: 'branches',
        truncated: false,
        results: [
          'foo@/work/selftest/sample.c:11 true->/work/selftest/sample.c:13=exit false->/work/selftest/sample.c:15=0.0 [critical]',
          'main@/work/selftest/sample.c:18 true->/work/selftest/sample.c:20=exit false->/work/selftest/sample.c:21=1000.0 [critical]',
        ],
      })
      expect(runQuery({ op: 'branches', bitcode: 'b', fn: 'foo' }, withDumps).results).toHaveLength(1)
    })

    it('branches: a critical block with no policy row contributes nothing, rather than a guess', () => {
      // 1006 is in CRITICAL but has no POLICY row, so its polarity is genuinely unknown and there
      // is nothing honest to print for it.
      expect(runQuery({ op: 'branches', bitcode: 'b' }, withDumps).results.join()).not.toContain('sample.c:21 true->')
    })

    it('branches: covers non-critical branches too, since both-reaching branches are still steerable', () => {
      // KAMain marks a branch critical only when one side is `inf`. A branch whose sides merely
      // differ in distance is just as steerable — and in the real readelf capture every branch
      // inside the target's own function is of exactly that kind. Synthesised here because the
      // selftest sample has no such branch: 1004's false edge now also reaches, at 2000.
      const bothReach = {
        ...withDumps,
        policy: [{ bid: 1004, trueDistance: 2000, falseDistance: 1000, trueBid: 1005, falseBid: 1006 }],
        critical: new Map<number, number[]>(),
      }
      expect(runQuery({ op: 'branches', bitcode: 'b' }, bothReach).results).toEqual([
        'main@/work/selftest/sample.c:18 true->/work/selftest/sample.c:20=2000.0 false->/work/selftest/sample.c:21=1000.0',
      ])
    })

    it('branches: a branch that cannot reach the target either way is omitted', () => {
      const deadEnd = {
        ...withDumps,
        policy: [{ bid: 1004, trueDistance: null, falseDistance: null, trueBid: 1005, falseBid: 1006 }],
      }
      expect(runQuery({ op: 'branches', bitcode: 'b' }, deadEnd).results).toEqual([])
    })

    it('all three answer empty rather than throwing when no targeted analysis ran', () => {
      // An index run produces no distance/policy dump at all; `data` deliberately omits both.
      // The empty answer carries a note: on its own it reads exactly like "nothing reaches the
      // target", which is the misreading this op must never invite.
      for (const op of ['branches', 'distances', 'functions'] as const) {
        const result = runQuery({ op, bitcode: 'b' }, data)
        expect(result.results).toEqual([])
        expect(result.truncated).toBe(false)
        expect(result.note).toMatch(/not proof/i)
      }
    })

    it('says so when no targeted analysis backs the dumps at all', () => {
      const result = runQuery({ op: 'distances', bitcode: 'b' }, { ...data, analyzed: false })
      expect(result.results).toEqual([])
      expect(result.note).toMatch(/No targeted kanalyzer_analyze/)
    })
  })
})

describe('prepare helpers', () => {
  it('prefers LLVMFuzzerTestOneInput over main', () => {
    expect(inferEntries(F.NM_FUZZ)).toEqual({ entries: ['LLVMFuzzerTestOneInput', 'main'], nFuncs: 3 })
    expect(inferEntries(F.NM_MAIN).entries).toEqual(['main'])
  })
  it('builds the LTO environment without dropping caller flags', () => {
    const env = ltoEnv(toolchainAt('/usr/lib/llvm-14'), { CFLAGS: '-DFOO' }, ['/l/libz.a'], { PATH: '/bin' })
    expect(env.CC).toBe('/usr/lib/llvm-14/bin/clang')
    expect(env.CFLAGS).toBe('-DFOO -O0 -g -fPIC -flto')
    expect(env.LDFLAGS).toContain('-fuse-ld=lld -Wl,-plugin-opt=save-temps')
    expect(env.LIBS).toBe('/l/libz.a')
    expect(env.PATH.startsWith('/usr/lib/llvm-14/bin:')).toBe(true)
  })
  it('selects bitcode by program name', () => {
    const found = ['/b/tools/readelf.0.0.preopt.bc', '/b/libfoo.so.0.0.preopt.bc', '/b/objdump.0.0.preopt.bc']
    expect(selectBitcode(found, 'readelf').selected).toBe('/b/tools/readelf.0.0.preopt.bc')
    expect(selectBitcode(found, 'nm').selected).toBeUndefined()
    expect(programOf('/x/lua.0.0.preopt.bc')).toBe('lua')
  })
})

/**
 * The 15-second detour. A real session wrote `buildCmd: "$CXX readelf.cpp -o readelf"` in lto mode;
 * `ltoEnv()` supplies `-flto`/`save-temps` only through $CXXFLAGS/$LDFLAGS, so that compiled a
 * plain native binary, produced no bitcode, and the failure was then misreported as the build
 * system dropping LDFLAGS. Catching it before the build turns 8s + three diagnostic calls into an
 * immediate answer carrying the fix.
 */
describe('ltoBuildCmdProblem', () => {
  const rejects = (cmd: string): boolean => ltoBuildCmdProblem(cmd, 'lto') !== undefined

  it('rejects a direct compiler invocation that references none of the flag variables', () => {
    expect(rejects('$CXX readelf.cpp -o readelf')).toBe(true)
    expect(rejects('clang++ -o readelf readelf.cpp')).toBe(true)
    expect(rejects('rm -f readelf && $CC foo.c -o foo')).toBe(true)
    const why = ltoBuildCmdProblem('$CXX readelf.cpp -o readelf', 'lto') ?? ''
    // The message has to carry the fix, not just the diagnosis.
    expect(why).toContain('$CXX $CXXFLAGS')
    expect(why).toContain('ENVIRONMENT VARIABLES')
  })

  it('accepts the same command once it references the flags, or spells LTO out itself', () => {
    expect(rejects('$CXX $CXXFLAGS readelf.cpp -o readelf $LDFLAGS')).toBe(false)
    expect(rejects('$CC $CFLAGS foo.c -o foo $LDFLAGS')).toBe(false)
    expect(rejects('clang++ -flto -fuse-ld=lld foo.cpp -o foo')).toBe(false)
    expect(rejects('$CXX ${CXXFLAGS} a.cpp -o a ${LDFLAGS}')).toBe(false)
  })

  it('never rejects a build system, which picks the variables up by convention', () => {
    for (const cmd of ['make -j8', './configure --disable-shared && make -j8', 'cmake --build build', 'ninja -C out', './build.sh', 'meson compile -C build']) {
      expect(rejects(cmd)).toBe(false)
    }
  })

  it('never fires in wllvm mode, which wraps the compiler instead of relying on flags', () => {
    expect(ltoBuildCmdProblem('$CXX readelf.cpp -o readelf', 'wllvm')).toBeUndefined()
  })
})
