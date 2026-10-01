/**
 * The `/pbfuzz` human command.
 *
 * - `/pbfuzz [notes]` — start a campaign: the notes are queued as the user's own turn (they are
 *   the request, and the session title is derived from them), and pbfuzz's procedure rides the
 *   same step as plugin-sourced context.
 * - `/pbfuzz run <campaign.yaml>` — headless: load a hand-written, confirmed campaign and start PIER.
 * - `/pbfuzz selfcheck` — the settings card's Self-check button: run the environment self-check now.
 * - `/pbfuzz status` — print the campaign status.
 *
 * **Why the two messages have different sources.** A DSH `UserMessage` carries a `MessageSource`,
 * and the client renders by its `kind`: `user` is the human's own chat bubble (always expanded,
 * and the only kind `dsh-session-title` will derive a title from), while `plugin` is a collapsed
 * "Context injection · pbfuzz" row. Sending pbfuzz's own procedure as `kind: 'user'` therefore
 * put a wall of internal instructions in the transcript as if the human had typed it, and made
 * the session title a fragment of that text instead of the actual request. Producer identity is
 * `kind`; `form: 'instructions'` says what the content *is* — the same pair `pier-driver.ts`
 * already uses for its PIER nudges.
 *
 * **Why the procedure is staged, not sent.** The loop's inbox claims the WHOLE `next-step` queue
 * but exactly ONE `next-turn` message per turn (`ReactLoopInbox.claim`), so two `followup()` calls
 * can never share a turn. Sending both that way put the procedure a full turn behind the request
 * it describes: in a recorded session the campaign ran to completion without it, and the 8.9 KB
 * arrived at the top of the next turn as a manual for work already done. `stageInstructions`
 * therefore queues it on `next-step` WITHOUT a wake, before `sendUser` opens the turn — so the
 * turn's first step claims both, procedure first, request second.
 *
 * @module @pbfuzz/dsh-pbfuzz/command
 */

import { runHeadless, status } from './campaign-flow.ts'
import { readOrRunEnvSelfcheck, type EnvSelfcheckCache } from './env-selfcheck.ts'
import type { AgentLike, PbfuzzHost } from './host.ts'

/** Minimal command registry view. */
interface CommandsLike {
  register(def: {
    name: string
    description: string
    input?: { hint: string }
    handler(inv: { agent: unknown; rawInput: string; signal: AbortSignal }): Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
  }): () => void
}

/** What `registerCommand` needs from the plugin body. */
export interface CommandDeps {
  host: PbfuzzHost
  /** Queue text as the human's own turn (`source.kind: 'user'`). */
  sendUser(agent: unknown, text: string): void
  /**
   * Queue pbfuzz-sourced context (`source.kind: 'plugin'`, `form: 'instructions'`) as its own
   * turn. For text that has no accompanying user message to ride along with.
   */
  sendInstructions(agent: unknown, text: string): void
  /**
   * Queue the same kind of context on the *step* inbox without waking the agent, so the turn
   * `sendUser` opens next claims it alongside the user's own message.
   */
  stageInstructions(agent: unknown, text: string): void
  /** The bundled `pbfuzz` skill body, injected up front so onboarding needs no `skill` round trip. */
  skillBody: string
  /** Persist a freshly-run environment self-check to `settings.status.envSelfcheck`. */
  writeEnvSelfcheckCache?(cache: EnvSelfcheckCache): void
}

/** The one line that frames the injected skill body. */
const INSTRUCTION_HEADER = 'pbfuzz campaign procedure — this is the complete `pbfuzz` skill, '
  + 'already loaded. Follow it for the request in this turn; do not call `skill` for it.'

/**
 * Register `/pbfuzz`.
 * @param commands - `ctx.commands`.
 * @param deps - host state and the two message channels.
 */
export function registerCommand(commands: CommandsLike, deps: CommandDeps): void {
  const { host } = deps
  commands.register({
    name: 'pbfuzz',
    description: 'Start a pbfuzz directed-fuzzing campaign (campaign yaml → confirm → PIER)',
    input: { hint: '[run <campaign.yaml> | selfcheck | status | what to reproduce]' },
    async handler({ agent, rawInput, signal }) {
      const a = agent as AgentLike
      const input = rawInput.trim()
      const flow = { host, agent: a, asker: undefined, signal }

      if (input === 'status') return { kind: 'success', text: JSON.stringify(status(flow), null, 2) }

      if (input === 'selfcheck') {
        // Always fresh: someone who just fixed their environment and pressed the button expects
        // to see that, so the TTL cache is bypassed (`cached: undefined`) rather than consulted.
        try {
          const outcome = await readOrRunEnvSelfcheck({
            ping: async () => await host.engine.call('ping', {}, signal) as { engineVersion: string; contractsVersion: string; python: string },
            engine: async version => await host.engine.call('selfcheck.engine', { contractsVersion: version }, signal) as never,
          }, undefined)
          deps.writeEnvSelfcheckCache?.(outcome.cache)
          const item = outcome.item
          return item.status === 'fail'
            ? { kind: 'error', text: `pbfuzz environment self-check failed: ${item.reason ?? 'no reason reported'}` }
            : { kind: 'success', text: `pbfuzz environment self-check ${item.status}${item.reason !== undefined ? `: ${item.reason}` : ''}` }
        } catch (error) {
          return { kind: 'error', text: `pbfuzz environment self-check could not run: ${(error as Error).message}` }
        }
      }

      if (input.startsWith('run')) {
        const path = input.slice(3).trim()
        if (path === '') return { kind: 'error', text: 'usage: /pbfuzz run <campaign.yaml>' }
        const outcome = await runHeadless(flow, path)
        if (!outcome.ok) {
          process.exitCode = 1
          return { kind: 'error', text: outcome.diagnosis ?? 'could not start the campaign' }
        }
        deps.sendInstructions(agent, outcome.nextInstruction!)
        return { kind: 'success', text: `campaign ${outcome.campaignId}: confirmed, PIER started` }
      }

      // Onboarding. The notes are the user's own request — queued as their turn, so the model
      // sees what was actually asked and the session title comes from it. pbfuzz's procedure is
      // staged on the step inbox FIRST so that same turn's first step claims both (see the module
      // doc: one `followup` per turn, so two of them would split across turns).
      const procedure = `${INSTRUCTION_HEADER}\n\n${deps.skillBody}`
      if (input === '') {
        // No request to ride along with, so the procedure has to open the turn itself.
        deps.sendInstructions(agent, procedure)
      } else {
        deps.stageInstructions(agent, procedure)
        deps.sendUser(agent, input)
      }
      return { kind: 'success', text: 'pbfuzz campaign started' }
    },
  })
}
