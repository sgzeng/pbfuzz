/**
 * Regression test for F5: KAMain's own reachability gate is vacuous for a genuinely unreachable
 * target (upstream bug, `kernel-analyzer/src/lib/Reachable.cc`'s exit-block seeding — see
 * `deriveStatus`'s module doc in `../src/core/status.ts`). `dsh-kanalyzer` must not simply trust
 * KAMain's `ok`/distance-0 verdict; it must independently cross-check entry→target reachability
 * over the caller→callee call graph KAMain also emits, and downgrade a suspicious `ok` to
 * `unreachable` when the two disagree.
 *
 * Fixtures under `fixtures/unreachable-toy/{unreachable,reachable}/` are the REAL, unmodified
 * dump files and stderr log from two real KAMain runs (kernel-analyzer `mzt` 3f5dbfd, LLVM 14,
 * Linux x86-64) against the same toy program, captured live from
 * `acceptance-run/work/L1-kanalyzer/scratch/toyproj/` (`fuzz.c`/`helper.c`/`helper.h`):
 *
 *   int LLVMFuzzerTestOneInput(...) { return helper_danger(...); }
 *   int main(...) { LLVMFuzzerTestOneInput(...); return ... + other_entry(argc); }
 *   int helper_other(int x) { int y = x * 2; return y; }   // target: helper.c:6
 *   int other_entry(int x) { return helper_other(x); }     // only caller of helper_other
 *   int helper_danger(...) { ...; helper_add(...); ... }   // unrelated to helper_other
 *
 * `helper_other` (target `helper.c:6`) is reachable ONLY via `main -> other_entry -> helper_other`
 * — `LLVMFuzzerTestOneInput` calls only the disjoint `helper_danger`. KAMain's own dumps disagree
 * with this ground truth exactly the way the module doc describes: they report `helper_other` (and
 * `other_entry`/`main`) at distance 0 regardless of which entry was requested, so a bare read of
 * the distance dump says `ok` for BOTH runs below — even the one where the fuzzer entry provably
 * never reaches the target. (`unreachable/entries.txt` = `LLVMFuzzerTestOneInput`;
 * `reachable/entries.txt` = `main`, which genuinely does reach it.)
 *
 * See `acceptance-run/work/L1-kanalyzer/g2_unreachable_toy_v2.mjs` and
 * `acceptance-run/evidence/L1/kanalyzer.md` §3.1 for the original repro.
 *
 * @module @pbfuzz/dsh-kanalyzer/tests/status-reachability
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBidMapping, parseDistance, parseFuncInfo, parseGuidEdges } from '../src/core/dumps.ts'
import { analyzeFromDumps, type DumpAnalysisInput } from '../src/core/result.ts'
import { parseStderr } from '../src/core/stderr.ts'
import { deriveStatus, type RunEvidence } from '../src/core/status.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures', 'unreachable-toy')

/** Read one dump/log file from a fixture case directory (`unreachable/` or `reachable/`). */
function read(caseDir: string, name: string): string {
  return readFileSync(join(FIXTURES, caseDir, name), 'utf8')
}

/** Assemble the {@link DumpAnalysisInput} a live `analyze()` call would have built for this case. */
function fixtureInput(caseDir: string, entries: string[]): DumpAnalysisInput {
  return {
    texts: {
      distance: read(caseDir, 'distance.cfg.txt'),
      criticalBranch: read(caseDir, 'critical_BBs.txt'),
      bidMapping: read(caseDir, 'bid_loc_mapping.txt'),
      funcInfo: read(caseDir, 'function_info.txt'),
      callerCallee: read(caseDir, 'caller-callee.txt'),
    },
    process: { exitCode: 0, signal: null, timedOut: false },
    stderr: parseStderr(read(caseDir, 'kamain.stderr.log')),
    requestedTargets: ['helper.c:6'],
    missingDumps: [],
    entries,
    outputDir: join(FIXTURES, caseDir),
    elapsedMs: 0,
  }
}

describe('F5 — independent reachability cross-check (real KAMain fixtures)', () => {
  it('downgrades KAMain\'s false "ok" to "unreachable" when entry->target is not connected', async () => {
    // Ground truth: LLVMFuzzerTestOneInput never reaches helper_other. KAMain's own dumps say
    // `ok` anyway (the upstream Reachable.cc bug) — the independent call-graph BFS must catch it.
    const result = await analyzeFromDumps(fixtureInput('unreachable', ['LLVMFuzzerTestOneInput']))
    expect(result.status).toBe('unreachable')
    expect(result.reason).toMatch(/call-graph|BFS|reachability/i)
  })

  it('keeps "ok" for a genuinely reachable target from the same toy program', async () => {
    // Ground truth: main -> other_entry -> helper_other is a real path. The BFS must not turn
    // this into a false "unreachable" — that would be a worse regression than the bug it fixes.
    const result = await analyzeFromDumps(fixtureInput('reachable', ['main']))
    expect(result.status).toBe('ok')
    expect(result.targets).toEqual([{ requested: 'helper.c:6', function: 'helper_other', location: expect.stringContaining('helper.c:6') as unknown as string, distance: 0 }])
  })

  it('deriveStatus alone downgrades ok -> unreachable given the real caller-callee edges', () => {
    const distance = parseDistance(read('unreachable', 'distance.cfg.txt'))
    const bidMapping = parseBidMapping(read('unreachable', 'bid_loc_mapping.txt'))
    const funcInfo = parseFuncInfo(read('unreachable', 'function_info.txt'))
    const callerCallee = parseGuidEdges(read('unreachable', 'caller-callee.txt'))
    const ev: RunEvidence = {
      process: { exitCode: 0, signal: null, timedOut: false },
      stderr: parseStderr(''),
      requestedTargets: ['helper.c:6'],
      missingDumps: [],
      distance,
      bidMapping,
      funcInfo,
      entries: ['LLVMFuzzerTestOneInput'],
      callerCallee,
    }
    expect(deriveStatus(ev).status).toBe('unreachable')
  })

  it('deriveStatus stays ok without call-graph data (no false unreachable from missing input)', () => {
    // Same distance dump (which itself already falsely says "ok"), but no callerCallee/entries —
    // the cross-check must fail open, not manufacture an unreachable from absent data.
    const distance = parseDistance(read('unreachable', 'distance.cfg.txt'))
    const bidMapping = parseBidMapping(read('unreachable', 'bid_loc_mapping.txt'))
    const funcInfo = parseFuncInfo(read('unreachable', 'function_info.txt'))
    const ev: RunEvidence = {
      process: { exitCode: 0, signal: null, timedOut: false },
      stderr: parseStderr(''),
      requestedTargets: ['helper.c:6'],
      missingDumps: [],
      distance,
      bidMapping,
      funcInfo,
    }
    expect(deriveStatus(ev).status).toBe('ok')
  })
})
