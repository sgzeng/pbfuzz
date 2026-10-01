/**
 * pbfuzz browser half: the `pbfuzz` settings card (slot `settings.plugin.item`,
 * keyed by the namespace) and the campaign dashboard (slot
 * `conversation.session.header.utilities`, session scope, so it receives the
 * `useProjection` standard prop and reads the `pbfuzz` session projection).
 * Built by `scripts/bundle-client.mjs` into the classic-script factory
 * `lib/client.js`; every DSH import below except the baseline externals (react,
 * cordis, client-store, ui-slots, ui-primitives) is type-only, which the
 * bundle-purity check enforces.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: the session-header utilities slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the Session standard kit's `useProjection` seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: ctx.remote.commands/settings and ctx.sessions.create — the Self-check button's
// dispatch-then-reload transport, mirroring dsh-kanalyzer's client/index.ts `hostOf()` exactly.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type { PbfuzzDashboardView } from './dashboard-contract.ts'
import { PbfuzzDashboardPanel } from './DashboardPanel.tsx'
import { en, NS, zh, type PbfuzzKey } from './locales.ts'
import { PbfuzzCardController, type CommandOutcome, type PbfuzzCardHost } from './settings-card.ts'
import { PBFUZZ_SETTINGS_NS } from './settings-model.ts'
import { PbfuzzSettingsCard } from './SettingsCard.tsx'
import { installPbfuzzStyles } from './styles.ts'

export type { PbfuzzCardFace, PbfuzzCardState, KanalyzerPresence } from './settings-card.ts'
export type { PbfuzzDashboardView } from './dashboard-contract.ts'

type SessionIdArg = Parameters<ClientContext['sessions']['open']>[0]

/**
 * Build the Self-check button's DSH adapter over `ctx`. Mirrors dsh-kanalyzer's client/index.ts
 * `hostOf()` (its Build/Self-test buttons dispatch-then-reload the same way), with one
 * simplification: `PbfuzzCardHost.executeCommand` takes no session id (the settings card has no
 * natural "current session" the way a session-scoped Build flow does), so this creates one
 * throwaway session per dispatch — `/pbfuzz selfcheck` is a short-lived, stateless command
 * (env ping/version/sandbox round trip only), so a fresh session per click costs nothing a user
 * would notice and needs no lifecycle management afterward.
 * @param ctx - this plugin's browser context.
 * @returns the host adapter.
 */
function hostOf(ctx: ClientContext): PbfuzzCardHost {
  return {
    executeCommand: async (line): Promise<CommandOutcome> => {
      const sessionId = await ctx.sessions.create({}) as SessionIdArg
      const result = await ctx.remote.commands.execute(sessionId, line, [])
      if (!result.ok) return { kind: 'refused', message: `${result.error.code}: ${result.error.message}` }
      if (result.value === undefined) return { kind: 'unknown' }
      const outcome = result.value.result
      return { kind: 'admitted', failed: outcome.kind === 'error', text: outcome.text ?? '' }
    },
    // The Host has no push channel for status: re-read the document and fold our namespace's
    // view into the shared mirror every scope derives from (same as dsh-kanalyzer's reload).
    reloadSettings: async () => {
      const response = await ctx.remote.settings.describe()
      if (!response.ok) return false
      const view = response.value.namespaces.find(candidate => candidate.ns === PBFUZZ_SETTINGS_NS)
      if (view === undefined) return false
      ctx.settingsScope.describe().acceptView(view)
      return true
    },
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** pbfuzz card + dashboard copy. */
    pbfuzz: PbfuzzKey
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Same entry the host half merges in src/projection.ts. */
    pbfuzz: PbfuzzDashboardView | null
  }
}

/** Plugin name. */
export const name = 'pbfuzz-client'

/** Required services: slots + locale for UI, settingsScope (and its `remote` transport) for the card. */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'remote.commands', 'remote.settings', 'sessions', 'settingsScope']

/**
 * Register the settings card and the dashboard.
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  installPbfuzzStyles(ctx)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'pbfuzz: dictionaries')

  const card = new PbfuzzCardController(
    ctx.settingsScope.bind<unknown>({ namespace: PBFUZZ_SETTINGS_NS }),
    ctx.settingsScope.describe(),
    hostOf(ctx),
  )
  ctx.effect(() => () => { card.dispose() }, 'pbfuzz: settings card')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: PBFUZZ_SETTINGS_NS,
    locale: NS,
    inject: () => card.inject(),
  }, PbfuzzSettingsCard))

  // No inject face: the live campaign arrives through useProjection('pbfuzz').
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'pbfuzz-dashboard',
    order: 50,
    locale: NS,
  }, PbfuzzDashboardPanel))
}
