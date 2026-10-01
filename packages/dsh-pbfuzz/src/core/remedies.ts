/**
 * Failure recovery as a first-class step (PLAN §2.6, §2.7).
 *
 * Whenever a step fails — environment bring-up, the canary rebuild, or any PIER phase — the agent must not silently retry or give up. It diagnoses the root cause from the
 * REAL output and offers the user a small set of concrete options. This module owns the
 * diagnosis→options mapping and the two presentation modes: an interactive question, and the
 * headless log line that precedes a non-zero exit.
 *
 * Everything here is pure so the catalogue can be unit-tested without a session.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/remedies
 */

import type { Remedy, SelfcheckItemName } from './contracts.ts'

/** A diagnosed failure plus the options the user may pick from. */
export interface Diagnosis {
  /** Which step failed, as it is named to the user. */
  step: string
  /** The root cause, read out of the actual output rather than guessed. */
  diagnosis: string
  /** The real output the diagnosis was drawn from, trimmed for display. */
  evidence: string[]
  remedies: Remedy[]
}

/** The remedy every failed step offers: fix the underlying problem and run the step again. */
export const RETRY: Remedy = {
  id: 'retry',
  label: 'Fix and re-run this step',
  detail: 'Apply the fix described above, then run the step again.',
  effect: 'retry',
}

/** The remedy that keeps the campaign runnable by degrading instead of failing. */
export function disableTool(tool: SelfcheckItemName, why: string): Remedy {
  return {
    id: `disable_${tool}`,
    label: `Turn ${TOOL_LABELS[tool]} off for this campaign`,
    detail: `${why} The campaign records the reason and the run continues without it.`,
    effect: 'disable_tool',
  }
}

/** User-facing names for the auxiliary tools. */
const TOOL_LABELS: Record<SelfcheckItemName, string> = {
  engine: 'the Python engine',
  oracle: 'the oracle / canaries',
  static_analysis: 'static analysis',
  corpus: 'corpus analysis',
  tracer: 'breakpoint tracing',
  deviation: 'deviation detection',
}

/** Offer a campaign edit, naming the exact field so the user is not left guessing. */
export function editCampaign(field: string, detail: string): Remedy {
  return {
    id: `edit_${field.replace(/[^a-z0-9]+/gi, '_')}`,
    label: `Correct \`${field}\` in the campaign`,
    detail,
    effect: 'edit_campaign',
  }
}

/** Offer to run a specific command, quoted verbatim so the user can also run it themselves. */
export function runCommand(id: string, label: string, command: string): Remedy {
  return { id, label, detail: `Runs: ${command}`, effect: 'run_command' }
}

/** The catch-all for a cause the agent could not classify; the user supplies the fix. */
export const MANUAL: Remedy = {
  id: 'manual',
  label: 'Let me describe the fix',
  detail: 'Paste a working command, a corrected path, or an explanation of what to change.',
  effect: 'manual',
}

/**
 * The kanalyzer-not-installed diagnosis: the most common static-analysis failure, and the one
 * with the most actionable fix. Raised when a `pbfuzz_callgraph` query cannot prepare.
 * @param reason - what the presence check actually reported.
 * @returns the diagnosis with the Build-button remedy first.
 */
export function kanalyzerMissingDiagnosis(reason: string): Diagnosis {
  return {
    step: 'static analysis',
    diagnosis: `The kanalyzer plugin is not installed or not built: ${reason}`,
    evidence: [reason],
    remedies: [
      {
        id: 'build_kanalyzer',
        label: 'Build kanalyzer now (Settings → Plugins → Kanalyzer → Build)',
        detail: 'Opens a visible build session that clones, installs dependencies and builds KAMain.',
        effect: 'run_command',
      },
      disableTool('static_analysis', 'Deviation detection degrades to target-only without it.'),
      MANUAL,
    ],
  }
}

/**
 * A target line that carries no instruction — KAMain finds nothing and exits 0, so this must be
 * diagnosed explicitly rather than read as "no bug here".
 * @param location - the requested `file:line`.
 * @param nearbyCandidates - instruction-bearing lines the provider suggested instead.
 * @returns the diagnosis whose remedies name each candidate line.
 */
export function unresolvedTargetDiagnosis(location: string, nearbyCandidates: string[]): Diagnosis {
  return {
    step: 'static analysis',
    diagnosis: `The target line ${location} carries no instruction, so the analyser resolved no basic block for it.`,
    evidence: [`requested target: ${location}`, `nearby instruction-bearing lines: ${nearbyCandidates.join(', ') || 'none found'}`],
    remedies: [
      ...nearbyCandidates.slice(0, 3).map(candidate => ({
        id: `use_${candidate.replace(/[^a-z0-9]+/gi, '_')}`,
        label: `Use ${candidate} instead`,
        detail: 'Rewrites `bug.targets[].location` in the campaign and re-runs the check.',
        effect: 'edit_campaign' as const,
      })),
      editCampaign('bug.targets[].location', 'Point at a line that carries an instruction.'),
      disableTool('static_analysis', 'The run continues without call-graph guidance.'),
      MANUAL,
    ],
  }
}

/**
 * Render a diagnosis for a headless run: PLAN §2.6 requires that a failed step records the
 * diagnosis AND the candidate options to the log, then exits non-zero instead of prompting.
 * @param diagnosis - the diagnosed failure.
 * @returns the multi-line log block.
 */
export function formatHeadlessDiagnosis(diagnosis: Diagnosis): string {
  const lines = [
    `pbfuzz: ${diagnosis.step} failed`,
    `  diagnosis: ${diagnosis.diagnosis}`,
    ...diagnosis.evidence.map(line => `  evidence: ${line}`),
    '  options (headless: none applied automatically):',
    ...diagnosis.remedies.map(remedy => `    - [${remedy.id}] ${remedy.label}${remedy.detail === undefined ? '' : ` — ${remedy.detail}`}`),
  ]
  return lines.join('\n')
}

/**
 * Turn a diagnosis into one `ask_user_question` item. The detail carries the evidence, because a
 * user choosing between options needs to see the output the diagnosis came from.
 * @param diagnosis - the diagnosed failure.
 * @param id - stable question id, echoed in the answer.
 * @returns the question item shape the user-questions seam accepts.
 */
export function diagnosisQuestion(diagnosis: Diagnosis, id: string): {
  id: string
  question: string
  header: string
  detail: string
  options: { label: string; description?: string }[]
} {
  return {
    id,
    question: `${diagnosis.step} failed. How should pbfuzz proceed?`,
    header: 'Recover',
    detail: [
      `**Diagnosis.** ${diagnosis.diagnosis}`,
      '',
      '**What was actually observed:**',
      ...diagnosis.evidence.map(line => `- ${line}`),
    ].join('\n'),
    options: diagnosis.remedies.map(remedy => ({
      label: remedy.label,
      ...remedy.detail !== undefined ? { description: remedy.detail } : {},
    })),
  }
}

/**
 * Resolve the option label a user picked back to its remedy.
 * @param diagnosis - the diagnosis that was asked.
 * @param label - the selected option label.
 * @returns the matching remedy, or undefined when the user typed a free-form answer instead.
 */
export function remedyForLabel(diagnosis: Diagnosis, label: string): Remedy | undefined {
  return diagnosis.remedies.find(remedy => remedy.label === label)
}
