/** Shared fixtures for the pure-core tests. */

import type { PbfuzzSettings } from '../src/core/contracts.ts'
import type { CampaignDraftInput } from '../src/core/campaign.ts'

/** Settings with every schema default, overridable per test. */
export function settings(over: { [K in keyof PbfuzzSettings]?: Partial<PbfuzzSettings[K]> } = {}): PbfuzzSettings {
  const base: PbfuzzSettings = {
    tools: { staticAnalysis: 'off', corpusAnalysis: true, deviationDetection: true, tracer: 'auto', interactiveDebug: true },
    budget: { maxPierRounds: 5, campaignWallTimeMin: 30, autoContinue: true, maxConsecutiveForcedContinues: 3 },
    fuzzing: { maxIters: 1000, execTimeoutSec: 3, fuzzTimeoutSec: 600, generatorTimeoutSec: 1, stage1MinConcreteParams: 5, enableDebuggerForAll: false },
    onboarding: { interviewPolicy: 'when-missing', deriveTargetFrom: ['patch', 'cve', 'crashTrace'], defaultOutputRoot: '.pbfuzz', confirmTimeoutMin: 0 },
    oracleDefaults: { canaryOnTrigger: 'log', reachedPattern: 'PBFUZZ_REACHED:\\s*(\\S+)', triggeredPattern: 'PBFUZZ_TRIGGERED:\\s*(\\S+)' },
    execution: { pythonPath: 'python3', gdbPath: 'gdb', generatorMemLimitMB: 512, generatorCpuLimitSec: 10, logLevel: 'info', fuzzBackground: true },
    guards: { bashGuard: true, tamperLedger: true, hideToolsWithoutCampaign: false },
    status: { envSelfcheck: { checkedAt: '', ttlExpiresAt: '', overall: '', items: [] } },
  }
  const out = structuredClone(base) as unknown as Record<string, Record<string, unknown>>
  for (const [k, v] of Object.entries(over)) Object.assign(out[k]!, v)
  return out as unknown as PbfuzzSettings
}

/** A valid draft input for a readelf-like target. */
export function draftInput(over: Partial<CampaignDraftInput> = {}): CampaignDraftInput {
  return {
    id: 'readelf-1',
    target: { repo: '/src/binutils', language: 'c' },
    bug: { targets: [{ location: 'binutils/readelf.c:1234', condition: 'len > size' }] },
    entry: {
      kind: 'executable',
      binary: '/src/binutils/binutils/readelf',
      run_cmd: '/src/binutils/binutils/readelf -a @@',
      input_channel: 'file',
    },
    ...over,
  }
}
