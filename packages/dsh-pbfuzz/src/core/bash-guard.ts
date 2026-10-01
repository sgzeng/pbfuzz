/**
 * Best-effort detection of a shell command that would tamper with pbfuzz's campaign state.
 *
 * Ported from `engine/hooks/pbfuzz_hooks/guards.py`'s `_bash_guard_verdict` and its regex
 * machinery, verbatim in structure: clause-by-clause scanning for a *protected path mention* and
 * a *mutation* landing in the same clause, with a `cd`-tracking carve-out for a bare state
 * filename used right after `cd`-ing into the campaign directory. This is explicitly **not a
 * security boundary** — it is regex matching over the raw command text, with no real shell
 * tokenization — the guarded `write`/`edit` denial in `guard-policy.ts` is the actually-enforced
 * path; this module only makes the common, unobfuscated cases of "just `cat`/`echo >` the state
 * file" visible before they run. Do not "improve" the regexes' coverage as part of any future
 * change without re-running them against every row of the precision/recall table in
 * `tests/bash-guard.spec.ts` — a wider match here trades a false negative for a new false
 * positive (see `B3`/`B8`/`B9` in that table), which is not free.
 *
 * Also runs a small variable-taint pass (see {@link taintedVarNames}/{@link taintedVarRefRegExp})
 * so `f=<protected-path>; ...$f...` — assigning the protected filename to a shell variable in one
 * clause and mutating through the variable in another — is caught too, instead of being an
 * undocumented fourth false-negative class alongside N1/N2 below (finding F2). That pass is itself
 * a heuristic, not dataflow analysis: a value laundered through command substitution (`f=$(...)`),
 * a second variable (`f=$g`), an `export`/env-prefix assignment (`FOO=bar cmd`), or reassigned
 * partway through the command is not tracked. Chasing those with more regex is exactly the kind of
 * "improve the regexes' coverage" this file warns against below.
 *
 * A known, accepted residual (alongside N1/N2): the scan is *direction-blind* within a clause — a
 * protected path that is only a *read source* (`cp .pbfuzz/<id>/crashes/poc /tmp/out`) or a mere
 * mention next to an unrelated redirect (`./fuzzer "$POC" >/dev/null`) is denied the same as a real
 * write, because distinguishing operand position needs real tokenization, not regex. Rather than
 * widen (or narrow, and lose the coarse `.pbfuzz` protection for `crashes/`/`testcases/`/the
 * campaign yaml that nothing else guards), the plugin removes the *need* for these shapes: the
 * skill writes `canaries.patch` via the `write` tool and reproduces a PoV in place, and
 * `env-verify.ts` keeps its scratch under the campaign dir — so nothing legitimate routes through
 * `/tmp`. If a future workflow genuinely needs to copy state out, add real tokenization here (with
 * test rows first, per the rule below), not another regex clause.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/bash-guard
 */

/** The result of scanning one bash command for a protected-path-plus-mutation pairing. */
export interface BashGuardVerdict {
  /** Whether `guard-policy.ts` should deny this command. */
  denied: boolean
  /** The protected-path text matched, present whenever {@link denied} is `true`. */
  target?: string
  /** The mutation text matched (trimmed), present whenever {@link denied} is `true`. */
  mutation?: string
}

/** One model-written analysis block or engine-owned file, matching `paths.ts`'s
 * `STATE_BLOCK_FILES` plus `metrics.json` (also inside `state/`). Kept as a literal list rather
 * than importing `STATE_BLOCK_FILES` so this module never needs anything beyond a string and a
 * directory path — see the module doc comment on why: it must stay regex-only, no path/I/O logic
 * of its own. */
const BLOCK_AND_ENGINE_FILES = ['bug_predicates.json', 'fuzz_plan.json', 'metrics.json', 'preconditions.json', 'root_causes.json', 'state.json', 'trigger_plans.json']

/** Campaign-directory files (outside `state/`) a tampering command might also target. */
const CAMPAIGN_FILES = ['.stop_guard.json', 'settings.json', 'tamper-ledger.jsonl']

/** Every filename `_PROTECTED`/`_PROTECTED_BARE` recognise, sorted like `guards.py`'s
 * `_STATE_NAMES` (a plain `sorted(set)` over the same names). */
const STATE_NAMES = [...BLOCK_AND_ENGINE_FILES, ...CAMPAIGN_FILES].sort()

/** Escape every regex metacharacter in `s`, JS's answer to Python's `re.escape`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `(?:name1|name2|...)\b`, one alternative per known state filename. */
const STATE_NAME_ALT = `(?:${STATE_NAMES.map(escapeRegExp).join('|')})\\b`

/** A known state filename with no path-separator requirement at all — only used once a preceding
 * `cd` in the same command has already put the scan inside a directory matching {@link protectedRegExp}. */
const PROTECTED_BARE = new RegExp(`(?<![\\w.-])${STATE_NAME_ALT}`)

/**
 * A protected mention with real path context: the campaign's root-directory marker, or a known
 * state filename immediately preceded by a path separator (so an unrelated same-named file, e.g.
 * a bare `settings.json` from some other project, does not match on its own — see `B8` in
 * `tests/bash-guard.spec.ts`).
 *
 * `guards.py` hardcodes this marker as the literal `.pbfuzz` (the only output-root name it ever
 * saw in practice). `settings.onboarding.defaultOutputRoot` is user-configurable, though, so this
 * port derives the marker from the campaign's actual `stateDir` instead of hardcoding it — a
 * `stateDir` always resolves to `<repo>/<outputRoot>/<id>/state` (`paths.ts`'s `campaignLayout()`),
 * so the output-root's own name is `stateDir`'s third-from-last path segment. This keeps every row
 * of the ported precision/recall table passing (its fixtures all use the default `.pbfuzz` root)
 * while also catching a command against a campaign whose root was renamed — a small, deliberate
 * widening of recall that guards.py's docstring explicitly welcomes ("visible... after the fact")
 * as long as it does not touch the mutation side of the match.
 * @param stateDir - the campaign's state directory (`GuardView.stateDir`).
 * @returns the built regex.
 */
function protectedRegExp(stateDir: string): RegExp {
  const marker = rootMarkerFromStateDir(stateDir)
  return new RegExp(`${escapeRegExp(marker)}\\b|/${STATE_NAME_ALT}`)
}

/**
 * The output-root directory name (e.g. `.pbfuzz`) implied by a campaign's state directory, or the
 * conventional default when `stateDir` is too short to contain one (never expected in practice —
 * this module does no I/O and never throws, so it degrades to the default instead).
 * @param stateDir - `<repo>/<outputRoot>/<id>/state`.
 * @returns the output-root segment, or `'.pbfuzz'`.
 */
function rootMarkerFromStateDir(stateDir: string): string {
  const segments = stateDir.split('/').filter(part => part.length > 0)
  const marker = segments.length >= 3 ? segments[segments.length - 3] : undefined
  return marker !== undefined && marker.length > 0 ? marker : '.pbfuzz'
}

/** Output redirection, or a mutating verb/flag, ported verbatim from `guards.py`'s `_MUTATION`. */
const MUTATION = new RegExp(
  '(?<![<>&0-9])>{1,2}(?!&)' // output redirection (not 2>&1, not <)
  + String.raw`|\b(?:rm|mv|cp|tee|truncate|dd|install|ln|touch|shred|patch|rsync|chmod|chown)\b`
  + String.raw`|\bsed\b[^|;&]*\s-[a-zA-Z]*i`
  // open(...) only counts as a mutation with an explicit write/append/exclusive-create mode
  // (default open() is read-only -- see B3 in tests/bash-guard.spec.ts); `.write(`/`-i` still count.
  + String.raw`|\b(?:python3?|perl|ruby|node|jq)\b[^|;&]*(?:open\([^)]*['"][wax][a-zA-Z]{0,2}['"]|write|-i\b)`,
)

/** Clause separators the scan scopes matching to, so a mutation verb in one `&&`/`;`/`||` clause
 * no longer denies an unrelated protected mention in another (`B10` in the evidence table). */
const CLAUSE_SPLIT = /&&|\|\||;/

/** A leading `cd <arg>` in a clause, tracked so a bare state filename after `cd .pbfuzz/...` still
 * counts (`N3`), independent of the mutation match happening in a later clause. */
const CD_CLAUSE = /^\s*cd\s+(\S+)/

/** A clause that opens with `echo`/`printf`, whose quoted argument text should not be scanned. */
const ECHO_CLAUSE = /^\s*(?:echo|printf)\b/

/** Quoted text within an `echo`/`printf` clause (global: every quoted span, not just the first). */
const QUOTED = /(['"]).*?\1/g

/**
 * Within an `echo`/`printf` clause, drop quoted *argument* text so a `.pbfuzz` mention (or a
 * mutation-verb-shaped English word) inside a printed message doesn't trip the guard; anything
 * outside the quotes — e.g. a real `> .pbfuzz/...` redirection target — is left untouched.
 * @param clause - one `&&`/`||`/`;`-delimited clause.
 * @returns the clause with quoted spans removed, if it is an echo/printf clause; else unchanged.
 */
function echoStripped(clause: string): string {
  return ECHO_CLAUSE.test(clause) ? clause.replace(QUOTED, '') : clause
}

/**
 * A simple shell variable assignment anchored to the start of a clause: `name=value`,
 * `name="value"`, or `name='value'`. Deliberately narrow — no `export name=value`, no env-var
 * prefix ahead of a command (`FOO=bar cmd`), no command substitution (`f=$(...)`), no
 * indirection-through-another-variable (`f=$g`) — this only needs to catch the ordinary
 * `f=<literal-path>; ...$f...` pattern from finding F2 (see `N4` in `tests/bash-guard.spec.ts`);
 * a command that launders the value through any of those other forms is beyond what a
 * regex-only guard can be expected to track and is left as a residual, documented gap (see the
 * module doc comment) rather than chased with more regex.
 */
const VAR_ASSIGNMENT = /^\s*([A-Za-z_]\w*)=(.*)$/

/**
 * Strip one layer of matching leading/trailing quotes (`"..."` or `'...'`) from a raw assignment
 * right-hand side, so `f=".pbfuzz/.../state.json"` and `f=.pbfuzz/.../state.json` taint the same
 * way. Not shell-accurate (no handling of escaped quotes or concatenated segments) — see
 * {@link VAR_ASSIGNMENT}'s doc comment on scope.
 * @param raw - the text after `name=` in a matched assignment.
 * @returns `raw`, trimmed and with one matching pair of outer quotes removed if present.
 */
function stripOuterQuotes(raw: string): string {
  const trimmed = raw.trim()
  const quote = trimmed[0]
  if ((quote === '"' || quote === '\'') && trimmed.length >= 2 && trimmed[trimmed.length - 1] === quote) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Scan every clause of `cmd` for a {@link VAR_ASSIGNMENT} whose right-hand side is itself a
 * protected-path mention, and return the set of variable names so tainted. Scoped to the whole
 * command rather than "only clauses before this one" — deliberately: a regex-only guard has no
 * real notion of execution order, and erring toward also flagging a (never-valid-bash, harmless
 * to over-flag) `use-before-assign` ordering is the safe direction, the same recall-over-precision
 * tradeoff the module doc comment describes for `protectedRegExp`'s root-marker widening.
 * @param cmd - the full (already-string-coerced) command.
 * @param protectedRe - {@link protectedRegExp}'s regex for this campaign's `stateDir`.
 * @returns the tainted variable names (possibly empty).
 */
function taintedVarNames(cmd: string, protectedRe: RegExp): Set<string> {
  const tainted = new Set<string>()
  for (const rawClause of cmd.split(CLAUSE_SPLIT)) {
    const assignment = VAR_ASSIGNMENT.exec(rawClause)
    if (assignment !== null && protectedRe.test(stripOuterQuotes(assignment[2] ?? ''))) {
      tainted.add(assignment[1]!)
    }
  }
  return tainted
}

/**
 * `\$name` / `\${name}`, one alternative per tainted variable name, so a clause that merely
 * *references* a variable assigned (elsewhere in the command) to a protected path — `$f`, `${f}`,
 * and either form inside double quotes all contain one of these substrings verbatim — is treated
 * the same as a literal protected-path mention in that clause. Returns `null` for an empty set so
 * the (overwhelmingly common) untainted-command path skips the extra `.exec()` entirely.
 * @param names - {@link taintedVarNames}'s result.
 * @returns the built regex, or `null` if `names` is empty.
 */
function taintedVarRefRegExp(names: Set<string>): RegExp | null {
  if (names.size === 0) return null
  const alt = [...names].map(escapeRegExp).join('|')
  return new RegExp(String.raw`\$\{(?:${alt})\}|\$(?:${alt})(?!\w)`)
}

/**
 * Scan a bash command clause by clause for a protected-path mention and a mutation landing
 * together in the same clause, tracking a leading `cd` so a bare state filename after
 * `cd .pbfuzz/...` still counts, while an unrelated mutation in one `&&` clause and an unrelated
 * protected mention in another do not cross-contaminate. A protected-path mention also counts as
 * present in a clause that only references (via `$var`/`${var}`) a variable {@link taintedVarNames}
 * found assigned to a protected path elsewhere in the command, so `f=<path>; ... > "$f"` is caught
 * the same as `... > <path>` (finding F2).
 *
 * Pure string matching, no filesystem access, no shell parsing — see the module doc comment for
 * why this is best-effort and not a security boundary. Coerces a non-string `command` to `''`
 * rather than throwing, so a caller that hands this a malformed value (this module's own type
 * says `string`, but nothing stops a misbehaving caller) still gets a well-formed verdict instead
 * of an exception a `ctx.tools.guard()` callback would have to catch.
 * @param command - the bash tool's `command` argument.
 * @param stateDir - the campaign's state directory (`GuardView.stateDir`), used only to derive the
 *   protected-path marker (see {@link protectedRegExp}) — no file is read.
 * @returns whether the command should be denied, and what matched.
 */
export function bashGuardVerdict(command: string, stateDir: string): BashGuardVerdict {
  const cmd = typeof command === 'string' ? command : ''
  const dir = typeof stateDir === 'string' ? stateDir : ''
  const protectedRe = protectedRegExp(dir)
  const taintedRef = taintedVarRefRegExp(taintedVarNames(cmd, protectedRe))
  let inProtectedDir = false
  for (const rawClause of cmd.split(CLAUSE_SPLIT)) {
    const clause = echoStripped(rawClause)
    const target = protectedRe.exec(clause)
      ?? (inProtectedDir ? PROTECTED_BARE.exec(clause) : null)
      ?? (taintedRef !== null ? taintedRef.exec(clause) : null)
    const mutation = MUTATION.exec(clause)
    if (target !== null && mutation !== null) {
      return { denied: true, target: target[0], mutation: mutation[0].trim() }
    }
    const cdMatch = CD_CLAUSE.exec(rawClause)
    if (cdMatch !== null) {
      inProtectedDir = protectedRe.test(cdMatch[1] ?? '')
    }
  }
  return { denied: false }
}
