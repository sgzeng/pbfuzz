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

const b = (v: boolean): z<boolean> => z.boolean().default(v)

/** Schemastery schema; defaults are identical to the frozen JSON schema (checked by tests/contract-parity.spec.ts for the analysis defaults). */
export const Config: z<Config> = z.object({
  install: z.object({
    installDir: z.string().default('~/.dsh/kanalyzer').description('The clone lands at `<installDir>/kernel-analyzer`.'),
    repoUrl: z.string().default('https://github.com/sgzeng/kernel-analyzer.git'),
    branch: z.string().default('mzt'),
    llvmPrefix: z.string().default('').description('Empty = auto-detect; prefers /usr/lib/llvm-14.'),
    buildType: z.union(['Release', 'RelWithDebInfo', 'Debug'] as const).default('Release'),
    jobs: z.natural().default(0).description('0 = nproc.'),
    wllvmBinDir: z.string().default('').description('Directory holding wllvm/wllvm++/extract-bc, prepended to PATH for a wllvm build. Empty = rely on the host PATH.'),
  }).default({} as Config['install']),
  defaults: z.object({
    verbose: z.natural().max(3).default(BUILTIN_DEFAULTS.verbose),
    callStackLen: z.natural().min(1).default(BUILTIN_DEFAULTS.callStackLen),
    useTypeBasedCallGraph: b(BUILTIN_DEFAULTS.useTypeBasedCallGraph),
    dumps: z.object({
      policy: b(true), distance: b(true), criticalBranch: b(true),
      bidMappingAndFuncInfo: b(true), callerCalleeBothWays: b(true), annotatedIr: b(false),
    }).default({} as Config['defaults']['dumps']),
    timeoutSec: z.natural().min(1).default(BUILTIN_DEFAULTS.timeoutSec),
    memLimitMB: z.natural().min(256).default(BUILTIN_DEFAULTS.memLimitMB),
    cacheEnabled: b(true),
    prepareMode: z.union(['wllvm', 'lto'] as const).default('wllvm').description('Mode used when kanalyzer_prepare omits `mode`. wllvm survives build systems that drop LDFLAGS; lto is the fast path for small projects.'),
  }).default({} as Config['defaults']),
  standalone: z.object({
    inputFilenames: z.array(z.string()).default([]),
    targetList: z.array(z.string()).default([]),
    entryList: z.array(z.string()).default([]),
  }).default({} as Config['standalone']),
  status: z.object({
    installed: b(false),
    binaryPath: z.string().default(''),
    commit: z.string().default(''),
    llvmVersion: z.string().default(''),
    lastDoctor: z.union(['', 'pass', 'fail'] as const).default(''),
    lastDoctorAt: z.string().default(''),
    lastDoctorMessage: z.string().default(''),
    lastWllvm: z.union(['', 'pass', 'fail'] as const).default(''),
    lastWllvmAt: z.string().default(''),
    lastWllvmMessage: z.string().default(''),
    wllvmBinDir: z.string().default(''),
  }).default({} as Config['status']),
}) as unknown as z<Config>

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
