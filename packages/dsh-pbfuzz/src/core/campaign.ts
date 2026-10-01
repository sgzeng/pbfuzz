/**
 * Campaign drafting and validation (`pbfuzz_campaign draft`).
 *
 * Answers arrive as plain values — there is no `{value, source, evidence}` wrapper. An earlier
 * version accepted one on most leaves but not on six of them (`id`, `bug.source.text`/`path`,
 * `env.verified`/`verified_at`, `notes`), while the skill stated the rule as universal; the first
 * `draft` call of a recorded session failed on exactly that (`"answers.id" must be a string`) and
 * cost a round trip plus ~3k reasoning tokens to work out. Evidence for a decision is still
 * useful, so it is passed as a separate optional `evidence` map, shown once in the confirmation
 * panel and never written to disk.
 *
 * This module is pure: no filesystem, no session.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/campaign
 */

import type { ArrayValueSchemaSpec, ObjectValueSchemaSpec, StringValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { CampaignLanguage, PbfuzzCampaign, PbfuzzSettings, TracerKind } from './contracts.ts'
import { defaultOutputDir } from './paths.ts'

/** One schema or cross-field violation, addressed by dotted path. */
export interface CampaignIssue {
  path: string
  message: string
}

/** Validation outcome. `ok` is false when any issue exists. */
export interface CampaignValidation {
  ok: boolean
  issues: CampaignIssue[]
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const LOCATION_PATTERN = /^.+:[0-9]+$/
const LANGUAGES: readonly CampaignLanguage[] = ['c', 'cpp', 'python', 'java', 'other']
const TRACERS: readonly TracerKind[] = ['auto', 'gdb', 'lldb', 'pymon', 'jdb', 'off']

/**
 * Validate a campaign against `campaign.schema.json` and the cross-field rules the schema cannot
 * express: `@@` appears in `entry.run_cmd` iff `input_channel` is `file`; a disabled analysis tool
 * records `disabled_reason`; `deviation.mode: critical_bb` requires static analysis.
 * @param campaign - candidate document (possibly hand-written, so typed as unknown).
 * @returns every issue found.
 */
export function validateCampaign(campaign: unknown): CampaignValidation {
  const issues: CampaignIssue[] = []
  const add = (path: string, message: string): void => { issues.push({ path, message }) }
  if (typeof campaign !== 'object' || campaign === null || Array.isArray(campaign)) {
    return { ok: false, issues: [{ path: '', message: 'campaign must be a mapping' }] }
  }
  const c = campaign as Record<string, unknown>
  const allowedTop = new Set(['version', 'id', 'confirmed', 'target', 'bug', 'build', 'entry',
    'oracle', 'tracer', 'analysis', 'output'])
  for (const key of Object.keys(c)) if (!allowedTop.has(key)) add(key, 'unknown top-level field')
  if (c.version !== 1) add('version', 'must be 1')
  if (typeof c.id !== 'string' || !ID_PATTERN.test(c.id)) add('id', `must match ${ID_PATTERN.source}`)

  const target = obj(c.target)
  if (target === undefined) add('target', 'required')
  else {
    if (!isNonEmpty(target.repo)) add('target.repo', 'required')
    else if (!(target.repo as string).startsWith('/')) add('target.repo', 'must be an absolute path')
    if (target.language !== undefined && !LANGUAGES.includes(target.language as CampaignLanguage)) {
      add('target.language', `must be one of ${LANGUAGES.join(', ')}`)
    }
  }

  const bug = obj(c.bug)
  if (bug === undefined) add('bug', 'required')
  else if (!Array.isArray(bug.targets) || bug.targets.length === 0) add('bug.targets', 'at least one target location is required')
  else {
    bug.targets.forEach((t, i) => {
      const loc = obj(t)?.location
      if (typeof loc !== 'string' || !LOCATION_PATTERN.test(loc)) add(`bug.targets[${i}].location`, 'must be `file:line`')
    })
  }

  const entry = obj(c.entry)
  if (entry === undefined) add('entry', 'required')
  else {
    if (entry.kind !== 'api' && entry.kind !== 'executable') add('entry.kind', 'must be `api` or `executable`')
    if (entry.input_channel !== 'file' && entry.input_channel !== 'stdin') add('entry.input_channel', 'must be `file` or `stdin`')
    if (!isNonEmpty(entry.run_cmd)) add('entry.run_cmd', 'required')
    else {
      const hasAt = /(^|\s)@@(\s|$)/.test(entry.run_cmd as string)
      if (entry.input_channel === 'file' && !hasAt) add('entry.run_cmd', 'input_channel is `file` but `@@` does not appear')
      if (entry.input_channel === 'stdin' && hasAt) add('entry.run_cmd', 'input_channel is `stdin` so `@@` must not appear')
    }
  }

  const oracle = obj(c.oracle)
  if (oracle === undefined) add('oracle', 'required')
  else {
    if (oracle.mode !== 'canary' && oracle.mode !== 'preexisting') add('oracle.mode', 'must be `canary` or `preexisting`')
    for (const key of ['reached_pattern', 'triggered_pattern'] as const) {
      if (!isNonEmpty(oracle[key])) add(`oracle.${key}`, 'required')
      else {
        try { new RegExp(oracle[key] as string) } catch (error) {
          add(`oracle.${key}`, `invalid regex: ${(error as Error).message}`)
        }
      }
    }
  }

  if (c.tracer !== undefined && !TRACERS.includes(c.tracer as TracerKind)) add('tracer', `must be one of ${TRACERS.join(', ')}`)

  const analysis = obj(c.analysis)
  if (analysis !== undefined) {
    for (const tool of ['static', 'corpus', 'deviation'] as const) {
      const section = obj(analysis[tool])
      if (section !== undefined && section.enabled === false && !isNonEmpty(section.disabled_reason)) {
        add(`analysis.${tool}.disabled_reason`, 'a disabled tool must record why')
      }
    }
    const dev = obj(analysis.deviation)
    if (dev?.enabled === true && (dev.mode ?? 'critical_bb') === 'critical_bb' && obj(analysis.static)?.enabled === false) {
      add('analysis.deviation.mode', '`critical_bb` needs static analysis; use `target_only`')
    }
    const corpus = obj(analysis.corpus)
    if (corpus?.enabled === true && !isNonEmpty(corpus.seeds_dir)) add('analysis.corpus.seeds_dir', 'required when corpus analysis is enabled')
  }

  const output = obj(c.output)
  if (output === undefined || !isNonEmpty(output.dir)) add('output.dir', 'required')
  return { ok: issues.length === 0, issues }
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isNonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The answers `pbfuzz_campaign draft` accepts: the campaign's own shape, plain values only, with
 * everything settings already decide left out.
 */
export interface CampaignDraftInput {
  id: string
  target: { repo: string; language?: CampaignLanguage }
  bug: { targets: { location: string; condition?: string }[] }
  entry: {
    kind: 'api' | 'executable'
    run_cmd: string
    input_channel: 'file' | 'stdin'
    harness?: string
    harness_function?: string
    cwd?: string
    env?: Record<string, string>
  }
  oracle?: { mode?: 'canary' | 'preexisting'; reached_pattern?: string; triggered_pattern?: string }
  build?: { cmd?: string; dir?: string }
  tracer?: TracerKind
  analysis?: {
    static?: { mode?: 'lto' | 'wllvm' | 'prebuilt'; program?: string; bitcode?: string; entries?: string[]; lto_libs?: string[]; prebuilt_dir?: string }
    corpus?: { seeds_dir?: string }
  }
  output?: { dir?: string }
  /**
   * How a field was decided, keyed by its dotted path — e.g.
   * `{"entry.run_cmd": "main() requires exactly one argv argument (readelf.cpp:102)"}`. Shown in
   * the confirmation panel so the user can check pbfuzz's inferences, then discarded: it is not
   * part of the campaign and never reaches the yaml.
   */
  evidence?: Record<string, string>
}

/** A drafted campaign plus what to show the user before they approve it. */
export interface CampaignDraft {
  campaign: PbfuzzCampaign
  /** Automatic decisions worth calling out (e.g. corpus turned off: no seeds). */
  decisions: string[]
  validation: CampaignValidation
}

/**
 * Thrown when a `draft` answer is the wrong shape. The message always names the offending dotted
 * field path, so the model gets something it can act on instead of a raw TypeError.
 */
export class DraftAnswersError extends Error {
  constructor(field: string, detail: string) {
    super(field === '' ? `answers ${detail}` : `answers.${field} ${detail}`)
    this.name = 'DraftAnswersError'
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeShape(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value}`
}

function str(field: string, value: unknown, required: true): string
function str(field: string, value: unknown, required?: false): string | undefined
function str(field: string, value: unknown, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new DraftAnswersError(field, 'is required')
    return undefined
  }
  if (typeof value !== 'string' || value.trim() === '') throw new DraftAnswersError(field, `must be a non-empty string, got ${describeShape(value)}`)
  return value
}

function strArray(field: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
    throw new DraftAnswersError(field, `must be an array of strings, got ${describeShape(value)}`)
  }
  return value as string[]
}

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[], required: true): T
function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[], required?: false): T | undefined
function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[], required = false): T | undefined {
  if (value === undefined) {
    if (required) throw new DraftAnswersError(field, 'is required')
    return undefined
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new DraftAnswersError(field, `must be one of ${allowed.join(', ')}, got ${describeShape(value)}`)
  }
  return value as T
}

function section(field: string, value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!isPlainRecord(value)) throw new DraftAnswersError(field, `must be an object, got ${describeShape(value)}`)
  return value
}

/** Drop the keys whose value is undefined, so an optional section never serializes as `key: null`. */
function defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]: T[K] } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

/**
 * Normalize raw `draft` answers into a {@link CampaignDraftInput}, naming the offending field on
 * any shape error.
 * @param raw - the `answers` argument as the tool received it, of unknown shape.
 * @returns the validated input.
 */
export function normalizeDraftAnswers(raw: unknown): CampaignDraftInput {
  if (!isPlainRecord(raw)) throw new DraftAnswersError('', `must be an object, got ${describeShape(raw)}`)
  const target = section('target', raw.target) ?? {}
  const bug = section('bug', raw.bug) ?? {}
  const entry = section('entry', raw.entry) ?? {}
  const oracle = section('oracle', raw.oracle)
  const build = section('build', raw.build)
  const analysis = section('analysis', raw.analysis)
  const staticSection = section('analysis.static', analysis?.static)
  const corpus = section('analysis.corpus', analysis?.corpus)
  const output = section('output', raw.output)

  if (!Array.isArray(bug.targets) || bug.targets.length === 0) throw new DraftAnswersError('bug.targets', 'must be a non-empty array of {location, condition?}')
  const targets = bug.targets.map((t, i) => {
    if (!isPlainRecord(t)) throw new DraftAnswersError(`bug.targets[${i}]`, `must be an object with a string 'location', got ${describeShape(t)}`)
    return defined({ location: str(`bug.targets[${i}].location`, t.location, true), condition: str(`bug.targets[${i}].condition`, t.condition) })
  })

  let entryEnv: Record<string, string> | undefined
  const rawEntryEnv = section('entry.env', entry.env)
  if (rawEntryEnv !== undefined) {
    for (const [k, v] of Object.entries(rawEntryEnv)) if (typeof v !== 'string') throw new DraftAnswersError(`entry.env.${k}`, `must be a string, got ${describeShape(v)}`)
    entryEnv = rawEntryEnv as Record<string, string>
  }

  let evidence: Record<string, string> | undefined
  const rawEvidence = section('evidence', raw.evidence)
  if (rawEvidence !== undefined) {
    for (const [k, v] of Object.entries(rawEvidence)) if (typeof v !== 'string') throw new DraftAnswersError(`evidence.${k}`, `must be a string, got ${describeShape(v)}`)
    evidence = rawEvidence as Record<string, string>
  }

  return defined({
    id: str('id', raw.id, true),
    target: defined({ repo: str('target.repo', target.repo, true), language: oneOf('target.language', target.language, LANGUAGES) }),
    bug: { targets },
    entry: defined({
      kind: oneOf('entry.kind', entry.kind, ['api', 'executable'] as const, true),
      run_cmd: str('entry.run_cmd', entry.run_cmd, true),
      input_channel: oneOf('entry.input_channel', entry.input_channel, ['file', 'stdin'] as const, true),
      harness: str('entry.harness', entry.harness),
      harness_function: str('entry.harness_function', entry.harness_function),
      cwd: str('entry.cwd', entry.cwd),
      env: entryEnv,
    }),
    oracle: oracle === undefined ? undefined : defined({
      mode: oneOf('oracle.mode', oracle.mode, ['canary', 'preexisting'] as const),
      reached_pattern: str('oracle.reached_pattern', oracle.reached_pattern),
      triggered_pattern: str('oracle.triggered_pattern', oracle.triggered_pattern),
    }),
    build: build === undefined ? undefined : defined({ cmd: str('build.cmd', build.cmd), dir: str('build.dir', build.dir) }),
    tracer: oneOf('tracer', raw.tracer, TRACERS),
    analysis: analysis === undefined ? undefined : defined({
      static: staticSection === undefined ? undefined : defined({
        mode: oneOf('analysis.static.mode', staticSection.mode, ['lto', 'wllvm', 'prebuilt'] as const),
        program: str('analysis.static.program', staticSection.program),
        bitcode: str('analysis.static.bitcode', staticSection.bitcode),
        entries: strArray('analysis.static.entries', staticSection.entries),
        lto_libs: strArray('analysis.static.lto_libs', staticSection.lto_libs),
        prebuilt_dir: str('analysis.static.prebuilt_dir', staticSection.prebuilt_dir),
      }),
      corpus: corpus === undefined ? undefined : defined({ seeds_dir: str('analysis.corpus.seeds_dir', corpus.seeds_dir) }),
    }),
    output: output === undefined ? undefined : defined({ dir: str('output.dir', output.dir) }),
    evidence,
  }) as CampaignDraftInput
}

/**
 * Assemble a campaign from the answers plus settings.
 *
 * Settings decide which conditional sections exist at all, so the agent never has to read them:
 * the oracle's default patterns, which analysis tools are on, the tracer and the output directory
 * all come from here. Corpus analysis with no seeds turns itself off and records the reason;
 * deviation without static analysis degrades to `target_only`.
 * @param input - the answers (normalized first, so a raw tool argument is accepted).
 * @param settings - resolved pbfuzz settings.
 * @param seedsAvailable - whether the seeds dir exists and is non-empty (checked by the caller).
 * @returns the draft with its validation.
 */
export function draftCampaign(input: CampaignDraftInput, settings: PbfuzzSettings, seedsAvailable: boolean): CampaignDraft {
  const a = normalizeDraftAnswers(input)
  const decisions: string[] = []
  const campaign: PbfuzzCampaign = {
    version: 1,
    id: a.id,
    confirmed: false,
    target: defined({ repo: a.target.repo, language: a.target.language }),
    bug: { targets: a.bug.targets },
    entry: a.entry,
    oracle: defined({
      mode: a.oracle?.mode ?? 'canary',
      reached_pattern: a.oracle?.reached_pattern ?? settings.oracleDefaults.reachedPattern,
      triggered_pattern: a.oracle?.triggered_pattern ?? settings.oracleDefaults.triggeredPattern,
      // What an inserted canary does on trigger: meaningless for the target's own markers, and
      // not worth a line when it is the default.
      canary_on_trigger: (a.oracle?.mode ?? 'canary') === 'canary' && settings.oracleDefaults.canaryOnTrigger !== 'log'
        ? settings.oracleDefaults.canaryOnTrigger
        : undefined,
    }),
    output: { dir: a.output?.dir ?? defaultOutputDir(a.target.repo, settings.onboarding.defaultOutputRoot, a.id) },
  }
  // Written only when this campaign overrides the setting — otherwise it is one more line saying
  // what `tools.tracer` already says.
  if (a.tracer !== undefined) campaign.tracer = a.tracer
  // `build.dir` only when it is not the repo, which is where the build runs anyway.
  const build = a.build === undefined ? undefined : defined({ cmd: a.build.cmd, dir: a.build.dir === a.target.repo ? undefined : a.build.dir })
  if (build !== undefined && Object.keys(build).length > 0) campaign.build = build

  const analysis: NonNullable<PbfuzzCampaign['analysis']> = {}
  // Whether static analysis runs is the setting's call; the section only carries inputs the
  // agent actually has (usually none — the analyzer builds its own bitcode when first queried).
  const staticOn = settings.tools.staticAnalysis !== 'off'
  if (staticOn) {
    const s = a.analysis?.static ?? {}
    const inputs = defined({
      mode: s.mode ?? (s.prebuilt_dir !== undefined ? 'prebuilt' as const : undefined),
      // `program` names what to extract bitcode from; with `bitcode` already given it is never read.
      program: s.bitcode === undefined ? s.program : undefined,
      bitcode: s.bitcode,
      entries: s.entries,
      lto_libs: s.lto_libs,
      prebuilt_dir: s.prebuilt_dir,
    })
    if (Object.keys(inputs).length > 0) analysis.static = inputs
  }
  if (settings.tools.corpusAnalysis) {
    const seedsDir = a.analysis?.corpus?.seeds_dir
    if (seedsDir !== undefined && seedsAvailable) {
      analysis.corpus = { enabled: true, seeds_dir: seedsDir }
    } else {
      const reason = seedsDir === undefined ? 'no seeds supplied' : `seeds directory ${seedsDir} is missing or empty`
      analysis.corpus = { enabled: false, disabled_reason: reason }
      decisions.push(`Corpus analysis off: ${reason}.`)
    }
  }
  if (settings.tools.deviationDetection) {
    analysis.deviation = { enabled: true, mode: staticOn ? 'critical_bb' : 'target_only' }
    if (!staticOn) decisions.push('Deviation detection degraded to target_only: static analysis is off.')
  }
  if (Object.keys(analysis).length > 0) campaign.analysis = analysis

  return { campaign, decisions, validation: validateCampaign(campaign) }
}

/**
 * Mark a campaign confirmed after the plan-review panel returned Approve.
 * @param campaign - the drafted campaign.
 * @returns a new campaign with `confirmed: true`.
 */
export function confirmCampaign(campaign: PbfuzzCampaign): PbfuzzCampaign {
  return { ...campaign, confirmed: true }
}

/**
 * Record a tool as disabled for this campaign — the "turn this tool off" remedy.
 * @param campaign - the campaign.
 * @param tool - which analysis section to disable.
 * @param reason - why, recorded verbatim.
 * @returns the updated campaign.
 */
export function disableAnalysis(campaign: PbfuzzCampaign, tool: 'static' | 'corpus' | 'deviation', reason: string): PbfuzzCampaign {
  const analysis = { ...campaign.analysis }
  analysis[tool] = { ...analysis[tool], enabled: false, disabled_reason: reason } as never
  if (tool === 'static' && analysis.deviation?.enabled === true) analysis.deviation = { ...analysis.deviation, mode: 'target_only' }
  return { ...campaign, analysis }
}

/* -------------------------------------------------------------------------- */
/* Typed parameter schema for `pbfuzz_campaign`'s `answers` argument (draft).  */
/* -------------------------------------------------------------------------- */

const STR: StringValueSchemaSpec = { type: 'string' }
const STR_ARRAY: ArrayValueSchemaSpec = { type: 'array', items: { type: 'string' } }

/**
 * `pbfuzz_campaign`'s `answers` parameter, shaped exactly like `campaign.schema.json` with plain
 * values throughout. Everything settings already decide — the oracle's default patterns, the
 * tracer, which analysis tools run, the output directory — is absent on purpose: the agent cannot
 * fill those in without reading the user's settings file, which is what sent a recorded session
 * grepping through `~/.dsh` and the installed plugin's own compiled source.
 */
export const ANSWERS_PARAMETER_SCHEMA: ObjectValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  description: 'The campaign, as target-project facts. Plain values; no provenance wrapper.',
  properties: {
    id: { ...STR, required: true, description: 'Campaign id, e.g. "libpng-png006". Lowercase, [a-z0-9._-].' },
    target: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        repo: { ...STR, required: true, description: 'Absolute path to the target checkout.' },
        language: { type: 'string', enum: ['c', 'cpp', 'python', 'java', 'other'] },
      },
    },
    bug: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        targets: {
          type: 'array', required: true,
          description: 'Where the bug is. Each location must be a line carrying an instruction.',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              location: { ...STR, required: true, description: '`file:line`.' },
              condition: { ...STR, description: 'The predicate that must hold there, in source syntax.' },
            },
          },
        },
      },
    },
    entry: {
      type: 'object', additionalProperties: false, required: true,
      properties: {
        kind: { type: 'string', enum: ['api', 'executable'], required: true },
        run_cmd: { ...STR, required: true, description: 'Full command; exactly one `@@` for input_channel `file`, none for `stdin`.' },
        input_channel: { type: 'string', enum: ['file', 'stdin'], required: true },
        harness: STR,
        harness_function: STR,
        cwd: STR,
        env: { type: 'json', description: 'Extra environment for the target process, as {NAME: value} strings.' },
      },
    },
    oracle: {
      type: 'object', additionalProperties: false,
      description: 'Omit entirely to insert pbfuzz canaries with the configured default patterns.',
      properties: {
        mode: { type: 'string', enum: ['canary', 'preexisting'] },
        reached_pattern: { ...STR, description: 'stderr regex; required with mode `preexisting`.' },
        triggered_pattern: { ...STR, description: 'stderr regex; required with mode `preexisting`.' },
      },
    },
    build: {
      type: 'object', additionalProperties: false,
      description: 'How to build the target: the project\'s own command, or the path of a script you wrote. draft makes a script executable, runs it, and reports the result. No run script: entry.run_cmd is how the target runs.',
      properties: { cmd: STR, dir: { ...STR, description: 'Only if the build must run somewhere other than target.repo.' } },
    },
    tracer: { type: 'string', enum: ['auto', 'gdb', 'lldb', 'pymon', 'jdb', 'off'], description: 'Only to override the configured tracer for this campaign.' },
    analysis: {
      type: 'object', additionalProperties: false,
      description: 'Inputs for the analysis tools that are switched on; whether they run at all is a setting.',
      properties: {
        static: {
          type: 'object', additionalProperties: false,
          description: 'Usually omit: static analysis builds its own bitcode the first time it is queried, and a campaign that never queries it never pays for that build.',
          properties: {
            mode: { type: 'string', enum: ['lto', 'wllvm', 'prebuilt'] },
            program: { ...STR, description: 'The linked binary to analyse (basename).' },
            bitcode: { ...STR, description: 'An existing *.0.0.preopt.bc to reuse. Do not build one for this.' },
            entries: { ...STR_ARRAY, description: 'KAMain entry list; LLVMFuzzerTestOneInput if present, else main.' },
            lto_libs: STR_ARRAY,
            prebuilt_dir: STR,
          },
        },
        corpus: { type: 'object', additionalProperties: false, properties: { seeds_dir: STR } },
      },
    },
    output: { type: 'object', additionalProperties: false, properties: { dir: { ...STR, description: 'Rarely needed; defaults to <repo>/.pbfuzz/<id>.' } } },
    evidence: {
      type: 'json',
      description: 'Optional: how you decided a field, keyed by dotted path, e.g. {"entry.run_cmd": "main() at readelf.cpp:102 takes one argv"}. Shown in the approval panel, never written to the campaign.',
    },
  },
}
