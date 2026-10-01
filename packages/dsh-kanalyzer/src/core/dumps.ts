/**
 * Parsers for KAMain's dump files.
 *
 * Formats are taken from the dump functions in `src/lib/Reachable.cc`; the header comments in
 * `src/lib/KAMain.cc` state each one:
 *
 * | dump | line format | notes |
 * |---|---|---|
 * | distance | `bid,bb_hash,file:line,distance` | distance is `dist*1000`; exit blocks are written with `-1`; a `##########` separator is followed by `fun:<name>` lines for every function containing a reached block |
 * | policy | `bid,true_distance,false_distance,false_bid,true_bid` | either distance may be the literal `inf`; after `##########` come indirect call sites as `bid,order:GUID,dist;…` |
 * | critical-branch | `critical_bid,exit_bid_1,…` | |
 * | bid-mapping | `bid,bb_hash,fun_GUID,filepath:line` | filepath is an **absolute** normalised path |
 * | func-info | `fun_GUID,fun_name,filepath,start_line,end_line` | |
 * | caller-callee | `caller_GUID,callee_GUID,…` | GUIDs only; names come from func-info |
 * | callee-caller | `callee_GUID,caller_GUID,…` | |
 *
 * Two properties drive the shape of this module. The location field is written by two different
 * helpers — `getSourceLocation()` emits a **basename**, `getDebugLocationFullPath()` emits an
 * **absolute path** — so callers must never compare the two literally (see `core/paths.ts`).
 * And every dump is written by iterating unordered containers, so ordering carries no meaning
 * and every list this module returns is sorted.
 *
 * @module @pbfuzz/dsh-kanalyzer/core/dumps
 */

/** One row of the distance dump. */
export interface DistanceRow {
  bid: number
  bbHash: string
  /** `file:line` as KAMain wrote it — a basename, or `NoLoc:0` when the block has no debug info. */
  location: string
  /** KAMain's distance, already multiplied by 1000. `-1` marks a block that reaches an exit. */
  distance: number
}

/** The distance dump: reached blocks plus the list of functions they live in. */
export interface DistanceDump {
  rows: DistanceRow[]
  /** Names from the trailing `fun:` section — the functions the analysis reached. */
  reachedFunctions: string[]
}

/** One conditional branch from the policy dump. */
export interface PolicyRow {
  bid: number
  /** Distance when the branch takes its false successor; `null` for `inf`. */
  trueDistance: number | null
  falseDistance: number | null
  falseBid: number
  trueBid: number
}

/** One row of the bid → location mapping. */
export interface BidMappingRow {
  bid: number
  bbHash: string
  funcGuid: string
  /** Absolute path. */
  file: string
  line: number
}

/** One function from the func-info dump. */
export interface FuncInfoRow {
  guid: string
  name: string
  file: string
  startLine: number
  endLine: number
}

/** A GUID adjacency list (caller→callees or callee→callers). */
export type GuidEdges = Map<string, string[]>

const SEPARATOR = '##########'

/** Split a dump into non-empty trimmed lines. */
function lines(text: string): string[] {
  return text.split('\n').map(l => l.trim()).filter(l => l.length > 0)
}

/**
 * Parse the distance dump.
 * @param text - file contents.
 * @returns rows and reached function names, both sorted.
 */
export function parseDistance(text: string): DistanceDump {
  const rows: DistanceRow[] = []
  const reached: string[] = []
  let afterSeparator = false
  for (const line of lines(text)) {
    if (line === SEPARATOR) { afterSeparator = true; continue }
    if (afterSeparator) {
      if (line.startsWith('fun:')) reached.push(line.slice(4))
      continue
    }
    // The location itself contains a colon, so split on commas and take the fixed positions.
    const parts = line.split(',')
    if (parts.length < 4) continue
    const bid = Number(parts[0])
    const distance = Number(parts[parts.length - 1])
    if (!Number.isFinite(bid) || !Number.isFinite(distance)) continue
    rows.push({
      bid,
      bbHash: parts[1] ?? '',
      location: parts.slice(2, parts.length - 1).join(','),
      distance,
    })
  }
  rows.sort((a, b) => a.distance - b.distance || a.bid - b.bid)
  return { rows, reachedFunctions: [...new Set(reached)].sort() }
}

/** Parse one policy distance field; KAMain writes `inf` for an unreachable successor. */
function policyDistance(raw: string | undefined): number | null {
  if (raw === undefined || raw === 'inf') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * Parse the branch section of the policy dump. The indirect-callsite section after the
 * separator is not part of the service contract and is skipped.
 *
 * `dumpPolicy` (Reachable.cc) writes `bid, dist(succ 1), dist(succ 0), bid(succ 1), bid(succ 0)`,
 * where successor 0 is the branch's true edge and successor 1 its false edge — its local
 * variable names (`tdist`/`fdist`) say the opposite of what they hold. Verified on the real
 * selftest row `1001,0.000000,inf,1003,1002`: the false edge (1003) leads to the target.
 * @param text - file contents.
 * @returns branch rows sorted by block id.
 */
export function parsePolicy(text: string): PolicyRow[] {
  const rows: PolicyRow[] = []
  for (const line of lines(text)) {
    if (line === SEPARATOR) break
    const parts = line.split(',')
    if (parts.length < 5) continue
    const bid = Number(parts[0])
    if (!Number.isFinite(bid)) continue
    rows.push({
      bid,
      falseDistance: policyDistance(parts[1]),
      trueDistance: policyDistance(parts[2]),
      falseBid: Number(parts[3]),
      trueBid: Number(parts[4]),
    })
  }
  return rows.sort((a, b) => a.bid - b.bid)
}

/**
 * Parse the critical-branch dump: each row is one branch block and the exit blocks it guards.
 * @param text - file contents.
 * @returns a map from critical block id to its exit block ids.
 */
export function parseCriticalBranches(text: string): Map<number, number[]> {
  const map = new Map<number, number[]>()
  for (const line of lines(text)) {
    const parts = line.split(',').map(Number)
    const [bid, ...exits] = parts
    if (bid === undefined || !Number.isFinite(bid)) continue
    map.set(bid, exits.filter(Number.isFinite).sort((a, b) => a - b))
  }
  return map
}

/**
 * Parse the bid → location mapping.
 * @param text - file contents.
 * @returns one row per mapped basic block.
 */
export function parseBidMapping(text: string): BidMappingRow[] {
  const rows: BidMappingRow[] = []
  for (const line of lines(text)) {
    const parts = line.split(',')
    if (parts.length < 4) continue
    const bid = Number(parts[0])
    const locator = parts.slice(3).join(',')
    const colon = locator.lastIndexOf(':')
    if (!Number.isFinite(bid) || colon < 0) continue
    const lineNo = Number(locator.slice(colon + 1))
    if (!Number.isFinite(lineNo)) continue
    rows.push({
      bid,
      bbHash: parts[1] ?? '',
      funcGuid: parts[2] ?? '',
      file: locator.slice(0, colon),
      line: lineNo,
    })
  }
  return rows.sort((a, b) => a.bid - b.bid)
}

/**
 * Parse the func-info dump.
 * @param text - file contents.
 * @returns one row per defined function, sorted by name.
 */
export function parseFuncInfo(text: string): FuncInfoRow[] {
  const rows: FuncInfoRow[] = []
  for (const line of lines(text)) {
    const parts = line.split(',')
    if (parts.length < 5) continue
    const [guid, name, file, start, end] = parts
    if (guid === undefined || name === undefined || file === undefined) continue
    rows.push({ guid, name, file, startLine: Number(start), endLine: Number(end) })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.guid.localeCompare(b.guid))
}

/**
 * Parse a GUID adjacency dump (`caller-callee` or `callee-caller`).
 *
 * GUIDs are 64-bit and are kept as strings: `Number` would round the large ones and silently
 * merge two functions into one node.
 * @param text - file contents.
 * @returns the adjacency map, each neighbour list sorted and de-duplicated.
 */
export function parseGuidEdges(text: string): GuidEdges {
  const edges: GuidEdges = new Map()
  for (const line of lines(text)) {
    const [head, ...rest] = line.split(',').map(p => p.trim()).filter(p => p.length > 0)
    if (head === undefined) continue
    const existing = edges.get(head) ?? []
    edges.set(head, [...new Set([...existing, ...rest])].sort())
  }
  return edges
}
