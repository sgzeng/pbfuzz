import { describe, expect, it } from 'vitest'
import type { ParameterSpace } from '../src/core/contracts.ts'
import {
  checkSafeUpdate,
  validateBugPredicates,
  validateFuzzPlan,
  validatePreconditions,
  validateRootCauses,
  validateTriggerPlans,
} from '../src/core/state-blocks.ts'

describe('validateBugPredicates', () => {
  it('accepts a well-formed array', () => {
    const v = validateBugPredicates([{ id: 'BP1', location: 'png.c:620', bug_condition: 'info_ptr->free_me & PNG_FREE_EXIF == 0' }])
    expect(v.ok).toBe(true)
    expect(v.issues).toEqual([])
  })

  it('rejects a non-array', () => {
    const v = validateBugPredicates({ id: 'BP1' })
    expect(v.ok).toBe(false)
    expect(v.issues[0]!.message).toMatch(/must be an array/)
  })

  it('rejects a bad id pattern, a location missing the line number, and an empty bug_condition', () => {
    const v = validateBugPredicates([{ id: 'bp1', location: 'png.c', bug_condition: '' }])
    expect(v.ok).toBe(false)
    expect(v.issues.map(i => i.path)).toEqual(expect.arrayContaining(['[0].id', '[0].location', '[0].bug_condition']))
    expect(v.issues.find(i => i.path === '[0].id')!.message).toMatch(/\^BP\[0-9\]\+\$/)
  })

  it('rejects an unknown field (additionalProperties: false)', () => {
    const v = validateBugPredicates([{ id: 'BP1', location: 'a.c:1', bug_condition: 'x', extra: true }])
    expect(v.ok).toBe(false)
    expect(v.issues.find(i => i.path === '[0].extra')?.message).toBe('unknown field')
  })
})

describe('validatePreconditions', () => {
  it('accepts a well-formed array, including the optional input_constraints default', () => {
    const v = validatePreconditions([
      { id: 'R1', statement: 'len < 100', status: 'verified', evidence: ['saw the check at png.c:610'] },
      { id: 'R2', statement: 'width > 0', status: 'unknown', evidence: [], input_constraints: ['width < 100'] },
    ])
    expect(v.ok).toBe(true)
  })

  it('rejects a bad id pattern, a bad status enum value, and non-string evidence', () => {
    const v = validatePreconditions([{ id: 'X1', statement: 's', status: 'maybe', evidence: [1, 2] }])
    expect(v.ok).toBe(false)
    expect(v.issues.find(i => i.path === '[0].id')!.message).toMatch(/\^R\[0-9\]\+\$/)
    expect(v.issues.find(i => i.path === '[0].status')!.message).toMatch(/verified, violated, unknown, impossible/)
    expect(v.issues.find(i => i.path === '[0].evidence')).toBeDefined()
  })

  it('requires evidence to be present (even if empty array) and statement non-empty', () => {
    const v = validatePreconditions([{ id: 'R1', statement: '', status: 'verified' }])
    expect(v.ok).toBe(false)
    expect(v.issues.map(i => i.path)).toEqual(expect.arrayContaining(['[0].statement', '[0].evidence']))
  })
})

describe('validateRootCauses', () => {
  it('accepts a well-formed array with a category outside the suggested examples list (open string)', () => {
    const v = validateRootCauses([{
      id: 'RC1', description: 'missing bounds check', category: 'a_totally_custom_category', evidence: ['patch hunk'],
    }])
    expect(v.ok).toBe(true)
  })

  it('rejects a bad id pattern and missing required fields', () => {
    const v = validateRootCauses([{ id: 'RC-x', description: '', category: '', evidence: [] }])
    expect(v.ok).toBe(false)
    expect(v.issues.find(i => i.path === '[0].id')!.message).toMatch(/\^RC\[0-9\]\+\$/)
    expect(v.issues.map(i => i.path)).toEqual(expect.arrayContaining(['[0].description', '[0].category']))
  })

  it('rejects non-string-array related_precondition_ids', () => {
    const v = validateRootCauses([{
      id: 'RC1', description: 'd', category: 'buffer_overflow', evidence: [], related_precondition_ids: [1],
    }])
    expect(v.ok).toBe(false)
    expect(v.issues[0]!.path).toBe('[0].related_precondition_ids')
  })
})

describe('validateTriggerPlans', () => {
  it('accepts a well-formed array; id carries no fixed pattern unlike the other three blocks', () => {
    const v = validateTriggerPlans([{
      id: 'lowest-cost-route', description: 'd', route_description: 'r', complexity: 3, status: 'pending',
    }])
    expect(v.ok).toBe(true)
  })

  it('rejects complexity out of the 1-10 range and a bad status', () => {
    const low = validateTriggerPlans([{ id: 'p1', description: 'd', route_description: 'r', complexity: 0, status: 'pending' }])
    expect(low.ok).toBe(false)
    expect(low.issues[0]!.path).toBe('[0].complexity')
    const high = validateTriggerPlans([{ id: 'p1', description: 'd', route_description: 'r', complexity: 11, status: 'active' }])
    expect(high.ok).toBe(false)
    expect(high.issues.map(i => i.path)).toEqual(expect.arrayContaining(['[0].complexity', '[0].status']))
  })
})

// The incident this whole module exists to prevent: a fuzz plan pinning a decimal value for a
// parameter declared `int_range`, outside its declared bounds.
const READELF_SPACE: ParameterSpace = {
  entry_addr: { type: 'int_range', min: 0, max: 0xffffffff },
  section_count: { type: 'int_range', min: 1, max: 64 },
  flavor: { type: 'categorical', values: ['elf32', 'elf64'] },
  corrupt: { type: 'bool' },
  jitter: { type: 'float_range', min: 0, max: 1 },
}

describe('validateFuzzPlan', () => {
  it('accepts a well-formed plan whose next_batch_plan pins are all in-domain', () => {
    const v = validateFuzzPlan({
      trigger_plan_id: 'lowest-cost-route',
      parameter_space: READELF_SPACE,
      next_batch_plan: [
        { plan_description: 'minimal valid header', entry_addr: 4096, flavor: 'elf64', corrupt: false, jitter: 0.5 },
      ],
      breakpoints: [{ location: 'readelf.c:1234', hit_limit: 5 }],
    }, READELF_SPACE)
    expect(v.ok).toBe(true)
    expect(v.issues).toEqual([])
  })

  it('THE INCIDENT: rejects a decimal entry_addr pinned outside its declared int_range domain', () => {
    const v = validateFuzzPlan({
      parameter_space: READELF_SPACE,
      next_batch_plan: [{ plan_description: 'boundary probe', entry_addr: 4294967296.5 }],
    }, READELF_SPACE)
    expect(v.ok).toBe(false)
    const issue = v.issues.find(i => i.path === 'next_batch_plan[0].entry_addr')
    expect(issue).toBeDefined()
    expect(issue!.message).toMatch(/must be an integer/)
  })

  it('rejects an int_range pin that is a valid integer but outside [min, max]', () => {
    const v = validateFuzzPlan({
      parameter_space: READELF_SPACE,
      next_batch_plan: [{ plan_description: 'out of range', section_count: 999 }],
    }, READELF_SPACE)
    expect(v.ok).toBe(false)
    expect(v.issues[0]!.path).toBe('next_batch_plan[0].section_count')
    expect(v.issues[0]!.message).toMatch(/within \[1, 64\]/)
  })

  it('rejects a pin whose key is not declared in parameter_space', () => {
    const v = validateFuzzPlan({
      parameter_space: READELF_SPACE,
      next_batch_plan: [{ plan_description: 'typo', entyr_addr: 10 }],
    }, READELF_SPACE)
    expect(v.ok).toBe(false)
    expect(v.issues[0]!.path).toBe('next_batch_plan[0].entyr_addr')
    expect(v.issues[0]!.message).toMatch(/no such parameter/)
  })

  it('rejects a categorical pin outside its declared values and a non-boolean bool pin', () => {
    const v = validateFuzzPlan({
      parameter_space: READELF_SPACE,
      next_batch_plan: [{ plan_description: 'x', flavor: 'elf16', corrupt: 'yes' }],
    }, READELF_SPACE)
    expect(v.ok).toBe(false)
    expect(v.issues.find(i => i.path === 'next_batch_plan[0].flavor')!.message).toMatch(/must be one of/)
    expect(v.issues.find(i => i.path === 'next_batch_plan[0].corrupt')!.message).toMatch(/must be a boolean/)
  })

  it('rejects a float_range pin outside its bounds', () => {
    const v = validateFuzzPlan({
      parameter_space: READELF_SPACE,
      next_batch_plan: [{ plan_description: 'x', jitter: 1.5 }],
    }, READELF_SPACE)
    expect(v.ok).toBe(false)
    expect(v.issues[0]!.path).toBe('next_batch_plan[0].jitter')
  })

  it('rejects a breakpoint location that is not a bare file:line', () => {
    const v = validateFuzzPlan({
      parameter_space: READELF_SPACE,
      breakpoints: [{ location: 'readelf.c' }],
    }, READELF_SPACE)
    expect(v.ok).toBe(false)
    expect(v.issues[0]!.path).toBe('breakpoints[0].location')
  })

  it('rejects a malformed parameter_space entry (bad type, missing bounds, unknown field)', () => {
    const v = validateFuzzPlan({
      parameter_space: { bad: { type: 'not_a_type' }, missing_bounds: { type: 'int_range', min: 0 }, extra: { type: 'bool', foo: 1 } },
    }, {})
    expect(v.ok).toBe(false)
    expect(v.issues.some(i => i.path === 'parameter_space.bad.type')).toBe(true)
    expect(v.issues.some(i => i.path === 'parameter_space.missing_bounds.max')).toBe(true)
    expect(v.issues.some(i => i.path === 'parameter_space.extra.foo')).toBe(true)
  })

  it('rejects an unknown top-level field and requires parameter_space', () => {
    const v = validateFuzzPlan({ bogus: 1 }, {})
    expect(v.ok).toBe(false)
    expect(v.issues.map(i => i.path)).toEqual(expect.arrayContaining(['bogus', 'parameter_space']))
  })

  it('validates a nested segments parameter space recursively', () => {
    const value = {
      parameter_space: {
        chunks: {
          type: 'segments',
          count_range: { min: 1, max: 4 },
          segment_params: { len: { type: 'int_range', min: 1, max: 10 }, kind: { type: 'not_a_type' } },
        },
      },
    }
    const v = validateFuzzPlan(value, {})
    expect(v.ok).toBe(false)
    expect(v.issues.some(i => i.path === 'parameter_space.chunks.segment_params.kind.type')).toBe(true)
  })

  it('accepts (does not domain-check) a pin naming a base_seed/segments parameter — not a single scalar', () => {
    const space: ParameterSpace = { ...READELF_SPACE, seed: { type: 'base_seed', seed_file_path: '/seeds/a.bin' } }
    const v = validateFuzzPlan({
      parameter_space: space,
      next_batch_plan: [{ plan_description: 'x', seed: 'whatever' }],
    }, space)
    expect(v.ok).toBe(true)
  })
})

describe('checkSafeUpdate (RULE_SAFE_UPDATE)', () => {
  it('allows revising an existing entry in place and appending a new one', () => {
    const current = [{ id: 'R1', status: 'unknown' }, { id: 'R2', status: 'unknown' }]
    const next = [{ id: 'R1', status: 'verified' }, { id: 'R2', status: 'unknown' }, { id: 'R3', status: 'unknown' }]
    const v = checkSafeUpdate('preconditions', current, next)
    expect(v.ok).toBe(true)
    expect(v.issues).toEqual([])
  })

  it('rejects a write that drops an existing id, even when the array length is unchanged', () => {
    // The original CCS'26 RULE_SAFE_UPDATE only compared array length; a same-length write that
    // silently swaps one entry for another would have slipped through it. This port catches that.
    const current = [{ id: 'RC1' }, { id: 'RC2' }]
    const next = [{ id: 'RC1' }, { id: 'RC3' }]
    const v = checkSafeUpdate('root_causes', current, next)
    expect(v.ok).toBe(false)
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]!.path).toBe('RC2')
    expect(v.issues[0]!.message).toMatch(/RULE_SAFE_UPDATE/)
    expect(v.issues[0]!.message).toMatch(/root_causes/)
  })
})
