/**
 * `dsh-pbfuzz` — PBFuzz as a DeepSeek Harness plugin (host half).
 *
 * Registers the `pbfuzz` settings section at host level, the model-facing `pbfuzz_*` tools, the
 * `/pbfuzz` command, the dashboard projection, the bundled skills, and — only while kanalyzer is
 * loaded — the kanalyzer analysis provider. Enforcement (phase gating, state writes, the bash
 * tamper ledger) is wired by `guards.ts`; unattended PIER advance is wired by `pier-driver.ts`.
 *
 * @module @pbfuzz/dsh-pbfuzz
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-user-questions'
import z from '@deepseek-ai/schemastery'
import { registerCommand } from './command.ts'
import type { EnvSelfcheckCache } from './env-selfcheck.ts'
import type { KanalyzerService, PbfuzzSettings } from './core/contracts.ts'
import { KanalyzerProvider } from './core/kanalyzer-provider.ts'
import { engineEnv } from './engine-bridge.ts'
import { installGuards } from './guards.ts'
import { PbfuzzHost, type AgentLike } from './host.ts'
import { installPierDriver } from './pier-driver.ts'
import { registerProjection } from './projection.ts'
import { PBFUZZ_SETTINGS_NS, resolveSettings, SettingsSchema } from './settings.ts'
import { loadSkills, registerSkills } from './skills.ts'
import { registerTools } from './tools.ts'

export type * from './core/contracts.ts'
export { ProviderRegistry } from './core/registry.ts'

/**
 * `ctx.kanalyzer`'s real type (`@pbfuzz/dsh-kanalyzer`'s `KanalyzerRuntime`) is deliberately not a
 * source dependency of this package — `core/contracts.ts`'s whole `KanalyzerService`/
 * `AnalysisProvider` split exists so pbfuzz only ever depends on the frozen, restated shape it
 * actually uses (see that module's own doc comment). This is the loose-coupling side of that same
 * choice: declaring `Context.kanalyzer` ourselves, with our own interface, is what lets
 * `ctx.inject(['kanalyzer'], …)` below type-check with no `any`/`unknown` escape hatch, without
 * pulling in kanalyzer's own types. `KanalyzerRuntime implements KanalyzerService`
 * (`packages/dsh-kanalyzer/src/host/runtime.ts`), so this is exactly the type the real service
 * object already satisfies.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    kanalyzer: KanalyzerService
  }
  interface Events {
    /**
     * Restated from `@deepseek-ai/cordis-plugin-loader` (a transitive dependency of DSH, not ours):
     * emitted to the owning fiber after the loader commits an edit to this entry's `.volatile()`
     * config fields. Identical signature, so the two declarations merge.
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** pbfuzz's own procedure text and job notices (DSH ≥ 0.2: each producer declares its own source kind). */
    pbfuzz: { kind: 'pbfuzz' } & ContextFormed
  }
}

export const name = 'pbfuzz'
export const inject = ['tools']

/** Plugin config: the `pbfuzz` Loader entry (every leaf is a live `Volatile` reference at runtime). */
export type Config = PbfuzzSettings

/** Schemastery `Config`, identical to the settings section schema. */
export const Config: z<Config> = SettingsSchema

/** Package root (`lib/index.js` → `..`), where `skills/` ships. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Plugin body.
 * @param ctx - host-level context.
 * @param config - composition entry for the settings section.
 */
export function apply(ctx: Context, config: Config): void {
  // The loader hands over live `Volatile` references. Settings are resolved once and re-resolved
  // after the loader commits a form edit (`loader/volatile-update`, below) — guards read them on
  // every tool call, so they are not re-parsed per read.
  let resolved: PbfuzzSettings | undefined
  const current = (): PbfuzzSettings => (resolved ??= resolveSettings(config))
  const host = new PbfuzzHost(
    current,
    { info: m => { ctx.logger.info(m) }, warn: m => { ctx.logger.warn(m) } },
    () => new Set(ctx.tools.schemas().map(s => s.name)),
    // PYTHONPATH=<engine dir> so `python -m pbfuzz_engine.rpc` runs without a pip install.
    engineEnv(PACKAGE_ROOT),
  )
  ctx.effect(() => () => { host.dispose() })

  const warnOnInconsistentSettings = (): void => {
    const { tools } = current()
    if (tools.deviationDetection && tools.staticAnalysis === 'off' && tools.tracer === 'off') {
      ctx.logger.warn('pbfuzz: deviation detection needs the tracer; enable a tracer or turn deviation detection off')
    }
  }
  warnOnInconsistentSettings()

  // Settings (DSH ≥ 0.2): this entry's volatile fields are edited in place; the loader announces
  // the change to the owning fiber instead of calling a plugin-supplied `onChange`.
  ctx.on('loader/volatile-update', () => {
    resolved = undefined
    warnOnInconsistentSettings()
    host.onSettingsChanged()
  })
  // pbfuzz ships its own settings card, so the generic schema-generated page stays off.
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
  })

  // `settings.update()` is ns-addressed (the ns is this plugin's Loader entry id, `pbfuzz`), so a
  // lazy `ctx.get('settings')` at call time (well after `apply()` returns, by which point the
  // settings service is loaded if composed at all) reaches it directly. `update()` is a merge
  // patch: `{status:{envSelfcheck: cache}}` leaves every other settings field untouched, so no
  // read-modify-write race with a concurrent user edit.
  const writeEnvSelfcheckCache = (cache: EnvSelfcheckCache): void => {
    const settings = ctx.get('settings')
    if (settings === undefined) return // no settings provider composed; nothing to persist into.
    void settings.update(PBFUZZ_SETTINGS_NS, { status: { envSelfcheck: cache } }).catch((error: Error) => {
      ctx.logger.warn(`pbfuzz: could not persist the environment self-check cache: ${error.message}`)
    })
  }

  registerTools(ctx, host)
  ctx.inject(['sessionProjections'], (pctx) => { registerProjection(pctx.sessionProjections) })

  // Apply tool visibility the moment an agent exists. Before, restrict() first ran on the first
  // pbfuzz tool call, so a fresh session listed every pbfuzz tool (hideToolsWithoutCampaign had no
  // effect on the first step).
  ctx.on('agent/created', ({ agent }) => {
    try { host.refresh(agent as AgentLike) } catch (error) { ctx.logger.warn(`pbfuzz: tool visibility for a new agent failed: ${(error as Error).message}`) }
    return undefined
  })

  const skills = loadSkills(join(PACKAGE_ROOT, 'skills'))
  ctx.inject(['skills'], (skctx) => {
    registerSkills(skctx.skills, skills)
  })

  /** pbfuzz's own procedure text, as the collapsed "Context injection · pbfuzz" row. */
  const instructionMessage = (text: string): ReturnType<typeof createUserMessage> => createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'pbfuzz', form: 'instructions' },
  })

  ctx.inject(['commands'], (cctx) => {
    registerCommand(cctx.commands, {
      host,
      sendUser: (agent, text) => {
        (agent as Agent).followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      },
      sendInstructions: (agent, text) => {
        (agent as Agent).followup(instructionMessage(text))
      },
      stageInstructions: (agent, text) => {
        (agent as Agent).inject(instructionMessage(text))
      },
      skillBody: skills.find(s => s.name === 'pbfuzz')?.content ?? '',
      writeEnvSelfcheckCache,
    })
  })

  // Everything kanalyzer-dependent lives in this fiber and unloads with kanalyzer.
  ctx.inject(['kanalyzer'], (kctx) => {
    const registration = host.providers.register(new KanalyzerProvider(kctx.kanalyzer))
    kctx.effect(() => () => { registration.dispose() })
  })

  // The one native ctx.tools.guard() registration, plus the bash tamper audit ledger.
  installGuards(ctx, host)
  // Unattended PIER advance, the headless `/pbfuzz run <path>` bootstrap catch, and the campaign
  // status banner.
  installPierDriver(ctx, host)
}
