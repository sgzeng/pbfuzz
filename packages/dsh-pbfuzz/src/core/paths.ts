/**
 * The `.pbfuzz/<id>/` layout, as pure path arithmetic.
 *
 * A contract between the host half and the Python engine (both read/write files under this
 * layout). Kept dependency-free so it can be unit-tested on any platform even though the runtime
 * is Linux x86-64 only.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/paths
 */

/** POSIX join: the runtime is Linux-only, so no platform separator logic is wanted here. */
function join(...parts: string[]): string {
  const joined = parts
    .filter(part => part.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/')
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined
}

/** Every file the host half and the engine agree on for one campaign. */
export interface CampaignLayout {
  /** `<output.dir>` — the campaign directory itself. */
  readonly dir: string
  /** The campaign yaml. Lives beside the state dir so a run is self-describing. */
  readonly campaignFile: string
  /** `state/` — the model-written PIER blocks. */
  readonly stateDir: string
  /** `state/state.json` — the FSM cursor. */
  readonly stateFile: string
  /** `state/metrics.json` — engine-written only; every agent write of it is denied. */
  readonly metricsFile: string
  /** `state/fuzz_plan.json` — what EXECUTE runs. */
  readonly fuzzPlanFile: string
  /** Where generated inputs and the PoC land. */
  readonly testcasesDir: string
  /** Engine and tool logs. */
  readonly logsDir: string
}

/** The pointer file naming the active campaign; its absence is `PbfuzzHost.active()`'s fast exit
 * (no campaign in this workspace). Relative to the output root. */
export const ACTIVE_POINTER = 'active'

/** One model-written analysis block, by file name under `state/`. */
export const STATE_BLOCK_FILES = [
  'bug_predicates.json',
  'preconditions.json',
  'root_causes.json',
  'trigger_plans.json',
  'fuzz_plan.json',
] as const

/** File name of one model-written analysis block. */
export type StateBlockFile = typeof STATE_BLOCK_FILES[number]

/**
 * Resolve every path of one campaign from its output directory.
 * @param outputDir - the campaign's `output.dir`.
 * @returns the full layout.
 */
export function campaignLayout(outputDir: string): CampaignLayout {
  const stateDir = join(outputDir, 'state')
  return {
    dir: outputDir,
    campaignFile: join(outputDir, 'pbfuzz.campaign.yaml'),
    stateDir,
    stateFile: join(stateDir, 'state.json'),
    metricsFile: join(stateDir, 'metrics.json'),
    fuzzPlanFile: join(stateDir, 'fuzz_plan.json'),
    testcasesDir: join(outputDir, 'testcases'),
    logsDir: join(outputDir, 'logs'),
  }
}

/**
 * The default output directory for a campaign: `<repo>/<outputRoot>/<id>` (PLAN §2.6 S6).
 * @param repo - the target project checkout.
 * @param outputRoot - `onboarding.defaultOutputRoot` from settings, normally `.pbfuzz`.
 * @param id - the campaign id.
 * @returns the default `output.dir`.
 */
export function defaultOutputDir(repo: string, outputRoot: string, id: string): string {
  return join(repo, outputRoot, id)
}

/**
 * The pointer file naming the active campaign directory. Its absence is `PbfuzzHost.active()`'s
 * fast exit — a workspace with no pointer has no campaign, checked with one `existsSync()`.
 * @param repo - the target project checkout.
 * @param outputRoot - `onboarding.defaultOutputRoot` from settings.
 * @returns the absolute path of the `active` pointer file.
 */
export function activePointerPath(repo: string, outputRoot: string): string {
  return join(repo, outputRoot, ACTIVE_POINTER)
}
