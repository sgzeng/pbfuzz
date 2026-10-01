/**
 * The `pbfuzz_campaign` actions as plain functions over {@link PbfuzzHost}: draft, confirm
 * (plan-review with Revise loop, which also opens PLAN), status.
 *
 * @module @pbfuzz/dsh-pbfuzz/campaign-flow
 */

import type { PbfuzzPhase } from './core/contracts.ts'
import { confirmCampaign, draftCampaign, type CampaignDraftInput } from './core/campaign.ts'
import { campaignReviewMarkdown, campaignToYaml, type CampaignVerification } from './core/campaign-yaml.ts'
import { verifyEnvironment } from './env-verify.ts'
import { NEXT_STEP } from './core/fsm.ts'
import { planInterview, type KnownAnswers } from './core/questionnaire.ts'
import { formatHeadlessDiagnosis } from './core/remedies.ts'
import type { ActiveCampaign, AgentLike, PbfuzzHost } from './host.ts'
import type { QuestionAsker } from './recovery.ts'
import { advancePhase } from './state-writer.ts'

/** Plan-review option labels. */
export const APPROVE = 'Approve'
export const REVISE = 'Revise'

/** Caller context shared by the actions. */
export interface FlowContext {
  host: PbfuzzHost
  agent: AgentLike | undefined
  asker: QuestionAsker | undefined
  signal: AbortSignal
}

/** Draft result returned to the model. */
export interface DraftOutcome {
  ok: boolean
  path?: string
  issues: { path: string; message: string }[]
  decisions: string[]
  /** What building and running the target actually did, just now. */
  verification: CampaignVerification[]
  yaml?: string
  /**
   * Content hash of the drafted campaign (F3). Pass this back to `confirm` to have it refuse to
   * approve a draft that has since gone stale (a Revise happened without a redraft, or the yaml
   * changed underneath). Only set when `ok`.
   */
  draftVersion?: string
}

/**
 * `draft`: validate the answers, write the yaml, then build the target and run it once on an
 * empty input so the campaign states something observed rather than claimed.
 * @param flow - caller context.
 * @param input - the answers.
 * @returns the outcome; `issues` lists every violation when not ok.
 */
export async function draft(flow: FlowContext, input: CampaignDraftInput): Promise<DraftOutcome> {
  const settings = flow.host.settings()
  const seeds = input.analysis?.corpus?.seeds_dir
  const result = draftCampaign(input, settings, seeds !== undefined && flow.host.seedsAvailable(flow.host.resolvePath(flow.agent, seeds)))
  if (!result.validation.ok) return { ok: false, issues: result.validation.issues, decisions: result.decisions, verification: [] }
  const verification = await verifyEnvironment(result.campaign, undefined, flow.signal)
  const active = flow.host.save(flow.agent, result.campaign, {
    decisions: result.decisions,
    verification,
    ...input.evidence !== undefined ? { evidence: input.evidence } : {},
  })
  return {
    ok: true,
    path: active.path,
    issues: [],
    decisions: result.decisions,
    verification,
    yaml: campaignToYaml(result.campaign),
    draftVersion: active.draftVersion,
  }
}

/** Confirm outcome. */
export type ConfirmOutcome =
  | { verdict: 'approved'; path: string; phase: PbfuzzPhase }
  | { verdict: 'revise'; feedback: string; draftVersion: string }
  | { verdict: 'error'; message: string }

/**
 * `confirm`: plan-review panel (Approve/Revise). Approve writes `confirmed: true` and the time;
 * Revise asks what to change and returns it so the agent regenerates and re-confirms.
 *
 * F3: a stale re-confirm is structurally impossible. Picking Revise marks the active draft
 * pending (`host.markRevisionPending`); any `confirm` call before the next `draft()` regenerates
 * it — including one that would otherwise approve — is refused, never silently approved with the
 * pre-Revise content. Passing `expectedDraftVersion` (from the last `draft`/`confirm` call) adds a
 * second, caller-checked guard against confirming a draft that has changed underneath.
 * @param flow - caller context.
 * @param expectedDraftVersion - the `draftVersion` the caller believes it is confirming, from the
 *   last `draft` (or a prior `revise`/`approved` outcome). Optional for backward compatibility;
 *   when supplied and stale, `confirm` refuses rather than acting on an outdated draft.
 * @returns the verdict.
 */
export async function confirm(flow: FlowContext, expectedDraftVersion?: string): Promise<ConfirmOutcome> {
  const active = flow.host.active(flow.agent)
  if (active === undefined) return { verdict: 'error', message: 'no drafted campaign; call pbfuzz_campaign with action "draft" first' }
  if (active.campaign.confirmed === true) {
    return { verdict: 'approved', path: active.path, phase: openPlan(flow, active) }
  }
  if (expectedDraftVersion !== undefined && expectedDraftVersion !== active.draftVersion) {
    return {
      verdict: 'error',
      message: `the draft has changed since draftVersion ${expectedDraftVersion} (now ${active.draftVersion}); call pbfuzz_campaign with action "draft" again and confirm with the new draftVersion`,
    }
  }
  if (active.pendingRevision !== undefined && active.pendingRevision.sinceVersion === active.draftVersion) {
    return {
      verdict: 'error',
      message: `a Revise was requested ("${active.pendingRevision.feedback}") but the campaign was never redrafted to incorporate it; call pbfuzz_campaign with action "draft" again before confirming`,
    }
  }
  if (active.headless || flow.asker === undefined) {
    return { verdict: 'error', message: 'headless run: the campaign must be hand-confirmed (`confirmed: true`) before `/pbfuzz run`' }
  }
  const markdown = campaignReviewMarkdown(active.campaign, { ...active.review, path: active.path })
  const askPromise = flow.asker.ask({
    questions: [{
      id: 'campaign-review',
      question: 'Approve this pbfuzz campaign?',
      header: 'Campaign',
      detail: markdown,
      options: [
        { label: APPROVE, description: 'Start the campaign: it moves to PLAN and the PIER loop begins.' },
        { label: REVISE, description: 'Tell pbfuzz what to change; it regenerates the campaign and asks again.' },
      ],
      intent: { kind: 'plan-review', approve: APPROVE },
    } as never],
    ...flow.agent !== undefined ? { agent: flow.agent } : {},
    signal: flow.signal,
  })
  // The plan-review panel blocks the whole turn on human latency (idiomatic — `exit_plan_mode` does
  // the same). `onboarding.confirmTimeoutMin` (0 = wait forever) bounds it for unattended runs: on
  // expiry, return a recoverable error instead of idling. A late human answer is swallowed so it
  // cannot surface as an unhandled rejection after we have already returned.
  const timeoutMin = flow.host.settings().onboarding.confirmTimeoutMin ?? 0
  let answer: Awaited<typeof askPromise>
  if (timeoutMin > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      askPromise.then(() => false as const),
      new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMin * 60_000) }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (timedOut) {
      askPromise.catch(() => undefined)
      return { verdict: 'error', message: `no response to the campaign-review panel after ${timeoutMin} min; call pbfuzz_campaign confirm again to re-open it, or draft a change first` }
    }
    answer = await askPromise
  } else {
    answer = await askPromise
  }
  const item = answer.answers.find(a => a.id === 'campaign-review')
  if (item?.selected.includes(APPROVE) === true && (item.custom ?? '').trim() === '') {
    const saved = flow.host.save(flow.agent, confirmCampaign(active.campaign), active.review, active.headless)
    return { verdict: 'approved', path: saved.path, phase: openPlan(flow, saved) }
  }
  let feedback = item?.custom?.trim() ?? ''
  if (feedback === '') {
    const follow = await flow.asker.ask({
      questions: [{ id: 'campaign-revise', question: 'What should change in the campaign?', header: 'Revise' }],
      ...flow.agent !== undefined ? { agent: flow.agent } : {},
      signal: flow.signal,
    })
    const f = follow.answers.find(a => a.id === 'campaign-revise')
    feedback = f?.custom ?? f?.selected.join(', ') ?? ''
  }
  // F3: mark this draft pending so a follow-up confirm() without an intervening draft() is
  // refused instead of silently approving the unmodified campaign.
  flow.host.markRevisionPending(flow.agent, feedback)
  return { verdict: 'revise', feedback, draftVersion: active.draftVersion }
}

/**
 * Open PLAN for a confirmed campaign: the one automatic FSM hop the plugin performs on the
 * model's behalf. Idempotent — a campaign that already left INIT (a re-confirm of an
 * already-approved campaign) keeps whatever phase it is in.
 *
 * This used to be gated behind a campaign-wide self-check. That gate is gone; approving the
 * campaign IS the gate, and the checks it ran now happen where they belong (`draft` builds and
 * runs the target, `pbfuzz_fuzz` validates the generator and preflights the plan against the real
 * oracle, the analysis provider prepares lazily on its first query).
 * @param flow - caller context.
 * @param active - the confirmed campaign.
 * @returns the phase the campaign is in once this returns.
 */
function openPlan(flow: FlowContext, active: ActiveCampaign): PbfuzzPhase {
  flow.host.ensureInitState(active)
  const current = flow.host.state(active)?.phase ?? 'INIT'
  if (current !== 'INIT') return current
  return advancePhase(flow.host, flow.agent, active, 'PLAN', {
    status: 'campaign confirmed; PLAN blocks pending',
    current_task: 'write the PLAN hypothesis blocks',
    next_action: NEXT_STEP.PLAN,
  }).phase
}

/** Status returned to the model and used by `/pbfuzz`. */
export function status(flow: FlowContext, known: KnownAnswers = {}): Record<string, unknown> {
  const active = flow.host.active(flow.agent)
  if (active === undefined) {
    const plan = planInterview(known, flow.host.settings())
    return {
      campaign: null,
      interview: plan.questions.map(q => ({ id: q.id, step: q.step, required: q.required, question: q.question, fields: q.fields })),
      skipped: plan.skipped,
      missingRequired: plan.missingRequired,
    }
  }
  const state = flow.host.state(active)
  return {
    campaign: { id: active.campaign.id, path: active.path, confirmed: active.campaign.confirmed === true },
    // Same default as the guards: INIT until state.json exists (the hooks' digest says INIT too).
    phase: state?.phase ?? 'INIT',
    state: state ?? null,
    metrics: flow.host.metrics(active) ?? null,
    providers: flow.host.providers.list().map(p => p.id),
  }
}

/** `run` outcome — shared by the `/pbfuzz run` command and the `pbfuzz_campaign` tool's `run`
 * action, the two ways a hand-written, confirmed campaign gets started headlessly. */
export interface RunOutcome {
  ok: boolean
  /** Set when `ok`. */
  campaignId?: string
  /** Set when `!ok`: an actionable diagnosis (`formatHeadlessDiagnosis` or the thrown error). */
  diagnosis?: string
  /** Set when `ok`: what the agent should do next (insert canaries if needed, then drive PIER). */
  nextInstruction?: string
}

/**
 * Load a hand-written, confirmed campaign and run its self-check — the whole of what
 * `/pbfuzz run <path>` does, factored out so `pbfuzz_campaign`'s `run` action (headless mode has
 * no slash-command dispatch to reach the command with) can do the exact same thing as a tool call.
 * @param flow - caller context.
 * @param path - path to the campaign yaml, resolved against the workspace if relative.
 * @returns the outcome; never throws.
 */
export async function runHeadless(flow: FlowContext, path: string): Promise<RunOutcome> {
  try {
    const active = flow.host.load(flow.agent, path, true)
    if (active.campaign.confirmed !== true) {
      return {
        ok: false,
        diagnosis: formatHeadlessDiagnosis({
          step: 'campaign load',
          diagnosis: 'headless campaigns must be confirmed by hand',
          evidence: [`${active.path}: confirmed is not true`],
          remedies: [{ id: 'confirm', label: 'Set `confirmed: true` in the yaml', effect: 'edit_campaign' }],
        }),
      }
    }
    const phase = openPlan(flow, active)
    return {
      ok: true,
      campaignId: active.campaign.id,
      nextInstruction: `pbfuzz campaign ${active.campaign.id} is confirmed and now in ${phase}. ${NEXT_STEP[phase]} This run is headless: never ask the user; on any failure record the diagnosis and options, then call pbfuzz_reflect with decision "stop".`,
    }
  } catch (error) {
    return { ok: false, diagnosis: `pbfuzz: ${(error as Error).message}` }
  }
}
