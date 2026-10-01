/**
 * K1a — `RepoIndex` alias roots.
 *
 * The analysis build can run in an isolated copy of the repo (`<repo>/.kanalyzer/tree/`, see
 * `host/runtime.ts`), and KAMain then bakes that copy's absolute paths into its dumps. These
 * tests cover `remap()`/`remapLocation()` resolving paths under such an alias root back to the
 * same repo-relative string a path under the real repo would produce, alongside the existing
 * (no-alias) behaviour and `candidates()`, which alias roots must leave untouched.
 */
import { describe, expect, it } from 'vitest'
import { RepoIndex } from '../src/core/paths.ts'

describe('RepoIndex alias roots: the real case is nested inside the checkout', () => {
  // `<repo>/.kanalyzer/tree` sits *under* the repo root, so remap() has to try aliases before the
  // repo itself. Matching the repo first would answer `.kanalyzer/tree/src/x.c` — a path that
  // exists nowhere the user cares about, and one no target of theirs will ever match.
  const index = new RepoIndex('/work/nginx', ['src/http/x.c'], ['/work/nginx/.kanalyzer/tree'])

  it('maps a path from the isolated build back to the checkout, not to the copy', () => {
    expect(index.remap('/work/nginx/.kanalyzer/tree/src/http/x.c')).toBe('src/http/x.c')
  })

  it('still maps the checkout\'s own paths', () => {
    expect(index.remap('/work/nginx/src/http/x.c')).toBe('src/http/x.c')
  })

  it('maps a location the same way', () => {
    expect(index.remapLocation('/work/nginx/.kanalyzer/tree/src/http/x.c:178')).toBe('src/http/x.c:178')
  })

  it('prefers the longest matching alias when several overlap', () => {
    const nested = new RepoIndex('/r', ['a.c'], ['/r/t', '/r/t/inner'])
    expect(nested.remap('/r/t/inner/a.c')).toBe('a.c')
  })
})

describe('RepoIndex alias roots', () => {
  const repo = '/work/repo'
  const alias = '/work/nginx/.kanalyzer/tree'
  const files = ['src/x.c', 'src/other.c']

  it('remaps an absolute path under an alias root to repo-relative', () => {
    const r = new RepoIndex(repo, files, [alias])
    expect(r.remap(`${alias}/src/x.c`)).toBe('src/x.c')
  })

  it('tolerates a trailing slash on the alias root', () => {
    const r = new RepoIndex(repo, files, [`${alias}/`])
    expect(r.remap(`${alias}/src/x.c`)).toBe('src/x.c')
    expect(r.aliasRoots).toEqual([alias])
  })

  it('remaps a location under an alias root', () => {
    const r = new RepoIndex(repo, files, [alias])
    expect(r.remapLocation(`${alias}/src/x.c:12`)).toBe('src/x.c:12')
  })

  it('falls back to basename/suffix matching for a path under neither root', () => {
    const r = new RepoIndex(repo, files, [alias])
    expect(r.remap('/somewhere/else/src/x.c')).toBe('src/x.c')
    expect(r.remap('x.c')).toBe('src/x.c')
  })

  it('leaves existing no-alias behaviour unchanged', () => {
    const r = new RepoIndex(repo, files)
    expect(r.aliasRoots).toEqual([])
    expect(r.remap(`${repo}/src/x.c`)).toBe('src/x.c')
    expect(r.remap('nope.c')).toBe('nope.c')
  })

  it('does not affect candidates()', () => {
    const r = new RepoIndex(repo, files, [alias])
    expect(r.candidates('x.c')).toEqual(['src/x.c'])
  })
})
