import { describe, expect, it } from 'vitest'
import type { PbfuzzPhase } from '../src/core/contracts.ts'
import { NEXT_STEP } from '../src/core/fsm.ts'
import { transitionAllowed } from '../src/core/phases.ts'

const PHASES: readonly PbfuzzPhase[] = ['INIT', 'PLAN', 'IMPLEMENT', 'EXECUTE', 'REFLECT', 'SUCCESS', 'STOPPED']

/** `fsm.py`'s `LEGAL` table (the same one `phases.ts`'s `transitionAllowed()` implements — this
 * file only ports the table-driven test coverage for it). Every phase not named for a `from` here
 * has no *other-phase* legal target but STOPPED. */
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
      if (from === to) continue // same-phase re-entry is not part of the table.
      const expected = LEGAL[from].includes(to)
      it(`${from} → ${to} is ${expected ? 'legal' : 'illegal'}`, () => {
        expect(transitionAllowed(from, to)).toBe(expected)
      })
    }
  }
})

describe('NEXT_STEP', () => {
  it('no phase\'s text tells the model to write state.json directly (that write is now always denied by guard-policy.ts)', () => {
    for (const phase of PHASES) {
      expect(NEXT_STEP[phase]).not.toMatch(/write state\.json/)
    }
  })
})
