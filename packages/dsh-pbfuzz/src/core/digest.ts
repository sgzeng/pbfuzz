/**
 * Text formatting shared by every guard denial and by the campaign status banner.
 *
 * Both are pure string builders with no I/O: `formatDeny()` is what `guard-policy.ts` calls for
 * every denial (the exact wire format `contracts/hook-io.md` used to document for the hook
 * bridge — a rule id, the violation, and a concrete next legal action, so a denial never leaves
 * the model with nowhere to go), and `banner()` is the short line a later wave's
 * `ctx.systemPrompt.section()` registration re-renders on every request (PLAN's native-seam
 * table: "抗压缩/恢复的状态行").
 *
 * @module @pbfuzz/dsh-pbfuzz/core/digest
 */

import type { PbfuzzPhase } from './contracts.ts'
import { NEXT_STEP } from './fsm.ts'

/**
 * Build a denial message in pbfuzz's one wire format.
 *
 * Ported from `guards.py`'s `deny()`, with the tool name folded into the header text itself
 * (`(tool)`) instead of being stamped on afterwards from a separate payload field the way the old
 * cross-process hook bridge did — natively `exec.name` is already known to the caller, so there is
 * nothing left to stamp. The trailing period after `next` is part of this format, not part of any
 * individual `next` string; callers pass `next` without one.
 * @param rule - the dotted rule id, e.g. `'phase-gate/phase'`.
 * @param tool - the tool name the call was made against.
 * @param why - the one-sentence violation.
 * @param next - the concrete next legal action (no trailing period — this function adds it).
 * @returns the formatted denial string.
 */
export function formatDeny(rule: string, tool: string, why: string, next: string): string {
  return `[pbfuzz:${rule}] DENIED (${tool}) — ${why}\nNext legal action: ${next}.`
}

/**
 * What `banner()` needs to know about the active campaign. A subset of `GuardView`
 * (`guard-policy.ts`) restricted to the fields that may legitimately appear in a line injected
 * into *every* model request: phase and round identify where the campaign is; `campaignId` and
 * `maxPierRounds` are what makes that meaningful. Nothing here changes on its own between phase
 * transitions (no timestamps, no metrics, no per-call counters), which is the whole point — a
 * `systemPrompt.section()` registration re-renders this on every step, and a value that changed
 * every call would invalidate prompt-KV-cache every call along with it. A later wave (B0) building
 * the section callback is expected to construct this from the same `ActiveCampaign` state that
 * builds `GuardView`.
 */
export interface BannerView {
  /** The campaign id, shown so a workspace running more than one campaign stays disambiguated. */
  campaignId: string
  /** The current PIER phase. */
  phase: PbfuzzPhase
  /** Completed PLAN→REFLECT cycles so far (`state.json`'s `pier_round`). */
  pierRound: number
  /** `settings.budget.maxPierRounds`. */
  maxPierRounds: number
}

/**
 * The one-line campaign status banner for the system prompt.
 *
 * Deliberately terse and deliberately silent on anything that isn't phase/round: this text is
 * re-rendered on every single request in the session (unlike a denial, which only appears once
 * per denied call), so anything volatile here — a timestamp, a metrics counter — would defeat
 * prompt caching on every turn for no benefit (the equivalent information is already available
 * on demand through `pbfuzz_campaign status`). `view === undefined` (no active campaign) renders
 * as the empty string, matching `ctx.systemPrompt.section()`'s convention that an empty string
 * contributes nothing.
 * @param view - the active campaign's banner-relevant state, or `undefined` when none is active.
 * @returns the banner line, or `''` when there is no active campaign.
 */
export function banner(view: BannerView | undefined): string {
  if (view === undefined) return ''
  return `pbfuzz campaign ${view.campaignId} — phase ${view.phase}, round ${view.pierRound}/${view.maxPierRounds} — next: ${NEXT_STEP[view.phase]}`
}
