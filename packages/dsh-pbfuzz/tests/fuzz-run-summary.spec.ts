/**
 * F20-surface: a `fuzz.run` result that stopped on a non-fatal mid-run error (`stoppedBy ===
 * "error"`) now carries `errorPhase`/`errorMessage`/`errorDiagnosis` in `summary` (F20-engine, see
 * `engine/pbfuzz_engine/fuzzer.py`, `contracts/engine-rpc.schema.json:123-125`). Before this fix,
 * `registerTools`'s `pbfuzz_fuzz` job handler built its tool-visible `detail` string from a type
 * cast that only named `totalIterations`/`reachedCount`/`triggeredCount`/`stoppedBy`, so the
 * diagnosis was silently dropped from the one-line status a caller sees without reading the full
 * `output` JSON.
 */
import { describe, expect, it } from 'vitest'
import { summarizeFuzzRunResult } from '../src/tools.ts'

describe('summarizeFuzzRunResult surfaces the mid-run error diagnosis (F20-surface)', () => {
  it('folds errorMessage/errorDiagnosis into detail when stoppedBy is "error"', () => {
    const result = {
      summary: {
        totalIterations: 12,
        reachedCount: 3,
        triggeredCount: 0,
        errorCount: 1,
        elapsedSec: 1.5,
        stoppedBy: 'error',
        errorPhase: 'generator_call',
        errorMessage: "generate() raised KeyError: 'n'",
        errorDiagnosis: 'the generator function referenced a parameter not present in this sample.',
      },
      metricsPath: '/tmp/metrics.json',
      iterationsPath: '/tmp/iterations.jsonl',
      bestReachingInputs: [],
      stage1: { entries: 4, tracedEntries: 4, observations: 0 },
    }

    const summarized = summarizeFuzzRunResult(result)

    expect(summarized.status).toBe('completed')
    expect(summarized.detail).toContain("generate() raised KeyError: 'n'")
    expect(summarized.detail).toContain('the generator function referenced a parameter not present in this sample.')
    // The full RPC result (including the raw summary fields) must still be in `output`.
    const parsedOutput = JSON.parse(summarized.output) as { summary: { errorPhase?: string } }
    expect(parsedOutput.summary.errorPhase).toBe('generator_call')
  })

  it('leaves detail as the plain counts line when the run completed normally', () => {
    const result = {
      summary: {
        totalIterations: 40,
        reachedCount: 10,
        triggeredCount: 1,
        errorCount: 0,
        elapsedSec: 3.2,
        stoppedBy: 'trigger',
      },
      metricsPath: '/tmp/metrics.json',
      iterationsPath: '/tmp/iterations.jsonl',
      bestReachingInputs: [],
      stage1: { entries: 4, tracedEntries: 4, observations: 0 },
    }

    const summarized = summarizeFuzzRunResult(result)

    expect(summarized.detail).toBe('40 iterations, 10 reached, 1 triggered (trigger)')
  })
})
