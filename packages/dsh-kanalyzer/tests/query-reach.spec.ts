/**
 * `reach` — the op that answers "can this line reach the target?" without inviting the misreading
 * that cost a real session three wrong answers.
 *
 * In that session (nginx, target `ngx_http_rewrite_module.c:178`) the agent asked `distances` for a
 * function, got `{"results":[],"truncated":false}`, and told the user "the distance table is
 * authoritative, and it is empty" — for `ngx_http_rewrite_var`, which the target's own loop calls
 * and which returns straight back into it. KAMain simply never assigned those blocks a distance:
 * its distance pass skips indirect call sites with more than 50 type-compatible candidates, models
 * no return edges, and stops at the call-stack-length limit. Absence from the table is not a proof,
 * and these tests pin the three states apart.
 *
 * @module @pbfuzz/dsh-kanalyzer/tests/query-reach
 */
import { describe, expect, it } from 'vitest'
import {
  parseBidMapping, parseCriticalBranches, parseDistance, parseFuncInfo, parseGuidEdges, parsePolicy,
} from '../src/core/dumps.ts'
import { runQuery, type QueryData } from '../src/core/query.ts'
import { blockIndex } from '../src/core/status.ts'
import * as F from './fixtures.ts'

/** The selftest sample, as `query()` assembles it: every dump a targeted analysis writes. */
const base: QueryData = {
  funcInfo: parseFuncInfo(F.FUNC_INFO),
  callerCallee: parseGuidEdges(F.CALLER_CALLEE),
  calleeCaller: parseGuidEdges(F.CALLEE_CALLER),
  bidMapping: parseBidMapping(F.BID_MAPPING),
  critical: parseCriticalBranches(F.CRITICAL),
  distance: parseDistance(F.DISTANCE),
  policy: parsePolicy(F.POLICY),
  blocks: blockIndex(parseBidMapping(F.BID_MAPPING), parseFuncInfo(F.FUNC_INFO)),
  analyzed: true,
}

/**
 * The nginx shape the session tripped over, in miniature: `helper` is called from `foo` — which
 * does reach the target — and returns into it, but KAMain gave none of its blocks a distance.
 * Its blocks are simply absent from the distance dump, exactly as `ngx_http_rewrite_var`'s were.
 */
const HELPER_GUID = '9999999999999999999'
const withHelper: QueryData = (() => {
  const bidMapping = parseBidMapping(F.BID_MAPPING + `1008,111,${HELPER_GUID},/work/selftest/sample.c:30\n1009,112,${HELPER_GUID},/work/selftest/sample.c:31\n`)
  const funcInfo = parseFuncInfo(F.FUNC_INFO + `${HELPER_GUID},helper,/work/selftest/sample.c,30,31\n`)
  return {
    ...base,
    bidMapping,
    funcInfo,
    // foo (which reaches the target) calls helper; helper returns into foo.
    calleeCaller: parseGuidEdges(F.CALLEE_CALLER + `${HELPER_GUID},${F.GUID.foo}\n`),
    callerCallee: parseGuidEdges(F.CALLER_CALLEE + `${F.GUID.foo},${HELPER_GUID}\n`),
    blocks: blockIndex(bidMapping, funcInfo),
  }
})()

describe('reach: the three states a distance table can be in', () => {
  it('reaches — a distance is positive evidence of a static path', () => {
    const r = runQuery({ op: 'reach', bitcode: 'b', location: '/work/selftest/sample.c:11' }, base)
    expect(r.answers?.[0]).toMatchObject({ function: 'foo', verdict: 'reaches', exact: true })
    expect(r.answers?.[0]?.coverage).toMatchObject({ withDistance: 2, exitOnly: 1, absent: 0, nearest: 0 })
    // Nothing to warn about: the table said yes.
    expect(r.note).toBeUndefined()
  })

  it('exit_only — every block marked -1, reported as such and not as "no path"', () => {
    // Block 1002 (@:13) is the exit(1) arm of foo's `if`; the distance dump marks it -1.
    const r = runQuery({ op: 'reach', bitcode: 'b', location: '/work/selftest/sample.c:13' }, base)
    expect(r.answers?.[0]).toMatchObject({ function: 'foo', verdict: 'exit_only' })
    expect(r.note).toMatch(/leads to a program exit/)
    // Still hedged: the exit search is depth-bounded like everything else here.
    expect(r.note).toMatch(/bounded by the call-depth limit/)
  })

  it('no_distance — absent blocks never read as unreachable, and the call-graph evidence is given', () => {
    const r = runQuery({ op: 'reach', bitcode: 'b', fn: 'helper' }, withHelper)
    const answer = r.answers?.[0]
    expect(answer).toMatchObject({ function: 'helper', verdict: 'no_distance' })
    expect(answer?.coverage).toMatchObject({ blocks: 2, withDistance: 0, exitOnly: 0, absent: 2, inFunList: false })
    // The note must say what this is NOT, naming why the pass can miss a real path.
    expect(r.note).toMatch(/NOT proof/)
    expect(r.note).toMatch(/return edges/)
    // And the dumps' own evidence that it runs on the way to the target.
    expect(answer?.callNote).toMatch(/return/i)
    expect(answer?.callNote).toContain('foo')
  })

  it('no_distance — a caller chain the distance pass did not follow is surfaced as a path', () => {
    // main → foo → target exists in the call-graph dump; strip main's distances so only the
    // dump can answer. This is the `ngx_http_core_rewrite_phase` case: a real caller with no
    // distance because its dispatch is an indirect site with too many candidates.
    const noMainDistance: QueryData = {
      ...base,
      distance: { ...parseDistance(F.DISTANCE), rows: parseDistance(F.DISTANCE).rows.filter(r => r.bid < 1004), reachedFunctions: ['target', 'foo'] },
    }
    const answer = runQuery({ op: 'reach', bitcode: 'b', fn: 'main' }, noMainDistance).answers?.[0]
    expect(answer).toMatchObject({ verdict: 'no_distance' })
    // Queried function first, walking down to the function the target sits in. `foo` is where the
    // chain ends because its call-site block is itself at distance 0.
    expect(answer?.callPath).toEqual(['main', 'foo'])
    expect(answer?.callNote).toMatch(/hop\(s\) above the target/)
  })

  it('no_block — a line owning no instruction says nothing about reachability', () => {
    // :12 is inside foo but owns no block (the block covering it starts at :11), the same reason
    // nginx's `return NGX_HTTP_INTERNAL_SERVER_ERROR;` at :169 had no row of its own.
    const r = runQuery({ op: 'reach', bitcode: 'b', location: '/work/selftest/sample.c:12' }, base)
    expect(r.answers?.[0]).toMatchObject({ function: 'foo', exact: false, location: '/work/selftest/sample.c:11' })
    expect(r.note).toMatch(/owns no instruction of its own/)
  })

  it('a file:line in no analysed file is no_block, not unreachable', () => {
    const r = runQuery({ op: 'reach', bitcode: 'b', location: '/elsewhere/other.c:5' }, base)
    expect(r.answers?.[0]?.verdict).toBe('no_block')
    expect(r.note).toMatch(/says nothing about reachability/)
  })

  it('says plainly when no targeted analysis backs the answer at all', () => {
    const r = runQuery({ op: 'reach', bitcode: 'b', fn: 'foo' }, { ...base, analyzed: false })
    expect(r.note).toMatch(/No targeted kanalyzer_analyze/)
  })
})

describe('the ops that used to answer a bare empty list', () => {
  it('distances narrowed to a distance-less function explains itself and shows the coverage', () => {
    const r = runQuery({ op: 'distances', bitcode: 'b', fn: 'helper' }, withHelper)
    expect(r.results).toEqual([])
    expect(r.note).toMatch(/NOT proof/)
    expect(r.coverage).toMatchObject({ blocks: 2, withDistance: 0, absent: 2 })
  })

  it('distances narrowed to an unknown function says so instead of implying unreachable', () => {
    const r = runQuery({ op: 'distances', bitcode: 'b', fn: 'no_such_fn' }, base)
    expect(r.results).toEqual([])
    expect(r.note).toMatch(/No block in the analysed bitcode belongs to/)
  })

  it('callers/callees disclose that the dump is a type-based superset', () => {
    expect(runQuery({ op: 'callers', bitcode: 'b', fn: 'foo' }, base).note).toMatch(/type-compatible/)
    expect(runQuery({ op: 'callees', bitcode: 'b', fn: 'foo' }, base).note).toMatch(/Not a path proof/)
  })

  it('functionAt prefers the blocks actually at the line over overlapping function line spans', () => {
    // `function_info`'s spans come from min/max over every block's location, inlined callees
    // included, so they overlap: three nginx file-cache functions all "contained" line 1878 while
    // only one owned blocks there. A synthetic overlap reproduces it.
    const funcInfo = parseFuncInfo(F.FUNC_INFO + `${HELPER_GUID},wrapper,/work/selftest/sample.c,6,25\n`)
    const overlapping: QueryData = { ...base, funcInfo, blocks: blockIndex(parseBidMapping(F.BID_MAPPING), funcInfo) }
    // :11 has a real block in foo — `wrapper`'s span covers it but it owns no code there.
    expect(runQuery({ op: 'functionAt', bitcode: 'b', location: '/work/selftest/sample.c:11' }, overlapping).results).toEqual(['foo'])
    // A line with no block at all falls back to the spans, and says that is what it did.
    const fallback = runQuery({ op: 'functionAt', bitcode: 'b', location: '/work/selftest/sample.c:24' }, overlapping)
    expect(fallback.results).toEqual(['wrapper'])
    expect(fallback.note).toMatch(/line spans/)
  })

  it('distances defaults to a payload the host will not silently cut in half', () => {
    // 500 rows of `fn@/absolute/path.c:line=distance` ran to 51 KB on the real nginx case and the
    // host truncated the middle while the result still said truncated:false.
    const rows = Array.from({ length: 400 }, (_, i) => ({
      bid: 2000 + i, bbHash: 'h', location: `sample.c:${String(i)}`, distance: i,
    }))
    const bidMapping = parseBidMapping(rows.map(r => `${String(r.bid)},h,${F.GUID.foo},/work/selftest/sample.c:${String(r.bid)}`).join('\n'))
    const many: QueryData = {
      ...base,
      bidMapping,
      distance: { rows, reachedFunctions: ['foo'] },
      blocks: blockIndex(bidMapping, parseFuncInfo(F.FUNC_INFO)),
    }
    const r = runQuery({ op: 'distances', bitcode: 'b' }, many)
    expect(r.results).toHaveLength(200)
    expect(r.truncated).toBe(true)
    // An explicit limit still wins, so nothing that asked for more silently gets less.
    expect(runQuery({ op: 'distances', bitcode: 'b', limit: 300 }, many).results).toHaveLength(300)
  })
})
