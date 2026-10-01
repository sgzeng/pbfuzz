/**
 * Parser for KAMain's verbose stderr.
 *
 * Everything this module looks for comes from `src/lib/Common.h` and `src/lib/Reachable.cc`:
 *
 * - `WARNING(x)` is `KA_LOG(1, "\n[WARN] " << x)` — emitted at `-verbose≥1`. The three
 *   decisive ones are `No target found`, `No entry BBs found` and
 *   `Target not reachable from entry BBs`.
 * - `RA_LOG(x)` is `KA_LOG(2, "Reachable: " << x)` — `-verbose≥2` only. The positive marker
 *   `=== Target is reachable from entry ===` lives here, which is exactly why success cannot be
 *   established from stderr at the default verbosity and must be confirmed from the dumps.
 * - `KA_ERR` prints `ERROR (fn@line): …` and calls `exit(-1)`; a bad `-target-list` path lands
 *   here, so it is a real failure with a non-zero exit.
 * - The module loader prints `error loading file '<path>'` at any verbosity and then *continues*,
 *   which is another way to exit 0 having analysed nothing.
 *
 * @module @pbfuzz/dsh-kanalyzer/core/stderr
 */

/** The facts a stderr log carries about one run. */
export interface StderrFacts {
  /** `[WARN] No target found` — no requested location resolved to an instruction. */
  noTargetFound: boolean
  /** `[WARN] No entry BBs found` — the entry symbol is absent from the bitcode. */
  noEntryBBs: boolean
  /** `[WARN] Target not reachable from entry BBs`. */
  notReachable: boolean
  /** `=== Target is reachable from entry ===`; only ever present at `-verbose≥2`. */
  reachableMarker: boolean
  /** `KA_ERR` lines — KAMain exited non-zero on purpose. */
  fatalErrors: string[]
  /** `error loading file '<path>'` — the bitcode never made it into the module list. */
  loadErrors: string[]
  /** Targets KAMain echoed back from the target list (`-verbose≥2`). */
  echoedTargets: string[]
  /** Entry functions KAMain accepted (`-verbose≥2`). */
  entryFunctions: string[]
  /** Number of input files KAMain reported loading, from `Total N file(s)`. */
  totalInputFiles?: number
  /** Functions warned about as having no caller; a truncated call graph shows up here first. */
  noCallerFunctions: string[]
}

const RE_LOAD_ERROR = /error loading file '([^']*)'/
const RE_FATAL = /^ERROR \([^)]*\):\s*(.*)$/
const RE_TOTAL = /^Total (\d+) file\(s\)$/
const RE_TARGET = /^Reachable: Target: (.+)$/
const RE_ENTRY_FN = /^Reachable: \[init\] Entry function detected: (.+)$/
const RE_NO_CALLER = /No caller for (\S+)/

/**
 * Parse one KAMain stderr log.
 *
 * Tolerant by construction: the log interleaves pass output, `[WARN]` lines that begin with an
 * embedded newline, and multi-line IR dumps, so every marker is matched per line against the
 * substrings KAMain actually writes rather than against a whole-log grammar.
 * @param stderr - the complete stderr text of one run.
 * @returns the extracted facts.
 */
export function parseStderr(stderr: string): StderrFacts {
  const facts: StderrFacts = {
    noTargetFound: false,
    noEntryBBs: false,
    notReachable: false,
    reachableMarker: false,
    fatalErrors: [],
    loadErrors: [],
    echoedTargets: [],
    entryFunctions: [],
    noCallerFunctions: [],
  }
  const noCallers = new Set<string>()
  for (const raw of stderr.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (line.includes('[WARN] No target found')) facts.noTargetFound = true
    if (line.includes('[WARN] No entry BBs found')) facts.noEntryBBs = true
    if (line.includes('[WARN] Target not reachable from entry BBs')) facts.notReachable = true
    if (line.includes('=== Target is reachable from entry ===')) facts.reachableMarker = true
    const fatal = RE_FATAL.exec(line)
    if (fatal?.[1] !== undefined) facts.fatalErrors.push(fatal[1].trim())
    const load = RE_LOAD_ERROR.exec(line)
    if (load?.[1] !== undefined) facts.loadErrors.push(load[1])
    const total = RE_TOTAL.exec(line)
    if (total?.[1] !== undefined) facts.totalInputFiles = Number(total[1])
    const target = RE_TARGET.exec(line)
    if (target?.[1] !== undefined) facts.echoedTargets.push(target[1].trim())
    const entry = RE_ENTRY_FN.exec(line)
    if (entry?.[1] !== undefined) facts.entryFunctions.push(entry[1].trim())
    if (line.includes('[WARN]') && line.includes('No caller for')) {
      const noCaller = RE_NO_CALLER.exec(line)
      if (noCaller?.[1] !== undefined) noCallers.add(noCaller[1])
    }
  }
  facts.echoedTargets = [...new Set(facts.echoedTargets)].sort()
  facts.entryFunctions = [...new Set(facts.entryFunctions)].sort()
  facts.noCallerFunctions = [...noCallers].sort()
  return facts
}
