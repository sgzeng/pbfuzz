import { describe, expect, it } from 'vitest'
import { planInterview } from '../src/core/questionnaire.ts'
import { settings } from './fixtures.ts'

const ids = (plan: ReturnType<typeof planInterview>) => plan.questions.map(q => q.id)

describe('planInterview', () => {
  it('asks S1..S6 in order with required/optional marking when nothing is known', () => {
    const plan = planInterview({}, settings())
    expect(ids(plan)).toEqual(['S1_repo', 'S2_bug', 'S3_env', 'S4_entry', 'S5_target', 'S6_output', 'C_corpus_seeds'])
    const byId = Object.fromEntries(plan.questions.map(q => [q.id, q]))
    expect(byId.S1_repo!.required).toBe(true)
    expect(byId.S2_bug!.required).toBe(true)
    expect(byId.S3_env!.required).toBe(false)
    expect(byId.S4_entry!.required).toBe(true)
    expect(byId.S5_target!.question.startsWith('[optional]')).toBe(true)
    expect(byId.S1_repo!.question.startsWith('[required]')).toBe(true)
  })

  it('skips S4 entirely when a run script is supplied', () => {
    const plan = planInterview({ runScript: './run.sh' }, settings({ onboarding: { interviewPolicy: 'always' } }))
    expect(ids(plan)).not.toContain('S4_entry')
    expect(plan.skipped.find(s => s.id === 'S4_entry')?.reason).toMatch(/run script/)
  })

  it('under when-missing asks only gaps', () => {
    const plan = planInterview({ repo: '/r', bug: 'patch', target: 'a.c:1' }, settings())
    expect(ids(plan)).toEqual(['S3_env', 'S4_entry', 'S6_output', 'C_corpus_seeds'])
  })

  it('under never asks nothing and reports missing required steps', () => {
    const plan = planInterview({ repo: '/r' }, settings({ onboarding: { interviewPolicy: 'never' } }))
    expect(plan.questions).toEqual([])
    expect(plan.missingRequired).toEqual(['S2_bug', 'S4_entry'])
    expect(planInterview({ repo: '/r', bug: 'x', runScript: 'r.sh' }, settings({ onboarding: { interviewPolicy: 'never' } })).missingRequired).toEqual([])
  })

  it('conditional questions follow settings and inference gaps', () => {
    const off = planInterview({}, settings({ tools: { corpusAnalysis: false } }))
    expect(ids(off)).not.toContain('C_corpus_seeds')
    const staticGaps = planInterview({ staticGaps: ['link output'] }, settings({ tools: { staticAnalysis: 'kanalyzer' } }))
    expect(staticGaps.questions.find(q => q.id === 'C_static_inputs')?.detail).toMatch(/link output/)
    expect(ids(planInterview({}, settings({ tools: { staticAnalysis: 'kanalyzer' } })))).not.toContain('C_static_inputs')
    expect(ids(planInterview({ preexistingMarkers: 'MAGMA_LOG' }, settings()))).toContain('C_oracle_reuse')
  })

  // Tiering (P2): S1_repo/S2_bug must be askable alone, before any repo probing -- the fix for the
  // incident where the agent built a working exploit input 460s before ever presenting them.
  describe('tiering: first (S1/S2 alone) vs confirm (folded into the plan-review panel)', () => {
    it('splits first/confirm disjointly, and first ∪ confirm == questions in order', () => {
      const plan = planInterview({}, settings({ onboarding: { interviewPolicy: 'always' } }))
      expect(plan.first.map(q => q.id)).toEqual(['S1_repo', 'S2_bug'])
      expect(plan.confirm.map(q => q.id)).toEqual(['S3_env', 'S4_entry', 'S5_target', 'S6_output', 'C_corpus_seeds'])
      expect([...plan.first, ...plan.confirm]).toEqual(plan.questions)
      // every question is tagged with exactly the tier its id belongs to
      for (const q of plan.first) expect(q.tier).toBe('first')
      for (const q of plan.confirm) expect(q.tier).toBe('confirm')
    })

    it('every StepDef beyond S1/S2 is tier confirm, even the required S4_entry', () => {
      const plan = planInterview({}, settings({ onboarding: { interviewPolicy: 'always' } }))
      const byId = Object.fromEntries(plan.questions.map(q => [q.id, q]))
      expect(byId.S1_repo!.tier).toBe('first')
      expect(byId.S2_bug!.tier).toBe('first')
      expect(byId.S4_entry!.required).toBe(true)
      expect(byId.S4_entry!.tier).toBe('confirm')
      expect(byId.S5_target!.tier).toBe('confirm')
      expect(byId.S6_output!.tier).toBe('confirm')
    })

    it('when S1/S2 are already known, first is empty and does not leak into confirm (when-missing policy)', () => {
      const plan = planInterview({ repo: '/r', bug: 'patch' }, settings())
      expect(plan.first).toEqual([])
      expect(plan.confirm.map(q => q.id)).not.toContain('S1_repo')
      expect(plan.confirm.map(q => q.id)).not.toContain('S2_bug')
    })

    it('S3->S4 skip logic still holds under the tiered split: S4_entry is absent from confirm when a run script was supplied', () => {
      const plan = planInterview({ runScript: './run.sh' }, settings({ onboarding: { interviewPolicy: 'always' } }))
      expect(plan.confirm.map(q => q.id)).not.toContain('S4_entry')
      expect(plan.skipped.find(s => s.id === 'S4_entry')?.reason).toMatch(/run script/)
      // S1/S2 tiering is unaffected by the S3/S4 skip rule
      expect(plan.first.map(q => q.id)).toEqual(['S1_repo', 'S2_bug'])
    })

    it('under never, first/confirm are both empty (nothing is ever asked) but missingRequired still fires', () => {
      const plan = planInterview({}, settings({ onboarding: { interviewPolicy: 'never' } }))
      expect(plan.first).toEqual([])
      expect(plan.confirm).toEqual([])
      expect(plan.missingRequired).toEqual(['S1_repo', 'S2_bug', 'S4_entry'])
    })
  })
})
