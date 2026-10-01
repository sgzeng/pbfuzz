/**
 * Pure path math for the isolated analysis tree.
 *
 * `kanalyzer_prepare` must not build in the user's own tree. A real session showed why: the
 * agent's build command began with `rm -rf build/src/nginx/objs` and the wllvm rebuild then
 * overwrote `build/out/http_request_fuzzer` — the very binary the user fuzzes — while the
 * analysis it produced was useless anyway, because the project's own `-fsanitize=address`
 * flags survived and 37,634 of KAMain's 37,678 critical branches turned out to be ASan check
 * traps rather than real source branches.
 *
 * So prepare copies the checkout into `<repo>/.kanalyzer/tree` and builds there, with the
 * sanitizers stripped. Everything this plugin writes into a workspace lives under that one
 * hidden directory, which is also the only thing excluded from the copy.
 *
 * No filesystem access here: this module only decides *which* paths are involved, so the rules
 * are unit-testable without a 447 MB tree.
 *
 * @module @pbfuzz/dsh-kanalyzer/core/isolation
 */

import type { PrepareMode } from '../api.ts'

/** The one directory prepare writes into the user's workspace. */
export const KANALYZER_DIR = '.kanalyzer'

/** Absolute locations prepare uses for one repo. */
export interface Isolation {
  /** `<repo>/.kanalyzer` — excluded from the copy, ignored by git, safe to delete. */
  root: string
  /** The copy the analysis build runs in. */
  tree: string
  /** Holds the compiler shims; goes first on the build subprocess's `PATH`. */
  shim: string
  /** One line per compiler invocation; the job's `readOutput()` tails it. */
  progress: string
  /** Persisted prepare memo, so a repeat call across sessions can reuse the bitcode. */
  memo: string
}

/** Strip a trailing slash (but never turn `/` into an empty string). */
function noTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/**
 * @param repo - the project checkout (already absolute).
 * @returns every path prepare derives from it.
 */
export function isolationFor(repo: string): Isolation {
  const root = `${noTrailingSlash(repo)}/${KANALYZER_DIR}`
  return { root, tree: `${root}/tree`, shim: `${root}/shim`, progress: `${root}/progress.log`, memo: `${root}/prepare.json` }
}

/**
 * @param root - an absolute directory.
 * @param path - an absolute path.
 * @returns whether `path` is `root` itself or sits under it.
 */
export function insideRoot(root: string, path: string): boolean {
  const r = noTrailingSlash(root)
  const p = noTrailingSlash(path)
  return p === r || p.startsWith(`${r}/`)
}

/**
 * Map a path inside the repo to the same relative position inside the copy.
 * @param repo - the checkout root (absolute).
 * @param tree - the copy's root (absolute).
 * @param path - an absolute path inside `repo`.
 * @returns the corresponding path inside `tree`.
 * @throws when `path` is outside the repo — building there would escape the isolation, and
 *   silently building in the user's own tree is exactly what this exists to prevent.
 */
export function intoTree(repo: string, tree: string, path: string): string {
  const r = noTrailingSlash(repo)
  const p = noTrailingSlash(path)
  if (!insideRoot(r, p)) {
    throw new Error([
      `${path} is outside the project checkout ${repo}, so the isolated analysis build cannot run there.`,
      'Pass a `cwd` inside `repo`, or set `isolate: false` to build in the checkout itself (which then keeps the',
      "project's own flags, including any sanitizers — see the kanalyzer skill's \"Sanitizer noise\" section).",
    ].join('\n'))
  }
  return p === r ? tree : `${noTrailingSlash(tree)}${p.slice(r.length)}`
}

/**
 * Point a build command's absolute repo paths at the copy.
 *
 * Deliberately a plain textual substitution of the checkout root: a command like
 * `bash /repo/build.sh` must run the copy's script, not the original. Relative paths need
 * nothing — the command already runs with its `cwd` mapped into the copy.
 * @param cmd - the caller's build command.
 * @param repo - the checkout root (absolute).
 * @param tree - the copy's root (absolute).
 * @returns the command to run inside the copy.
 */
export function rewriteBuildCmd(cmd: string, repo: string, tree: string): string {
  const r = noTrailingSlash(repo)
  return r.length > 1 ? cmd.split(r).join(noTrailingSlash(tree)) : cmd
}

/** The inputs that decide whether a previous prepare's bitcode can be reused. */
export interface PrepareIdentity {
  repo: string
  cwd?: string
  buildCmd: string
  mode: PrepareMode
  program?: string
  profile: string
  isolate: boolean
  ltoLibs?: readonly string[]
  env?: Record<string, string>
}

/**
 * Canonical, order-stable text for a prepare request — the memo and single-flight key.
 * @param id - the request's identity-bearing fields.
 * @returns a stable string; equal strings mean "the same build".
 */
export function prepareIdentityKey(id: PrepareIdentity): string {
  return JSON.stringify([
    noTrailingSlash(id.repo),
    id.cwd === undefined ? '' : noTrailingSlash(id.cwd),
    id.buildCmd,
    id.mode,
    id.program ?? '',
    id.profile,
    id.isolate,
    [...(id.ltoLibs ?? [])].sort(),
    Object.entries(id.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ])
}
