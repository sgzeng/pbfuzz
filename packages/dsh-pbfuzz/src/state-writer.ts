/**
 * Where pbfuzz's own tools write campaign state — the ONLY place `state/*.json` ever changes now
 * that `guard-policy.ts`'s `decide()` denies a direct agent `write`/`edit` under the state
 * directory (P3 of the rewrite: thin agent, thick plugin). `pbfuzz_plan` calls
 * {@link writeHypothesisBlocks}; `pbfuzz_fuzz` calls {@link writeFuzzPlan} then
 * {@link advancePhase}; `pbfuzz_reflect` and `pbfuzz_campaign confirm` call
 * {@link advancePhase} directly. Every write validates first (`core/state-blocks.ts`) and only
 * then touches disk — the same "validate, then write" shape `pbfuzz_campaign draft` already has
 * for the campaign yaml.
 *
 * @module @pbfuzz/dsh-pbfuzz/state-writer
 */

import { join } from 'node:path'
import type { ParameterSpace, PbfuzzPhase, PbfuzzState } from './core/contracts.ts'
import type { CampaignValidation } from './core/campaign.ts'
import {
  checkSafeUpdate,
  validateBugPredicates,
  validateFuzzPlan,
  validatePreconditions,
  validateRootCauses,
  validateTriggerPlans,
} from './core/state-blocks.ts'
import { roundWithinBudget, transitionAllowed } from './core/phases.ts'
import type { ActiveCampaign, AgentLike, PbfuzzHost } from './host.ts'
import { readJson, writeFile } from './host.ts'

/** One hypothesis block's file name, validator, and RULE_SAFE_UPDATE kind — the shared shape
 * {@link writeHypothesisBlocks} loops over so each block gets identical treatment. */
interface BlockSpec {
  file: 'bug_predicates.json' | 'preconditions.json' | 'root_causes.json' | 'trigger_plans.json'
  validate: (value: unknown) => CampaignValidation
  safeUpdateKind: 'bug_predicates' | 'preconditions' | 'root_causes' | 'trigger_plans'
}

const BLOCK_SPECS: BlockSpec[] = [
  { file: 'bug_predicates.json', validate: validateBugPredicates, safeUpdateKind: 'bug_predicates' },
  { file: 'preconditions.json', validate: validatePreconditions, safeUpdateKind: 'preconditions' },
  { file: 'root_causes.json', validate: validateRootCauses, safeUpdateKind: 'root_causes' },
  { file: 'trigger_plans.json', validate: validateTriggerPlans, safeUpdateKind: 'trigger_plans' },
]

/** `pbfuzz_plan`'s input: any subset of the four hypothesis blocks (a round may only need to
 * revise one). Each present value is a list of entries UPSERTED by `id` into that file: an id
 * already on disk is revised with just the fields given, a new id is appended whole, and an id
 * left out stays exactly as it is. */
export interface WriteStateBlocksInput {
  bugPredicates?: unknown
  preconditions?: unknown
  rootCauses?: unknown
  triggerPlans?: unknown
}

/** One state write's outcome: every issue found, across every block the caller supplied (a
 * multi-block call reports all of them at once, the same "every violation, one round-trip" shape
 * `pbfuzz_campaign draft` already has). Nothing is written when any block has an issue — a
 * partial write that lands some blocks and rejects others would leave the campaign in a state no
 * single call produced. */
export interface StateWriteResult {
  ok: boolean
  issues: { path: string; message: string }[]
}

/**
 * `current` with each supplied entry merged in by `id` (shallow: a field given replaces that field)
 * or appended when its id is new.
 * @param current - the block on disk.
 * @param supplied - the tool argument for that block.
 * @returns the merged block, or why `supplied` cannot be merged at all.
 */
function upsertById(current: { id: string }[], supplied: unknown): { id: string }[] | string {
  if (!Array.isArray(supplied)) return 'must be a list of entries'
  const merged = current.map(entry => ({ ...entry }))
  for (const [i, entry] of supplied.entries()) {
    if (typeof entry !== 'object' || entry === null || typeof (entry as { id?: unknown }).id !== 'string') {
      return `[${i}]: every entry needs a string \`id\` (it is what the entry is merged by)`
    }
    const at = merged.findIndex(e => e.id === (entry as { id: string }).id)
    if (at === -1) merged.push({ ...(entry as { id: string }) })
    else merged[at] = { ...merged[at]!, ...(entry as { id: string }) }
  }
  return merged
}

/** Rewrite a validator path's leading `[i]` into `[<id>]` — the model addresses entries by id. */
function byId(path: string, merged: { id: string }[]): string {
  return path.replace(/^\[(\d+)\]/, (whole, i: string) => {
    const id = merged[Number(i)]?.id
    return id === undefined ? whole : `[${id}]`
  })
}

function keyFor(spec: BlockSpec): keyof WriteStateBlocksInput {
  switch (spec.file) {
    case 'bug_predicates.json': return 'bugPredicates'
    case 'preconditions.json': return 'preconditions'
    case 'root_causes.json': return 'rootCauses'
    case 'trigger_plans.json': return 'triggerPlans'
  }
}

/**
 * Validate and write any subset of the four hypothesis blocks (`pbfuzz_plan`'s job).
 *
 * Writes are upserts by `id`. They used to replace the whole file, with RULE_SAFE_UPDATE checking
 * afterwards that no id on disk had vanished — so revising one precondition meant re-sending all
 * of them (1,549 output tokens in a recorded session, to correct a single number). Merging makes
 * a dropped entry impossible by construction rather than rejected after the fact; the rule is
 * still checked, and can no longer fail.
 *
 * The MERGED block is what gets validated, so a revision may carry only the fields it changes
 * while a new entry must still be complete. A violation in ANY supplied block rejects the whole
 * call with issues path-prefixed by the block name (and by entry id, not array index — the model
 * never sees the merged array's positions), and nothing lands. Does not touch `state.json`'s phase — compose with
 * {@link advancePhase} for the PLAN→IMPLEMENT hop.
 * @param active - the campaign whose state directory is written.
 * @param input - the blocks to write; blocks not present are left untouched on disk.
 * @returns `{ok:true, issues:[]}` on success (every supplied block landed), or every violation
 *   found with nothing written.
 */
export function writeHypothesisBlocks(active: ActiveCampaign, input: WriteStateBlocksInput): StateWriteResult {
  const issues: StateWriteResult['issues'] = []
  const toWrite: { path: string; content: unknown[] }[] = []
  for (const spec of BLOCK_SPECS) {
    const key = keyFor(spec)
    const value = input[key]
    if (value === undefined) continue
    const path = join(active.layout.stateDir, spec.file)
    const current = readJson<{ id: string }[]>(path) ?? []
    const merged = upsertById(current, value)
    if (typeof merged === 'string') {
      issues.push({ path: key, message: merged })
      continue
    }
    const structural = spec.validate(merged)
    for (const issue of structural.issues) issues.push({ path: `${key}${byId(issue.path, merged)}`, message: issue.message })
    if (!structural.ok) continue
    const next = merged
    const safe = checkSafeUpdate(spec.safeUpdateKind, current, next)
    for (const issue of safe.issues) issues.push({ path: `${key}.${issue.path}`, message: issue.message })
    if (safe.ok) toWrite.push({ path, content: next })
  }
  if (issues.length > 0) return { ok: false, issues }
  for (const { path, content } of toWrite) writeFile(path, `${JSON.stringify(content, null, 2)}\n`)
  return { ok: true, issues: [] }
}

/**
 * Validate and write `fuzz_plan.json` (`pbfuzz_fuzz`'s job). `plan` is the whole document
 * (`{parameter_space, next_batch_plan, breakpoints, trigger_plan_id?, generator_path?}`); the
 * parameter-space cross-check reads `plan.parameter_space` from the same value, so a plan that
 * omits it fails structurally before the cross-check ever runs. Does not touch `state.json`'s
 * phase — compose with {@link advancePhase} for the IMPLEMENT→EXECUTE hop.
 * @param active - the campaign whose state directory is written.
 * @param plan - the candidate fuzz plan document.
 * @returns the validation outcome; nothing is written when it fails.
 */
export function writeFuzzPlan(active: ActiveCampaign, plan: unknown): StateWriteResult {
  const parameterSpace = (
    typeof plan === 'object' && plan !== null && !Array.isArray(plan)
      ? (plan as { parameter_space?: unknown }).parameter_space
      : undefined
  ) as ParameterSpace | undefined
  const result = validateFuzzPlan(plan, parameterSpace ?? {})
  if (!result.ok) return result
  writeFile(active.layout.fuzzPlanFile, `${JSON.stringify(plan, null, 2)}\n`)
  return { ok: true, issues: [] }
}

/** A phase transition {@link advancePhase} was asked for that the FSM does not permit from the
 * campaign's current phase. A real bug in the calling tool (it should only ever request a
 * transition its own action legally implies), not a model-facing validation failure. */
export class IllegalTransitionError extends Error {
  constructor(from: PbfuzzPhase, to: PbfuzzPhase) {
    super(`illegal PIER transition ${from} -> ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

/** What the caller supplies alongside a phase transition; everything `state.json` needs beyond
 * `campaign_id`/`phase`/`pier_round`/timestamps, which {@link advancePhase} derives itself. */
export interface AdvancePhaseInput {
  status: string
  current_task: string
  next_action: string
  /** Required when `to` is `STOPPED` (including a budget-forced redirect — see below). */
  stopReason?: string
  /** Set only when `to` is `SUCCESS`. */
  poc?: PbfuzzState['poc']
}

/**
 * On reaching SUCCESS, flip any `trigger_plans.json` entry still marked `in_progress` to
 * `completed`, so a reader of `state/` alone no longer sees an in-progress hypothesis beside a
 * finished campaign (a real artifact of a run that succeeds mid-plan — round 0, iteration 1 — before
 * any `pbfuzz_plan` call reconciles the block). `pending`/`failed` are left as they were: never
 * started, or already ruled out, and the success only makes them moot. A no-op when the file is
 * absent or not an array; only the `status` field is touched, so the block stays schema-valid
 * without re-validation.
 * @param active - the succeeded campaign.
 */
function reconcileTriggerPlansOnSuccess(active: ActiveCampaign): void {
  const path = join(active.layout.stateDir, 'trigger_plans.json')
  const plans = readJson<{ status?: string }[]>(path)
  if (!Array.isArray(plans)) return
  let changed = false
  const next = plans.map((plan) => {
    if (plan !== null && typeof plan === 'object' && plan.status === 'in_progress') {
      changed = true
      return { ...plan, status: 'completed' }
    }
    return plan
  })
  if (changed) writeFile(path, `${JSON.stringify(next, null, 2)}\n`)
}

/**
 * Validated phase transition + `state.json` write — the one function
 * that ever moves a campaign's phase. Throws {@link IllegalTransitionError} when `to` is not
 * `core/phases.ts`'s `transitionAllowed(from, to)` — callers must only ever request a transition
 * their own action legally implies (e.g. `pbfuzz_reflect`'s `next_round` always requests
 * `REFLECT`→`PLAN`, never anything else), so this is a defensive assertion, not a model-facing
 * error path.
 *
 * Budget enforcement lives here, at the one loop-back edge the FSM has (`REFLECT`→`PLAN` is the
 * only transition that can repeat): a request that would exceed `budget.maxPierRounds` or that
 * lands after `budget.campaignWallTimeMin` has elapsed since `started_at` is silently redirected
 * to `STOPPED` with an auto-generated `stop_reason` instead of the caller-requested `PLAN` — the
 * caller's own `status`/`current_task`/`next_action` are still used, but `to`/`stopReason` are
 * overridden. This is the ONE place those two budgets are enforced as a real terminal state (the PIER budget is
 * the only brake on an unattended run — reaching it must produce `phase: STOPPED`, not just a
 * quieter agent).
 * @param host - the plugin host (for `state()`).
 * @param agent - the calling agent; unused for visibility (the tool list is session-constant,
 *   see `core/phases.ts`) and kept only so callers need not special-case a headless context.
 * @param active - the campaign being advanced.
 * @param to - the requested next phase.
 * @param input - everything else `state.json` needs.
 * @returns the state actually written (which may be `STOPPED` even when `to` was `PLAN`, per the
 *   budget redirect above).
 */
export function advancePhase(
  host: PbfuzzHost,
  agent: AgentLike | undefined,
  active: ActiveCampaign,
  to: PbfuzzPhase,
  input: AdvancePhaseInput,
): PbfuzzState {
  const current = host.state(active)
  const from = current?.phase ?? 'INIT'
  if (!transitionAllowed(from, to)) throw new IllegalTransitionError(from, to)

  let nextPhase = to
  let stopReason = input.stopReason
  if (from === 'REFLECT' && to === 'PLAN') {
    const maxRounds = host.settings().budget.maxPierRounds
    const pierRound = current?.pier_round ?? 0
    const wallTimeMin = host.settings().budget.campaignWallTimeMin
    const startedAt = current?.started_at === undefined ? undefined : Date.parse(current.started_at)
    const elapsedMin = startedAt === undefined || Number.isNaN(startedAt) ? 0 : (Date.now() - startedAt) / 60_000
    if (!roundWithinBudget(pierRound, maxRounds)) {
      nextPhase = 'STOPPED'
      stopReason = `PIER round budget exhausted: ${pierRound}/${maxRounds} rounds completed (budget.maxPierRounds)`
    } else if (elapsedMin > wallTimeMin) {
      nextPhase = 'STOPPED'
      stopReason = `campaign wall-clock budget exhausted: ${elapsedMin.toFixed(1)}/${wallTimeMin} minutes elapsed (budget.campaignWallTimeMin)`
    }
  }

  const now = new Date().toISOString()
  const state: PbfuzzState = {
    campaign_id: active.campaign.id,
    phase: nextPhase,
    status: input.status,
    current_task: input.current_task,
    next_action: input.next_action,
    // A round is "completed" (state.schema.json's own wording) at REFLECT, not at the following
    // REFLECT->PLAN hop -- that hop only ever *reads* pier_round to decide the budget, it must
    // never itself bump the count it is checking, or the very round that just finished would
    // never be counted until the round AFTER it.
    pier_round: to === 'REFLECT' ? (current?.pier_round ?? 0) + 1 : current?.pier_round ?? 0,
    started_at: current?.started_at ?? now,
    updated_at: now,
    ...input.poc !== undefined ? { poc: input.poc } : {},
    ...stopReason !== undefined ? { stop_reason: stopReason } : {},
  }
  writeFile(active.layout.stateFile, `${JSON.stringify(state, null, 2)}\n`)
  if (nextPhase === 'SUCCESS') reconcileTriggerPlansOnSuccess(active)
  return state
}
