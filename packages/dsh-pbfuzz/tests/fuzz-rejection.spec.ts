/**
 * `core/fuzz-rejection.ts`: the one message `pbfuzz_fuzz` rejects with. Every problem, once, with
 * the evidence to fix it — because each rejection costs the model a resubmission.
 */
import { describe, expect, it } from 'vitest'
import { fuzzRejection } from '../src/core/fuzz-rejection.ts'

const TRACEBACK = [
  '`generate` in /g.py failed: TypeError: generate() got an unexpected keyword argument \'seed\'',
  'Traceback (most recent call last):',
  '  File "_generator_child.py", line 261, in worker_main',
  'TypeError: generate() got an unexpected keyword argument \'seed\'',
].join('\n')

describe('fuzzRejection', () => {
  it('is undefined when there is nothing to reject', () => {
    expect(fuzzRejection({ planIssues: [], validation: { ok: true, samples: [] }, generatorPath: '/g.py' })).toBeUndefined()
  })

  it('states one identical failure once, not once per batch entry (it used to repeat the traceback four times)', () => {
    const error = "TypeError: generate() got an unexpected keyword argument 'seed'"
    const text = fuzzRejection({
      planIssues: [],
      validation: { ok: false, samples: [0, 1, 2, 3].map(i => ({ source: `next_batch_plan[${i}]`, error, diagnosis: TRACEBACK })) },
      generatorPath: '/g.py',
    })!
    expect(text.match(/Traceback/g)).toHaveLength(1)
    expect(text).toContain('next_batch_plan[0], next_batch_plan[1], next_batch_plan[2], next_batch_plan[3] (4 entries, same failure)')
  })

  it('names every layer in one message: the plan, the signature, the engine error', () => {
    const text = fuzzRejection({
      planIssues: [{ path: 'next_batch_plan[6].entry_point', message: 'must be one of [4194304], got 4096' }],
      validation: { ok: false, issues: ['`generate` cannot take e_ehsize, which the plan supplies'], samples: [] },
      generatorPath: '/g.py',
    })!
    expect(text).toContain('next_batch_plan[6].entry_point: must be one of [4194304], got 4096')
    expect(text).toContain('cannot take e_ehsize')
    expect(text).toMatch(/saved at \/g\.py\..*generator_path/s)
  })

  it('reports an engine call that failed outright (e.g. a syntax error) alongside the plan issues', () => {
    const text = fuzzRejection({
      planIssues: [{ path: 'breakpoints[0].location', message: 'needs file:line' }],
      engineError: 'generator has a syntax error — /g.py:3:1: invalid syntax',
      generatorPath: '/g.py',
    })!
    expect(text).toContain('breakpoints[0].location')
    expect(text).toContain('/g.py:3:1: invalid syntax')
  })

  it('says nothing about the preflight when an entry did reach the target', () => {
    const text = fuzzRejection({
      planIssues: [{ path: 'x', message: 'y' }],
      validation: { ok: false, samples: [{ source: 'next_batch_plan[0]', size: 64, reach: { ranTarget: true, reached: true, exitCode: 0 } }] },
      generatorPath: '/g.py',
    })!
    expect(text).not.toContain('preflight')
  })
})
