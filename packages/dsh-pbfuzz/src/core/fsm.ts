/**
 * The PIER phase vocabulary: what the agent should be doing in each phase.
 *
 * The legal-transition table and the round budget already live in `phases.ts`
 * (`transitionAllowed()`, `roundWithinBudget()`) and are re-exported from there unchanged — this
 * module does not duplicate them (the tests in `tests/phases-registry-misc.spec.ts` import them
 * from `phases.ts` and must keep working). What this module owns is `NEXT_STEP`: the one line of
 * "what to do now" text appended to nearly every guard denial and to the campaign status banner
 * (`digest.ts`'s `banner()`), so a denial never leaves the model without a next legal action.
 *
 * `engine/hooks/pbfuzz_hooks/guards.py` and `fsm.py` are not two independent copies of this
 * table: `guards.py` imports `fsm` and reads `fsm.NEXT_STEP` directly, so there is nothing to
 * reconcile between the two Python files. What *did* need reconciling is the table's own text: the
 * Python original tells the model to "write state.json with phase X" at every step, because in
 * that architecture the agent wrote `state.json` itself (through the `write` tool, validated by
 * `state_guard`). Under this rewrite's P3 design change, the agent never writes campaign state
 * directly — `pbfuzz_plan`/`pbfuzz_fuzz`/`pbfuzz_reflect`/`pbfuzz_campaign` own every state write,
 * and `core/guard-policy.ts` unconditionally denies any `write`/`edit` under the state directory.
 * Porting the old "write state.json" wording verbatim would actively mislead the model into
 * retrying the exact call `guard-policy.ts` just denied, so each phase's text below names the tool
 * that now drives that transition instead. The *meaning* (what evidence is needed, what phase
 * comes next) is preserved from `fsm.py`; only the mechanism ("write JSON" → "call this tool") is
 * updated to match the new architecture.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/fsm
 */

import type { PbfuzzPhase } from './contracts.ts'

/**
 * What the agent should be doing in each phase, one line per phase. Appended to phase-gate,
 * terminal-gate and backing-item denials (`guard-policy.ts`) and to the campaign status banner
 * (`digest.ts`'s `banner()`) so every message that names a phase also names the way forward.
 *
 * Ported from `fsm.py`'s `NEXT_STEP` (the single copy `guards.py` also reads), with the
 * "write state.json with phase X" phrasing replaced by the tool that now owns each transition —
 * see the module doc comment above for why.
 */
export const NEXT_STEP: Record<PbfuzzPhase, string> = {
  INIT: 'call pbfuzz_campaign draft, then pbfuzz_campaign confirm — approving it moves the campaign to PLAN',
  PLAN: 'call pbfuzz_plan with bug_predicates, preconditions, root_causes and trigger_plans — it writes the blocks and moves the campaign to IMPLEMENT',
  IMPLEMENT: 'call pbfuzz_fuzz with the generator source inline as generator_code and the fuzz plan (parameter_space, next_batch_plan, breakpoints) — it validates both, moves the campaign to EXECUTE and starts the run',
  EXECUTE: 'wait for the pbfuzz_fuzz job to finish; the campaign moves to REFLECT once it reports back',
  REFLECT: 'analyse metrics.json (pbfuzz_deviation / pbfuzz_trace help), then call pbfuzz_reflect with next_round, success (with a poc) or stop',
  SUCCESS: 'the campaign is finished; report the PoC',
  STOPPED: 'the campaign is finished; report stop_reason and the best evidence gathered',
}
