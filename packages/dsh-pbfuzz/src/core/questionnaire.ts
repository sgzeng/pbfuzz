/**
 * The onboarding questionnaire (PLAN §2.6): ordered steps S1–S6, required/optional marking, skip
 * logic, and the conditional questions for auxiliary tools enabled in settings.
 *
 * Inference comes first: the agent fills `known` from what it found in the repo, and only the
 * gaps become questions. The interview policy decides what "gap" means.
 *
 * Every step also carries a {@link QuestionTier}: `S1_repo`/`S2_bug` are `first` (asked alone,
 * before any repo probing); everything else is `confirm` (folded into the plan-review panel
 * instead of a separate chat round). See {@link QuestionTier} for why.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/questionnaire
 */

import type { PbfuzzSettings } from './contracts.ts'

/** Stable question ids; S-steps first, then conditional ones. */
export type QuestionId =
  | 'S1_repo'
  | 'S2_bug'
  | 'S3_env'
  | 'S4_entry'
  | 'S5_target'
  | 'S6_output'
  | 'C_corpus_seeds'
  | 'C_static_inputs'
  | 'C_oracle_reuse'

/** What the agent has already answered or inferred. A value present here is not asked (under `when-missing`). */
export interface KnownAnswers {
  repo?: string
  bug?: string
  buildScript?: string
  runScript?: string
  entry?: string
  target?: string
  outputDir?: string
  seedsDir?: string
  /** Static-analysis inputs the agent could not infer (link output, lto libs, prebuilt). Non-empty → ask. */
  staticGaps?: string[]
  /** Existing reach/trigger markers the agent found (e.g. MAGMA_LOG). Present → ask about reuse. */
  preexistingMarkers?: string
}

/**
 * Which round a question belongs to. `first` is `S1_repo`/`S2_bug` only: they must be asked
 * alone, in their own `ask_user_question` call, before the agent does ANY repo probing — the fix
 * for a real incident where the agent built a working exploit input 460s before ever presenting
 * these two questions (it had inferred everything else first, per the old "infer everything, then
 * ask only the gaps" ordering, and S1/S2 got swept up with the rest). `confirm` is everything
 * else: it is no longer asked as a separate chat round at all — the agent infers it via repo
 * probing/build verification/target derivation and puts the inferred values straight into
 * `draft` with `source: 'inferred'|'agent_built'` and `evidence`, and the existing confirm
 * plan-review panel (Approve/Revise) is where the user actually sees and can correct it.
 */
export type QuestionTier = 'first' | 'confirm'

/** One question as presented. */
export interface QuestionSpec {
  id: QuestionId
  step: string
  required: boolean
  /** Question text, already prefixed with the [required]/[optional] marker. */
  question: string
  header: string
  detail?: string
  /** Campaign fields this answer fills. */
  fields: string[]
  /** See {@link QuestionTier}. */
  tier: QuestionTier
}

/** Why a step was not asked. */
export interface SkippedStep {
  id: QuestionId
  reason: string
}

/** Plan for one batch interview. */
export interface InterviewPlan {
  /** `S1_repo`/`S2_bug` only — ask these alone, before any repo probing. */
  first: QuestionSpec[]
  /** Everything else — fold into the confirm plan-review panel instead of a separate chat round. */
  confirm: QuestionSpec[]
  /** `first` followed by `confirm`, in `STEPS` order. Kept for callers that don't split by tier. */
  questions: QuestionSpec[]
  skipped: SkippedStep[]
  /** Required steps with no answer under `never` — a headless run must fail with these. */
  missingRequired: QuestionId[]
}

interface StepDef {
  id: QuestionId
  step: string
  header: string
  text: string
  detail?: string
  fields: string[]
  required: (known: KnownAnswers) => boolean
  answered: (known: KnownAnswers) => boolean
  /** Returns a reason when the step is skipped regardless of policy. */
  skip?: (known: KnownAnswers, settings: PbfuzzSettings) => string | undefined
  tier: QuestionTier
}

const STEPS: StepDef[] = [
  {
    id: 'S1_repo', step: 'S1', header: 'Repo', fields: ['id', 'target.repo', 'target.revision', 'target.language'],
    text: 'Target project repo path (absolute), plus an optional git revision and the campaign id and source language.',
    required: () => true, answered: k => k.repo !== undefined, tier: 'first',
  },
  {
    id: 'S2_bug', step: 'S2', header: 'Bug', fields: ['bug.kind', 'bug.source'],
    text: 'Bug information: a trigger condition, or a patch diff / CVE description / crash trace (paste text or give a path).',
    required: () => true, answered: k => k.bug !== undefined, tier: 'first',
  },
  {
    id: 'S3_env', step: 'S3', header: 'Environment', fields: ['build.cmd', 'build.dir', 'entry.run_cmd', 'entry.input_channel', 'tracer'],
    text: 'Environment build script and run script (or Dockerfile / build & run commands), plus which tracer to use (auto/gdb/lldb/pymon/jdb/off). If omitted, pbfuzz builds and verifies them itself and shows them back for confirmation.',
    detail: 'Supplying a run script tells pbfuzz what is being tested, so the entry question (S4) is skipped.',
    required: () => false, answered: k => k.buildScript !== undefined || k.runScript !== undefined, tier: 'confirm',
  },
  {
    id: 'S4_entry', step: 'S4', header: 'Entry', fields: ['entry.kind', 'entry.harness', 'entry.harness_function', 'entry.run_cmd', 'entry.input_channel', 'entry.cwd'],
    text: 'Program entry: an API (which existing harness file/function) or an executable (which binary)? Does input arrive by file (where `@@` goes) or stdin? Which working directory should it run from?',
    required: k => k.runScript === undefined, answered: k => k.entry !== undefined,
    skip: k => k.runScript !== undefined ? 'a run script was supplied in S3, which already defines the entry and input channel' : undefined,
    tier: 'confirm',
  },
  {
    id: 'S5_target', step: 'S5', header: 'Target', fields: ['bug.targets'],
    text: 'Target location `file:line`. If omitted, pbfuzz derives it from the bug information and asks you to confirm.',
    required: () => false, answered: k => k.target !== undefined, tier: 'confirm',
  },
  {
    id: 'S6_output', step: 'S6', header: 'Output', fields: ['output.dir'],
    text: 'pbfuzz output path. Defaults to `<repo>/.pbfuzz/<id>`.',
    required: () => false, answered: k => k.outputDir !== undefined, tier: 'confirm',
  },
  {
    id: 'C_corpus_seeds', step: 'corpus', header: 'Seeds', fields: ['analysis.corpus.seeds_dir'],
    text: 'Initial seed directory. With no seeds, corpus analysis is turned off for this campaign and the yaml notes it.',
    required: () => false, answered: k => k.seedsDir !== undefined,
    skip: (_k, s) => s.tools.corpusAnalysis ? undefined : 'corpus analysis is off in settings',
    tier: 'confirm',
  },
  {
    id: 'C_static_inputs', step: 'static', header: 'Static analysis', fields: ['analysis.static.program', 'analysis.static.lto_libs', 'analysis.static.prebuilt_dir'],
    text: 'Static analysis inputs pbfuzz could not infer: which link output to analyse, which static dependency libraries need an LTO build, and whether prebuilt results exist.',
    required: () => false, answered: k => (k.staticGaps ?? []).length === 0,
    skip: (_k, s) => s.tools.staticAnalysis === 'off' ? 'static analysis is off in settings' : undefined,
    tier: 'confirm',
  },
  {
    id: 'C_oracle_reuse', step: 'oracle', header: 'Oracle', fields: ['oracle.mode', 'oracle.reached_pattern', 'oracle.triggered_pattern'],
    text: 'Existing reach/trigger markers were found in the project. Reuse them (and which pattern), or insert pbfuzz canaries?',
    required: () => false, answered: k => k.preexistingMarkers === undefined, tier: 'confirm',
  },
]

/**
 * Plan the batch interview: ordered, marked, with skip logic applied.
 * @param known - what the agent already has.
 * @param settings - resolved settings (interview policy + enabled tools).
 * @returns questions to ask, steps skipped with reasons, and required gaps.
 */
export function planInterview(known: KnownAnswers, settings: PbfuzzSettings): InterviewPlan {
  const policy = settings.onboarding.interviewPolicy
  const questions: QuestionSpec[] = []
  const skipped: SkippedStep[] = []
  const missingRequired: QuestionId[] = []
  for (const step of STEPS) {
    const hardSkip = step.skip?.(known, settings)
    if (hardSkip !== undefined) { skipped.push({ id: step.id, reason: hardSkip }); continue }
    const required = step.required(known)
    const answered = step.answered(known)
    if (policy === 'never') {
      if (!answered && required) missingRequired.push(step.id)
      skipped.push({ id: step.id, reason: 'interview policy is `never`' })
      continue
    }
    if (policy === 'when-missing' && answered) {
      skipped.push({ id: step.id, reason: 'already known or inferred' })
      continue
    }
    if (step.id === 'C_oracle_reuse' && known.preexistingMarkers === undefined) {
      skipped.push({ id: step.id, reason: 'no existing reach/trigger markers found' })
      continue
    }
    const detailParts = [step.detail]
    if (step.id === 'C_static_inputs' && (known.staticGaps ?? []).length > 0) detailParts.push(`Could not infer: ${known.staticGaps!.join(', ')}.`)
    if (step.id === 'C_oracle_reuse') detailParts.push(`Found: ${known.preexistingMarkers}`)
    const detail = detailParts.filter(Boolean).join(' ')
    questions.push({
      id: step.id,
      step: step.step,
      required,
      question: `${required ? '[required]' : '[optional]'} ${step.text}`,
      header: step.header,
      ...detail !== '' ? { detail } : {},
      fields: step.fields,
      tier: step.tier,
    })
  }
  return {
    first: questions.filter(q => q.tier === 'first'),
    confirm: questions.filter(q => q.tier === 'confirm'),
    questions,
    skipped,
    missingRequired,
  }
}
