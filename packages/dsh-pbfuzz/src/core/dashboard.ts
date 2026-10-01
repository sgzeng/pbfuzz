/**
 * Pure builder for the dashboard view carried by the `pbfuzz` session projection.
 *
 * The host reads the campaign's files and hands the parsed JSON here; this module only shapes
 * it into {@link PbfuzzDashboardView}, the single view type shared with the browser half. It
 * never touches the filesystem, so it is unit-testable anywhere. `denials` is always empty
 * here: denials are folded by the projection from `hook/result` session events, not read
 * from disk (see `src/projection.ts`). The per-file derivations are exported
 * ({@link dashboardStateFields}, {@link dashboardMetrics}) because that fold merges a landed
 * whole-document write of `state/state.json` / `state/metrics.json` into the last view and must
 * read those files exactly as this builder does.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/dashboard
 */

import type {
  DashboardHypothesis,
  DashboardMetrics,
  DashboardPoc,
  DashboardTarget,
  PbfuzzDashboardView,
  PierPhase,
} from '../client/dashboard-contract.ts'

/** Everything the view is built from; every file-backed part is the parsed JSON or undefined. */
export interface DashboardSources {
  /** Active campaign id. */
  campaignId: string
  /** `campaign.bug.targets[].location`, each `file:line`. */
  targets: readonly string[]
  /** Resolved `budget.maxPierRounds`. */
  maxPierRounds: number
  /** Parsed `state/state.json`. */
  state?: unknown
  /** Parsed model-written blocks under `state/`. */
  blocks: {
    bugPredicates?: unknown
    preconditions?: unknown
    rootCauses?: unknown
    triggerPlans?: unknown
  }
  /** Parsed `state/metrics.json` (engine-written). */
  metrics?: unknown
  /** ISO time stamped on the view. */
  now: string
}

/**
 * The view fields `state/state.json` alone determines — exactly what a landed whole-document
 * write of that file supersedes (see `src/projection.ts`).
 */
export type DashboardStateFields = Pick<
  PbfuzzDashboardView,
  'phase' | 'status' | 'nextAction' | 'pierRound' | 'poc' | 'stopReason'
>

const PHASES: readonly PierPhase[] = ['INIT', 'PLAN', 'IMPLEMENT', 'EXECUTE', 'REFLECT', 'SUCCESS', 'STOPPED']

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown): Record<string, unknown>[] => {
    const r = record(item)
    return r === undefined ? [] : [r]
  })
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Split `file:line` on its last colon. A location without a numeric line keeps the whole
 * string as the file and line 0, so an odd campaign value still shows instead of vanishing.
 * @param location - campaign target location.
 * @returns the dashboard target.
 */
export function parseTargetLocation(location: string): DashboardTarget {
  const at = location.lastIndexOf(':')
  const line = at > 0 ? Number(location.slice(at + 1)) : Number.NaN
  return Number.isInteger(line) && line > 0 ? { file: location.slice(0, at), line } : { file: location, line: 0 }
}

/**
 * Summarise the PLAN blocks. Null until the agent has written any of them.
 * @param blocks - parsed block files.
 * @returns the hypothesis summary.
 */
export function summarizeHypothesis(blocks: DashboardSources['blocks']): DashboardHypothesis | null {
  if (blocks.bugPredicates === undefined && blocks.preconditions === undefined
    && blocks.rootCauses === undefined && blocks.triggerPlans === undefined) return null
  const preconditions = { verified: 0, violated: 0, unknown: 0, impossible: 0 }
  for (const p of records(blocks.preconditions)) {
    const status = p.status
    if (status === 'verified' || status === 'violated' || status === 'unknown' || status === 'impossible') preconditions[status] += 1
  }
  const triggerPlans = { pending: 0, inProgress: 0, completed: 0, failed: 0 }
  let currentPlan: DashboardHypothesis['currentPlan']
  for (const plan of records(blocks.triggerPlans)) {
    if (plan.status === 'pending') triggerPlans.pending += 1
    else if (plan.status === 'completed') triggerPlans.completed += 1
    else if (plan.status === 'failed') triggerPlans.failed += 1
    else if (plan.status === 'in_progress') {
      triggerPlans.inProgress += 1
      currentPlan ??= {
        id: text(plan.id),
        description: text(plan.description),
        complexity: typeof plan.complexity === 'number' ? plan.complexity : 0,
        status: 'in_progress',
      }
    }
  }
  return {
    bugPredicates: records(blocks.bugPredicates).length,
    preconditions,
    rootCauses: records(blocks.rootCauses).length,
    triggerPlans,
    ...currentPlan !== undefined ? { currentPlan } : {},
  }
}

/**
 * Derive the view fields the FSM cursor alone determines, from a parsed `state/state.json`.
 * The projection's write fold reuses this, so a host snapshot and a folded whole-document write
 * can never disagree about what a given state.json means.
 * @param state - parsed `state/state.json`, or undefined when the file does not exist yet.
 * @returns the fields.
 */
export function dashboardStateFields(state: unknown): DashboardStateFields {
  const doc = record(state)
  const poc = record(doc?.poc)
  return {
    // A campaign exists whenever the view is built; before state.json it is in INIT (as the guards
    // say), not phase-less — the badge was blank. An unrecognised value still renders empty.
    phase: doc === undefined ? 'INIT' : PHASES.includes(doc.phase as PierPhase) ? doc.phase as PierPhase : '',
    status: text(doc?.status),
    nextAction: text(doc?.next_action),
    pierRound: typeof doc?.pier_round === 'number' ? doc.pier_round : 0,
    poc: poc !== undefined ? poc as DashboardPoc : null,
    stopReason: text(doc?.stop_reason),
  }
}

/**
 * The `metrics` view field for a parsed `state/metrics.json`: the file verbatim when it carries the
 * iteration counters, else null (absent, or not a metrics document).
 * @param metrics - parsed metrics file, or undefined.
 * @returns the metrics view value.
 */
export function dashboardMetrics(metrics: unknown): DashboardMetrics | null {
  const doc = record(metrics)
  return doc !== undefined && typeof doc.total_iterations === 'number' ? doc as unknown as DashboardMetrics : null
}

/**
 * Build the full dashboard view. `metrics` and `poc` pass through verbatim
 * (contract field names), as the view type promises; a file that is missing or not the
 * expected shape becomes null.
 * @param src - parsed campaign files and resolved settings.
 * @returns the view, with `denials` empty.
 */
export function buildDashboardView(src: DashboardSources): PbfuzzDashboardView {
  const state = record(src.state)
  return {
    campaignId: src.campaignId,
    updatedAt: src.now,
    ...dashboardStateFields(state),
    maxPierRounds: src.maxPierRounds,
    targets: src.targets.map(parseTargetLocation),
    hypothesis: summarizeHypothesis(src.blocks),
    metrics: dashboardMetrics(src.metrics),
    denials: [],
  }
}
