/**
 * The dashboard's view shape — the single source of truth for BOTH halves.
 *
 * CHANNEL: the `pbfuzz` session projection. The host half (`src/projection.ts`)
 * folds this view out of committed session events — the latest snapshot a pbfuzz
 * tool result carries in its `presentationMeta`, plus the `hook/result` denials
 * the hook bridge logs — and the browser reads it with `useProjection('pbfuzz')`.
 * It is per-session, replay-safe and never touches the user's settings document.
 *
 * This file must stay dependency-free: the host imports it too.
 *
 * The sub-objects `metrics` and `poc` are copied VERBATIM from
 * `.pbfuzz/<id>/state/metrics.json` and
 * `state.json#poc` (contract field names, snake_case), so the host can pass the
 * parsed files through without mapping.
 */

/** Session projection key the host registers and the browser reads. */
export const PBFUZZ_PROJECTION_KEY = 'pbfuzz'

/** How many denials the view keeps, most recent first. */
export const DENIALS_MAX = 10

/** PIER phase (state.schema.json). Empty string: no campaign. */
export type PierPhase = '' | 'INIT' | 'PLAN' | 'IMPLEMENT' | 'EXECUTE' | 'REFLECT' | 'SUCCESS' | 'STOPPED'

/** One resolved target location. */
export interface DashboardTarget {
  file: string
  line: number
  function?: string
}

/** Hypothesis-block summary derived from the state/*.json blocks. */
export interface DashboardHypothesis {
  bugPredicates: number
  preconditions: { verified: number; violated: number; unknown: number; impossible: number }
  rootCauses: number
  triggerPlans: { pending: number; inProgress: number; completed: number; failed: number }
  currentPlan?: { id: string; description: string; complexity: number; status: string }
}

/** metrics.schema.json, verbatim subset the dashboard shows. */
export interface DashboardMetrics {
  total_iterations: number
  total_reached_count: number
  last_reached_count?: number
  triggered_count: number
  timeout_count?: number
  error_count?: number
  last_session?: {
    iterations?: number
    reached?: number
    elapsed_sec?: number
    stopped_by?: string
  }
}

/** One guard deny, most recent first. */
export interface DashboardDenial {
  /** ISO time. */
  at: string
  /** The guard's dotted rule id, e.g. `phase-gate/phase`, `state-write/owned-by-tool`,
   * `bash-guard/state-tamper` (`core/guard-policy.ts`'s `decide()` — see its rule ids). */
  hook: string
  /** Tool the guard denied, when there was one. */
  tool?: string
  /** The actionable reason the guard returned. */
  reason: string
}

/** state.schema.json#poc, verbatim. */
export interface DashboardPoc {
  input_path?: string
  reproduced_times?: number
  run_cmd?: string
}

/** The whole `pbfuzz` projection value. */
export interface PbfuzzDashboardView {
  /** Active campaign id; empty string when none. */
  campaignId: string
  /** ISO time the host built the latest snapshot; empty before the first one. */
  updatedAt: string
  phase: PierPhase
  /** state.json#status one-liner. */
  status: string
  /** state.json#next_action. */
  nextAction: string
  /** state.json#pier_round (completed rounds). */
  pierRound: number
  /** Resolved settings budget.maxPierRounds. */
  maxPierRounds: number
  targets: DashboardTarget[]
  hypothesis: DashboardHypothesis | null
  metrics: DashboardMetrics | null
  /** At most 10, most recent first. */
  denials: DashboardDenial[]
  poc: DashboardPoc | null
  /** state.json#stop_reason, when STOPPED. */
  stopReason: string
}

const PHASES: readonly PierPhase[] = ['', 'INIT', 'PLAN', 'IMPLEMENT', 'EXECUTE', 'REFLECT', 'SUCCESS', 'STOPPED']

/**
 * The idle view: no campaign snapshot yet. The projection starts a denial list
 * from this when a guard denies before any pbfuzz tool has reported.
 * @returns a fresh empty view.
 */
export function emptyDashboard(): PbfuzzDashboardView {
  return {
    campaignId: '',
    updatedAt: '',
    phase: '',
    status: '',
    nextAction: '',
    pierRound: 0,
    maxPierRounds: 0,
    targets: [],
    hypothesis: null,
    metrics: null,
    denials: [],
    poc: null,
    stopReason: '',
  }
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Tolerant decoder for the projection value: a missing or malformed part
 * degrades to its empty form instead of blanking the dashboard.
 * @param section - raw projection value.
 * @returns the view, or undefined when the value is not an object (null: no campaign).
 */
export function decodeDashboard(section: unknown): PbfuzzDashboardView | undefined {
  const s = obj(section)
  if (s === undefined) return undefined
  const phase = PHASES.includes(s.phase as PierPhase) ? s.phase as PierPhase : ''
  const targets = Array.isArray(s.targets)
    ? s.targets.flatMap((raw) => {
      const t = obj(raw)
      return t === undefined ? [] : [{ file: str(t.file), line: num(t.line), ...typeof t.function === 'string' ? { function: t.function } : {} }]
    })
    : []
  const denials = Array.isArray(s.denials)
    ? s.denials.slice(0, 10).flatMap((raw) => {
      const d = obj(raw)
      return d === undefined ? [] : [{ at: str(d.at), hook: str(d.hook), reason: str(d.reason), ...typeof d.tool === 'string' ? { tool: d.tool } : {} }]
    })
    : []
  const metrics = obj(s.metrics)
  return {
    campaignId: str(s.campaignId),
    updatedAt: str(s.updatedAt),
    phase,
    status: str(s.status),
    nextAction: str(s.nextAction),
    pierRound: num(s.pierRound),
    maxPierRounds: num(s.maxPierRounds),
    targets,
    hypothesis: (obj(s.hypothesis) as DashboardHypothesis | undefined) ?? null,
    metrics: metrics !== undefined ? metrics as unknown as DashboardMetrics : null,
    denials,
    poc: (obj(s.poc) as DashboardPoc | undefined) ?? null,
    stopReason: str(s.stopReason),
  }
}
