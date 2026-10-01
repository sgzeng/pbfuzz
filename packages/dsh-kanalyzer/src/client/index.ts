/**
 * dsh-kanalyzer, browser half: the kanalyzer settings card in the
 * `settings.plugin.item` slot, keyed on the `kanalyzer` namespace.
 *
 * The card renders only while the Host serves that namespace. It adds no Host-side
 * surface of its own: Build and Self-test dispatch the `/kanalyzer build` and
 * `/kanalyzer doctor` commands the Host half registers, and results come back through
 * the `status.*` fields that the Host writes with `settings.update()`.
 *
 * Only platform modules are value-imported (react, cordis, dsh-client-ui-*). Every
 * other `@deepseek-ai` import below is type-only, because the client bundle purity rule
 * forbids cross-plugin value imports. Cross-plugin work goes through cordis services.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only Context merges: ctx.locale, ctx.slots, ctx.settingsScope, ctx.remote, ctx.sessions,
// and the settings.plugin.item SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { KanalyzerSettings } from '../generated/contracts.ts'
import { KanalyzerCard } from './KanalyzerCard.tsx'
import { KANALYZER_NS, KanalyzerCardController, type KanalyzerCardHost } from './controller.ts'
import { LOCALE_NS, en, zh, type KanalyzerLocaleKey } from './locales.ts'
import { installStyles } from './styles.ts'

export { KANALYZER_NS, BUILD_COMMAND, DOCTOR_COMMAND } from './controller.ts'
export type {
  ActionState, CommandOutcome, FieldState, KanalyzerCardFace, KanalyzerCardHost, KanalyzerCardState, StatusView,
} from './controller.ts'
export type { KanalyzerCardProps } from './KanalyzerCard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The kanalyzer settings card's copy. */
    'settings.kanalyzer': KanalyzerLocaleKey
  }
}

/** Required services (cordis fiber inject). */
export const inject = [
  'slots', 'locale', 'remote', 'remote.session', 'remote.commands', 'remote.settings', 'sessions', 'settingsScope',
]

type SessionIdArg = Parameters<ClientContext['sessions']['open']>[0]

/**
 * Build the controller's DSH adapter over `ctx`.
 * @param ctx - this plugin's browser context.
 * @returns the host adapter.
 */
function hostOf(ctx: ClientContext): KanalyzerCardHost {
  return {
    // ctx.sessions.create wraps remote.session.create and also records the new session
    // in the list store, so the sessions.open() that follows can find it straight away.
    createSession: async cwd => String(await ctx.sessions.create(cwd === undefined ? {} : { cwd })),
    executeCommand: async (sessionId, line) => {
      const result = await ctx.remote.commands.execute(sessionId as SessionIdArg, line, [])
      if (!result.ok) return { kind: 'refused', message: `${result.error.code}: ${result.error.message}` }
      if (result.value === undefined) return { kind: 'unknown' }
      const outcome = result.value.result
      return { kind: 'admitted', failed: outcome.kind === 'error', text: outcome.text ?? '' }
    },
    openSession: (sessionId) => { ctx.sessions.open(sessionId as SessionIdArg) },
    // The Host has no push channel for status: re-read the document and fold
    // our namespace's view into the shared mirror every scope derives from.
    reloadSettings: async () => {
      const response = await ctx.remote.settings.describe()
      if (!response.ok) return false
      const view = response.value.namespaces.find(candidate => candidate.ns === KANALYZER_NS)
      if (view === undefined) return false
      ctx.settingsScope.describe().acceptView(view)
      return true
    },
  }
}

/**
 * Mount the kanalyzer settings card.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-kanalyzer: card dictionaries')
  ctx.effect(() => installStyles(), 'dsh-kanalyzer: card styles')

  const card = new KanalyzerCardController(
    ctx.settingsScope.bind<KanalyzerSettings>({ namespace: KANALYZER_NS }),
    hostOf(ctx),
  )
  ctx.effect(() => () => { card.dispose() }, 'dsh-kanalyzer: card controller')

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: KANALYZER_NS,
    locale: LOCALE_NS,
    inject: () => card.inject(),
  }, KanalyzerCard))
}
