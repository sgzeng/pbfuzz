import { describe, expect, it } from 'vitest'
import { DENIALS_MAX, type PbfuzzDashboardView } from '../src/client/dashboard-contract.ts'
import { selectDashboardView } from '../src/client/dashboard.ts'
import { buildDashboardView, parseTargetLocation, summarizeHypothesis, type DashboardSources } from '../src/core/dashboard.ts'
import { formatDeny } from '../src/core/digest.ts'
import {
  dashboardStateSchema,
  dashboardViewSchema,
  denialFromToolResult,
  foldDashboard,
  registerProjection,
  type FoldEvent,
  type PbfuzzDashboardState,
} from '../src/projection.ts'
import { DASHBOARD_FIELD, DASHBOARD_META_KEY, dashboardMeta, renderJson } from '../src/tools.ts'

const metrics = {
  campaign_id: 'c1',
  pier_round: 1,
  total_iterations: 120,
  total_reached_count: 30,
  last_reached_count: 12,
  triggered_count: 0,
  last_session: { iterations: 60, reached: 12, elapsed_sec: 4.5, stopped_by: 'completed', best_reaching_input: '/tc/best' },
  last_updated: '2026-09-13T00:00:00Z',
}

function sources(over: Partial<DashboardSources> = {}): DashboardSources {
  return {
    campaignId: 'c1',
    targets: ['src/lua.c:120', 'weird'],
    maxPierRounds: 5,
    state: { campaign_id: 'c1', phase: 'REFLECT', status: 'round 1 done', current_task: 't', next_action: 'analyse metrics', pier_round: 1 },
    blocks: {
      bugPredicates: [{ id: 'BP1' }],
      preconditions: [{ status: 'verified' }, { status: 'unknown' }, { status: 'unknown' }, { status: 'bogus' }],
      rootCauses: [{ id: 'RC1' }, { id: 'RC2' }],
      triggerPlans: [
        { id: 'TP1', status: 'failed' },
        { id: 'TP2', description: 'overflow via a long key', complexity: 3, status: 'in_progress' },
        { id: 'TP3', status: 'pending' },
      ],
    },
    metrics,
    now: '2026-09-13T01:00:00.000Z',
    ...over,
  }
}

function snapshotEvent(view: unknown): FoldEvent {
  return { type: 'tool/result', time: 1, data: { turn: 1, step: 1, message: {}, meta: { [DASHBOARD_META_KEY]: view } } }
}

/**
 * A `tool/result` exactly as `dsh-tools`'s `prepareExecution` renders a denied call: `isError:
 * true`, content `Error: ` + the guard's own denial text (`digest.ts`'s `formatDeny()` output),
 * whatever tool the model tried to call.
 */
function denyResultEvent(callId: string, denial: string, time = 1_790_000_000_000): FoldEvent {
  return {
    type: 'tool/result',
    time,
    data: {
      turn: 3,
      step: 2,
      message: {
        id: `m-${callId}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError: true,
          content: [{ type: 'text', text: `Error: ${denial}` }],
        }],
      },
    },
  }
}

/** An ordinary (non-guard) tool failure: `isError`, but no `[pbfuzz:...]` header. */
function ordinaryErrorEvent(callId: string, text: string, time = 1_790_000_000_000): FoldEvent {
  return {
    type: 'tool/result',
    time,
    data: {
      turn: 3,
      step: 2,
      message: {
        id: `m-${callId}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, isError: true, content: [{ type: 'text', text }] }],
      },
    },
  }
}

/**
 * The wire `view` and `init` `registerProjection` registers, captured through the real entry point
 * so a test reads the fold exactly the way the browser's `wire.view` does.
 * @returns the captured definition.
 */
function registeredProjection(): { init(): unknown; wire: { view(state: unknown): unknown } } {
  let def: { init(): unknown; wire: { view(state: unknown): unknown } } | undefined
  registerProjection({ register: (d) => { def = d as typeof def } })
  if (def === undefined) throw new Error('registerProjection registered nothing')
  return def
}

describe('dashboard view builder (host)', () => {
  it('builds the full view from state, blocks and metrics', () => {
    const view = buildDashboardView(sources())
    expect(view).toMatchObject({
      campaignId: 'c1',
      updatedAt: '2026-09-13T01:00:00.000Z',
      phase: 'REFLECT',
      status: 'round 1 done',
      nextAction: 'analyse metrics',
      pierRound: 1,
      maxPierRounds: 5,
      targets: [{ file: 'src/lua.c', line: 120 }, { file: 'weird', line: 0 }],
      hypothesis: {
        bugPredicates: 1,
        preconditions: { verified: 1, violated: 0, unknown: 2, impossible: 0 },
        rootCauses: 2,
        triggerPlans: { pending: 1, inProgress: 1, completed: 0, failed: 1 },
        currentPlan: { id: 'TP2', description: 'overflow via a long key', complexity: 3, status: 'in_progress' },
      },
      denials: [],
      poc: null,
      stopReason: '',
    })
    // Verbatim pass-through: the same parsed objects, contract field names intact.
    expect(view.metrics).toBe(metrics)
    expect(dashboardViewSchema.safeParse(view).success).toBe(true)
  })

  it('keeps unknown metric fields through the wire schema (verbatim)', () => {
    const parsed = dashboardViewSchema.parse(buildDashboardView(sources()))
    expect(parsed.metrics).toMatchObject({ last_updated: '2026-09-13T00:00:00Z', last_session: { best_reaching_input: '/tc/best' } })
  })

  it('degrades missing or malformed parts to their empty form', () => {
    const view = buildDashboardView(sources({ state: { phase: 'NOPE' }, blocks: {}, metrics: { junk: 1 } }))
    expect(view.phase).toBe('')
    expect(view.hypothesis).toBeNull()
    expect(view.metrics).toBeNull()
    expect(summarizeHypothesis({ triggerPlans: [] })).toMatchObject({ bugPredicates: 0, triggerPlans: { pending: 0 } })
    expect(parseTargetLocation('/abs/a:b.c:7')).toEqual({ file: '/abs/a:b.c', line: 7 })
  })

  it('passes poc and stop_reason through', () => {
    const poc = { input_path: '/tc/poc', reproduced_times: 3, run_cmd: './lua /tc/poc' }
    const view = buildDashboardView(sources({ state: { phase: 'SUCCESS', pier_round: 2, poc, stop_reason: '' } }))
    expect(view.poc).toBe(poc)
    expect(buildDashboardView(sources({ state: { phase: 'STOPPED', stop_reason: 'budget' } })).stopReason).toBe('budget')
  })
})

describe('pbfuzz projection fold', () => {
  const view = buildDashboardView(sources())
  /** The projection state holding `view`. */
  const stateOf = (v: PbfuzzDashboardView): PbfuzzDashboardState => ({ view: v })

  it('ignores events that are not ours, keeping the same reference', () => {
    const state = stateOf(view)
    expect(foldDashboard(null, { type: 'turn/start', time: 1 })).toBeNull()
    expect(foldDashboard(state, { type: 'tool/result', data: { meta: { other: 1 } } })).toBe(state)
    expect(foldDashboard(state, snapshotEvent({ bad: true }))).toBe(state)
    expect(foldDashboard(state, { type: 'tool/call', data: { name: 'write', callId: 'c1', arguments: '{}' } })).toBe(state)
    expect(foldDashboard(state, { type: 'tool/result', data: { turn: 1, step: 1 } })).toBe(state)
    // An ordinary (non-guard) tool error carries no `[pbfuzz:...]` header, so it is not a denial.
    expect(foldDashboard(state, ordinaryErrorEvent('c2', 'Error: ENOENT: no such file'))).toBe(state)
    // A successful call (no isError at all).
    expect(foldDashboard(state, {
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'x', content: [{ type: 'text', text: 'ok' }] }] } },
    })).toBe(state)
    // isError but no content at all.
    expect(foldDashboard(state, {
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'x', isError: true, content: [] }] } },
    })).toBe(state)
  })

  it('takes the latest snapshot from tool/result meta', () => {
    const next = foldDashboard(null, snapshotEvent(view))
    expect(next?.view).toEqual(view)
    const later = { ...view, phase: 'PLAN', pierRound: 2 }
    expect(foldDashboard(next, snapshotEvent(later))?.view).toMatchObject({ phase: 'PLAN', pierRound: 2 })
  })

  it('turns a denied tool/result into a denial entry (any tool, not just pbfuzz\'s own)', () => {
    const denial = formatDeny('phase-gate/phase', 'pbfuzz_fuzz', 'pbfuzz_fuzz is not legal in phase PLAN', 'use one of pbfuzz_callgraph, pbfuzz_campaign')
    const time = Date.UTC(2026, 8, 13, 2, 0, 0)
    const next = foldDashboard(stateOf(view), denyResultEvent('call1', denial, time))
    expect(next?.view.denials).toEqual([{
      at: '2026-09-13T02:00:00.000Z',
      hook: 'phase-gate/phase',
      tool: 'pbfuzz_fuzz',
      reason: 'pbfuzz_fuzz is not legal in phase PLAN\nNext legal action: use one of pbfuzz_callgraph, pbfuzz_campaign.',
    }])
    // A denial on a plain `write`/`bash` call folds exactly the same way — the rule covers every
    // gated tool, not only pbfuzz_*.
    const bashDenial = formatDeny('bash-guard/state-tamper', 'bash', 'this shell command would modify pbfuzz state', 'read-only commands are fine')
    expect(foldDashboard(stateOf(view), denyResultEvent('call2', bashDenial, time))?.view.denials[0]).toMatchObject({ hook: 'bash-guard/state-tamper', tool: 'bash' })
    expect(denialFromToolResult(denyResultEvent('call3', 'not a pbfuzz denial at all'))).toBeUndefined()
  })

  it('keeps denials across snapshots of the same campaign, newest first, capped', () => {
    const denial = (n: number): string => formatDeny('guard-error', 'bash', `denial ${n}`, 'retry')
    let state: PbfuzzDashboardState | null = null
    state = foldDashboard(state, denyResultEvent('c0', denial(0), 1_000))
    expect(state?.view.campaignId).toBe('') // denial before any snapshot: the idle view carries it
    expect(selectDashboardView(state?.view)).toBeUndefined()
    state = foldDashboard(state, snapshotEvent(view))
    expect(state?.view.denials).toHaveLength(1)
    for (let i = 2; i <= DENIALS_MAX + 3; i++) state = foldDashboard(state, denyResultEvent(`c${i}`, denial(i), i * 1_000))
    expect(state?.view.denials).toHaveLength(DENIALS_MAX)
    expect(state?.view.denials[0]?.at).toBe(new Date((DENIALS_MAX + 3) * 1_000).toISOString())
    state = foldDashboard(state, snapshotEvent({ ...view, campaignId: 'c2' }))
    expect(state?.view.denials).toEqual([])
  })

  it('is replay-safe: the same log folds to the same state, and every state is schema-valid', () => {
    const denial = formatDeny('phase-gate/phase', 'pbfuzz_fuzz', 'not legal here', 'do something else')
    const log: FoldEvent[] = [
      { type: 'session/start', time: 0 },
      denyResultEvent('c1', denial, 5),
      snapshotEvent(view),
      ordinaryErrorEvent('c2', 'Error: unrelated', 6),
      denyResultEvent('c3', denial, 8),
      snapshotEvent({ ...view, phase: 'PLAN', pierRound: 2 }),
    ]
    const fold = (): (PbfuzzDashboardState | null)[] => {
      const states: (PbfuzzDashboardState | null)[] = []
      let s: PbfuzzDashboardState | null = null
      for (const e of log) { s = foldDashboard(s, e); states.push(s) }
      return states
    }
    const a = fold()
    expect(fold()).toEqual(a)
    for (const s of a) expect(dashboardStateSchema.safeParse(s).success).toBe(true)
    expect(JSON.parse(JSON.stringify(a.at(-1)))).toEqual(a.at(-1)) // plain JSON: persistable
  })

  it('serves the state\'s view on the wire, and null before any state', () => {
    const def = registeredProjection()
    expect(def.init()).toBeNull()
    expect(def.wire.view(stateOf(view))).toBe(view)
    expect(def.wire.view(null)).toBeNull()
  })
})

describe('tool presentation', () => {
  it('keeps the dashboard out of the model-facing text and in presentationMeta', () => {
    const value = { results: ['f'], [DASHBOARD_FIELD]: { campaignId: 'c1' } }
    expect(JSON.parse(renderJson(undefined, value)[0].text)).toEqual({ results: ['f'] })
    expect(dashboardMeta(undefined, value)).toEqual({ [DASHBOARD_META_KEY]: { campaignId: 'c1' } })
    expect(dashboardMeta(undefined, [1])).toEqual({ [DASHBOARD_META_KEY]: null })
  })
})
