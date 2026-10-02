/**
 * D5: `offerRecovery` (recovery.ts) must never touch `process.exitCode` — that mutates the whole
 * host process, poisoning every later session in a long-lived `dsh web` host, and this function
 * runs from inside ordinary tool calls, not only a genuine one-shot CLI entry point. The ONE place
 * a non-zero exit is legitimate is `command.ts`'s `/pbfuzz run` handler (tested in
 * `command.spec.ts`), which sets it independently from `RunOutcome`.
 */
import { describe, expect, it } from 'vitest'
import { offerRecovery, type QuestionAsker } from '../src/recovery.ts'
import type { Diagnosis } from '../src/core/remedies.ts'

const diagnosis: Diagnosis = {
  step: 'self-check: oracle',
  diagnosis: 'no canary found in the binary',
  evidence: ['nm output: no PBFUZZ_ symbol'],
  remedies: [{ id: 'retry', label: 'Fix and re-run this step', effect: 'retry' }],
}

describe('offerRecovery (D5)', () => {
  it.each([
    ['headless run', true],
    ['no asker composed', false],
  ])('%s: returns kind "headless" with the log block, and never sets process.exitCode', async (_label, headless) => {
    const before = process.exitCode
    const choice = await offerRecovery(diagnosis, undefined, { headless })
    expect(choice.kind).toBe('headless')
    if (choice.kind === 'headless') expect(choice.log).toContain('self-check: oracle failed')
    expect(process.exitCode).toBe(before)
  })

  it('interactive: asks the user and never touches process.exitCode either way', async () => {
    const before = process.exitCode
    const asker: QuestionAsker = {
      ask: async request => ({ answers: [{ id: request.questions[0]!.id, selected: ['Fix and re-run this step'] }] }),
    }
    const choice = await offerRecovery(diagnosis, asker, { headless: false })
    expect(choice.kind).toBe('remedy')
    expect(process.exitCode).toBe(before)
  })
})
