/**
 * Resolved KAMain invocation options, the argv they produce, and the cache key they take part in.
 *
 * Pure: no filesystem, no process. The one impure input — a digest of the bitcode file — is
 * passed in, so the whole key computation is testable without LLVM.
 *
 * @module @pbfuzz/dsh-kanalyzer/core/options
 */

import type { AnalyzeRequest, DumpSelection } from '../api.ts'

/** Every dump KAMain can write, with the file name this plugin gives it inside the output dir. */
export const DUMP_FILES = {
  policy: 'policy.txt',
  distance: 'distance.cfg.txt',
  criticalBranch: 'critical_BBs.txt',
  bidMapping: 'bid_loc_mapping.txt',
  funcInfo: 'function_info.txt',
  callerCallee: 'caller-callee.txt',
  calleeCaller: 'callee-caller.txt',
  annotatedIr: '.annotated.bc',
} as const

/** The dump selection applied when a caller passes none. Mirrors the settings schema defaults. */
export const DEFAULT_DUMPS: Required<DumpSelection> = {
  policy: true,
  distance: true,
  criticalBranch: true,
  bidMappingAndFuncInfo: true,
  callerCalleeBothWays: true,
  annotatedIr: false,
}

/** Fully resolved options for one KAMain run. */
export interface ResolvedOptions {
  /** Must be ≥1: at 0 KAMain says nothing at all about a target it failed to find. */
  verbose: number
  callStackLen: number
  typeBasedCallgraph: boolean
  dumps: Required<DumpSelection>
  timeoutSec: number
  memLimitMB: number
  /** Target locations, normalised and sorted; empty for an `index()` run. */
  targets: string[]
  /** Entry symbols; empty means KAMain's own `main` / `LLVMFuzzerTestOneInput*` inference. */
  entries: string[]
}

/** Defaults a deployment can override through the `kanalyzer.defaults` settings section. */
export interface OptionDefaults {
  verbose: number
  callStackLen: number
  useTypeBasedCallGraph: boolean
  dumps: Required<DumpSelection>
  timeoutSec: number
  memLimitMB: number
}

/** The built-in defaults, identical to `contracts/kanalyzer-settings.schema.json`. */
export const BUILTIN_DEFAULTS: OptionDefaults = {
  verbose: 1,
  callStackLen: 20,
  useTypeBasedCallGraph: true,
  dumps: DEFAULT_DUMPS,
  timeoutSec: 1800,
  memLimitMB: 16384,
}

/**
 * Merge a request over the deployment defaults.
 *
 * `verbose` is floored at 1 whatever the settings say. KAMain exits 0 whether or not it found
 * the target and prints nothing at verbose 0, so a verbose-0 run is indistinguishable from a
 * silent no-op and this plugin would have to report `error` for every successful analysis.
 * @param request - the caller's analysis request.
 * @param defaults - deployment defaults from settings.
 * @returns the options an invocation is built from.
 */
export function resolveOptions(request: AnalyzeRequest, defaults: OptionDefaults = BUILTIN_DEFAULTS): ResolvedOptions {
  return {
    verbose: Math.max(1, defaults.verbose),
    callStackLen: request.callStackLen ?? defaults.callStackLen,
    typeBasedCallgraph: request.typeBasedCallgraph ?? defaults.useTypeBasedCallGraph,
    dumps: { ...defaults.dumps, ...request.dumps },
    timeoutSec: request.timeoutSec ?? defaults.timeoutSec,
    memLimitMB: defaults.memLimitMB,
    // Sorted so two requests that differ only in target order share one cache entry, and so the
    // target-list file is byte-stable.
    targets: [...new Set(request.targets)].sort(),
    entries: request.entries === undefined ? [] : [...new Set(request.entries)].sort(),
  }
}

/** Absolute-ish paths of the files one run writes, relative to its output directory. */
export interface RunPaths {
  outputDir: string
  targetListFile: string
  entryListFile: string
  stderrLog: string
}

/**
 * Which dump files a run will actually produce.
 *
 * The two paired dumps are the pitfall: KAMain writes `bid-mapping` only when `func-info` is
 * also requested, and `caller-callee` only when `callee-caller` is, so this plugin never
 * requests one half. A selection asking for half a pair produces neither file, and the parser
 * would then see a resolved target with no function name.
 * @param dumps - the resolved dump selection.
 * @returns the dump file names, in a stable order.
 */
export function selectedDumpFiles(dumps: Required<DumpSelection>): string[] {
  const files: string[] = []
  if (dumps.policy) files.push(DUMP_FILES.policy)
  if (dumps.distance) files.push(DUMP_FILES.distance)
  if (dumps.criticalBranch) files.push(DUMP_FILES.criticalBranch)
  if (dumps.bidMappingAndFuncInfo) files.push(DUMP_FILES.bidMapping, DUMP_FILES.funcInfo)
  if (dumps.callerCalleeBothWays) files.push(DUMP_FILES.callerCallee, DUMP_FILES.calleeCaller)
  return files
}

/**
 * Build the KAMain argv.
 *
 * Option spelling follows `src/lib/KAMain.cc`: single-dash LLVM `cl::opt` names, the bitcode
 * last as the positional `InputFilenames`.
 * @param bitcode - absolute path to the `*.0.0.preopt.bc` to analyse.
 * @param options - resolved run options.
 * @param paths - where the run writes its dumps and list files.
 * @returns argv after the binary path.
 */
export function buildArgs(bitcode: string, options: ResolvedOptions, paths: RunPaths): string[] {
  const out = (name: string): string => `${paths.outputDir}/${name}`
  const args: string[] = [
    `-verbose=${String(options.verbose)}`,
    `-call-stack-len=${String(options.callStackLen)}`,
    `-type-based-callgraph=${options.typeBasedCallgraph ? '1' : '0'}`,
  ]
  if (options.targets.length > 0) args.push(`-target-list=${paths.targetListFile}`)
  if (options.entries.length > 0) args.push(`-entry-list=${paths.entryListFile}`)
  const { dumps } = options
  if (dumps.policy) args.push(`-dump-policy=${out(DUMP_FILES.policy)}`)
  if (dumps.distance) args.push(`-dump-distance=${out(DUMP_FILES.distance)}`)
  if (dumps.criticalBranch) args.push(`-dump-critical-branch=${out(DUMP_FILES.criticalBranch)}`)
  if (dumps.bidMappingAndFuncInfo) {
    args.push(`-dump-bid-mapping=${out(DUMP_FILES.bidMapping)}`)
    args.push(`-dump-func-info=${out(DUMP_FILES.funcInfo)}`)
  }
  if (dumps.callerCalleeBothWays) {
    args.push(`-dump-caller-callee=${out(DUMP_FILES.callerCallee)}`)
    args.push(`-dump-callee-caller=${out(DUMP_FILES.calleeCaller)}`)
  }
  if (dumps.annotatedIr) args.push(`-dump-annotated-ir=${DUMP_FILES.annotatedIr}`)
  args.push(bitcode)
  return args
}

/**
 * The canonical, order-independent description of a run, hashed into the cache key.
 * @param bitcodeDigest - digest of the bitcode file's contents (or size+mtime fallback).
 * @param kamainCommit - commit of the kernel-analyzer checkout the binary was built from.
 * @param options - resolved run options.
 * @returns a stable JSON string.
 */
export function cacheKeyMaterial(bitcodeDigest: string, kamainCommit: string, options: ResolvedOptions): string {
  return JSON.stringify({
    bitcode: bitcodeDigest,
    kamain: kamainCommit,
    verbose: options.verbose,
    callStackLen: options.callStackLen,
    typeBasedCallgraph: options.typeBasedCallgraph,
    dumps: Object.fromEntries(Object.entries(options.dumps).sort(([a], [b]) => a.localeCompare(b))),
    targets: options.targets,
    entries: options.entries,
  })
}
