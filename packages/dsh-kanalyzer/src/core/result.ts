/**
 * Assembly of one {@link AnalyzeResult} from the text dumps a KAMain run left behind.
 *
 * Two callers share this module, which is the point of it: `host/runtime.ts` right after a live
 * invocation, and its `importPrebuilt()` when the analysis ran somewhere else (Magma's
 * `SKIP_STATIC_ANALYSIS` path). Everything decisive — status derivation, target resolution,
 * critical branches, path remapping — already lives in the sibling core modules; this module only
 * sequences them, so an import answers exactly like a live run instead of growing a second,
 * subtly different code path.
 *
 * @module @pbfuzz/dsh-kanalyzer/core/result
 */

import type { AnalyzeResult } from '../api.ts'
import {
  parseBidMapping, parseCriticalBranches, parseDistance, parseFuncInfo, parseGuidEdges, type BidMappingRow,
} from './dumps.ts'
import type { RepoIndex } from './paths.ts'
import type { StderrFacts } from './stderr.ts'
import {
  blockIndex, criticalBranches, deriveStatus, instructionLines, nearbyCandidates, resolveTargets,
  type ProcessOutcome,
} from './status.ts'

/**
 * The dump texts result assembly reads, keyed like {@link DUMP_FILES}. A kind is absent when its
 * file was not produced — which is different from an empty file, and `deriveStatus` says so.
 */
export interface DumpTexts {
  distance?: string
  criticalBranch?: string
  bidMapping?: string
  funcInfo?: string
  /**
   * The caller→callee call graph (`-dump-caller-callee`), when available. Feeds the independent
   * reachability cross-check in `core/status.ts`'s `deriveStatus` (see its module doc); absent
   * simply skips that check rather than guessing.
   */
  callerCallee?: string
}

/** Everything one result is assembled from. */
export interface DumpAnalysisInput {
  texts: DumpTexts
  process: ProcessOutcome
  stderr: StderrFacts
  /** Target locations as requested, `file:line`. */
  requestedTargets: string[]
  /** Requested dump files that are not present; drives the `error` status. */
  missingDumps: string[]
  /** Entry symbols the caller passed; empty falls back to the ones the stderr log names. */
  entries: string[]
  /** Where the dumps live, as reported back to the caller. */
  outputDir: string
  elapsedMs: number
  /** Repo root, to remap KAMain's mixed path styles to repo-relative ones. */
  repo?: RepoIndex
  /**
   * Where to look for instruction-bearing lines when a target resolved to nothing and the bid
   * mapping has none for its file. The host layer passes a source-text reader; an import with no
   * repo simply leaves `nearbyCandidates` empty rather than guessing.
   */
  fallbackInstructionLines?: (requested: string) => Promise<number[]>
}

/**
 * Derive the same result a live run reports, from its dumps alone.
 * @param input - dumps, process outcome and caller context.
 * @returns the status, resolved targets, critical branches and counts.
 */
export async function analyzeFromDumps(input: DumpAnalysisInput): Promise<AnalyzeResult> {
  const { texts } = input
  const distance = texts.distance !== undefined ? parseDistance(texts.distance) : undefined
  const bidMapping = texts.bidMapping !== undefined ? parseBidMapping(texts.bidMapping) : undefined
  const funcInfo = texts.funcInfo !== undefined ? parseFuncInfo(texts.funcInfo) : undefined
  const critical = texts.criticalBranch !== undefined ? parseCriticalBranches(texts.criticalBranch) : undefined
  const callerCallee = texts.callerCallee !== undefined ? parseGuidEdges(texts.callerCallee) : undefined
  // A live run announces its entries on stderr only when none were configured explicitly (see
  // `entriesUsed` below, which the independent reachability cross-check needs the same list for).
  const entries = input.entries.length > 0 ? input.entries : input.stderr.entryFunctions
  const verdict = deriveStatus({
    process: input.process,
    stderr: input.stderr,
    requestedTargets: input.requestedTargets,
    distance,
    bidMapping,
    funcInfo,
    critical,
    missingDumps: input.missingDumps,
    entries,
    callerCallee,
  })
  const blocks = blockIndex(bidMapping, funcInfo)
  const resolved = resolveTargets(input.requestedTargets, distance, blocks, input.repo)
  // A live run announces "no target found" on stderr; an import has no stderr, so when targets were
  // requested and none of them resolved, the dumps themselves must carry the verdict. Reporting
  // `ok` with an empty target list would hand the caller a success it cannot act on.
  const noneResolved = verdict.status === 'ok' && input.requestedTargets.length > 0 && resolved.targets.length === 0
  const status = noneResolved ? 'no_target' as const : verdict.status
  const reason = noneResolved
    ? 'No requested location resolved to an instruction in these dumps. The line is probably a comment, declaration, blank or brace line, or the dumps are from a different revision — see unresolved[].nearbyCandidates.'
    : verdict.reason
  const unresolvedReqs = status === 'no_target' ? input.requestedTargets : resolved.unresolved
  const unresolved = await Promise.all(unresolvedReqs.map(async r => ({
    requested: r,
    nearbyCandidates: nearbyCandidates(r, await instructionLinesFor(r, bidMapping, input)),
  })))
  const ok = status === 'ok'
  return {
    status,
    targets: ok ? resolved.targets : [],
    criticalBranches: ok ? criticalBranches(critical, distance, blocks, input.repo) : [],
    reachableFunctions: distance?.reachedFunctions.length ?? 0,
    totalFunctions: funcInfo?.length ?? 0,
    entriesUsed: entries,
    outputDir: input.outputDir,
    // The host layer owns the output directory and fills this in: only it knows which dump files
    // actually landed there (a live run) or which the import resolved (an imported directory).
    dumpFiles: [],
    elapsedMs: input.elapsedMs,
    cached: false,
    ...(reason !== undefined ? { reason } : {}),
    ...(unresolved.length > 0 && input.requestedTargets.length > 0 ? { unresolved } : {}),
  }
}

/**
 * Instruction-bearing lines for a target that resolved to nothing.
 *
 * The bid mapping is authoritative when it has any row for the file (that is what KAMain actually
 * compiled); only when it has none does the caller's source-text fallback get a say.
 * @param requested - the requested `file:line`.
 * @param bidMapping - the run's bid mapping, when it produced one.
 * @param input - the enclosing input, for the fallback.
 * @returns candidate line numbers.
 */
async function instructionLinesFor(requested: string, bidMapping: BidMappingRow[] | undefined, input: DumpAnalysisInput): Promise<number[]> {
  const file = requested.replace(/:\d+(:\d+)?$/, '')
  const fromDump = bidMapping ? instructionLines(bidMapping, file) : []
  if (fromDump.length > 0) return fromDump
  return input.fallbackInstructionLines !== undefined ? input.fallbackInstructionLines(requested) : []
}
