/**
 * The pure path rules behind the isolated analysis tree (`src/core/isolation.ts`).
 *
 * These decide which directory a build runs in, and therefore whether `kanalyzer_prepare` can
 * overwrite the binary a user is fuzzing — the failure a real session hit when a prepare
 * rebuilt `build/out/http_request_fuzzer` in place.
 *
 * @module @pbfuzz/dsh-kanalyzer/tests/isolation
 */
import { describe, expect, it } from 'vitest'
import {
  insideRoot, intoTree, isolationFor, KANALYZER_DIR, prepareIdentityKey, rewriteBuildCmd,
} from '../src/core/isolation.ts'

describe('isolationFor()', () => {
  it('puts everything prepare writes under one hidden directory of the checkout', () => {
    const iso = isolationFor('/work/nginx')
    expect(iso.root).toBe(`/work/nginx/${KANALYZER_DIR}`)
    expect(iso.tree).toBe('/work/nginx/.kanalyzer/tree')
    expect(iso.shim).toBe('/work/nginx/.kanalyzer/shim')
    expect(iso.progress).toBe('/work/nginx/.kanalyzer/progress.log')
    expect(iso.memo).toBe('/work/nginx/.kanalyzer/prepare.json')
  })

  it('tolerates a trailing slash on the checkout', () => {
    expect(isolationFor('/work/nginx/').tree).toBe('/work/nginx/.kanalyzer/tree')
  })
})

describe('insideRoot()', () => {
  it('accepts the root itself and anything under it', () => {
    expect(insideRoot('/work/nginx', '/work/nginx')).toBe(true)
    expect(insideRoot('/work/nginx', '/work/nginx/build/src')).toBe(true)
  })

  it('rejects a sibling whose name merely starts the same way', () => {
    expect(insideRoot('/work/nginx', '/work/nginx-old/src')).toBe(false)
    expect(insideRoot('/work/nginx', '/work')).toBe(false)
  })
})

describe('intoTree()', () => {
  it('maps a directory to the same relative position in the copy', () => {
    expect(intoTree('/work/nginx', '/work/nginx/.kanalyzer/tree', '/work/nginx/build/src/nginx'))
      .toBe('/work/nginx/.kanalyzer/tree/build/src/nginx')
  })

  it('maps the checkout root to the copy root', () => {
    expect(intoTree('/work/nginx', '/t', '/work/nginx')).toBe('/t')
  })

  it('refuses a path outside the checkout rather than silently building in it', () => {
    expect(() => intoTree('/work/nginx', '/t', '/elsewhere')).toThrow(/outside the project checkout/)
    // The message has to say what to do instead, or the agent will just retry the same call.
    expect(() => intoTree('/work/nginx', '/t', '/elsewhere')).toThrow(/isolate: false/)
  })
})

describe('rewriteBuildCmd()', () => {
  it('points absolute checkout paths at the copy', () => {
    expect(rewriteBuildCmd('bash /work/nginx/build.sh && /work/nginx/x', '/work/nginx', '/t'))
      .toBe('bash /t/build.sh && /t/x')
  })

  it('leaves a relative command alone — its cwd is already mapped', () => {
    expect(rewriteBuildCmd('bash build.sh', '/work/nginx', '/t')).toBe('bash build.sh')
  })
})

describe('prepareIdentityKey()', () => {
  const base = { repo: '/r', buildCmd: 'make', mode: 'wllvm' as const, profile: 'analysis', isolate: true }

  it('is stable across key order and list/env order', () => {
    const a = prepareIdentityKey({ ...base, ltoLibs: ['/b.a', '/a.a'], env: { B: '2', A: '1' } })
    const b = prepareIdentityKey({ ...base, env: { A: '1', B: '2' }, ltoLibs: ['/a.a', '/b.a'] })
    expect(a).toBe(b)
  })

  it('separates builds that would produce different bitcode', () => {
    const key = prepareIdentityKey(base)
    expect(prepareIdentityKey({ ...base, buildCmd: 'make all' })).not.toBe(key)
    expect(prepareIdentityKey({ ...base, mode: 'lto' })).not.toBe(key)
    expect(prepareIdentityKey({ ...base, program: 'app' })).not.toBe(key)
    expect(prepareIdentityKey({ ...base, isolate: false })).not.toBe(key)
    expect(prepareIdentityKey({ ...base, profile: 'passthrough' })).not.toBe(key)
    expect(prepareIdentityKey({ ...base, env: { A: '1' } })).not.toBe(key)
  })
})
