/**
 * The `kanalyzer` settings namespace: schemastery `Config` mirroring
 * `contracts/kanalyzer-settings.schema.json`, and the read-only `status.*` write-back.
 *
 * @module @pbfuzz/dsh-kanalyzer/host/settings
 */

import z from '@deepseek-ai/schemastery'
import type { KanalyzerSettings } from '../generated/contracts.ts'
import { BUILTIN_DEFAULTS, type OptionDefaults } from '../core/options.ts'

/** The settings namespace; W8's card registers under the same key. */
export const KANALYZER_NS = 'kanalyzer'

/** Fully-defaulted settings (every optional field of the generated type filled). */
export interface Config {
  install: Required<NonNullable<KanalyzerSettings['install']>>
  defaults: Required<Omit<NonNullable<KanalyzerSettings['defaults']>, 'dumps'>> & { dumps: OptionDefaults['dumps'] }
  standalone: Required<NonNullable<KanalyzerSettings['standalone']>>
  status: Required<NonNullable<KanalyzerSettings['status']>>
}

const b = (v: boolean): z<boolean> => z.boolean().default(v).volatile() as unknown as z<boolean>

/**
 * Schemastery schema; defaults are identical to the frozen JSON schema (checked by tests/contract-parity.spec.ts for the analysis defaults).
 *
 * DSH ≥ 0.2 edits a plugin's settings through its own Loader entry and exposes only `.volatile()`
 * fields, so every leaf is volatile; the loader hands the plugin a live `Volatile<T>` reference per
 * leaf. Read them through {@link resolveConfig}.
 */
export const Config: z<Config> = z.object({
  install: z.object({
    installDir: z.string().default('~/.dsh/kanalyzer').volatile().description('The clone lands at `<installDir>/kernel-analyzer`.'),
    repoUrl: z.string().default('https://github.com/sgzeng/kernel-analyzer.git').volatile(),
    branch: z.string().default('mzt').volatile(),
    llvmPrefix: z.string().default('').volatile().description('Empty = auto-detect; prefers /usr/lib/llvm-14.'),
    buildType: z.union(['Release', 'RelWithDebInfo', 'Debug'] as const).default('Release').volatile(),
    jobs: z.natural().default(0).volatile().description('0 = nproc.'),
    wllvmBinDir: z.string().default('').volatile().description('Directory holding wllvm/wllvm++/extract-bc, prepended to PATH for a wllvm build. Empty = rely on the host PATH.'),
  }).default({} as Config['install']),
  defaults: z.object({
    verbose: z.natural().max(3).default(BUILTIN_DEFAULTS.verbose).volatile(),
    callStackLen: z.natural().min(1).default(BUILTIN_DEFAULTS.callStackLen).volatile(),
    useTypeBasedCallGraph: b(BUILTIN_DEFAULTS.useTypeBasedCallGraph),
    dumps: z.object({
      policy: b(true), distance: b(true), criticalBranch: b(true),
      bidMappingAndFuncInfo: b(true), callerCalleeBothWays: b(true), annotatedIr: b(false),
    }).default({} as Config['defaults']['dumps']),
    timeoutSec: z.natural().min(1).default(BUILTIN_DEFAULTS.timeoutSec).volatile(),
    memLimitMB: z.natural().min(256).default(BUILTIN_DEFAULTS.memLimitMB).volatile(),
    cacheEnabled: b(true),
    prepareMode: z.union(['wllvm', 'lto'] as const).default('wllvm').volatile().description('Mode used when kanalyzer_prepare omits `mode`. wllvm survives build systems that drop LDFLAGS; lto is the fast path for small projects.'),
  }).default({} as Config['defaults']),
  standalone: z.object({
    inputFilenames: z.array(z.string()).default([]).volatile(),
    targetList: z.array(z.string()).default([]).volatile(),
    entryList: z.array(z.string()).default([]).volatile(),
  }).default({} as Config['standalone']),
  status: z.object({
    installed: b(false),
    binaryPath: z.string().default('').volatile(),
    commit: z.string().default('').volatile(),
    llvmVersion: z.string().default('').volatile(),
    lastDoctor: z.union(['', 'pass', 'fail'] as const).default('').volatile(),
    lastDoctorAt: z.string().default('').volatile(),
    lastDoctorMessage: z.string().default('').volatile(),
    lastWllvm: z.union(['', 'pass', 'fail'] as const).default('').volatile(),
    lastWllvmAt: z.string().default('').volatile(),
    lastWllvmMessage: z.string().default('').volatile(),
    wllvmBinDir: z.string().default('').volatile(),
  }).default({} as Config['status']),
}) as unknown as z<Config>

/** The `get()` half of the loader's `Volatile<T>` reference (`@deepseek-ai/cordis` exports only the type). */
function isReference(value: unknown): value is { get(): unknown } {
  return typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function'
}

/** Replace every `Volatile` reference in a parsed config with its current snapshot. */
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
export function resolveConfig(value: unknown = {}): Config {
  return unwrap(Config(unwrap(value) as Config)) as Config
}

/** @returns the analysis defaults section as core option defaults. */
export function optionDefaults(c: Config): OptionDefaults {
  return {
    verbose: c.defaults.verbose,
    callStackLen: c.defaults.callStackLen,
    useTypeBasedCallGraph: c.defaults.useTypeBasedCallGraph,
    dumps: c.defaults.dumps,
    timeoutSec: c.defaults.timeoutSec,
    memLimitMB: c.defaults.memLimitMB,
  }
}

/** Writes a `status.*` patch back to the settings document — the only channel to the card. */
export type StatusWriter = (patch: Partial<Config['status']>) => Promise<void>
