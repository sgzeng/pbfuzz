/** `core/run-digest.ts`: the lines REFLECT needs, read from what the engine left on disk. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PbfuzzCampaign } from '../src/core/contracts.ts'
import { latestIterationsPath, readIterations, reproduceCommand, runDigest } from '../src/core/run-digest.ts'

const campaign = (channel: 'file' | 'stdin'): PbfuzzCampaign => ({
  entry: { kind: 'executable', run_cmd: channel === 'file' ? './t -a @@' : './t', input_channel: channel },
} as never)

describe('run digest', () => {
  it('a round that reached but never triggered points at the best input, names unbound breakpoints, and surfaces engine errors', () => {
    const text = runDigest({
      campaign: campaign('file'),
      metrics: { last_session: { iterations: 40, reached: 12, triggered: 0, stopped_by: 'completed', best_reaching_input: '/r/best' } } as never,
      iterations: [
        { type: 'iter_result', stage: 1, reached: 1, triggered: 0, trace: { breakpoints: [{ location: 'a.c:3', hitTimes: 2, resolved: true }, { location: 'a.c:9', resolved: false }] } },
        { type: 'iter_result', stage: 2, reached: 0, triggered: 0 },
        { type: 'error', phase: 'generate', message: 'boom', diagnosis: 'bad kwarg' },
      ],
      iterationsPath: '/r/runs/session-0001/iterations.jsonl',
    })
    expect(text).toContain('40 iterations (stage 1: 1, stage 2: 1), 12 reached, 0 triggered')
    expect(text).toContain('best reaching input (nothing triggered): /r/best')
    expect(text).toContain('breakpoints hit: a.c:3 ×2')
    expect(text).toMatch(/never bound .*a\.c:9/)
    expect(text).toContain('1 engine error(s); first: generate: boom — bad kwarg')
    expect(text).not.toContain('"success"')
  })

  it('picks the newest run and survives a torn last line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pbfuzz-digest-'))
    for (const n of ['session-0001', 'session-0002']) mkdirSync(join(dir, 'runs', n), { recursive: true })
    const path = latestIterationsPath(dir)!
    expect(path).toBe(join(dir, 'runs', 'session-0002', 'iterations.jsonl'))
    writeFileSync(path, '{"iter": 1, "triggered": 1}\n{"iter": 2, "trig')
    expect(readIterations(path)).toEqual([{ iter: 1, triggered: 1 }])
    expect(latestIterationsPath(join(dir, 'nope'))).toBeUndefined()
  })

  it('reproduces a file-channel PoC by substitution and a stdin one by redirection', () => {
    expect(reproduceCommand(campaign('file'), '/p')).toBe('./t -a /p')
    expect(reproduceCommand(campaign('stdin'), '/p')).toBe('./t < /p')
  })
})
