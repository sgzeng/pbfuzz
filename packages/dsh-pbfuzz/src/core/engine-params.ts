/**
 * The exact parameter objects the host sends to the Python engine.
 *
 * `FuzzRunParams`, `TraceRunParams`, `DeviationRunParams` and `DebuggerPaths` come from
 * `contracts/engine-rpc.schema.json`; the shapes the contract leaves open are the ones
 * `engine/README.md` documents. Every builder here is pure so each shape is unit-tested and
 * exercised by the real-engine smoke test (`tests/engine-smoke.spec.ts`).
 *
 * @module @pbfuzz/dsh-pbfuzz/core/engine-params
 */

import type { PbfuzzSettings } from './contracts.ts'

/** `DebuggerPaths`: interpreter/debugger locations; the engine falls back to PATH for any omitted. */
export interface DebuggerPaths {
  gdbPath?: string
  lldbPath?: string
  pythonPath?: string
  jdbPath?: string
}

/** Everything `fuzz.run` reads from `runtime`: the contract's knobs plus the engine-documented limits. */
export interface FuzzRuntime {
  maxIters: number
  execTimeoutSec: number
  fuzzTimeoutSec: number
  generatorTimeoutSec: number
  enableDebuggerForAll: boolean
  generatorMemLimitMB: number
  generatorCpuLimitSec: number
  stage1MinConcreteParams: number
}

/** `FuzzRunParams` as sent. */
export interface FuzzRunParams {
  campaignPath: string
  planPath: string
  generatorPath: string
  runtime: FuzzRuntime & Record<string, unknown>
  pierRound: number
  debuggerPaths: DebuggerPaths
}

/**
 * `debuggerPaths` from `execution.gdbPath` / `execution.pythonPath` (empty values omitted).
 * @param settings - resolved pbfuzz settings.
 * @returns the object forwarded on fuzz.run, trace.run and deviation.run.
 */
export function debuggerPaths(settings: PbfuzzSettings): DebuggerPaths {
  const out: DebuggerPaths = {}
  if (settings.execution.gdbPath !== '') out.gdbPath = settings.execution.gdbPath
  if (settings.execution.pythonPath !== '') out.pythonPath = settings.execution.pythonPath
  return out
}

/**
 * The fuzz-session runtime from settings: every `fuzzing.*` knob plus the generator sandbox
 * limits from `execution.*`.
 * @param settings - resolved pbfuzz settings.
 * @returns the runtime object.
 */
export function fuzzRuntime(settings: PbfuzzSettings): FuzzRuntime {
  return {
    maxIters: settings.fuzzing.maxIters,
    execTimeoutSec: settings.fuzzing.execTimeoutSec,
    fuzzTimeoutSec: settings.fuzzing.fuzzTimeoutSec,
    generatorTimeoutSec: settings.fuzzing.generatorTimeoutSec,
    enableDebuggerForAll: settings.fuzzing.enableDebuggerForAll,
    stage1MinConcreteParams: settings.fuzzing.stage1MinConcreteParams,
    generatorMemLimitMB: settings.execution.generatorMemLimitMB,
    generatorCpuLimitSec: settings.execution.generatorCpuLimitSec,
  }
}

/**
 * `fuzz.run` parameters.
 * @param input - paths, the PIER round, resolved settings and the model's per-run overrides.
 * @returns FuzzRunParams (settings first, overrides win).
 */
export function fuzzRunParams(input: {
  campaignPath: string
  planPath: string
  generatorPath: string
  pierRound: number
  settings: PbfuzzSettings
  overrides?: Record<string, unknown>
}): FuzzRunParams {
  return {
    campaignPath: input.campaignPath,
    planPath: input.planPath,
    generatorPath: input.generatorPath,
    runtime: { ...fuzzRuntime(input.settings), ...input.overrides },
    pierRound: input.pierRound,
    debuggerPaths: debuggerPaths(input.settings),
  }
}

/**
 * `generator.validate {generatorPath, plan}`: runs the generator on every batch-plan entry and a
 * few samples of the plan's parameter space, in the sandbox. The plan goes inline, not as a path:
 * it is validated in the same call rather than written first, so an invalid plan never reaches
 * `fuzz_plan.json` and its problems are reported alongside the generator's.
 * @param generatorPath - generator module.
 * @param plan - the candidate fuzz plan.
 * @returns the params.
 */
export function generatorValidateParams(generatorPath: string, plan: unknown): { generatorPath: string; plan: unknown } {
  return { generatorPath, plan }
}

/**
 * `corpus.analyze {campaignPath, seedsDir?}`.
 * @param campaignPath - campaign yaml.
 * @param seedsDir - absolute seeds directory, when the campaign names one.
 * @returns the params.
 */
export function corpusAnalyzeParams(campaignPath: string, seedsDir?: string): { campaignPath: string; seedsDir?: string } {
  return seedsDir === undefined ? { campaignPath } : { campaignPath, seedsDir }
}

/**
 * `params.extract {extractorPath, seedsDir | inputs}`.
 * @param extractorPath - model-written extractor module.
 * @param source - the seeds directory, or explicit input paths.
 * @returns the params.
 */
export function paramsExtractParams(
  extractorPath: string,
  source: { seedsDir: string } | { inputs: string[] },
): { extractorPath: string; seedsDir?: string; inputs?: string[] } {
  return { extractorPath, ...source }
}

/**
 * `selfcheck.engine {contractsVersion}`.
 * @param contractsVersion - the version this plugin speaks.
 * @returns the params.
 */
export function selfcheckEngineParams(contractsVersion: string): { contractsVersion: string } {
  return { contractsVersion }
}

