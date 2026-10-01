/**
 * Location normalisation and path remapping.
 *
 * KAMain matches a target when the debug-info filename *contains* the requested file string
 * and the line is *exactly* equal (`f.find(target.first) != npos && line == target.second`).
 * Its outputs then use two path styles: basenames in the distance dump and absolute paths in
 * the bid-mapping dump. Neither is the caller's path. This module turns both back into
 * repo-relative `file:line` strings and detects the basename ambiguity that substring matching
 * silently accepts (two `util.c` files both "match" `util.c:10`).
 *
 * @module @pbfuzz/dsh-kanalyzer/core/paths
 */

/** A parsed `file:line`. */
export interface FileLine {
  file: string
  line: number
}

/**
 * Parse `file:line`, tolerating a trailing `:col`. Returns undefined for anything else.
 * @param location - the location string.
 * @returns the parsed location, or undefined.
 */
export function parseLocation(location: string): FileLine | undefined {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(location.trim())
  if (m?.[1] === undefined || m[2] === undefined || m[1].length === 0) return undefined
  return { file: m[1], line: Number(m[2]) }
}

/** @returns the final path component (POSIX or Windows separators). */
export function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? path : path.slice(i + 1)
}

/** Strip `./` prefixes and collapse duplicate separators. */
function clean(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^(\.\/)+/, '')
}

/**
 * What to write into KAMain's target-list file for one requested location.
 *
 * KAMain compares against the DI filename, which is whatever the compiler was given —
 * sometimes absolute, sometimes relative to the build directory. A basename is the one form
 * that is always a substring of it, so the target list uses the basename; ambiguity is
 * detected afterwards by {@link RepoIndex.ambiguous}.
 * @param location - requested `file:line`.
 * @returns the `basename:line` entry, or undefined when the location is malformed.
 */
export function targetListEntry(location: string): string | undefined {
  const parsed = parseLocation(location)
  if (parsed === undefined) return undefined
  return `${basename(clean(parsed.file))}:${String(parsed.line)}`
}

/**
 * The repo's source files, for remapping KAMain's paths back to repo-relative ones.
 * Built from a list of repo-relative file paths (the caller walks the tree).
 *
 * `prepare()` can run the analysis build in an isolated copy of the repo (see
 * `host/runtime.ts`'s `<repo>/.kanalyzer/tree/`) so a source build never touches the caller's
 * working tree. KAMain then bakes that copy's absolute paths into its dumps, not the original
 * repo's. `aliasRoots` lets {@link remap} treat one or more such copies as additional repo roots,
 * so a path inside a copy resolves to the same repo-relative string a path inside the real repo
 * would.
 */
export class RepoIndex {
  private readonly byBase = new Map<string, string[]>()

  /** Cleaned, trailing-slash-stripped alias roots (isolated-tree copies of {@link repo}). */
  readonly aliasRoots: readonly string[]

  /**
   * @param repo - absolute repo root.
   * @param files - repo-relative source paths.
   * @param aliasRoots - absolute directories that mirror `repo`'s contents (e.g. an isolated
   *   analysis-build copy); an absolute KAMain path under one of these remaps the same way a
   *   path under `repo` does.
   */
  constructor(readonly repo: string, files: readonly string[], aliasRoots: readonly string[] = []) {
    for (const f of files) {
      const rel = clean(f)
      const base = basename(rel)
      const list = this.byBase.get(base) ?? []
      list.push(rel)
      this.byBase.set(base, list)
    }
    for (const list of this.byBase.values()) list.sort()
    this.aliasRoots = aliasRoots.map(a => clean(a).replace(/\/$/, ''))
  }

  /** @returns every repo file with this basename. */
  candidates(base: string): string[] {
    return this.byBase.get(base) ?? []
  }

  /**
   * Remap one KAMain path (basename, absolute, or build-relative) to a repo-relative path.
   *
   * Absolute paths inside the repo are made relative; absolute paths inside an alias root (see
   * {@link aliasRoots}) are made relative the same way; otherwise the longest repo path that is
   * a suffix of the KAMain path wins; a bare basename resolves only when it is unique.
   * @param path - the path as KAMain wrote it.
   * @returns the repo-relative path, or the input unchanged when it cannot be resolved.
   */
  remap(path: string): string {
    const p = clean(path)
    const root = clean(this.repo).replace(/\/$/, '')
    // Aliases first, longest first: the isolated analysis tree lives *inside* the checkout
    // (`<repo>/.kanalyzer/tree`), so matching the repo root first would strip only the checkout
    // prefix and leave `.kanalyzer/tree/src/x.c` — a path that exists nowhere the user cares about.
    for (const alias of [...this.aliasRoots].sort((a, b) => b.length - a.length)) {
      if (alias.length > 0 && p.startsWith(`${alias}/`)) return p.slice(alias.length + 1)
    }
    if (root.length > 0 && p.startsWith(`${root}/`)) return p.slice(root.length + 1)
    const cands = this.candidates(basename(p))
    if (cands.length === 1 && cands[0] !== undefined) return cands[0]
    const suffixed = cands.filter(c => p === c || p.endsWith(`/${c}`)).sort((a, b) => b.length - a.length)
    if (suffixed[0] !== undefined) return suffixed[0]
    return p
  }

  /**
   * Remap a `file:line` location; non-locations (e.g. `NoLoc:0`) pass through.
   * @param location - as KAMain wrote it.
   * @returns the repo-relative location.
   */
  remapLocation(location: string): string {
    const parsed = parseLocation(location)
    if (parsed === undefined || parsed.line === 0) return location
    return `${this.remap(parsed.file)}:${String(parsed.line)}`
  }

  /**
   * Whether a requested file is ambiguous under KAMain's basename-substring matching.
   * @param file - the requested file (any style).
   * @returns the other repo files that would also match, empty when unambiguous.
   */
  ambiguous(file: string): string[] {
    const base = basename(clean(file))
    const all = [...this.byBase.entries()]
      .filter(([b]) => b.includes(base))
      .flatMap(([, list]) => list)
    return all.length > 1 ? all.sort() : []
  }
}
