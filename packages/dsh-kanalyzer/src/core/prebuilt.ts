/**
 * Importing a directory of existing KAMain text dumps instead of running the analysis.
 *
 * Magma ships exactly this shape under `fuzzers/pre-built/<target>/BBtargets/<BUG>/`: the outputs
 * of one KAMain run, named `<link output>_<canonical dump file>`. pbfuzz's
 * `analysis.static.prebuilt_dir` exists to consume it — the `SKIP_STATIC_ANALYSIS` path — without
 * KAMain, LLVM or a build being present at all.
 *
 * **File discovery is suffix-based, on purpose.** This plugin's own cache directories use the
 * canonical names (`distance.cfg.txt`); Magma prefixes them with the link output
 * (`lua_distance.cfg.txt`). Both are the same dump, so an exact name is preferred and a suffixed
 * one accepted. Two entries matching one kind is *reported*, never guessed at: silently reading
 * `luac_distance.cfg.txt` when the campaign is about `lua` would answer every later query from the
 * wrong call graph, which is worse than failing the import.
 *
 * @module @pbfuzz/dsh-kanalyzer/core/prebuilt
 */

import type { DumpFiles, DumpKind } from '../api.ts'
import { DUMP_FILES } from './options.ts'

/** Every dump a prebuilt directory may carry, i.e. the core dump names minus the annotated IR. */
type ImportableKind = Exclude<keyof typeof DUMP_FILES, 'annotatedIr'>

type AssertTrue<T extends true> = T

/**
 * Compile-time parity between the api's kind union and the dump names core actually reads and
 * writes: a new dump added to one side and not the other fails here rather than at the first
 * import of a directory that uses it.
 */
type _KindsMatch = AssertTrue<
  [DumpKind] extends [ImportableKind] ? ([ImportableKind] extends [DumpKind] ? true : false) : false
>

/** The kinds a prebuilt directory must contain for the import to answer like a live run. */
export const REQUIRED_DUMP_KINDS = [
  'distance',
  'criticalBranch',
  'bidMapping',
  'funcInfo',
  'callerCallee',
  'calleeCaller',
] as const satisfies readonly DumpKind[]

/** The kinds an import looks for. `policy` is imported when present but nothing depends on it. */
const IMPORTABLE_KINDS = [
  'policy',
  'distance',
  'criticalBranch',
  'bidMapping',
  'funcInfo',
  'callerCallee',
  'calleeCaller',
] as const satisfies readonly DumpKind[]

/** One kind that more than one file in the directory could serve. */
export interface AmbiguousDump {
  kind: DumpKind
  candidates: string[]
}

/** What a directory listing resolved to. */
export interface ResolvedDumps {
  files: DumpFiles
  /** Kinds with several candidates and no way to choose; the caller must refuse to import. */
  ambiguous: AmbiguousDump[]
}

/**
 * Match a directory listing against KAMain's canonical dump file names.
 * @param names - the directory's entry names.
 * @param program - the campaign's link output, used to break a tie between prefixed dump sets.
 * @returns the file per kind, plus any kind left ambiguous.
 */
export function resolveDumpFiles(names: readonly string[], program?: string): ResolvedDumps {
  const files: DumpFiles = {}
  const ambiguous: AmbiguousDump[] = []
  const sorted = [...names].sort()
  for (const kind of IMPORTABLE_KINDS) {
    const canonical = DUMP_FILES[kind]
    const matches = sorted.filter(n => n === canonical || n.endsWith(canonical))
    if (matches.length === 0) continue
    const exact = matches.find(n => n === canonical)
    const prefer = (prefix: string): string | undefined => matches.find(n => n === `${prefix}${canonical}`)
    const pick = exact
      ?? (program !== undefined ? prefer(`${program}_`) ?? prefer(`${program}-`) : undefined)
      ?? (matches.length === 1 ? matches[0] : undefined)
    if (pick !== undefined) files[kind] = pick
    else ambiguous.push({ kind, candidates: matches })
  }
  return { files, ambiguous }
}

/**
 * The canonical names of the required kinds the directory does not carry.
 *
 * Canonical, not as-found: this list becomes part of a diagnosis, and "critical_BBs.txt" is the
 * name the user will search KAMain's documentation for.
 * @param files - what {@link resolveDumpFiles} resolved.
 * @returns canonical file names, in the order of {@link REQUIRED_DUMP_KINDS}.
 */
export function missingRequiredDumps(files: DumpFiles): string[] {
  return REQUIRED_DUMP_KINDS.filter(kind => files[kind] === undefined).map(kind => DUMP_FILES[kind])
}
