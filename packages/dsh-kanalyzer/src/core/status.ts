/**
 * Derivation of {@link AnalyzeStatus} from what one KAMain run left behind.
 *
 * **Never from the exit code.** KAMain returns 0 when it found no target, when the target is
 * unreachable, and when the bitcode failed to load. The decision table, in precedence order:
 *
 * | evidence | status |
 * |---|---|
 * | timed out, killed, non-zero exit, `KA_ERR`, `error loading file`, or a requested dump missing on a run that got past target resolution | `error` |
 * | `[WARN] No target found`, or targets were requested and the distance dump has no distance-0 row | `no_target` |
 * | `[WARN] No entry BBs found` or `[WARN] Target not reachable from entry BBs` | `unreachable` |
 * | distance dump holds a distance-0 row (reachability is only dumped after the reachability check passed) | `ok` |
 * | otherwise | `error` (unparsable) |
 *
 * The last `ok` rule relies on `ReachableCallGraphPass::run` returning *before* computing
 * distances for any non-target block when the target is unreachable — so a distance dump with
 * more than the target rows is itself proof of reachability, even at `-verbose=1` where the
 * positive stderr marker is not printed.
 *
 * **Defense in depth.** The rule above is itself not fully trustworthy: `kernel-analyzer`'s own
 * `Reachable.cc` has an upstream exit-block-seeding bug (third-party repo, not fixed here) that
 * can seed a disconnected entry's *own* exit block into `reachableBBs`, so KAMain reports a target
 * as reached — including a distance-0 row for it — even when no configured entry actually reaches
 * it in the call graph. Case (d) of the table above ("target unreachable from entry") can
 * therefore come out as a false `ok`. When the caller→callee call graph KAMain also emits
 * (`-dump-caller-callee`) is available, {@link deriveStatus} independently re-derives entry→target
 * reachability with a plain BFS and downgrades a suspicious `ok` to `unreachable` when the two
 * disagree — the same edges `core/query.ts`'s `callers`/`callees` operations already traverse one
 * hop at a time. This check fails *open*: with no caller-callee dump, no configured/echoed
 * entries, or a target whose containing function cannot be named from the bid mapping, it changes
 * nothing rather than guess.
 *
 * @module @pbfuzz/dsh-kanalyzer/core/status
 */

import type { AnalyzeStatus, CriticalBranch, ResolvedTarget } from '../api.ts'
import type { BidMappingRow, DistanceDump, DistanceRow, FuncInfoRow, GuidEdges } from './dumps.ts'
import { basename, parseLocation, type RepoIndex } from './paths.ts'
import type { StderrFacts } from './stderr.ts'

/** Raw process outcome. */
export interface ProcessOutcome {
  exitCode: number | null
  signal?: string | null
  timedOut: boolean
}

/** Everything the derivation consumes. Dumps are undefined when the file was not produced. */
export interface RunEvidence {
  process: ProcessOutcome
  stderr: StderrFacts
  requestedTargets: string[]
  distance?: DistanceDump
  bidMapping?: BidMappingRow[]
  funcInfo?: FuncInfoRow[]
  critical?: Map<number, number[]>
  /** Dump files that were requested but do not exist after the run. */
  missingDumps: string[]
  /**
   * Entry function symbols actually used for this run — configured explicitly, or (when none
   * were) the ones KAMain itself echoed on stderr at `-verbose≥2`. Optional, and only ever
   * consulted by the {@link deriveStatus} cross-check below; absent simply skips it.
   */
  entries?: string[]
  /**
   * Caller→callee call-graph edges KAMain also emits (`-dump-caller-callee`), GUID-keyed. Same
   * shape `core/query.ts`'s `QueryData.callerCallee` traverses. Optional, and only ever consulted
   * by the {@link deriveStatus} cross-check below; absent simply skips it.
   */
  callerCallee?: GuidEdges
}

/** Derived status plus the explanation a caller can act on. */
export interface StatusVerdict {
  status: AnalyzeStatus
  reason?: string
}

/** @returns the status, with a reason whenever it is not `ok`. */
export function deriveStatus(ev: RunEvidence): StatusVerdict {
  const { process: p, stderr: s } = ev
  if (p.timedOut) return { status: 'error', reason: 'KAMain timed out; raise timeoutSec, reduce callStackLen, or use the signature call graph (typeBasedCallgraph=true).' }
  if (p.signal) return { status: 'error', reason: `KAMain was killed by ${p.signal} (often the memory limit; raise memLimitMB).` }
  if (s.fatalErrors.length > 0) return { status: 'error', reason: `KAMain aborted: ${s.fatalErrors.join('; ')}` }
  if (p.exitCode !== 0) return { status: 'error', reason: `KAMain exited with code ${String(p.exitCode)}.` }
  if (s.loadErrors.length > 0) return { status: 'error', reason: `KAMain could not load ${s.loadErrors.join(', ')} — the bitcode is missing, corrupt, or from a different LLVM major version than KAMain.` }

  const hasTargets = ev.requestedTargets.length > 0
  const zeroRows = ev.distance?.rows.filter(r => r.distance === 0) ?? []
  if (hasTargets && (s.noTargetFound || (ev.distance !== undefined && zeroRows.length === 0))) {
    return { status: 'no_target', reason: 'No requested location resolved to an instruction. The line is probably a comment, declaration, blank or brace line, or the file was compiled without -g; see unresolved[].nearbyCandidates.' }
  }
  if (s.noEntryBBs) return { status: 'unreachable', reason: 'No entry function was found in the bitcode. Pass entries explicitly (e.g. the fuzz harness symbol) or check that the link output contains main/LLVMFuzzerTestOneInput.' }
  if (s.notReachable) return { status: 'unreachable', reason: 'The target resolved but no entry reaches it in the call graph. Check that static dependency libraries were LTO-built (a missing one silently truncates the graph), try entries closer to the target, or raise callStackLen.' }
  if (!hasTargets) {
    // index() run: success means the function info exists.
    return ev.funcInfo !== undefined && ev.funcInfo.length > 0
      ? { status: 'ok' }
      : { status: 'error', reason: 'Index run produced no function info; the bitcode may lack debug info (-g).' }
  }
  if (ev.missingDumps.length > 0) return { status: 'error', reason: `Requested dumps were not written: ${ev.missingDumps.join(', ')}.` }
  if (zeroRows.length > 0) return crossCheckReachability(ev, zeroRows) ?? { status: 'ok' }
  if (ev.distance === undefined && s.reachableMarker) return { status: 'ok' }
  return { status: 'error', reason: 'KAMain output could not be interpreted (no distance dump and no reachability marker).' }
}

/**
 * Independent defense-in-depth cross-check for KAMain's own `ok` verdict — see the "Defense in
 * depth" paragraph in this module's doc comment for why it exists. Re-derives entry→target
 * reachability with a plain BFS over the caller→callee call graph, from the configured/echoed
 * entries to the target's own containing function(s) (read off the bid mapping, which is plain
 * compiled-IR bookkeeping and not itself subject to the buggy reachability pass).
 *
 * Deliberately conservative: every guard below returns `undefined` (keep `ok`) rather than guess,
 * so missing or partial graph data — no caller-callee dump, an entry name absent from func-info,
 * an indirect call the graph does not record — can never manufacture a false `unreachable` for a
 * genuinely reachable target. It can only downgrade a status that KAMain's own dumps, re-examined,
 * fail to substantiate.
 * @param ev - the run evidence; only `callerCallee`, `entries`, `bidMapping` and `funcInfo` matter here.
 * @param zeroRows - the distance-0 rows `deriveStatus` is about to trust as `ok`.
 * @returns a downgraded `unreachable` verdict, or `undefined` to leave the caller's `ok` alone.
 */
function crossCheckReachability(ev: RunEvidence, zeroRows: DistanceRow[]): StatusVerdict | undefined {
  const { callerCallee, entries, funcInfo, bidMapping } = ev
  if (callerCallee === undefined || callerCallee.size === 0) return undefined
  if (entries === undefined || entries.length === 0) return undefined
  if (funcInfo === undefined || funcInfo.length === 0 || bidMapping === undefined) return undefined

  const funcGuidOfBid = new Map(bidMapping.map(r => [r.bid, r.funcGuid]))
  const nameOfGuid = new Map(funcInfo.map(f => [f.guid, f.name]))
  const guidsOfName = new Map<string, string[]>()
  for (const f of funcInfo) guidsOfName.set(f.name, [...(guidsOfName.get(f.name) ?? []), f.guid])

  const targetFns = new Set(
    zeroRows
      .map(r => { const guid = funcGuidOfBid.get(r.bid); return guid !== undefined ? nameOfGuid.get(guid) : undefined })
      .filter((f): f is string => f !== undefined),
  )
  // Can't name the target's own function from this run's bid mapping — nothing to cross-check.
  if (targetFns.size === 0) return undefined

  const entryGuids = entries.flatMap(e => guidsOfName.get(e) ?? [])
  // None of the configured/echoed entries resolved in func-info: the graph data is incomplete
  // relative to what we were told, so don't trust a negative result from it either.
  if (entryGuids.length === 0) return undefined

  const reachable = new Set(entryGuids)
  const queue = [...entryGuids]
  for (let g = queue.shift(); g !== undefined; g = queue.shift()) {
    for (const callee of callerCallee.get(g) ?? []) if (!reachable.has(callee)) { reachable.add(callee); queue.push(callee) }
  }
  const reachedFns = new Set([...reachable].map(g => nameOfGuid.get(g)).filter((f): f is string => f !== undefined))
  // The independent BFS agrees with KAMain: genuinely reachable, leave `ok` alone.
  if ([...targetFns].some(fn => reachedFns.has(fn))) return undefined

  return {
    status: 'unreachable',
    reason: `KAMain reported ${[...targetFns].sort().join(', ')} as reached from entr${entries.length === 1 ? 'y' : 'ies'} [${entries.join(', ')}], but an independent call-graph BFS over KAMain's own caller→callee dump found no path from any configured entry to it. This matches the known upstream KAMain reachability-gate bug (kernel-analyzer's Reachable.cc seeds a disconnected entry's own exit block as reached); treat this target as unreachable until that is fixed upstream, or pass entries that genuinely reach it.`,
  }
}

/** Lookup tables derived from the paired dumps. */
export interface BlockIndex {
  locationOf(bid: number): string | undefined
  functionOf(bid: number): string | undefined
}

/** @returns lookups from block id to absolute location and function name. */
export function blockIndex(bidMapping: BidMappingRow[] = [], funcInfo: FuncInfoRow[] = []): BlockIndex {
  const names = new Map(funcInfo.map(f => [f.guid, f.name]))
  const rows = new Map(bidMapping.map(r => [r.bid, r]))
  return {
    locationOf: bid => { const r = rows.get(bid); return r ? `${r.file}:${String(r.line)}` : undefined },
    functionOf: bid => { const r = rows.get(bid); return r ? names.get(r.funcGuid) : undefined },
  }
}

/** Same file under KAMain's own rule (basename substring either way)? Exported so `core/query.ts`'s
 * `file` filter matches a source file exactly the way target resolution here already does, rather
 * than growing a second, subtly different copy of the rule. */
export function sameFile(requested: string, file: string): boolean {
  const rb = basename(requested)
  return file.includes(rb) || rb.includes(basename(file))
}

/**
 * Resolve each requested target against the distance-0 rows.
 *
 * KAMain locates a basic block by the line of its *first* instruction (`sample.c:6` for a block
 * spanning lines 6–8), so a requested line rarely appears verbatim in the dumps. A request
 * resolves to the block that contains it — the block in the same file with the greatest start
 * line not after the requested line — when that block is at distance 0. Distance-0 call-site
 * blocks elsewhere (the caller's `call target`) are not the target and are not reported.
 * Verified against real KAMain (mzt 3f5dbfd, LLVM 14) output on `selftest/`.
 * @returns resolved targets (sorted) and the requests that resolved to nothing.
 */
export function resolveTargets(
  requested: string[], distance: DistanceDump | undefined, blocks: BlockIndex, repo?: RepoIndex,
): { targets: ResolvedTarget[]; unresolved: string[] } {
  const rows = (distance?.rows ?? []).map(row => ({ row, loc: parseLocation(blocks.locationOf(row.bid) ?? row.location) }))
  const targets: ResolvedTarget[] = []
  const unresolved: string[] = []
  for (const req of requested) {
    const r = parseLocation(req)
    const before = r ? rows.filter(x => x.loc !== undefined && sameFile(r.file, x.loc.file) && x.loc.line <= r.line) : []
    const start = Math.max(...before.map(x => x.loc?.line ?? -1))
    const hits = before.filter(x => x.loc?.line === start && x.row.distance === 0)
    if (r === undefined || hits.length === 0) { unresolved.push(req); continue }
    for (const h of hits) {
      const loc = `${h.loc?.file ?? r.file}:${String(r.line)}`
      targets.push({
        requested: req,
        function: blocks.functionOf(h.row.bid) ?? '',
        location: repo ? repo.remapLocation(loc) : loc,
        distance: 0,
      })
    }
  }
  const uniq = new Map(targets.map(t => [`${t.requested}|${t.location}|${t.function}`, t]))
  return {
    targets: [...uniq.values()].sort((a, b) => a.requested.localeCompare(b.requested) || a.location.localeCompare(b.location)),
    unresolved: unresolved.sort(),
  }
}

/**
 * Critical branches with their source location, function and distance.
 * @returns sorted, de-duplicated branches.
 */
export function criticalBranches(
  critical: Map<number, number[]> | undefined, distance: DistanceDump | undefined, blocks: BlockIndex, repo?: RepoIndex,
): CriticalBranch[] {
  if (!critical) return []
  const dist = new Map((distance?.rows ?? []).map(r => [r.bid, r]))
  const out = new Map<string, CriticalBranch>()
  for (const bid of critical.keys()) {
    const row = dist.get(bid)
    const raw = blocks.locationOf(bid) ?? row?.location ?? `bid:${String(bid)}`
    const location = repo ? repo.remapLocation(raw) : raw
    const fn = blocks.functionOf(bid) ?? ''
    const b: CriticalBranch = { function: fn, location, distance: row && row.distance >= 0 ? row.distance : -1 }
    const key = `${fn}|${location}`
    const prev = out.get(key)
    if (!prev || (b.distance >= 0 && (prev.distance < 0 || b.distance < prev.distance))) out.set(key, b)
  }
  return [...out.values()].sort((a, b) => a.location.localeCompare(b.location) || a.function.localeCompare(b.function))
}

/**
 * Trim {@link criticalBranches} down to what is worth putting in front of a model.
 *
 * Why this exists: the nginx session that motivated it (`read-dsh-session-log-curried-dusk.md`,
 * section K6) had `criticalBranches()` return 22,020 entries for one target, 99.9% of them the
 * sanitizer's own `__asan_report_*` check branches rather than anything in the target's real
 * control flow. Sorted alphabetically by location — `criticalBranches()`'s own order — the
 * 13,924 `distance: -1` rows and 347 `bid:NNNNN` placeholders (no bid-mapping entry at all, so
 * no real location) sort ahead of everything else, and the tool result's ~50 KB JSON then gets
 * head+tail truncated to ~24.9 KB apiece: the head was all `bid:` placeholders, the tail was
 * unrelated files, and the target's 171 actually-useful rows (distance 28818 → 0) sat in the
 * omitted 3.4 MB middle. The model never saw them and had to re-derive the same information nine
 * times over with `kanalyzer_query` instead.
 *
 * Sorting by distance first surfaces the rows nearest the target — what a caller deciding where
 * to fuzz next actually wants — and unresolved rows are dropped outright rather than left to
 * compete with resolved ones for a byte budget.
 * @param branches - the full set, as returned by {@link criticalBranches}.
 * @param limit - how many resolved rows to keep.
 * @returns the capped, sorted rows plus the counts a caller needs to explain what was cut.
 */
export function criticalBranchesForDisplay(
  branches: readonly CriticalBranch[], limit = 150,
): { branches: CriticalBranch[]; total: number; shown: number; unresolved: number; truncated: boolean } {
  const isUnresolved = (b: CriticalBranch): boolean => b.location.startsWith('bid:') || b.distance < 0
  const unresolved = branches.filter(isUnresolved).length
  const resolved = [...branches]
    .filter(b => !isUnresolved(b))
    .sort((a, b) => a.distance - b.distance || a.location.localeCompare(b.location) || a.function.localeCompare(b.function))
  const shown = resolved.slice(0, limit)
  return { branches: shown, total: branches.length, shown: shown.length, unresolved, truncated: shown.length < resolved.length }
}

/**
 * Nearby instruction-bearing lines for a target that resolved to nothing.
 *
 * `lines` are the lines known to carry instructions in the target's file — from the
 * bid-mapping dump of an index run, or failing that from a source heuristic.
 * @param requested - the unresolved `file:line`.
 * @param lines - candidate instruction lines in that file.
 * @param limit - how many to return.
 * @returns `file:line` strings, nearest first (ties prefer the later line, the usual fix for a comment above a statement).
 */
export function nearbyCandidates(requested: string, lines: Iterable<number>, limit = 3): string[] {
  const r = parseLocation(requested)
  if (!r) return []
  return [...new Set(lines)]
    .filter(l => l !== r.line && l > 0)
    .sort((a, b) => Math.abs(a - r.line) - Math.abs(b - r.line) || b - a)
    .slice(0, limit)
    .map(l => `${r.file}:${String(l)}`)
}

/** Instruction lines per basename, from a bid-mapping dump. */
export function instructionLines(bidMapping: BidMappingRow[], file: string): number[] {
  const base = basename(file)
  return bidMapping.filter(r => basename(r.file) === base).map(r => r.line)
}

/**
 * Source-text fallback when no bid mapping is available: lines that look like statements.
 * Deliberately conservative — excludes blanks, comments, lone braces, preprocessor lines and
 * bare declarations without an initializer.
 * @param source - file text.
 * @returns 1-based line numbers.
 */
export function heuristicInstructionLines(source: string): number[] {
  const out: number[] = []
  let inBlock = false
  source.split('\n').forEach((raw, i) => {
    let t = raw.trim()
    if (inBlock) { const e = t.indexOf('*/'); if (e < 0) return; inBlock = false; t = t.slice(e + 2).trim() }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return }
    if (t === '' || t.startsWith('//') || t.startsWith('#') || /^[{}]+;?$/.test(t)) return
    if (/^(?:(?:static|const|unsigned|signed|struct|enum|extern)\s+)*[A-Za-z_]\w*[\s*]+[A-Za-z_]\w*(\[[^\]]*\])?;$/.test(t)) return
    if (/^[A-Za-z_][\w\s*]*\([^;]*\)\s*\{?$/.test(t) && !/^(if|while|for|switch|return)\b/.test(t)) return
    out.push(i + 1)
  })
  return out
}
