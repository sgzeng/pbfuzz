/**
 * Validators for the PIER hypothesis blocks and `fuzz_plan.json` (PLAN/IMPLEMENT).
 *
 * `.pbfuzz/<id>/state/{bug_predicates,preconditions,root_causes,trigger_plans}.json` and
 * `fuzz_plan.json` are written by tools (`pbfuzz_plan`, `pbfuzz_fuzz` — a later wave, not this
 * file), which validate their input against `contracts/state/blocks.schema.json`'s `$defs` before
 * writing, exactly as `pbfuzz_campaign draft` validates against `campaign.schema.json` today. This
 * module hand-writes that validation, following `core/campaign.ts::validateCampaign()`'s style
 * (plain object walk, no JSON-Schema library — this repo has none installed and a schema this
 * size does not need one) rather than the CC hook's Python `schema.py`, which this replaces.
 *
 * `validateFuzzPlan` additionally cross-checks `next_batch_plan` against the declared
 * `parameter_space` — the static half of what the engine's `generator.validate` preflight does
 * dynamically, and the check that would have caught the incident this plan is named after: a
 * batch entry pinning a decimal value for a parameter declared `int_range`, outside its domain,
 * only discovered after a full fuzzing budget had been burned.
 *
 * `checkSafeUpdate` ports RULE_SAFE_UPDATE from the CCS'26 artifact (see the old-pbfuzz reader's
 * F11 in the `wf_b94cd15d-3b0` journal): a write to one of the four hypothesis blocks must never
 * silently drop an existing entry, which is how hypothesis drift — one of the poster's four named
 * design challenges — would otherwise corrupt a long campaign.
 *
 * Pure: no filesystem, no session.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/state-blocks
 */

import type { ParameterSpace, ParameterSpec } from './contracts.ts'
import type { CampaignIssue, CampaignValidation } from './campaign.ts'

const BUG_PREDICATE_ID_PATTERN = /^BP[0-9]+$/
const PRECONDITION_ID_PATTERN = /^R[0-9]+$/
const ROOT_CAUSE_ID_PATTERN = /^RC[0-9]+$/
const LOCATION_PATTERN = /^.+:[0-9]+$/
const PRECONDITION_STATUSES = ['verified', 'violated', 'unknown', 'impossible'] as const
const TRIGGER_PLAN_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const
const PARAM_SPEC_TYPES = ['int_range', 'float_range', 'categorical', 'bool', 'base_seed', 'segments'] as const

/** A validation-issue collector bound to a growing `issues` array; every validator shares this shape. */
type AddIssue = (path: string, message: string) => void

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string')
}

/** Flag every key of `o` not in `allowed` as an unknown field (mirrors each $def's `additionalProperties: false`). */
function checkNoExtraKeys(o: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, add: AddIssue): void {
  for (const key of Object.keys(o)) if (!allowed.has(key)) add(`${path}.${key}`, 'unknown field')
}

/**
 * Validate `bug_predicates.json` against `blocks.schema.json#/$defs/BugPredicate`, applied to each
 * array element (F11: satisfying ANY one triggers the bug, so `bug_predicates.json` holds an array).
 * @param value - candidate document (typed as unknown: may be hand-written or agent-built).
 * @returns every issue found, index-qualified (`[i].field`).
 */
export function validateBugPredicates(value: unknown): CampaignValidation {
  const issues: CampaignIssue[] = []
  const add: AddIssue = (path, message) => { issues.push({ path, message }) }
  if (!Array.isArray(value)) return { ok: false, issues: [{ path: '', message: 'bug_predicates.json must be an array' }] }
  const allowed = new Set(['id', 'location', 'bug_condition'])
  value.forEach((item, i) => {
    const o = obj(item)
    if (o === undefined) { add(`[${i}]`, 'must be a mapping'); return }
    checkNoExtraKeys(o, allowed, `[${i}]`, add)
    if (typeof o.id !== 'string' || !BUG_PREDICATE_ID_PATTERN.test(o.id)) add(`[${i}].id`, `must match ${BUG_PREDICATE_ID_PATTERN.source}`)
    if (!isNonEmpty(o.location) || !LOCATION_PATTERN.test(o.location)) add(`[${i}].location`, 'must be `file:line`')
    if (!isNonEmpty(o.bug_condition)) add(`[${i}].bug_condition`, 'required')
  })
  return { ok: issues.length === 0, issues }
}

/**
 * Validate `preconditions.json` against `blocks.schema.json#/$defs/Precondition` (conditions that
 * must hold to REACH the target), applied to each array element.
 * @param value - candidate document.
 * @returns every issue found.
 */
export function validatePreconditions(value: unknown): CampaignValidation {
  const issues: CampaignIssue[] = []
  const add: AddIssue = (path, message) => { issues.push({ path, message }) }
  if (!Array.isArray(value)) return { ok: false, issues: [{ path: '', message: 'preconditions.json must be an array' }] }
  const allowed = new Set(['id', 'statement', 'status', 'evidence', 'input_constraints'])
  value.forEach((item, i) => {
    const o = obj(item)
    if (o === undefined) { add(`[${i}]`, 'must be a mapping'); return }
    checkNoExtraKeys(o, allowed, `[${i}]`, add)
    if (typeof o.id !== 'string' || !PRECONDITION_ID_PATTERN.test(o.id)) add(`[${i}].id`, `must match ${PRECONDITION_ID_PATTERN.source}`)
    if (!isNonEmpty(o.statement)) add(`[${i}].statement`, 'required')
    if (typeof o.status !== 'string' || !(PRECONDITION_STATUSES as readonly string[]).includes(o.status)) {
      add(`[${i}].status`, `must be one of ${PRECONDITION_STATUSES.join(', ')}`)
    }
    if (!isStringArray(o.evidence)) add(`[${i}].evidence`, 'required, must be an array of strings')
    if (o.input_constraints !== undefined && !isStringArray(o.input_constraints)) add(`[${i}].input_constraints`, 'must be an array of strings')
  })
  return { ok: issues.length === 0, issues }
}

/**
 * Validate `root_causes.json` against `blocks.schema.json#/$defs/RootCause` (why the bug triggers
 * once reached), applied to each array element. `category` stays an open string — the framework is
 * language-agnostic, so the schema's category list is examples, not an enum.
 * @param value - candidate document.
 * @returns every issue found.
 */
export function validateRootCauses(value: unknown): CampaignValidation {
  const issues: CampaignIssue[] = []
  const add: AddIssue = (path, message) => { issues.push({ path, message }) }
  if (!Array.isArray(value)) return { ok: false, issues: [{ path: '', message: 'root_causes.json must be an array' }] }
  const allowed = new Set(['id', 'description', 'category', 'evidence', 'input_constraints', 'related_precondition_ids'])
  value.forEach((item, i) => {
    const o = obj(item)
    if (o === undefined) { add(`[${i}]`, 'must be a mapping'); return }
    checkNoExtraKeys(o, allowed, `[${i}]`, add)
    if (typeof o.id !== 'string' || !ROOT_CAUSE_ID_PATTERN.test(o.id)) add(`[${i}].id`, `must match ${ROOT_CAUSE_ID_PATTERN.source}`)
    if (!isNonEmpty(o.description)) add(`[${i}].description`, 'required')
    if (!isNonEmpty(o.category)) add(`[${i}].category`, 'required')
    if (!isStringArray(o.evidence)) add(`[${i}].evidence`, 'required, must be an array of strings')
    if (o.input_constraints !== undefined && !isStringArray(o.input_constraints)) add(`[${i}].input_constraints`, 'must be an array of strings')
    if (o.related_precondition_ids !== undefined && !isStringArray(o.related_precondition_ids)) add(`[${i}].related_precondition_ids`, 'must be an array of strings')
  })
  return { ok: issues.length === 0, issues }
}

/**
 * Validate `trigger_plans.json` against `blocks.schema.json#/$defs/TriggerPlan` (a high-level
 * route to the bug with a self-assessed implementation cost), applied to each array element.
 * Unlike the other three blocks, `TriggerPlan.id` carries no fixed prefix pattern in the schema.
 * @param value - candidate document.
 * @returns every issue found.
 */
export function validateTriggerPlans(value: unknown): CampaignValidation {
  const issues: CampaignIssue[] = []
  const add: AddIssue = (path, message) => { issues.push({ path, message }) }
  if (!Array.isArray(value)) return { ok: false, issues: [{ path: '', message: 'trigger_plans.json must be an array' }] }
  const allowed = new Set(['id', 'description', 'route_description', 'complexity', 'status', 'evidence', 'precondition_ids', 'strategy'])
  value.forEach((item, i) => {
    const o = obj(item)
    if (o === undefined) { add(`[${i}]`, 'must be a mapping'); return }
    checkNoExtraKeys(o, allowed, `[${i}]`, add)
    if (!isNonEmpty(o.id)) add(`[${i}].id`, 'required')
    if (!isNonEmpty(o.description)) add(`[${i}].description`, 'required')
    if (!isNonEmpty(o.route_description)) add(`[${i}].route_description`, 'required')
    if (!Number.isInteger(o.complexity) || (o.complexity as number) < 1 || (o.complexity as number) > 10) {
      add(`[${i}].complexity`, 'must be an integer between 1 and 10')
    }
    if (typeof o.status !== 'string' || !(TRIGGER_PLAN_STATUSES as readonly string[]).includes(o.status)) {
      add(`[${i}].status`, `must be one of ${TRIGGER_PLAN_STATUSES.join(', ')}`)
    }
    if (o.evidence !== undefined && !isStringArray(o.evidence)) add(`[${i}].evidence`, 'must be an array of strings')
    if (o.precondition_ids !== undefined && !isStringArray(o.precondition_ids)) add(`[${i}].precondition_ids`, 'must be an array of strings')
    if (o.strategy !== undefined && typeof o.strategy !== 'string') add(`[${i}].strategy`, 'must be a string')
  })
  return { ok: issues.length === 0, issues }
}

/**
 * RULE_SAFE_UPDATE, ported from the CCS'26 artifact: a write to one of the four hypothesis blocks
 * must never silently drop an existing entry. Every `id` present in `current` must still be
 * present in `next` — an entry may be freely revised in place (status/evidence/etc. changed) or
 * new entries appended, but never removed. The original (`mcp_workflow_server.py`'s
 * `RULE_SAFE_UPDATE`) compared array LENGTH and applied only to `Preconditions`/`RootCauses`/
 * `TriggerPlans`; this port compares by `id` (catching a same-length write that silently swaps one
 * entry for another, not just a shrink) and covers `bug_predicates` too, since it is exactly as
 * vulnerable to hypothesis drift as the other three.
 * @param kind - which block this write targets, used only to phrase the message.
 * @param current - what is currently on disk for that file (the caller reads it; this stays pure).
 * @param next - what is about to be written.
 * @returns one issue per dropped id; `ok` is false if any entry was dropped.
 */
export function checkSafeUpdate(
  kind: 'bug_predicates' | 'preconditions' | 'root_causes' | 'trigger_plans',
  current: { id: string }[],
  next: { id: string }[],
): CampaignValidation {
  const nextIds = new Set(next.map(entry => entry.id))
  const issues: CampaignIssue[] = []
  for (const entry of current) {
    if (!nextIds.has(entry.id)) {
      issues.push({
        path: entry.id,
        message: `RULE_SAFE_UPDATE: '${entry.id}' is in the current ${kind} but missing from this write — `
          + 'revise or append, never drop an entry (this is how hypothesis drift corrupts a campaign)',
      })
    }
  }
  return { ok: issues.length === 0, issues }
}

/** Validate one `common.schema.json#/$defs/ParameterSpec` node, recursing into `segments.segment_params`. */
function validateParameterSpecNode(path: string, value: unknown, add: AddIssue): void {
  const o = obj(value)
  if (o === undefined) { add(path, 'must be a mapping'); return }
  const type = o.type
  if (typeof type !== 'string' || !(PARAM_SPEC_TYPES as readonly string[]).includes(type)) {
    add(`${path}.type`, `must be one of ${PARAM_SPEC_TYPES.join(', ')}`)
    return
  }
  switch (type) {
    case 'int_range':
    case 'float_range': {
      checkNoExtraKeys(o, new Set(['type', 'min', 'max']), path, add)
      const isInt = type === 'int_range'
      const validNumber = (n: unknown): boolean => isInt ? Number.isInteger(n) : typeof n === 'number' && Number.isFinite(n)
      if (!validNumber(o.min)) add(`${path}.min`, `must be ${isInt ? 'an integer' : 'a finite number'}`)
      if (!validNumber(o.max)) add(`${path}.max`, `must be ${isInt ? 'an integer' : 'a finite number'}`)
      break
    }
    case 'categorical':
      checkNoExtraKeys(o, new Set(['type', 'values']), path, add)
      if (!Array.isArray(o.values) || o.values.length === 0) add(`${path}.values`, 'must be a non-empty array')
      break
    case 'bool':
      checkNoExtraKeys(o, new Set(['type']), path, add)
      break
    case 'base_seed':
      checkNoExtraKeys(o, new Set(['type', 'seed_file_path']), path, add)
      if (!isNonEmpty(o.seed_file_path)) add(`${path}.seed_file_path`, 'required')
      break
    case 'segments': {
      checkNoExtraKeys(o, new Set(['type', 'count_range', 'segment_params']), path, add)
      const countRange = obj(o.count_range)
      if (countRange === undefined) add(`${path}.count_range`, 'required')
      else {
        checkNoExtraKeys(countRange, new Set(['min', 'max']), `${path}.count_range`, add)
        if (!Number.isInteger(countRange.min) || (countRange.min as number) < 0) add(`${path}.count_range.min`, 'must be a non-negative integer')
        if (!Number.isInteger(countRange.max) || (countRange.max as number) < 0) add(`${path}.count_range.max`, 'must be a non-negative integer')
      }
      const segmentParams = obj(o.segment_params)
      if (segmentParams === undefined) add(`${path}.segment_params`, 'required')
      else for (const [name, spec] of Object.entries(segmentParams)) validateParameterSpecNode(`${path}.segment_params.${name}`, spec, add)
      break
    }
  }
}

/** Validate a `common.schema.json#/$defs/ParameterSpace` node: every entry a valid `ParameterSpec`. */
function validateParameterSpaceNode(path: string, value: unknown, add: AddIssue): void {
  const o = obj(value)
  if (o === undefined) { add(path, 'must be a mapping'); return }
  for (const [name, spec] of Object.entries(o)) validateParameterSpecNode(`${path}.${name}`, spec, add)
}

/** Validate one `common.schema.json#/$defs/Breakpoint`, including the bare `file:line` location pattern. */
function validateBreakpointNode(path: string, value: unknown, add: AddIssue): void {
  const o = obj(value)
  if (o === undefined) { add(path, 'must be a mapping'); return }
  checkNoExtraKeys(o, new Set(['location', 'hit_limit', 'inline_expr', 'print_call_stack']), path, add)
  if (!isNonEmpty(o.location) || !LOCATION_PATTERN.test(o.location)) add(`${path}.location`, 'must be `file:line`')
  if (o.hit_limit !== undefined && (!Number.isInteger(o.hit_limit) || (o.hit_limit as number) < 1)) add(`${path}.hit_limit`, 'must be an integer >= 1')
  if (o.inline_expr !== undefined && !isStringArray(o.inline_expr)) add(`${path}.inline_expr`, 'must be an array of strings')
  if (o.print_call_stack !== undefined && typeof o.print_call_stack !== 'boolean') add(`${path}.print_call_stack`, 'must be a boolean')
}

/**
 * Whether `pinned` is a legal value for a parameter declared `spec` in the parameter space.
 * `base_seed`/`segments` are not single pinnable scalars (a `next_batch_plan` entry pins one JSON
 * value per key), so they are only name-checked by the caller, not domain-checked here.
 * @param spec - the parameter's declared domain.
 * @param pinned - the value a `next_batch_plan` entry pins for it.
 * @returns an error message, or undefined when `pinned` is in-domain.
 */
function pinnedValueIssue(spec: ParameterSpec, pinned: unknown): string | undefined {
  switch (spec.type) {
    case 'int_range':
      if (!Number.isInteger(pinned)) return `must be an integer, got ${JSON.stringify(pinned)}`
      if ((pinned as number) < spec.min || (pinned as number) > spec.max) return `must be within [${spec.min}, ${spec.max}], got ${pinned}`
      return undefined
    case 'float_range':
      if (typeof pinned !== 'number' || !Number.isFinite(pinned)) return `must be a finite number, got ${JSON.stringify(pinned)}`
      if (pinned < spec.min || pinned > spec.max) return `must be within [${spec.min}, ${spec.max}], got ${pinned}`
      return undefined
    case 'categorical':
      return spec.values.some(v => JSON.stringify(v) === JSON.stringify(pinned))
        ? undefined
        : `must be one of ${JSON.stringify(spec.values)}, got ${JSON.stringify(pinned)}`
    case 'bool':
      return typeof pinned === 'boolean' ? undefined : `must be a boolean, got ${JSON.stringify(pinned)}`
    default:
      return undefined
  }
}

/** Validate one `blocks.schema.json#/$defs/BatchPlanEntry`, cross-checked against `parameterSpace`. */
function validateBatchPlanEntry(path: string, value: unknown, parameterSpace: ParameterSpace, add: AddIssue): void {
  const o = obj(value)
  if (o === undefined) { add(path, 'must be a mapping'); return }
  if (!isNonEmpty(o.plan_description)) add(`${path}.plan_description`, 'required')
  // BatchPlanEntry has no `additionalProperties: false`: every other key is a generator param.
  for (const [key, pinned] of Object.entries(o)) {
    if (key === 'plan_description') continue
    const spec = parameterSpace[key]
    if (spec === undefined) { add(`${path}.${key}`, 'no such parameter in parameter_space'); continue }
    const issue = pinnedValueIssue(spec, pinned)
    if (issue !== undefined) add(`${path}.${key}`, issue)
  }
}

/**
 * Validate `fuzz_plan.json` against `blocks.schema.json#/$defs/FuzzPlan`, plus the cross-checks a
 * JSON Schema cannot express: every `next_batch_plan` entry's pinned parameter names must exist in
 * `parameterSpace`, and its pinned value must be in-domain for that parameter's declared type
 * (`int_range`/`float_range` bounds, `categorical` membership, `bool`); every breakpoint's
 * `location` matches the bare `file:line` pattern. This is the static half of what the engine's
 * `generator.validate` preflight does dynamically — it catches the incident's exact bug (a plan
 * pinning a decimal value for a parameter declared `int_range`, outside its bounds) before any
 * fuzzing starts, not after a full budget is burned. Pure and synchronous: it runs nothing.
 * @param value - candidate document (typed as unknown).
 * @param parameterSpace - the authoritative parameter space the pinned values are checked against
 *   (ordinarily `value.parameter_space` itself, once the caller has narrowed it — passed
 *   separately so the cross-check does not depend on `value`'s own structural validity).
 * @returns every issue found.
 */
export function validateFuzzPlan(value: unknown, parameterSpace: ParameterSpace): CampaignValidation {
  const issues: CampaignIssue[] = []
  const add: AddIssue = (path, message) => { issues.push({ path, message }) }
  const o = obj(value)
  if (o === undefined) return { ok: false, issues: [{ path: '', message: 'fuzz_plan.json must be a mapping' }] }
  const topLevelAllowed = new Set(['trigger_plan_id', 'parameter_space', 'next_batch_plan', 'breakpoints', 'generator_path'])
  for (const key of Object.keys(o)) if (!topLevelAllowed.has(key)) add(key, 'unknown field')
  if (o.trigger_plan_id !== undefined && typeof o.trigger_plan_id !== 'string') add('trigger_plan_id', 'must be a string')
  if (o.generator_path !== undefined && typeof o.generator_path !== 'string') add('generator_path', 'must be a string')

  if (o.parameter_space === undefined) add('parameter_space', 'required')
  else validateParameterSpaceNode('parameter_space', o.parameter_space, add)

  if (o.next_batch_plan !== undefined) {
    if (!Array.isArray(o.next_batch_plan)) add('next_batch_plan', 'must be an array')
    else o.next_batch_plan.forEach((entry, i) => validateBatchPlanEntry(`next_batch_plan[${i}]`, entry, parameterSpace, add))
  }
  if (o.breakpoints !== undefined) {
    if (!Array.isArray(o.breakpoints)) add('breakpoints', 'must be an array')
    else o.breakpoints.forEach((bp, i) => validateBreakpointNode(`breakpoints[${i}]`, bp, add))
  }
  return { ok: issues.length === 0, issues }
}
