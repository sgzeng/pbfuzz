/**
 * Call-graph and location queries over the dumps of an index or analyze run.
 * Every result list is sorted: KAMain writes its dumps from unordered containers.
 *
 * `fn` name matching (`callers`/`callees`/`critical`) tries the dump's exact name first — the
 * only path before this module grew a demangler, and it still decides for a C target. For a C++
 * target, func-info holds Itanium-mangled names (`_Z31check_dangerous_elf_combination…`), which a
 * model asking by source name cannot know; {@link demangleItanium} recovers the common-case
 * qualified name so that query still resolves. See its own doc comment for exactly what subset
 * it covers and what it deliberately does not.
 *
 * @module @pbfuzz/dsh-kanalyzer/core/query
 */

import type { QueryRequest, QueryResult, ReachAnswer, ReachCoverage, ReachVerdict } from '../api.ts'
import type { BidMappingRow, DistanceDump, FuncInfoRow, GuidEdges, PolicyRow } from './dumps.ts'
import { basename, parseLocation, type RepoIndex } from './paths.ts'
import { type BlockIndex, sameFile } from './status.ts'

/** The parsed dumps a query reads. */
export interface QueryData {
  funcInfo: FuncInfoRow[]
  callerCallee: GuidEdges
  calleeCaller: GuidEdges
  bidMapping: BidMappingRow[]
  critical: Map<number, number[]>
  blocks: BlockIndex
  repo?: RepoIndex
  /** The distance dump, when one was produced — `distances`/`functions`/`branches` read it.
   * Absent for an index run (no targets), where those three ops answer empty rather than error. */
  distance?: DistanceDump
  /** The policy dump's branch rows, when one was produced — `branches` reads it for the polarity
   * (which successor still reaches the target); absent leaves `branches` empty. */
  policy?: PolicyRow[]
  /**
   * Whether a targeted analysis backs these dumps at all. False means the distance ops have
   * nothing to read — an empty answer that says nothing about the program, which the result's
   * `note` must spell out rather than leave to be read as "unreachable".
   */
  analyzed?: boolean
}

/** Default cap on returned results. */
export const QUERY_LIMIT = 500

/**
 * Default cap for `distances`, below {@link QUERY_LIMIT}.
 *
 * Its rows are the longest of any op — `function@/absolute/path/file.c:line=distance` — so 500 of
 * them ran to 51 KB on the nginx case and the host truncated the middle of the JSON while the
 * payload still claimed `truncated:false`. 200 rows stay well inside that, and anyone who wants
 * the tail can ask for it.
 */
export const DISTANCES_LIMIT = 200

function cap(results: string[], limit: number): { results: string[]; truncated: boolean } {
  const sorted = [...new Set(results)].sort()
  return { results: sorted.slice(0, limit), truncated: sorted.length > limit }
}

/**
 * Cap rows that are already in a meaningful order, without re-sorting them.
 *
 * {@link cap} sorts because KAMain's dumps come out of unordered containers and a call-graph answer
 * has no inherent order. The distance-bearing ops do: nearest the target first is the whole point,
 * and lexically sorting `…=93.1` against `…=1093.1` would destroy it. Dedupe is kept.
 * @param rows - rows in the order they should be returned.
 * @param limit - result cap.
 * @returns the first `limit` distinct rows, and whether any were dropped.
 */
function capOrdered(rows: string[], limit: number): { results: string[]; truncated: boolean } {
  const distinct = [...new Set(rows)]
  return { results: distinct.slice(0, limit), truncated: distinct.length > limit }
}

/** KAMain writes distances already multiplied by 1000; keep one decimal so two blocks a single
 * branch apart stay distinguishable without printing float noise. */
function distanceText(distance: number): string {
  return distance.toFixed(1)
}

/**
 * Find the index of the `E` that closes an Itanium `I…E` template-argument block (or an `N…E`
 * nested-name embedded inside one) opened at `open` in `mangled`, honoring nesting between the
 * two — every `I` or `N` needs its own closing `E`, so a nested-name inside a template argument
 * does not end the template block early.
 * @param mangled - the full mangled name.
 * @param open - index of the opening `I`.
 * @returns the index of the matching `E`, or undefined when the block never closes.
 */
function matchingClose(mangled: string, open: number): number | undefined {
  let depth = 0
  for (let k = open; k < mangled.length; k++) {
    const c = mangled[k]
    if (c === 'I' || c === 'N') depth++
    else if (c === 'E') { depth--; if (depth === 0) return k }
  }
  return undefined
}

/**
 * Demangle the Itanium C++ ABI subset that covers the overwhelming majority of real-world
 * function names KAMain reports for a C++ target: a length-prefixed `<source-name>`, optionally
 * scoped (`_ZN…E` nested names — namespaces and classes — with one level of cv-/ref-qualifiers
 * skipped and a per-component template-argument block stripped), and an unscoped name with a
 * trailing template-argument block. Parameter types are never decoded: this recovers only the
 * qualified function name, which is exactly what a source-level query needs — e.g.
 * `_Z31check_dangerous_elf_combinationRK9ELFHeader` → `check_dangerous_elf_combination`, and
 * `_ZN3FooIiE3barEv` → `Foo::bar`.
 *
 * Deliberately NOT covered — this bails out to `undefined` rather than guess, so those names
 * keep matching only by their exact mangled form: substitution back-references (`S_`, `S0_`, …,
 * including the `St`/`Ss`/`Sa`/… abbreviations for `std::` types, both common in real C++ dumps),
 * constructor/destructor special members (`C1`/`C2`/`C3`, `D0`/`D1`/`D2`), operator-name codes
 * (`pl`, `mi`, `cv`, …), vendor extensions, and local-scope (`Z…E`) names. Full ABI coverage
 * (in particular substitutions, which most nontrivial C++ names use) is out of scope.
 * @param mangled - a name as KAMain's func-info dump wrote it.
 * @returns the demangled, `::`-joined qualified name, or undefined when this is not a
 *   `_Z`-mangled Itanium name or falls outside the covered subset.
 */
export function demangleItanium(mangled: string): string | undefined {
  if (!mangled.startsWith('_Z') || mangled.length <= 2) return undefined
  let i = 2

  // One `<length><chars>` component, plus an immediately-following `I…E` template block if any.
  const readComponent = (): string | undefined => {
    let j = i
    while (j < mangled.length && mangled[j] >= '0' && mangled[j] <= '9') j++
    if (j === i) return undefined // not length-prefixed: a substitution, ctor/dtor, operator, …
    const len = Number(mangled.slice(i, j))
    if (!Number.isFinite(len) || len <= 0) return undefined
    const start = j
    const end = start + len
    if (end > mangled.length) return undefined
    const name = mangled.slice(start, end)
    i = end
    if (mangled[i] === 'I') {
      const close = matchingClose(mangled, i)
      if (close === undefined) return undefined
      i = close + 1
    }
    return name
  }

  if (mangled[i] === 'N') {
    i++
    while (i < mangled.length && 'KVRO'.includes(mangled[i])) i++ // cv-/ref-qualifiers
    const parts: string[] = []
    for (;;) {
      const part = readComponent()
      if (part === undefined) return undefined
      parts.push(part)
      if (mangled[i] === 'E') { i++; break }
      if (i >= mangled.length) return undefined // unterminated nested-name
    }
    return parts.join('::')
  }
  return readComponent()
}

/**
 * Strip a trailing `(...)` argument list and/or `<...>` template-argument list a model might
 * append when asking by source name (`check_dangerous_elf_combination(const ELFHeader&)`,
 * `foo<int>`). Template args on a non-trailing scope component (`Foo<int>::bar`) are not
 * normalized — see {@link demangleItanium}'s doc comment for its own, matching gaps.
 * @param name - the query's `fn`, as asked.
 * @returns the name with a trailing call/template suffix removed, unchanged otherwise.
 */
function stripCallSuffix(name: string): string {
  let s = name.trim()
  if (s.endsWith(')')) {
    const open = s.lastIndexOf('(')
    if (open > 0) s = s.slice(0, open).trimEnd()
  }
  if (s.endsWith('>')) {
    const open = s.lastIndexOf('<')
    if (open > 0) s = s.slice(0, open).trimEnd()
  }
  return s
}

/**
 * Whether a KAMain-reported function name answers a source-level name query.
 *
 * Tries the exact dump form first — unchanged from before this function existed, so a C target
 * (or any caller already passing the correct mangled name) matches byte-identically. Only when
 * that fails does it try {@link demangleItanium} on the dump name, comparing the demangled form
 * exactly or against the query with a trailing `(...)`/`<...>` stripped — the two ways a model
 * asking by source name (it cannot see the mangling) is likely to phrase a C++ query.
 * @param dumpName - a name as KAMain's func-info/bid-mapping dump wrote it.
 * @param query - the requested `fn`.
 * @returns whether `dumpName` answers `query`.
 */
function nameMatches(dumpName: string, query: string): boolean {
  if (dumpName === query) return true
  const demangled = demangleItanium(dumpName)
  return demangled !== undefined && (demangled === query || demangled === stripCallSuffix(query))
}

/** What an empty or negative distance answer does and does not prove. */
const NOTES = {
  noAnalysis:
    'No targeted kanalyzer_analyze is on record for this bitcode, so there is no distance table to read — '
    + 'this empty answer says nothing about the program. Run kanalyzer_analyze with the target first.',
  noDistance:
    'KAMain recorded no distance for these blocks. That is NOT proof the code cannot reach the target: '
    + 'the distance pass skips indirect call sites with more than 50 type-compatible candidates (nginx\'s own '
    + '`rc = ph->handler(r)` phase dispatch is one), never propagates through return edges, stops at the '
    + 'call-stack-length limit, and only falls back to type-based callers for a function with no direct caller. '
    + 'Say "KAMain found no static path" and give the evidence, not "unreachable".',
  exitOnly:
    'Every block here is marked -1: KAMain found it leads to a program exit (an `unreachable` terminator or a '
    + 'noreturn call — with a sanitizer-instrumented bitcode, usually its own abort stub) and its backward search '
    + 'from the target did not reach it. Strong negative evidence, still bounded by the call-depth limit.',
  noBlock:
    'No basic block maps to that line: after optimisation the line owns no instruction of its own (a declaration, '
    + 'a brace, or a `return` merged into a shared block). This says nothing about reachability — the answer is '
    + 'for the block that actually covers the line.',
  callersDump:
    'KAMain lists a function\'s direct callers when it has any, and otherwise every call site whose signature is '
    + 'type-compatible — a superset that includes functions which cannot really call it. Not a path proof.',
} as const

/**
 * bid → distance, built once per distance dump rather than once per lookup.
 *
 * The dump runs to 70k rows on a real program and several answers in one query need it; keyed on
 * the parsed dump itself, the map dies with it and can never outlive the file it came from.
 */
const distanceIndexes = new WeakMap<DistanceDump, Map<number, number>>()

/** @returns bid → distance for this dump, cached on it. */
function distanceIndex(distance: DistanceDump | undefined): Map<number, number> {
  if (distance === undefined) return new Map()
  const hit = distanceIndexes.get(distance)
  if (hit !== undefined) return hit
  const index = new Map(distance.rows.map(r => [r.bid, r.distance]))
  distanceIndexes.set(distance, index)
  return index
}

/** Per-function block coverage of the distance table, and the verdict that follows from it. */
function coverageOf(fn: string, data: QueryData): ReachCoverage {
  const distanceByBid = distanceIndex(data.distance)
  let blocks = 0, withDistance = 0, exitOnly = 0, absent = 0
  let nearest: number | undefined
  for (const row of data.bidMapping) {
    const owner = data.blocks.functionOf(row.bid)
    if (owner === undefined || !nameMatches(owner, fn)) continue
    blocks++
    const d = distanceByBid.get(row.bid)
    if (d === undefined) absent++
    else if (d < 0) exitOnly++
    else { withDistance++; if (nearest === undefined || d < nearest) nearest = d }
  }
  const inFunList = (data.distance?.reachedFunctions ?? []).some(f => nameMatches(f, fn))
  return { blocks, withDistance, exitOnly, absent, ...(nearest !== undefined ? { nearest } : {}), inFunList }
}

/** @returns the verdict the coverage supports, on its own terms. */
function verdictOf(c: ReachCoverage): ReachVerdict {
  if (c.blocks === 0) return 'no_block'
  if (c.withDistance > 0) return 'reaches'
  if (c.exitOnly > 0 && c.absent === 0) return 'exit_only'
  return 'no_distance'
}

/** The function(s) owning the target blocks — distance 0 is the target itself. */
function targetFunctions(data: QueryData): string[] {
  const fns = new Set<string>()
  for (const row of data.distance?.rows ?? []) {
    if (row.distance !== 0) continue
    const fn = data.blocks.functionOf(row.bid)
    if (fn !== undefined) fns.add(fn)
  }
  return [...fns]
}

/**
 * Call-graph evidence for a function the distance table has nothing positive to say about.
 *
 * The distance pass and the call-graph dumps disagree by construction — the pass drops the very
 * indirect edges the dumps still list, and models no return edges at all — so when a function has
 * no distance, the dumps are the one place left that can show a path. Both directions matter: a
 * (possibly indirect) caller chain into the target's function, and being called *from* code that
 * does reach the target, which means control returns into reaching code.
 * @param fn - the function asked about.
 * @param data - parsed dumps.
 * @param maxHops - how far to search in the caller direction. Kept short on purpose: the edges are
 *   type-matched, so by three hops almost everything is "reachable" through some shared-signature
 *   callback (nginx's `ngx_log_error_core` alone bridges half the program) and the path stops being
 *   evidence of anything.
 * @returns a path — the queried function first, walking down to the target's — and/or a note, when
 *   there is anything to say.
 */
function callEvidence(fn: string, data: QueryData, maxHops = 2): { callPath?: string[]; callNote?: string } {
  const targets = targetFunctions(data)
  if (targets.length === 0 || targets.some(t => nameMatches(t, fn))) return {}
  const nameOf = new Map(data.funcInfo.map(f => [f.guid, f.name]))
  const guidsOf = (name: string): string[] => data.funcInfo.filter(f => nameMatches(f.name, name)).map(f => f.guid)
  const from = new Set(guidsOf(fn))
  if (from.size === 0) return {}

  // Backward from the target's function over callee→caller: does some chain arrive at `fn`?
  let frontier = targets.flatMap(guidsOf)
  const seen = new Set(frontier)
  const parent = new Map<string, string>()
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: string[] = []
    for (const g of frontier) {
      for (const caller of data.calleeCaller.get(g) ?? []) {
        if (seen.has(caller)) continue
        seen.add(caller); parent.set(caller, g); next.push(caller)
        if (from.has(caller)) {
          const path: string[] = []
          for (let cur: string | undefined = caller; cur !== undefined; cur = parent.get(cur)) path.push(nameOf.get(cur) ?? `guid:${cur}`)
          return {
            callPath: path,
            callNote: `KAMain's call-graph dump does put this function ${String(path.length - 1)} hop(s) above the target's function, `
              + 'even though its distance pass assigned no distance along that chain — the usual sign of an indirect '
              + 'call site the pass skipped. Call edges are a type-based over-approximation, so treat this as a candidate path, not a proof.',
          }
        }
      }
    }
    frontier = next
  }

  // Called from code that does reach the target ⇒ it returns into reaching code, which the
  // distance pass models for reachability but never for distance.
  const reaching = new Set(data.distance?.reachedFunctions ?? [])
  const callers = [...from].flatMap(g => data.calleeCaller.get(g) ?? []).map(g => nameOf.get(g)).filter((n): n is string => n !== undefined)
  const reachingCallers = [...new Set(callers.filter(c => reaching.has(c)))].sort()
  if (reachingCallers.length > 0) {
    return {
      callNote: `Called from ${String(reachingCallers.length)} function(s) that do reach the target (e.g. ${reachingCallers.slice(0, 3).join(', ')}), `
        + 'so control returns from here into code that reaches it. KAMain propagates distance through call edges but '
        + 'not through return edges, which is why this function has none of its own.',
    }
  }
  return {}
}

/**
 * Answer one query.
 * @param req - the query.
 * @param data - parsed dumps.
 * @param limit - result cap.
 * @returns sorted results.
 */
export function runQuery(req: QueryRequest, data: QueryData, limit = QUERY_LIMIT): QueryResult {
  const nameOf = new Map(data.funcInfo.map(f => [f.guid, f.name]))
  const guidsOf = (fn: string): string[] => data.funcInfo.filter(f => nameMatches(f.name, fn)).map(f => f.guid)
  const neighbours = (edges: GuidEdges, fn: string): string[] =>
    guidsOf(fn).flatMap(g => edges.get(g) ?? []).map(g => nameOf.get(g) ?? `guid:${g}`)
  /** A block's source location, repo-remapped exactly as `critical` has always remapped it. */
  const locationOf = (bid: number): string | undefined => {
    const raw = data.blocks.locationOf(bid)
    if (raw === undefined) return undefined
    return data.repo ? data.repo.remapLocation(raw) : raw
  }
  /**
   * The blocks a requested line resolves to: the ones mapped to that exact line, else the block
   * that covers it (the greatest block start line not after it, in the same file) — the same rule
   * target resolution uses, because KAMain records a block by the line of its first instruction.
   */
  /**
   * What an empty distance answer means. A distance op returning nothing is the exact shape that
   * got read as "unreachable" in the audited session; it has three quite different causes, and the
   * coverage counts say which one applies.
   * @param found - rows the op produced.
   * @param fn - the function it was narrowed to, when it was.
   * @returns the `note`/`coverage` fields to merge into the result, or nothing when rows were found.
   */
  const emptyNote = (found: number, fn?: string): { note?: string; coverage?: ReachCoverage } => {
    if (found > 0) return {}
    if (data.analyzed === false) return { note: NOTES.noAnalysis }
    if (fn === undefined) return { note: NOTES.noDistance }
    const coverage = coverageOf(fn, data)
    const verdict = verdictOf(coverage)
    return {
      coverage,
      note: verdict === 'no_block'
        ? `No block in the analysed bitcode belongs to ${fn} — check the name (C++ names are mangled in the dumps).`
        : verdict === 'exit_only' ? NOTES.exitOnly : NOTES.noDistance,
    }
  }

  const blocksAt = (location: string): { bids: number[]; exact: boolean; location?: string } => {
    const want = parseLocation(location)
    if (want === undefined) return { bids: [], exact: false }
    // Straight off the parsed rows' own `file`/`line`: routing 132k rows through `locationOf` and
    // `parseLocation` to rebuild strings this dump already gives us in parts cost seconds per query.
    const rows = data.bidMapping.filter(r => sameFile(want.file, r.file))
    if (rows.length === 0) return { bids: [], exact: false }
    const exact = rows.filter(r => r.line === want.line)
    const at = (line: number, hits: BidMappingRow[]): { bids: number[]; exact: boolean; location: string } => ({
      bids: hits.map(r => r.bid),
      exact: line === want.line,
      // Remap only the one location actually reported, not every candidate row.
      location: locationOf(hits[0]?.bid ?? -1) ?? `${want.file}:${String(line)}`,
    })
    if (exact.length > 0) return at(want.line, exact)
    const before = rows.filter(r => r.line <= want.line)
    if (before.length === 0) return { bids: [], exact: false }
    const start = Math.max(...before.map(r => r.line))
    return at(start, before.filter(r => r.line === start))
  }

  switch (req.op) {
    case 'callers': return { op: req.op, ...cap(neighbours(data.calleeCaller, req.fn), limit), note: NOTES.callersDump }
    case 'callees': return { op: req.op, ...cap(neighbours(data.callerCallee, req.fn), limit), note: NOTES.callersDump }
    case 'functionAt': {
      const loc = parseLocation(req.location)
      if (!loc) return { op: req.op, results: [], truncated: false }
      // Blocks actually mapped to the line answer first: `function_info`'s line span is a min/max
      // over every block's location, inlined callees included, so spans overlap wildly (three
      // nginx file-cache functions all "contain" line 1878; only one has blocks there). Only an
      // exact line hit counts here — this op names what is at a line, so extending it to the block
      // that merely covers the line would answer a different question. `reach` does that, and says so.
      const at = blocksAt(req.location)
      const byBlock = at.exact
        ? [...new Set(at.bids.map(b => data.blocks.functionOf(b)).filter((f): f is string => f !== undefined))]
        : []
      if (byBlock.length > 0) return { op: req.op, ...cap(byBlock, limit) }
      const base = basename(loc.file)
      const hits = data.funcInfo.filter(f => basename(f.file) === base && f.startLine <= loc.line && loc.line <= f.endLine)
      return {
        op: req.op,
        ...cap(hits.map(f => f.name), limit),
        note: hits.length === 0
          ? NOTES.noBlock
          : 'No block maps to this line, so these come from function_info\'s line spans, which include inlined '
            + 'callees and therefore overlap: a function listed here may own no code at this line. Use op=reach for a per-line answer.',
      }
    }
    case 'critical': {
      const locs: string[] = []
      for (const bid of data.critical.keys()) {
        if (req.fn !== undefined) {
          const fn = data.blocks.functionOf(bid)
          if (fn === undefined || !nameMatches(fn, req.fn)) continue
        }
        const raw = locationOf(bid)
        if (raw !== undefined) locs.push(raw)
      }
      return { op: req.op, ...cap(locs, limit) }
    }
    case 'branches': {
      // Every branch the policy dump describes, not only the ones `critical_BBs.txt` singles out.
      // KAMain calls a branch critical only when one side is `inf` — but a branch where BOTH sides
      // can still reach the target, just at different distances, is exactly as steerable and is
      // usually where the interesting predicates live (in the real readelf capture the target
      // function's own branches are all in the policy dump and none of them are critical).
      // Reporting only the critical subset is what left "which way does the branch at line 82 go?"
      // unanswerable by any tool.
      const where = (b: number): string => locationOf(b) ?? `bid:${String(b)}`
      const edgeText = (loc: string, distance: number | null): string =>
        `${loc}=${distance === null ? 'exit' : distanceText(distance)}`
      const rows: { text: string; critical: boolean; nearest: number }[] = []
      for (const row of data.policy ?? []) {
        const fn = data.blocks.functionOf(row.bid)
        if (req.fn !== undefined && (fn === undefined || !nameMatches(fn, req.fn))) continue
        // Both sides `inf`: this branch cannot reach the target either way, so there is nothing to
        // steer and nothing to say about it.
        if (row.trueDistance === null && row.falseDistance === null) continue
        const critical = data.critical.has(row.bid)
        const reaching = [row.trueDistance, row.falseDistance].filter((d): d is number => d !== null)
        rows.push({
          critical,
          nearest: Math.min(...reaching),
          text: `${fn ?? '?'}@${where(row.bid)} true->${edgeText(where(row.trueBid), row.trueDistance)} false->${edgeText(where(row.falseBid), row.falseDistance)}${critical ? ' [critical]' : ''}`,
        })
      }
      // Critical first (one side is a dead end, so the choice is forced and most consequential),
      // then nearest the target first within each group.
      rows.sort((a, b) => Number(b.critical) - Number(a.critical) || a.nearest - b.nearest || a.text.localeCompare(b.text))
      return { op: req.op, ...capOrdered(rows.map(r => r.text), req.limit ?? limit), ...emptyNote(rows.length, req.fn) }
    }
    case 'distances': {
      const rows: string[] = []
      // Already sorted ascending by `parseDistance`; `-1` (reaches an exit, never the target) is
      // excluded because this op answers "how far to the target" — those blocks show up in
      // `branches` as the exit side, which is where they are actually actionable.
      for (const row of data.distance?.rows ?? []) {
        if (row.distance < 0) continue
        const fn = data.blocks.functionOf(row.bid)
        if (req.fn !== undefined && (fn === undefined || !nameMatches(fn, req.fn))) continue
        const loc = locationOf(row.bid) ?? row.location
        if (req.file !== undefined && !sameFile(req.file, loc)) continue
        rows.push(`${fn ?? '?'}@${loc}=${distanceText(row.distance)}`)
      }
      return { op: req.op, ...capOrdered(rows, req.limit ?? Math.min(limit, DISTANCES_LIMIT)), ...emptyNote(rows.length, req.fn) }
    }
    case 'functions': {
      const nearest = new Map<string, number>()
      for (const row of data.distance?.rows ?? []) {
        if (row.distance < 0) continue
        const fn = data.blocks.functionOf(row.bid)
        if (fn === undefined) continue
        const seen = nearest.get(fn)
        if (seen === undefined || row.distance < seen) nearest.set(fn, row.distance)
      }
      const rows = [...nearest.entries()]
        .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
        .map(([fn, distance]) => `${fn}=${distanceText(distance)}`)
      return { op: req.op, ...capOrdered(rows, req.limit ?? limit), ...emptyNote(rows.length) }
    }
    case 'reach': {
      const at = req.location !== undefined ? blocksAt(req.location) : undefined
      const asked = req.fn
      const fns = at !== undefined
        ? [...new Set(at.bids.map(b => data.blocks.functionOf(b)).filter((f): f is string => f !== undefined))].sort()
        : asked !== undefined ? [...new Set(data.funcInfo.filter(f => nameMatches(f.name, asked)).map(f => f.name))].sort() : []

      if (fns.length === 0) {
        // A line with no block of its own, or a name nothing matches: say which, and never imply
        // the code cannot run.
        const answers: ReachAnswer[] = req.location !== undefined
          ? [{ function: '?', verdict: 'no_block', coverage: { blocks: 0, withDistance: 0, exitOnly: 0, absent: 0, inFunList: false } }]
          : []
        return {
          op: req.op, results: [], truncated: false, answers,
          note: data.analyzed === false ? NOTES.noAnalysis : req.location !== undefined ? NOTES.noBlock : 'No function of that name is in the analysed bitcode.',
        }
      }

      const answers: ReachAnswer[] = fns.map((fn) => {
        const coverage = coverageOf(fn, data)
        // A location narrows the verdict to the blocks the line resolved to; the function-wide
        // coverage stays attached as the context for it.
        const verdict = ((): ReachVerdict => {
          if (at === undefined) return verdictOf(coverage)
          const byBid = distanceIndex(data.distance)
          const own = at.bids.filter(b => { const f = data.blocks.functionOf(b); return f !== undefined && nameMatches(f, fn) })
          const ds = own.map(b => byBid.get(b))
          if (own.length === 0) return 'no_block'
          if (ds.some(d => d !== undefined && d >= 0)) return 'reaches'
          if (ds.every(d => d !== undefined && d < 0)) return 'exit_only'
          return 'no_distance'
        })()
        // Call-graph evidence is for a function the distance table says nothing positive about.
        // When the function itself reaches and only this block does not, the function's own table
        // is the better evidence and the caller list is noise.
        const evidence = verdict === 'reaches' || coverage.withDistance > 0 ? {} : callEvidence(fn, data)
        const inReachingFn = verdict !== 'reaches' && coverage.withDistance > 0
          ? {
              callNote: `${fn} itself reaches the target (${String(coverage.withDistance)} of its ${String(coverage.blocks)} blocks carry a distance, `
                + `nearest ${distanceText(coverage.nearest ?? 0)}); it is this block that KAMain gave none. Ask for op=branches on this function to see which way its branches go.`,
            }
          : {}
        return {
          function: fn,
          verdict,
          ...(at?.location !== undefined ? { location: at.location, exact: at.exact } : {}),
          coverage,
          ...evidence,
          ...inReachingFn,
        }
      })

      const results = answers.map((a) => {
        const c = a.coverage
        const near = verdictAt(a, data)
        return `${a.function}${a.location !== undefined ? `@${a.location}` : ''}=${a.verdict}${near !== undefined ? `(${distanceText(near)})` : ''}`
          + ` [blocks ${String(c.blocks)}: ${String(c.withDistance)} with distance, ${String(c.exitOnly)} exit-only, ${String(c.absent)} not in table]`
      })
      const worst = answers.some(a => a.verdict === 'reaches')
        ? undefined
        : answers.every(a => a.verdict === 'exit_only') ? NOTES.exitOnly
          : answers.some(a => a.verdict === 'no_block') && answers.every(a => a.verdict === 'no_block') ? NOTES.noBlock : NOTES.noDistance
      const note = data.analyzed === false
        ? NOTES.noAnalysis
        : [at !== undefined && !at.exact ? NOTES.noBlock : undefined, worst].filter(t => t !== undefined).join(' ')
      return { op: req.op, results, truncated: false, answers, coverage: answers[0]?.coverage, ...(note === '' ? {} : { note }) }
    }
  }
}

/** The nearest distance backing a `reaches` verdict, for the one-line result row. */
function verdictAt(answer: ReachAnswer, data: QueryData): number | undefined {
  if (answer.verdict !== 'reaches') return undefined
  if (answer.location === undefined) return answer.coverage.nearest
  const want = parseLocation(answer.location)
  if (want === undefined) return answer.coverage.nearest
  const here = (data.distance?.rows ?? [])
    .filter(r => r.distance >= 0 && parseLocation(data.blocks.locationOf(r.bid) ?? r.location)?.line === want.line)
    .map(r => r.distance)
  return here.length > 0 ? Math.min(...here) : answer.coverage.nearest
}
