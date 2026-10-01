/**
 * The failure-recovery glue: ask the user to pick a remedy (interactive), or log the diagnosis
 * and options and signal a non-zero exit (headless).
 *
 * @module @pbfuzz/dsh-pbfuzz/recovery
 */

import type { Remedy } from './core/contracts.ts'
import { diagnosisQuestion, formatHeadlessDiagnosis, MANUAL, remedyForLabel, RETRY, type Diagnosis } from './core/remedies.ts'

/** The subset of `ctx.userQuestions` recovery needs. */
export interface QuestionAsker {
  ask(request: {
    questions: {
      id: string
      question: string
      header?: string
      detail?: string
      options?: { label: string; description?: string }[]
    }[]
    agent?: unknown
    signal?: AbortSignal
  }): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>
}

/** What the user chose. */
export type RecoveryChoice =
  | { kind: 'remedy'; remedy: Remedy }
  | { kind: 'custom'; text: string }
  | { kind: 'headless'; log: string }

/**
 * Offer a diagnosed failure to the user.
 *
 * D5: never touches `process.exitCode` — a plugin tool call mutating the host process's exit code
 * poisons every later session in a long-lived `dsh web` host, and this function runs from inside
 * ordinary tool calls (`pbfuzz_campaign run`), not only from a real
 * one-shot CLI invocation. The failure is signaled purely through the returned
 * {@link RecoveryChoice} (`kind: 'headless'`); the ONE place a non-zero exit is legitimate is
 * `command.ts`'s `/pbfuzz run` handler, a genuine headless one-shot entry point, which already sets
 * it independently from the `RunOutcome` this eventually feeds into.
 * @param diagnosis - the diagnosed failure with its remedies.
 * @param asker - `ctx.userQuestions`, or undefined when no UI is composed.
 * @param options - agent, signal, and whether the run is headless.
 * @returns the user's choice, or the headless log block (the caller decides what "failure" means for it).
 */
export async function offerRecovery(
  diagnosis: Diagnosis,
  asker: QuestionAsker | undefined,
  options: { agent?: unknown; signal?: AbortSignal; headless: boolean },
): Promise<RecoveryChoice> {
  if (options.headless || asker === undefined) {
    const log = formatHeadlessDiagnosis(diagnosis)
    return { kind: 'headless', log }
  }
  const id = `recover-${diagnosis.step.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
  const answer = await asker.ask({
    questions: [diagnosisQuestion(diagnosis, id)],
    ...options.agent !== undefined ? { agent: options.agent } : {},
    ...options.signal !== undefined ? { signal: options.signal } : {},
  })
  const item = answer.answers.find(a => a.id === id)
  if (item?.custom !== undefined && item.custom.trim() !== '') return { kind: 'custom', text: item.custom }
  const remedy = item?.selected[0] === undefined ? undefined : remedyForLabel(diagnosis, item.selected[0])
  return remedy === undefined ? { kind: 'custom', text: '' } : { kind: 'remedy', remedy }
}

/** The fields of an engine RPC failure recovery reads (`EngineRpcError` satisfies it). */
export interface EngineFailure {
  message: string
  code: number
  diagnosis: string | undefined
  remedies: Remedy[]
}

/**
 * An engine failure as a {@link Diagnosis}: the engine's own diagnosis and remedies
 * (`error.data`), never just the message.
 * @param step - the step as named to the user.
 * @param error - the engine failure.
 * @returns the diagnosis.
 */
export function engineDiagnosis(step: string, error: EngineFailure): Diagnosis {
  return {
    step,
    diagnosis: error.diagnosis ?? error.message,
    evidence: [`engine error ${error.code}: ${error.message}`],
    remedies: error.remedies.length > 0 ? error.remedies : [RETRY, MANUAL],
  }
}

/**
 * Surface an engine failure raised inside a tool call. Interactive: the engine's remedies are
 * offered through `ask_user_question` first, and the returned error tells the model what the
 * user chose. Headless or without a UI: the error carries the diagnosis and every option, and
 * — unlike {@link offerRecovery} — does not touch the exit code, because one failed tool call
 * does not end an unattended run.
 * @param step - the step as named to the user.
 * @param error - the engine failure.
 * @param asker - `ctx.userQuestions`, or undefined.
 * @param options - agent, signal, and whether the run is headless.
 * @returns the error for the tool to throw.
 */
export async function engineToolError(
  step: string,
  error: EngineFailure,
  asker: QuestionAsker | undefined,
  options: { agent?: unknown; signal?: AbortSignal; headless: boolean },
): Promise<Error> {
  const diagnosis = engineDiagnosis(step, error)
  if (options.headless || asker === undefined) return new Error(formatHeadlessDiagnosis(diagnosis))
  const choice = await offerRecovery(diagnosis, asker, { ...options, headless: false })
  const chose = choice.kind === 'remedy'
    ? `${choice.remedy.label}${choice.remedy.detail !== undefined ? ` (${choice.remedy.detail})` : ''} [effect: ${choice.remedy.effect ?? 'manual'}]`
    : choice.kind === 'custom' ? `custom instruction: ${choice.text === '' ? '(none given)' : choice.text}` : '(no choice)'
  return new Error(`${step} failed: ${diagnosis.diagnosis}\nThe user chose: ${chose}. Act on that choice before retrying.`)
}
