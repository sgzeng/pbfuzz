/**
 * Unattended PIER advance: nudges a stalled agent forward when nothing else will, and catches the
 * headless `/pbfuzz run <path>` bootstrap message.
 *
 * This module deliberately registers no `ctx.systemPrompt.section()`. It used to keep a one-line
 * campaign status banner there, whose text embedded the phase and PIER round — so it changed at
 * every phase transition, and a changed system prompt re-projects the whole prompt and starts a
 * new request series, costing the provider's prefix cache. The same phase/next-step information
 * already reaches the model where it is actually needed: in every phase-owning tool's own result,
 * in the job-completion notice, and in the nudge below.
 *
 * Deliberately minimal. `@deepseek-ai/dsh-tool-jobs` already wakes an idle owner on job completion
 * (bounded by its own `maxConsecutiveWakes`, reset only by a real user message); this module's own
 * `onJobDone` listener only matters once THAT budget is exhausted (the owner is still idle because
 * `dsh-tool-jobs` chose `inject()` instead of `followup()`). `agent/turn-stopping` covers the other
 * case: a natural stop with nothing left to wait on. Neither listener returns a truthy value —
 * `agent/turn-stopping` is `serial`/`void`, and a truthy return there would bail out every other
 * plugin's own listener.
 *
 * A message built at one moment and delivered at another is a real, previously-observed hazard
 * class in this codebase (an unrelated, since-deleted plugin once cost a live session ~74s chasing
 * a campaign directory a stale message swore existed). Two defenses against it live here:
 * `shouldForceContinue()`'s text names the campaign id and pier round it was computed for, so a
 * reader — model or human — can tell whether it is still current before acting on it (`fsm.ts`'s
 * `NEXT_STEP` text alone cannot say that). And the headless `/pbfuzz run` bootstrap dispatch below,
 * whose `runHeadless()` self-check can span an arbitrary number of turns before it settles, is
 * re-validated against `host.active(agent)` at settlement time rather than trusted blindly.
 *
 * @module @pbfuzz/dsh-pbfuzz/pier-driver
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-jobs'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { NEXT_STEP } from './core/fsm.ts'
import type { AgentLike, PbfuzzHost } from './host.ts'
import { advancePhase } from './state-writer.ts'

/** Types the `pbfuzz_fuzz` `kind: 'pbfuzz_fuzz'` job (same merge `tools.ts` declares for the job
 * producer side; declaring it again here is harmless — TS module augmentation is idempotent — and
 * keeps this file typeable in isolation from `tools.ts`). */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    pbfuzz_fuzz: 'pbfuzz_fuzz'
  }
}

/**
 * Per-agent, per-`phase:round` consecutive-forced-continue counters. Module-level (not on `host`,
 * which is workspace/campaign-keyed, not agent-keyed, and has no notion of "how many times have we
 * nudged this exact agent without a real user turn in between") and a `WeakMap` so a disposed
 * agent's bookkeeping is not this module's problem to clean up.
 */
const forcedContinueCounts = new WeakMap<Agent, Map<string, number>>()

/** This agent's counter map, creating an empty one on first use. */
function countersFor(agent: Agent): Map<string, number> {
  const existing = forcedContinueCounts.get(agent)
  if (existing !== undefined) return existing
  const created = new Map<string, number>()
  forcedContinueCounts.set(agent, created)
  return created
}

/** Re-arm: a real user turn or a turn error means the next nudge starts counting from zero again. */
function resetForcedContinueCount(agent: Agent): void {
  forcedContinueCounts.delete(agent)
}

/**
 * Per-agent generation counter for in-flight headless `/pbfuzz run` dispatches (see the
 * `agent/inbox/inserted` listener below). Bumped on every dispatch so a settlement can tell
 * whether it is still the most recent one for this agent: a second `/pbfuzz run` arriving before
 * the first's self-check finishes must not let the first settlement's now-irrelevant verdict act
 * as though it were still current.
 */
const headlessRunGeneration = new WeakMap<Agent, number>()

/**
 * The one decision function shared by both nudging listeners: whether to force the agent to
 * continue the PIER loop right now, and if so, with what instruction.
 *
 * Every early `undefined` below is a legitimate "nothing to do", not a failure: no active campaign,
 * `autoContinue` off, a terminal phase, an unconfirmed campaign awaiting the user, or a fuzz job
 * already in flight (its own completion — via `finishFuzz` advancing the phase, and this module's
 * `onJobDone` listener — pushes things forward; forcing a continue now would just make the model
 * busy-poll).
 * @param ctx - plugin context (for `ctx.jobs`, read defensively since jobs is an optional peer).
 * @param host - the plugin's host state.
 * @param agent - the agent that just stopped, or whose job just finished.
 * @returns the nudge to send, or `undefined` when nothing should happen.
 */
function shouldForceContinue(ctx: Context, host: PbfuzzHost, agent: Agent): { message: string } | undefined {
  const active = host.active(agent as AgentLike)
  if (active === undefined) return undefined
  const settings = host.settings()
  if (!settings.budget.autoContinue) return undefined
  const state = host.state(active)
  const phase = state?.phase ?? 'INIT'
  if (phase === 'SUCCESS' || phase === 'STOPPED') return undefined
  if (phase === 'INIT' && active.campaign.confirmed !== true) return undefined
  const running = ctx.get('jobs')?.list(agent.id).some(job => job.kind === 'pbfuzz_fuzz' && job.status === 'running') ?? false
  if (running) return undefined

  const pierRound = state?.pier_round ?? 0
  const key = `${phase}:${pierRound}`
  const counters = countersFor(agent)
  const count = (counters.get(key) ?? 0) + 1
  counters.set(key, count)
  if (count > settings.budget.maxConsecutiveForcedContinues) {
    if (active.headless === true) {
      // Headless has no user to re-arm the counter, so a cap this deep means the run is genuinely
      // stuck; write a real terminal state rather than leaving the process idling forever. Never
      // let a write failure (disk full, permissions) escape into the caller's event listener —
      // there is no safe fallback state to write here anyway, only somewhere to log it.
      try {
        advancePhase(host, agent as AgentLike, active, 'STOPPED', {
          status: 'stopped: consecutive forced-continue cap reached in headless mode',
          current_task: '',
          next_action: '',
          stopReason: 'consecutive forced-continue cap reached; headless mode has no user to re-arm it',
        })
      } catch (error) {
        ctx.logger.warn(`pbfuzz: could not write STOPPED after the forced-continue cap in headless mode: ${(error as Error).message}`)
      }
    }
    // Interactive: just stop nudging. The model may legitimately be waiting on the user, and
    // writing STOPPED here would kill a campaign the user is about to steer by hand.
    return undefined
  }
  // Self-describing on purpose: this text is handed to `agent.steer()`/`owner.followup()` by a
  // caller that computes it now but may not deliver it until later (a `turn-stopping` steer lands
  // in the very next step, but `onJobDone`'s followup can be delayed behind whatever the owner is
  // already doing) — naming the campaign and the round it was computed for lets a reader notice a
  // message that arrived after the campaign moved on, instead of trusting phase/round-specific
  // instructions that no longer apply.
  return { message: `pbfuzz: continue the PIER loop — campaign ${active.campaign.id}, phase ${phase} round ${pierRound}/${settings.budget.maxPierRounds} — ${NEXT_STEP[phase]}` }
}

/** Concatenated text of every `text` content block, for matching the headless bootstrap prefix. */
function textOf(message: UserMessage): string {
  return message.content.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text).join('')
}

/** `/pbfuzz run <path>` verbatim, or the natural-language `run campaign <path>` variant. Both
 * resolve to the one registered `/pbfuzz` command line — this module never hand-rolls a second
 * implementation of `command.ts`'s own `run` handling. */
function headlessRunCommandLine(text: string): string | undefined {
  const direct = /^\s*\/pbfuzz\s+run\s+(\S+)/i.exec(text)
  if (direct !== null) return text.trim()
  const natural = /^\s*run\s+campaign\s+(\S+)/i.exec(text)
  return natural === null ? undefined : `/pbfuzz run ${natural[1]}`
}

/**
 * Install the PIER driver: the two nudging listeners and the headless bootstrap catch.
 * @param ctx - plugin context (host level).
 * @param host - the plugin's host state.
 */
export function installPierDriver(ctx: Context, host: PbfuzzHost): void {
  ctx.on('agent/error', ({ agent }) => { resetForcedContinueCount(agent) })

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source.kind !== 'user') return
    resetForcedContinueCount(agent)
    const line = headlessRunCommandLine(textOf(message))
    if (line === undefined) return
    const commands = ctx.get('commands')
    if (commands === undefined) return
    // `agent/inbox/inserted` is Cordis `@mode emit` (installed `@deepseek-ai/dsh-agent` runtime
    // types: the listener's return type is plain `void`), unlike `agent/turn-stopping`'s
    // `serial`/`Promise<void> | void`, which the machine really does await before its own boundary
    // commits. There is no way to make *this* listener async and have anything block on it, so
    // dispatching `commands.execute()` — which runs `runHeadless()`'s self-check, slow enough to
    // span turns the agent spends on other work — is unavoidably fire-and-forget from here. What
    // stays fully in this module's control is never treating the settlement as automatically still
    // current: snapshot the workspace's active campaign before dispatching, and the generation this
    // dispatch belongs to, then re-check both once the promise settles. A mismatch means the
    // workspace moved on while the self-check ran, and `runHeadless()`'s own next-step text (sent
    // via `command.ts`'s `send()`, already delivered by the time we can observe this) was computed
    // for a campaign that is no longer the live one — log it and take no further action on this
    // settlement rather than treat stale-by-construction state as current. A rejected dispatch is
    // logged too: `void` alone would swallow it as an unhandled rejection.
    const dispatchedActive = host.active(agent as AgentLike)
    const generation = (headlessRunGeneration.get(agent) ?? 0) + 1
    headlessRunGeneration.set(agent, generation)
    commands.execute(agent, line, [], new AbortController().signal).then(
      () => {
        if (headlessRunGeneration.get(agent) !== generation) {
          ctx.logger.warn(`pbfuzz: dropping headless "/pbfuzz run" settlement for ${agent.id} — superseded by a later run dispatch before this one settled`)
          return
        }
        const nowActive = host.active(agent as AgentLike)
        if (dispatchedActive !== undefined && dispatchedActive.campaign.id !== nowActive?.campaign.id) {
          ctx.logger.warn(`pbfuzz: dropping headless "/pbfuzz run" settlement for ${agent.id} — active campaign changed from ${dispatchedActive.campaign.id} to ${nowActive?.campaign.id ?? 'none'} while the self-check ran`)
        }
      },
      (error: unknown) => {
        ctx.logger.warn(`pbfuzz: headless "/pbfuzz run" dispatch failed for ${agent.id}: ${(error as Error).message}`)
      },
    )
  })

  // Serial/void: never return a truthy value, or every later listener (from other plugins) on
  // this same turn's stop boundary would be skipped.
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const decision = shouldForceContinue(ctx, host, agent)
    if (decision === undefined) return
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: decision.message }],
      source: { kind: 'pbfuzz', form: 'instructions' },
    }))
  })

  // jobs is an optional peer (registerTools already degrades gracefully without it); the wakeup
  // fallback below simply never fires until it loads.
  ctx.inject(['jobs'], (jctx) => {
    jctx.effect(() => jctx.jobs.events.subscribe({ owners: 'scope' }, (event) => {
      // Same filter `@deepseek-ai/dsh-tool-jobs` applies before it reports a completion itself: a
      // waiter already collected it (`awaited`), or the owner is gone (`teardown`).
      if (event.type !== 'settled' || event.job.kind !== 'pbfuzz_fuzz' || event.awaited || event.cause === 'teardown') return
      const ownerId = event.job.owner
      if (ownerId === undefined) return
      // Dispatch is synchronous across listeners: deferring one tick lets dsh-tool-jobs deliver its
      // own wake first, so the `status !== 'idle'` check below sees the owner it already woke and
      // this listener never double-nudges.
      queueMicrotask(() => {
        const owner = jctx.get('agents')?.get(ownerId)
        if (owner === undefined || owner.status !== 'idle') return
        const decision = shouldForceContinue(ctx, host, owner)
        if (decision === undefined) return
        owner.followup(createUserMessage({
          content: [{ type: 'text', text: decision.message }],
          source: { kind: 'pbfuzz', form: 'notice', summary: 'pbfuzz: fuzz job finished' },
        }))
      })
    }))
  })
}
