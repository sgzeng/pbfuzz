/**
 * The `pbfuzz` session projection feeding the dashboard.
 *
 * A pure, replay-safe fold over events DSH already commits — no new session event type:
 *
 * - `tool/result` — every pbfuzz tool result carries the host-built {@link PbfuzzDashboardView}
 *   in its `presentationMeta` (`tool/result.meta`); the fold keeps the latest one.
 * - `tool/result` — a DENIED call's result (any tool: `pbfuzz_*`, `kanalyzer_*`, `write`, `edit`,
 *   `bash`, a terminal tool) is `isError: true` with model-facing content `Error: <reason>`, where
 *   `<reason>` is exactly `guard-policy.ts`'s `decide()` return value — `digest.ts`'s `formatDeny()`
 *   output, `[pbfuzz:<rule>] DENIED (<tool>) — <why>\nNext legal action: <next>.` — because that is
 *   the string `ctx.tools.guard()` returned and `dsh-tools`'s `prepareExecution` renders verbatim
 *   (`Error: ${denialReason}`) into the tool-result block. {@link denialFromToolResult} recognises
 *   that header and turns it into a denial entry, newest first.
 *
 * Under this rewrite's P3 design change the agent never writes campaign state directly:
 * `guard-policy.ts` denies every `write`/`edit` under the state directory outright, so the OLD
 * write-staging mechanism this fold used to run (`tool/call` stages a whole-document `write` of
 * `state/state.json` or `state/metrics.json`, its paired `tool/result` either lands it or discards
 * it) is now structurally dead code — such a call can never succeed, so it never has anything to
 * land. State document changes reach the dashboard exclusively through `presentationMeta` on
 * pbfuzz's own tool results, which was already the primary path and needs nothing from this file
 * to keep working.
 *
 * The state is just the wire view ({@link PbfuzzDashboardState}), and `wire.view` returns the view
 * itself: an event that is not ours returns the same state reference (zero downstream work).
 *
 * @module @pbfuzz/dsh-pbfuzz/projection
 */

import { z as zod } from 'zod'
import {
  DENIALS_MAX,
  emptyDashboard,
  PBFUZZ_PROJECTION_KEY,
  type DashboardDenial,
  type PbfuzzDashboardView,
} from './client/dashboard-contract.ts'
import { DASHBOARD_META_KEY } from './tools.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    pbfuzz: PbfuzzDashboardState | null
  }
  interface SessionProjectionMap {
    /** The pbfuzz dashboard view, or null before any pbfuzz tool or guard reported. */
    pbfuzz: PbfuzzDashboardView | null
  }
}

const count = zod.number()
const metricsSchema = zod.looseObject({
  total_iterations: count,
  total_reached_count: count,
  last_reached_count: count.optional(),
  triggered_count: count,
  timeout_count: count.optional(),
  error_count: count.optional(),
  last_session: zod.looseObject({
    iterations: count.optional(),
    reached: count.optional(),
    elapsed_sec: count.optional(),
    stopped_by: zod.string().optional(),
  }).optional(),
})
const denialSchema = zod.object({ at: zod.string(), hook: zod.string(), tool: zod.string().optional(), reason: zod.string() })

/** Zod schema of {@link PbfuzzDashboardView}; validates both persisted state and the wire value. */
export const dashboardViewSchema = zod.object({
  campaignId: zod.string(),
  updatedAt: zod.string(),
  phase: zod.enum(['', 'INIT', 'PLAN', 'IMPLEMENT', 'EXECUTE', 'REFLECT', 'SUCCESS', 'STOPPED']),
  status: zod.string(),
  nextAction: zod.string(),
  pierRound: count,
  maxPierRounds: count,
  targets: zod.array(zod.object({ file: zod.string(), line: count, function: zod.string().optional() })),
  hypothesis: zod.object({
    bugPredicates: count,
    preconditions: zod.object({ verified: count, violated: count, unknown: count, impossible: count }),
    rootCauses: count,
    triggerPlans: zod.object({ pending: count, inProgress: count, completed: count, failed: count }),
    currentPlan: zod.object({ id: zod.string(), description: zod.string(), complexity: count, status: zod.string() }).optional(),
  }).nullable(),
  metrics: metricsSchema.nullable(),
  denials: zod.array(denialSchema).max(DENIALS_MAX),
  poc: zod.looseObject({
    input_path: zod.string().optional(),
    reproduced_times: count.optional(),
    run_cmd: zod.string().optional(),
  }).nullable(),
  stopReason: zod.string(),
}) satisfies zod.ZodType<PbfuzzDashboardView>

/**
 * The projection's state: just the wire view. Kept as a one-field wrapper (rather than using
 * {@link PbfuzzDashboardView} directly as the state type) so a future fold input that needs
 * additional bookkeeping alongside the view — the way the removed write-staging mechanism once did
 * — has somewhere to add it without changing `wire.view`'s shape again.
 */
export interface PbfuzzDashboardState {
  /** The wire value; `wire.view` returns this reference unchanged. */
  view: PbfuzzDashboardView
}

/** Zod schema of {@link PbfuzzDashboardState}; the persisted-state contract `registerProjection` declares. */
export const dashboardStateSchema = zod.object({
  view: dashboardViewSchema,
}).nullable() satisfies zod.ZodType<PbfuzzDashboardState | null>

/**
 * The header every pbfuzz guard denial carries, exactly as `digest.ts`'s `formatDeny()` builds it:
 * the rule id (one or two hyphenated segments, e.g. `guard-error`, `phase-gate/phase`,
 * `state-write/metrics-engine-only`), then the tool name in parens, then ` — ` and the reason.
 * Deliberately NOT the old hook-bridge format this regex used to match (`<guard>_snake/<rule>`,
 * e.g. `phase_gate/phase`) — that event type (`hook/result`) no longer exists, so there is nothing
 * left to stay compatible with; the format below is `guard-policy.ts`'s own rule ids verbatim (see
 * every `formatDeny(...)` call site there).
 */
const DENY_HEADER = /^\[pbfuzz:([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?)\] DENIED(?: \(([^)\s]+)\))? — /

/** The literal envelope `dsh-tools`'s `prepareExecution` wraps a denial reason in before it becomes
 * the tool-result block's rendered text (`Error: ${denialReason}`, verified against the installed
 * `@deepseek-ai/dsh-tools` source: the guard/pre-execute-denial branch of `prepareExecution`). */
const ERROR_ENVELOPE = 'Error: '

/** The slice of a committed session event the fold reads. */
export interface FoldEvent {
  type: string
  /** Unix epoch ms (every committed event carries it). */
  time?: number
  data?: unknown
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * The denied call's full reason text, or undefined when this `tool/result` was not a denial at
 * all. Tries the durable event's own `error.message` first (the shape a `ToolExecutionFailure`
 * carries in-memory), then falls back to the rendered block's text with the `Error: ` envelope
 * stripped — the field that actually reaches the durable log for a guard denial, since
 * `prepareExecution`'s denial branch sets `error: { message }` on the execution-local result but
 * the session event's own `error` field only ever carries `{ name, code }` (`ToolErrorInfo`), never
 * a message.
 * @param data - the `tool/result` event's data.
 * @param block - the result message's one `ToolResultBlock`.
 * @returns the denial's full text (still carrying the `[pbfuzz:...]` header), or undefined.
 */
function deniedText(data: Record<string, unknown>, block: Record<string, unknown>): string | undefined {
  const viaError = record(data.error)?.message
  if (typeof viaError === 'string' && viaError !== '') return viaError
  const inner = Array.isArray(block.content) ? record(block.content[0]) : undefined
  const raw = typeof inner?.text === 'string' ? inner.text : undefined
  if (raw === undefined) return undefined
  return raw.startsWith(ERROR_ENVELOPE) ? raw.slice(ERROR_ENVELOPE.length) : raw
}

/**
 * Parse one `tool/result` into a denial, or undefined when it is not a pbfuzz guard deny (an
 * ordinary success, a non-pbfuzz tool error, or a pbfuzz tool's own thrown error that never went
 * through `ctx.tools.guard()` at all — none of those carry the `[pbfuzz:...]` header).
 * @param event - a `tool/result` event.
 * @returns the denial, or undefined.
 */
export function denialFromToolResult(event: FoldEvent): DashboardDenial | undefined {
  const data = record(event.data)
  if (data === undefined) return undefined
  const content = record(data.message)?.content
  const block = Array.isArray(content) ? record(content[0]) : undefined
  if (block === undefined || block.isError !== true) return undefined
  const text = deniedText(data, block)
  if (text === undefined) return undefined
  const header = DENY_HEADER.exec(text)
  if (header === null) return undefined
  const [matched, rule = '', tool] = header
  return {
    at: typeof event.time === 'number' && Number.isFinite(event.time) ? new Date(event.time).toISOString() : '',
    hook: rule,
    ...tool !== undefined ? { tool } : {},
    reason: text.slice(matched.length),
  }
}

/**
 * Pure fold step, exported for tests.
 * @param state - the state covering all prior events.
 * @param event - one committed session event.
 * @returns the next state (the same reference when the event is not ours).
 */
export function foldDashboard(state: PbfuzzDashboardState | null, event: FoldEvent): PbfuzzDashboardState | null {
  if (event.type !== 'tool/result') return state
  // Checked first, independent of whether this same result also carries presentationMeta (it
  // structurally never both fails AND returns a value, but a denial reaching the dashboard must
  // never depend on that): any denied call, any tool name, not just pbfuzz's own.
  const denial = denialFromToolResult(event)
  if (denial !== undefined) {
    const base = state ?? { view: emptyDashboard() }
    return { view: { ...base.view, denials: [denial, ...base.view.denials].slice(0, DENIALS_MAX) } }
  }
  const data = record(event.data)
  const meta = record(data?.meta)
  if (meta === undefined || !(DASHBOARD_META_KEY in meta)) return state
  const parsed = dashboardViewSchema.safeParse(meta[DASHBOARD_META_KEY])
  if (!parsed.success) return state
  // Denials belong to the fold, not the snapshot; they reset only when the campaign changes.
  const keep = state !== null && (state.view.campaignId === '' || state.view.campaignId === parsed.data.campaignId)
  return { view: { ...parsed.data, denials: keep ? state.view.denials : [] } }
}

/**
 * Register the projection on `ctx.sessionProjections`.
 * @param registry - the session projection registry.
 */
export function registerProjection(registry: { register(def: unknown): unknown }): void {
  registry.register({
    key: PBFUZZ_PROJECTION_KEY,
    stateSchema: dashboardStateSchema,
    init: () => null,
    apply: foldDashboard,
    wire: { viewSchema: dashboardViewSchema.nullable(), view: (state: PbfuzzDashboardState | null) => state?.view ?? null },
    // 4: the write-staging mechanism (a `tool/call` stage plus its paired `tool/result` landing) is
    // gone — guard-policy.ts denies every agent write/edit under the state directory outright, so
    // that call could never land in the first place — and denials now fold from `tool/result`
    // (`denialFromToolResult`) instead of the retired `hook/result` event. A persisted v3 state's
    // `pending` field is simply absent from the v4 shape; the version bump is what makes the
    // registry discard rather than misread a v3 row instead of trying to resume mid-fold with a
    // schema that no longer describes what it produces.
    stateVersion: 4,
  })
}
