/**
 * The one message `pbfuzz_fuzz` returns when it will not start a fuzz run.
 *
 * Every rejection costs the model a resubmission, and a resubmission used to mean re-emitting the
 * whole generator. So this names every problem found, in one message, with the evidence needed to
 * fix each — not just the first. In a recorded session three problems each arrived in a separate
 * call, and the one that mattered most (a 56-byte input for a target that reads 64) was never
 * stated at all: the engine had the size, and only the stderr tail was passed on.
 *
 * Pure: formatting only, so it can be tested without an engine.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/fuzz-rejection
 */

/** What the real-target preflight saw for one batch entry (`server.py` `_preflight_reach`). */
export interface PreflightReach {
  ranTarget?: boolean
  reached?: boolean
  triggered?: boolean
  timedOut?: boolean
  exitCode?: number | null
  durationMs?: number
  stderrTail?: string
  error?: string
  diagnosis?: string
}

/** One `generator.validate` sample. */
export interface ValidationSample {
  source: string
  params?: Record<string, unknown>
  size?: number
  /** First 32 bytes, hex. */
  preview?: string
  error?: string
  diagnosis?: string
  reach?: PreflightReach
}

/** The `generator.validate` response, as far as this module reads it. */
export interface ValidationResult {
  ok: boolean
  /** Signature mismatches, read from source before anything ran. */
  issues?: string[]
  samples?: ValidationSample[]
}

/** Everything `pbfuzz_fuzz` found wrong, from every layer. */
export interface FuzzRejectionInput {
  /** The host's own fuzz-plan validation (`validateFuzzPlan`). */
  planIssues: { path: string; message: string }[]
  /** `generator.validate`'s result, when the call got that far. */
  validation?: ValidationResult
  /** The call itself failed (e.g. the generator does not parse). */
  engineError?: string
  /** Where the generator source is saved — what the model edits instead of resending. */
  generatorPath: string
}

const MAX_PARAMS = 160
const MAX_STDERR = 300

/** `{"a":1,"b":2}` on one line, cut short. */
function compact(params: Record<string, unknown> | undefined): string {
  if (params === undefined) return ''
  const text = JSON.stringify(params)
  return text.length > MAX_PARAMS ? `${text.slice(0, MAX_PARAMS)}…}` : text
}

/** `next_batch_plan[0]`, or `next_batch_plan[0], next_batch_plan[1] (2 entries, same failure)`. */
function sources(group: ValidationSample[]): string {
  const names = group.map(s => s.source)
  return names.length === 1 ? names[0]! : `${names.join(', ')} (${names.length} entries, same failure)`
}

/**
 * Generator failures, grouped: the same exception from every batch entry is one bullet with one
 * traceback, not one copy per entry.
 */
function generatorLines(samples: ValidationSample[]): string[] {
  const groups = new Map<string, ValidationSample[]>()
  for (const s of samples) {
    if (s.error === undefined) continue
    const key = JSON.stringify([s.error, s.diagnosis ?? ''])
    groups.set(key, [...groups.get(key) ?? [], s])
  }
  return [...groups.values()].map((group) => {
    const { error, diagnosis } = group[0]!
    // The diagnosis repeats the error on its first line; keep only what it adds (the traceback).
    const extra = diagnosis?.split('\n').slice(1).join('\n').trim()
    const traceback = extra !== undefined && extra !== '' ? `\n${extra.split('\n').map(l => `      ${l}`).join('\n')}` : ''
    return `  - ${sources(group)}: ${error}${traceback}`
  })
}

/** What one preflighted entry actually fed the target, and what the target did with it. */
function preflightLine(s: ValidationSample): string {
  const r = s.reach!
  if (r.ranTarget === false) return `  - ${s.source}: the target could not be run: ${r.error ?? ''}${r.diagnosis !== undefined ? ` — ${r.diagnosis}` : ''}`
  const bytes = s.size !== undefined
    ? `${s.size} bytes${s.preview !== undefined && s.preview !== '' ? ` (${s.preview}${s.size > 32 ? '…' : ''})` : ''}`
    : 'input'
  const outcome = r.timedOut === true ? 'timed out' : `exit ${r.exitCode ?? '?'}`
  const stderr = r.stderrTail?.trim()
  const tail = stderr !== undefined && stderr !== '' ? `; stderr: ${stderr.length > MAX_STDERR ? `…${stderr.slice(-MAX_STDERR)}` : stderr}` : ''
  const took = r.durationMs !== undefined ? ` in ${r.durationMs} ms` : ''
  return `  - ${s.source} ${compact(s.params)} → ${bytes} → ${outcome}${took}${r.reached === true ? ', reached' : ''}${tail}`
}

/**
 * The rejection message, or `undefined` when there is nothing to reject.
 * @param input - every layer's findings.
 * @returns one message naming every problem, ending with how to resubmit cheaply.
 */
export function fuzzRejection(input: FuzzRejectionInput): string | undefined {
  const sections: string[] = []
  if (input.planIssues.length > 0) {
    sections.push(`fuzz plan:\n${input.planIssues.map(i => `  - ${i.path}: ${i.message}`).join('\n')}`)
  }
  const samples = input.validation?.samples ?? []
  const generator = [
    ...input.engineError !== undefined ? [`  - ${input.engineError}`] : [],
    ...(input.validation?.issues ?? []).map(i => `  - ${i}`),
    ...generatorLines(samples),
  ]
  if (generator.length > 0) sections.push(`generator:\n${generator.join('\n')}`)

  const preflighted = samples.filter(s => s.reach !== undefined)
  const couldNotRun = preflighted.some(s => s.reach!.ranTarget === false)
  const noneReached = preflighted.length > 0 && !preflighted.some(s => s.reach!.reached === true)
  if (couldNotRun || noneReached) {
    const heading = couldNotRun
      ? 'real-target preflight:'
      : 'real-target preflight — no entry reached the target (compare the input size and layout with what the target reads, then the entry address and run_cmd):'
    sections.push(`${heading}\n${preflighted.map(preflightLine).join('\n')}`)
  }

  if (sections.length === 0 && input.validation?.ok !== false) return undefined
  if (sections.length === 0) sections.push('generator:\n  - validation failed without a reported cause')
  return [
    'pbfuzz_fuzz: nothing was started. Every problem found in this call:',
    '',
    sections.join('\n\n'),
    '',
    `The generator is saved at ${input.generatorPath}. Fix it there with \`edit\` and call pbfuzz_fuzz again with \`generator_path\` instead of resending the code.`,
  ].join('\n')
}
