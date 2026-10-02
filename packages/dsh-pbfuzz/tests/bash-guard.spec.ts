import { describe, expect, it } from 'vitest'
import { bashGuardVerdict } from '../src/core/bash-guard.ts'

/** Matches `engine/hooks/tests/helpers.py`'s fixture layout (`<root>/.pbfuzz/c1/state`), so the
 * ported table below — copied verbatim from `engine/hooks/tests/test_bash_guard.py`'s `TABLE`,
 * itself sourced from `acceptance-run/evidence/L1/hooks-gating.md` §5 — exercises the exact same
 * commands against the exact same directory shape. */
const STATE_DIR = '/repo/.pbfuzz/camp1/state'

/** (case id, command, expect_denied) — verbatim from `test_bash_guard.py`'s 18-command table, plus
 * `N4` (added for finding F2). `B` = benign (must allow), `M` = real mutation (must deny), `N` =
 * false-negative bypass (N1/N2 are known, accepted, permanent gaps in a regex-only guard — see the
 * module doc comment in `bash-guard.ts` — N3 and N4 are not: N3 is a bare filename after
 * `cd`-ing into the campaign directory, which the `cd`-tracking carve-out must still catch; N4 is
 * the protected filename assigned to a shell variable in one clause and used (not repeated
 * literally) in the mutating clause, which the variable-taint pass must still catch). */
const TABLE: readonly [id: string, command: string, expectDenied: boolean][] = [
  ['B1', 'mkdir -p out && cp seed1 out/', false],
  ['B2', 'echo "never touch .pbfuzz state" && mkdir -p out && cp seed1 out/', false],
  ['B3', "python3 -c \"print(open('.pbfuzz/camp1/state/state.json').read())\"", false],
  ['B4', 'cat .pbfuzz/camp1/selfcheck.json', false],
  ['B5', 'grep triggered .pbfuzz/camp1/state/metrics.json', false],
  ['B6', "jq '.phase' .pbfuzz/camp1/state/state.json", false],
  ['M1', "jq -i '.x=1' .pbfuzz/camp1/state/state.json", true],
  ['M2', 'rm -rf .pbfuzz/camp1/state/state.json', true],
  ['M3', 'echo hi > .pbfuzz/camp1/state/state.json', true],
  ['M4', 'cp payload.bin .pbfuzz/camp1/state/metrics.json', true],
  ['B7', 'rm -rf /tmp/scratch/build', false],
  ['B8', 'rm -rf node_modules && touch settings.json', false],
  ['M5', "sed -i 's/x/y/' .pbfuzz/camp1/state/state.json", true],
  ['B9', "sed -n '1,5p' .pbfuzz/camp1/state/state.json", false],
  ['B10', 'rm -rf /tmp/build && cat .pbfuzz/camp1/selfcheck.json', false],
  ['N1', 'exec 3> .pbfuzz/camp1/state/state.json; echo \'{"phase":"SUCCESS"}\' >&3; exec 3>&-', false],
  ['N2', 'p=$(echo Ly5wYmZ1enovY2FtcDEvc3RhdGUvc3RhdGUuanNvbg== | base64 -d); rm "$p"', false],
  ['N3', 'cd .pbfuzz/camp1/state && rm state.json', true],
  ['N4', 'f=.pbfuzz/camp1/state/state.json; > "$f"', true],
]

describe('bashGuardVerdict — precision/recall table', () => {
  it.each(TABLE)('%s: %s -> denied=%s', (caseId, command, expectDenied) => {
    const verdict = bashGuardVerdict(command, STATE_DIR)
    expect(verdict.denied, `${caseId}: ${command}`).toBe(expectDenied)
    if (expectDenied) {
      expect(verdict.target).toBeTruthy()
      expect(verdict.mutation).toBeTruthy()
    } else {
      expect(verdict.target).toBeUndefined()
      expect(verdict.mutation).toBeUndefined()
    }
  })
})

describe('bashGuardVerdict — mechanics', () => {
  it('names the exact target and (trimmed) mutation text that triggered the denial', () => {
    const verdict = bashGuardVerdict('rm -rf .pbfuzz/camp1/state/state.json', STATE_DIR)
    expect(verdict).toEqual({ denied: true, target: '.pbfuzz', mutation: 'rm' })
  })

  it('a bare state filename is only protected once a preceding cd landed inside the campaign dir', () => {
    expect(bashGuardVerdict('rm state.json', STATE_DIR).denied).toBe(false)
    expect(bashGuardVerdict('cd /tmp/scratch && rm state.json', STATE_DIR).denied).toBe(false)
    expect(bashGuardVerdict('cd .pbfuzz/camp1/state && rm state.json', STATE_DIR).denied).toBe(true)
  })

  it('2>&1 and < are not treated as mutating redirection', () => {
    expect(bashGuardVerdict('cat .pbfuzz/camp1/state/state.json 2>&1', STATE_DIR).denied).toBe(false)
    expect(bashGuardVerdict('diff .pbfuzz/camp1/state/state.json < other.json', STATE_DIR).denied).toBe(false)
  })

  it('open() with an explicit write mode is a mutation (the default read-only open is table row B3)', () => {
    expect(bashGuardVerdict("python3 -c \"open('.pbfuzz/camp1/state/state.json', 'w').write('{}')\"", STATE_DIR).denied).toBe(true)
  })

  it('derives the protected-path marker from stateDir instead of hardcoding .pbfuzz, so a renamed output root is still caught', () => {
    const customDir = '/repo/.fuzzwork/camp1/state'
    expect(bashGuardVerdict('rm -rf .fuzzwork/camp1/state/state.json', customDir).denied).toBe(true)
    expect(bashGuardVerdict('cat .fuzzwork/camp1/selfcheck.json', customDir).denied).toBe(false)
    // A command mentioning the DEFAULT marker (but no known state filename with slash context)
    // against a campaign using a CUSTOM root is unrelated to this campaign's state.
    expect(bashGuardVerdict('rm -rf .pbfuzz/some-other-project/notes.txt', customDir).denied).toBe(false)
  })

  it('variable-taint also catches the ${f} braces form and a quoted assignment with a bare $f reference (the plain "$f" form is table row N4)', () => {
    // Braces form.
    expect(bashGuardVerdict('f=.pbfuzz/camp1/state/state.json; > "${f}"', STATE_DIR).denied).toBe(true)
    // Bare (unquoted) reference, and a quoted assignment right-hand side.
    expect(bashGuardVerdict('f=".pbfuzz/camp1/state/state.json"; rm $f', STATE_DIR).denied).toBe(true)
  })

  it('variable-taint tracking does not overtighten: an unrelated assignment, or a tainted reference with no mutation, still allows', () => {
    // A variable assignment wholly unrelated to any protected path.
    expect(bashGuardVerdict('x=hello; rm -rf $x', STATE_DIR).denied).toBe(false)
    // The protected path is assigned to a variable and the variable is referenced, but never
    // through a mutating clause.
    expect(bashGuardVerdict('f=.pbfuzz/camp1/state/state.json; cat "$f"', STATE_DIR).denied).toBe(false)
  })

  it('never throws on a malformed stateDir or command, even when the declared string type is bypassed', () => {
    const cases: unknown[] = [null, undefined, 42, {}, [], '']
    for (const bad of cases) {
      expect(() => bashGuardVerdict(bad as string, STATE_DIR)).not.toThrow()
      expect(() => bashGuardVerdict('rm -rf .pbfuzz/c1/state/state.json', bad as string)).not.toThrow()
    }
  })
})
