/**
 * The `pbfuzz` settings namespace: the schemastery `Config` derived from
 * `contracts/pbfuzz-settings.schema.json`, and the reader that turns the loader's config into plain
 * `PbfuzzSettings`.
 *
 * DSH ≥ 0.2 edits plugin settings through the plugin's own Loader entry (`pbfuzz` in the profile's
 * `cordis.patch.yml`), and only exposes fields declared `.volatile()`: the loader hands the plugin a
 * live `Volatile<T>` reference per such field and updates it in place when the user edits the
 * form. Every leaf below is therefore volatile; {@link resolveSettings} reads the references.
 *
 * @module @pbfuzz/dsh-pbfuzz/settings
 */

import z from '@deepseek-ai/schemastery'
import type { PbfuzzSettings } from './core/contracts.ts'

/** Namespace key, shared with the W6 card. */
export const PBFUZZ_SETTINGS_NS = 'pbfuzz'

/**
 * Schemastery form of `pbfuzz-settings.schema.json`. Field-for-field; defaults and bounds copied
 * verbatim. `tests/phases-registry-misc.spec.ts` ("Config schema mirrors pbfuzz-settings.schema.json
 * defaults") checks it against the JSON schema.
 */
export const SettingsSchema: z<PbfuzzSettings> = z.object({
  tools: z.object({
    staticAnalysis: z.union(['off', 'kanalyzer'] as const).default('off').volatile()
      .description('Static analysis provider. `kanalyzer` needs the dsh-kanalyzer plugin installed.'),
    corpusAnalysis: z.boolean().default(true).volatile(),
    deviationDetection: z.boolean().default(true).volatile()
      .description('Needs static analysis for critical-BB mode; degrades to target-only without it.'),
    tracer: z.union(['auto', 'gdb', 'lldb', 'pymon', 'jdb', 'off'] as const).default('auto').volatile(),
    interactiveDebug: z.boolean().default(true).volatile(),
  }).description('Which auxiliary analysis tools are enabled.'),
  budget: z.object({
    maxPierRounds: z.natural().min(1).max(100).default(5).volatile(),
    campaignWallTimeMin: z.natural().min(1).default(30).volatile(),
    autoContinue: z.boolean().default(true).volatile(),
    maxConsecutiveForcedContinues: z.natural().min(1).max(20).default(3).volatile(),
  }),
  fuzzing: z.object({
    maxIters: z.natural().min(1).default(1000).volatile(),
    execTimeoutSec: z.number().min(Number.MIN_VALUE).default(3).volatile(),
    fuzzTimeoutSec: z.number().min(Number.MIN_VALUE).default(600).volatile(),
    generatorTimeoutSec: z.number().min(Number.MIN_VALUE).default(1).volatile(),
    stage1MinConcreteParams: z.natural().default(5).volatile(),
    enableDebuggerForAll: z.boolean().default(false).volatile(),
  }),
  onboarding: z.object({
    interviewPolicy: z.union(['always', 'when-missing', 'never'] as const).default('when-missing').volatile(),
    deriveTargetFrom: z.array(z.union(['patch', 'cve', 'crashTrace'] as const)).default(['patch', 'cve', 'crashTrace']).volatile(),
    defaultOutputRoot: z.string().default('.pbfuzz').volatile(),
    confirmTimeoutMin: z.natural().min(0).default(0).volatile(),
  }),
  oracleDefaults: z.object({
    canaryOnTrigger: z.union(['abort', 'log'] as const).default('log').volatile(),
    reachedPattern: z.string().default('PBFUZZ_REACHED:\\s*(\\S+)').volatile(),
    triggeredPattern: z.string().default('PBFUZZ_TRIGGERED:\\s*(\\S+)').volatile(),
  }),
  execution: z.object({
    pythonPath: z.string().default('python3').volatile(),
    gdbPath: z.string().default('gdb').volatile(),
    generatorMemLimitMB: z.natural().min(16).default(512).volatile(),
    generatorCpuLimitSec: z.natural().min(1).default(10).volatile(),
    logLevel: z.union(['error', 'warn', 'info', 'debug'] as const).default('info').volatile(),
    fuzzBackground: z.boolean().default(true).volatile(),
  }),
  guards: z.object({
    bashGuard: z.boolean().default(true).volatile(),
    tamperLedger: z.boolean().default(true).volatile(),
    hideToolsWithoutCampaign: z.boolean().default(false).volatile(),
  }),
  status: z.object({
    envSelfcheck: z.object({
      checkedAt: z.string().default(''),
      ttlExpiresAt: z.string().default(''),
      overall: z.union(['', 'pass', 'warn', 'fail'] as const).default(''),
      items: z.array(z.object({
        name: z.string().default(''),
        status: z.union(['pass', 'warn', 'fail', 'disabled', 'skipped'] as const).default('pass'),
        reason: z.string().default(''),
      })).default([]),
    }).default({ checkedAt: '', ttlExpiresAt: '', overall: '', items: [] }).volatile(),
  }),
}) as unknown as z<PbfuzzSettings>

/** The `get()` half of the loader's `Volatile<T>` reference (`@deepseek-ai/cordis` exports only the type). */
function isReference(value: unknown): value is { get(): unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/**
 * Replace every `Volatile` reference in a parsed config with its current snapshot.
 * @param value - parsed config, a snapshot, or plain input.
 * @returns the same shape with plain data only.
 */
function unwrap(value: unknown): unknown {
  if (isReference(value)) return unwrap(value.get())
  if (Array.isArray(value)) return value.map(unwrap)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unwrap(entry)]))
  }
  return value
}

/**
 * Read settings as plain data: the loader's live config (volatile references, read at call time so
 * form edits show up immediately) or a partial plain value, with every default filled.
 * @param value - the plugin's Loader config, or plain/partial settings.
 * @returns resolved settings.
 */
export function resolveSettings(value: unknown): PbfuzzSettings {
  return unwrap(SettingsSchema(unwrap(value ?? {}) as PbfuzzSettings)) as PbfuzzSettings
}
