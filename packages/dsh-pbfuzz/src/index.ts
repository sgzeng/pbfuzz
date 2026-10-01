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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
}

export const name = 'pbfuzz'
export const inject = ['tools']

/** Plugin config: the composition entry for the `pbfuzz` settings section. */
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
  const entry = resolveSettings(config)
  const host = new PbfuzzHost(
    () => entry,
    { info: m => { ctx.logger.info(m) }, warn: m => { ctx.logger.warn(m) } },
    () => new Set(ctx.tools.schemas().map(s => s.name)),
    // PYTHONPATH=<engine dir> so `python -m pbfuzz_engine.rpc` runs without a pip install.
    engineEnv(PACKAGE_ROOT),
  )
  ctx.effect(() => () => { host.dispose() })

  // Settings: host-level section; falls back to the composition entry without a provider.
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(ctx, PBFUZZ_SETTINGS_NS, SettingsSchema, entry, {
      setSource: (current: () => PbfuzzSettings) => { host.setSettingsSource(current) },
      onChange: () => { host.onSettingsChanged() },
      validate: (value: PbfuzzSettings) => {
        if (value.tools.deviationDetection && value.tools.staticAnalysis === 'off' && value.tools.tracer === 'off') {
          throw new Error('deviation detection needs the tracer; enable a tracer or turn deviation detection off')
        }
      },
    })
  })

  // `SettingsProvider.update()` is a top-level method (ns-addressed, not tied to the
  // `SettingsScope` `installSection()` keeps to itself), so this needs no reference to the
  // `sctx` the block above captured — a lazy `ctx.get('settings')` at call time (well after
  // `apply()` returns, by which point the settings service is loaded if composed at all) reaches
  // it directly. `update()` is a merge patch: `{status:{envSelfcheck: cache}}` leaves every
  // other settings field untouched, so no read-modify-write race with a concurrent user edit.
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
  })

  const skills = loadSkills(join(PACKAGE_ROOT, 'skills'))
  ctx.inject(['skills'], (skctx) => {
    registerSkills(skctx.skills, skills)
  })

  /** pbfuzz's own procedure text, as the collapsed "Context injection · pbfuzz" row. */
  const instructionMessage = (text: string): ReturnType<typeof createUserMessage> => createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'pbfuzz', form: 'instructions' },
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
