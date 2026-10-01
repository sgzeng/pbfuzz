/**
 * Tool visibility, the phase-transition table, and the round budget.
 *
 * **Visibility is session-constant on purpose.** The model sees one tool list for the whole
 * campaign; phase discipline is enforced by `ctx.tools.guard()` (`guard-policy.ts::decide()`,
 * which re-reads `POLICY.phaseTools` on every call and denies with the next legal action). An
 * earlier design also narrowed the *visible* set per PIER phase, on top of that enforcement.
 * DSH's agent loop treats any change to the tool-schema array as a new request series
 * (`dsh-agent-loop`'s `toolsChanged()` feeds `startsSeries`, which re-projects the whole system
 * prompt), so each narrowing invalidated the provider's prompt prefix cache: one measured
 * single-round campaign paid ~470k fully-uncached input tokens across six such transitions, 92%
 * of the session's non-cached prompt spend, for a layer that enforced nothing.
 *
 * What still varies the list — settings switches and whether an analysis provider is registered —
 * is constant within a session in practice, so the list is computed once per agent and left alone.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/phases
 */

import type { PbfuzzPhase, PbfuzzSettings, SelfcheckItemName } from './contracts.ts'
import { POLICY } from '../generated/policy.ts'

/** Every model-facing tool this plugin registers. */
export const PBFUZZ_TOOLS = [
  'pbfuzz_campaign',
  'pbfuzz_callgraph',
  'pbfuzz_corpus',
  'pbfuzz_extract_parameters',
  'pbfuzz_fuzz',
  'pbfuzz_trace',
  'pbfuzz_deviation',
  'pbfuzz_probe',
  'pbfuzz_plan',
  'pbfuzz_reflect',
] as const

/** One pbfuzz tool name. */
export type PbfuzzToolName = typeof PBFUZZ_TOOLS[number]

/** The kanalyzer tools pbfuzz makes visible in every phase when static analysis is on
 * (`contracts/policy.json`'s `kanalyzerTools`). */
export const KANALYZER_TOOLS = POLICY.kanalyzerTools

/** Which settings switch backs each tool. Read from the shared policy table
 * (`POLICY.toolBacking`), the same table `guard-policy.ts` reads. Keyed only by pbfuzz's own tools: an absent tool (every `kanalyzer_*` name) has no
 * backing to fail, so pbfuzz's `tools.staticAnalysis` switch and `static_analysis` self-check
 * govern `pbfuzz_callgraph` — pbfuzz's own use of static analysis — and no longer decide whether
 * the user may drive the standalone kanalyzer plugin. See `guard-policy.ts`'s copy for the full
 * reasoning. */
const TOOL_BACKING: Partial<Record<string, SelfcheckItemName>> = POLICY.toolBacking

/** What the visibility computation needs to know. Deliberately phase-free — see the module doc. */
export interface VisibilityInput {
  /** True once `pbfuzz_campaign confirm` wrote `confirmed: true`. */
  hasConfirmedCampaign: boolean
  /** The resolved settings section. */
  settings: Pick<PbfuzzSettings, 'tools' | 'guards'>
  /** Whether an analysis provider is actually registered (kanalyzer installed and loaded). */
  providerPresent: boolean
}

/**
 * Whether an auxiliary tool is enabled in settings at all. A tool disabled here has its pbfuzz
 * tools hidden by `restrict()` and denied by the `phase_gate` hook.
 * @param item - the self-check item standing for the tool.
 * @param settings - the resolved settings section.
 * @returns whether the user enabled it.
 */
export function toolEnabledInSettings(item: SelfcheckItemName, settings: Pick<PbfuzzSettings, 'tools'>): boolean {
  switch (item) {
    case 'static_analysis':
      return settings.tools.staticAnalysis !== 'off'
    case 'corpus':
      return settings.tools.corpusAnalysis
    case 'deviation':
      return settings.tools.deviationDetection
    case 'tracer':
      return settings.tools.tracer !== 'off'
    case 'engine':
    case 'oracle':
      // Neither is optional: the engine runs every fuzz session and the oracle is how a run is
      // judged at all. They appear in the self-check, never as a switch.
      return true
  }
}

/**
 * The tools visible to the model, for the whole session.
 *
 * A tool is visible when the auxiliary analysis backing it is enabled in settings and — for
 * provider-backed tools — a provider is actually registered. Nothing here depends on the campaign
 * phase; see the module doc for why. `hideToolsWithoutCampaign` (off by default) additionally
 * keeps pbfuzz's own tools out of the list until a confirmed campaign exists, except
 * `pbfuzz_campaign` itself, which is how a campaign comes to exist.
 *
 * The kanalyzer tools are always exempt: kanalyzer is a standalone analysis plugin the user may
 * invoke with no pbfuzz campaign at all, so hiding them by campaign state is what once made a
 * plain `/kanalyzer analyze …` look like "the kanalyzer tools aren't registered in this session".
 *
 * @param input - settings and provider presence.
 * @returns the sorted set of visible tool names.
 */
export function visibleTools(input: VisibilityInput): string[] {
  const { settings, providerPresent, hasConfirmedCampaign } = input
  if (settings.guards.hideToolsWithoutCampaign && !hasConfirmedCampaign) {
    // POLICY.noCampaignTools is the one no-campaign-visibility table: guard-policy.ts's own
    // "use one of ..." denial suggestion reads the same table for the identical state.
    return [...POLICY.noCampaignTools, ...KANALYZER_TOOLS].sort()
  }
  const visible: string[] = [...PBFUZZ_TOOLS]
    .filter((tool) => {
      const backing = TOOL_BACKING[tool]
      if (backing === undefined) return true
      if (!toolEnabledInSettings(backing, settings)) return false
      const needsProvider = backing === 'static_analysis'
        || (backing === 'deviation' && settings.tools.staticAnalysis !== 'off')
      return !needsProvider || providerPresent
    })
  return [...visible, ...KANALYZER_TOOLS].sort()
}

/**
 * Whether a phase transition is legal (PLAN §2.4 and `state/state.schema.json`). The budget check
 * is separate: REFLECT→PLAN is legal as a transition but denied once the round budget is spent,
 * which is why the two questions do not collapse into one.
 * @param from - the current phase.
 * @param to - the requested phase.
 * @returns whether the FSM permits it.
 */
export function transitionAllowed(from: PbfuzzPhase, to: PbfuzzPhase): boolean {
  if (to === 'STOPPED') return true
  const legal: Record<PbfuzzPhase, PbfuzzPhase[]> = {
    INIT: ['PLAN'],
    PLAN: ['IMPLEMENT'],
    IMPLEMENT: ['EXECUTE'],
    EXECUTE: ['REFLECT'],
    REFLECT: ['PLAN', 'SUCCESS'],
    SUCCESS: [],
    STOPPED: [],
  }
  return legal[from].includes(to)
}

/**
 * Whether another PIER round is within budget.
 * @param pierRound - completed PLAN→REFLECT cycles.
 * @param maxPierRounds - `budget.maxPierRounds`.
 * @returns whether REFLECT→PLAN may be taken; false means the agent must write STOPPED.
 */
export function roundWithinBudget(pierRound: number, maxPierRounds: number): boolean {
  return pierRound < maxPierRounds
}
