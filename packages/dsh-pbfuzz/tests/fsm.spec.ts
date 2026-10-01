import { describe, expect, it } from 'vitest'
import type { PbfuzzPhase } from '../src/core/contracts.ts'
import { NEXT_STEP } from '../src/core/fsm.ts'
import { roundWithinBudget, transitionAllowed } from '../src/core/phases.ts'

const PHASES: readonly PbfuzzPhase[] = ['INIT', 'PLAN', 'IMPLEMENT', 'EXECUTE', 'REFLECT', 'SUCCESS', 'STOPPED']

/** `fsm.py`'s `LEGAL` table (the same one `phases.ts`'s `transitionAllowed()` already implements —
 * this module does not duplicate the function, only ports the table-driven test coverage for it,
 * since the existing coverage in `tests/phases-registry-misc.spec.ts` only spot-checks four
 * pairs). Every phase not named for a `from` here has no *other-phase* legal target but STOPPED. */
const LEGAL: Record<PbfuzzPhase, readonly PbfuzzPhase[]> = {
  INIT: ['PLAN', 'STOPPED'],
  PLAN: ['IMPLEMENT', 'STOPPED'],
  IMPLEMENT: ['EXECUTE', 'STOPPED'],
  EXECUTE: ['REFLECT', 'STOPPED'],
  REFLECT: ['PLAN', 'SUCCESS', 'STOPPED'],
  SUCCESS: ['STOPPED'],
  STOPPED: [],
}

describe('transitionAllowed — the full LEGAL transition table (fsm.py parity)', () => {
  for (const from of PHASES) {
    for (const to of PHASES) {
      if (from === to) continue // same-phase re-entry has its own describe block below.
      const expected = LEGAL[from].includes(to)
      it(`${from} → ${to} is ${expected ? 'legal' : 'illegal'}`, () => {
        expect(transitionAllowed(from, to)).toBe(expected)
      })
    }
  }

  it('STOPPED has no other legal target (terminal phase)', () => {
    for (const to of PHASES) {
      if (to === 'STOPPED') continue
      expect(transitionAllowed('STOPPED', to)).toBe(false)
    }
  })
})

describe('transitionAllowed — same-phase re-entry (documented gap vs. fsm.py)', () => {
  // fsm.py's transition_violations() treats staying in the same phase as ALWAYS structurally
  // legal (new == old), with a *content* side-condition only for SUCCESS (needs `poc`) and
  // STOPPED (needs `stop_reason`) — a condition transitionAllowed() was never meant to check (its
  // own doc comment: "The budget check is separate", i.e. it only ever answered the coarse
  // FSM-shape question, never content requirements). phases.ts's transitionAllowed(x, x) for any
  // x other than STOPPED returns false today (x is not literally listed among x's own legal
  // targets), which is a real, known gap against fsm.py's full same-phase semantics — flagged in
  // this rewrite's research notes and explicitly left unfixed here: transitionAllowed() is shared
  // with modules this task does not own, and the full same-phase content check belongs with
  // whichever later-wave tool (pbfuzz_plan/pbfuzz_reflect) actually validates a phase-write
  // candidate. This test pins the CURRENT behaviour so a future fix is a deliberate, visible
  // change here, not a silent one.
  it('transitionAllowed(x, x) is false for every non-terminal phase today', () => {
    for (const phase of PHASES) {
      if (phase === 'STOPPED') continue
      expect(transitionAllowed(phase, phase)).toBe(false)
    }
  })

  it('STOPPED → STOPPED is true, via the to===\'STOPPED\' shortcut — consistent in effect with fsm.py (staying STOPPED is always structurally legal there too)', () => {
    expect(transitionAllowed('STOPPED', 'STOPPED')).toBe(true)
  })
})

describe('roundWithinBudget', () => {
  it('is a simple monotonic threshold', () => {
    expect(roundWithinBudget(0, 5)).toBe(true)
    expect(roundWithinBudget(4, 5)).toBe(true)
    expect(roundWithinBudget(5, 5)).toBe(false)
    expect(roundWithinBudget(6, 5)).toBe(false)
  })

  it('a budget of 1 allows exactly one round', () => {
    expect(roundWithinBudget(0, 1)).toBe(true)
    expect(roundWithinBudget(1, 1)).toBe(false)
  })
})

describe('NEXT_STEP', () => {
  it('has exactly one entry per phase, every one a non-empty sentence', () => {
    expect(Object.keys(NEXT_STEP).sort()).toEqual([...PHASES].sort())
    for (const phase of PHASES) {
      expect(NEXT_STEP[phase].length).toBeGreaterThan(10)
    }
  })

  it('names the tool that now drives each transition (P3: the agent never writes state.json itself any more)', () => {
    expect(NEXT_STEP.INIT).toMatch(/pbfuzz_campaign draft/)
    expect(NEXT_STEP.INIT).toMatch(/pbfuzz_campaign confirm/)
    expect(NEXT_STEP.INIT).toMatch(/pbfuzz_campaign confirm/)
    expect(NEXT_STEP.PLAN).toMatch(/pbfuzz_plan/)
    expect(NEXT_STEP.PLAN).toMatch(/bug_predicates/)
    expect(NEXT_STEP.IMPLEMENT).toMatch(/pbfuzz_fuzz/)
    expect(NEXT_STEP.EXECUTE).toMatch(/pbfuzz_fuzz/)
    expect(NEXT_STEP.REFLECT).toMatch(/pbfuzz_reflect/)
    expect(NEXT_STEP.REFLECT).toMatch(/next_round/)
    expect(NEXT_STEP.REFLECT).toMatch(/success/)
    expect(NEXT_STEP.REFLECT).toMatch(/stop/)
    // Neither terminal phase's text mentions writing state.json, or any tool call at all —
    // there is nothing left to legally do but report the outcome.
    expect(NEXT_STEP.SUCCESS).not.toMatch(/write state\.json/)
    expect(NEXT_STEP.STOPPED).not.toMatch(/write state\.json/)
  })

  it('no phase\'s text tells the model to write state.json directly (that write is now always denied by guard-policy.ts)', () => {
    for (const phase of PHASES) {
      expect(NEXT_STEP[phase]).not.toMatch(/write state\.json/)
    }
  })
})
