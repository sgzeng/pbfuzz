/**
 * The `pbfuzz` settings namespace: the schemastery `Config` derived from
 * `contracts/pbfuzz-settings.schema.json`, host-level registration, and the snapshot writer.
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
    staticAnalysis: z.union(['off', 'kanalyzer'] as const).default('off')
      .description('Static analysis provider. `kanalyzer` needs the dsh-kanalyzer plugin installed.'),
    corpusAnalysis: z.boolean().default(true),
    deviationDetection: z.boolean().default(true)
      .description('Needs static analysis for critical-BB mode; degrades to target-only without it.'),
    tracer: z.union(['auto', 'gdb', 'lldb', 'pymon', 'jdb', 'off'] as const).default('auto'),
    interactiveDebug: z.boolean().default(true),
  }).description('Which auxiliary analysis tools are enabled.'),
  budget: z.object({
    maxPierRounds: z.natural().min(1).max(100).default(5),
    campaignWallTimeMin: z.natural().min(1).default(30),
    autoContinue: z.boolean().default(true),
    maxConsecutiveForcedContinues: z.natural().min(1).max(20).default(3),
  }),
  fuzzing: z.object({
    maxIters: z.natural().min(1).default(1000),
    execTimeoutSec: z.number().min(Number.MIN_VALUE).default(3),
    fuzzTimeoutSec: z.number().min(Number.MIN_VALUE).default(600),
    generatorTimeoutSec: z.number().min(Number.MIN_VALUE).default(1),
    stage1MinConcreteParams: z.natural().default(5),
    enableDebuggerForAll: z.boolean().default(false),
  }),
  onboarding: z.object({
    interviewPolicy: z.union(['always', 'when-missing', 'never'] as const).default('when-missing'),
    deriveTargetFrom: z.array(z.union(['patch', 'cve', 'crashTrace'] as const)).default(['patch', 'cve', 'crashTrace']),
    defaultOutputRoot: z.string().default('.pbfuzz'),
    confirmTimeoutMin: z.natural().min(0).default(0),
  }),
  oracleDefaults: z.object({
    canaryOnTrigger: z.union(['abort', 'log'] as const).default('log'),
    reachedPattern: z.string().default('PBFUZZ_REACHED:\\s*(\\S+)'),
    triggeredPattern: z.string().default('PBFUZZ_TRIGGERED:\\s*(\\S+)'),
  }),
  execution: z.object({
    pythonPath: z.string().default('python3'),
    gdbPath: z.string().default('gdb'),
    generatorMemLimitMB: z.natural().min(16).default(512),
    generatorCpuLimitSec: z.natural().min(1).default(10),
    logLevel: z.union(['error', 'warn', 'info', 'debug'] as const).default('info'),
    fuzzBackground: z.boolean().default(true),
  }),
  guards: z.object({
    bashGuard: z.boolean().default(true),
    tamperLedger: z.boolean().default(true),
    hideToolsWithoutCampaign: z.boolean().default(false),
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
    }).default({ checkedAt: '', ttlExpiresAt: '', overall: '', items: [] }),
  }),
}) as unknown as z<PbfuzzSettings>

/**
 * Resolve a (possibly partial) value to full settings with every default filled.
 * @param value - raw section or composition entry.
 * @returns resolved settings.
 */
export function resolveSettings(value: unknown): PbfuzzSettings {
  return SettingsSchema((value ?? {}) as PbfuzzSettings)
}
