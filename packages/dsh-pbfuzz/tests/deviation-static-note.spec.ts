/**
 * `resolveCriticalLocations` / `withStaticAnalysisNote` (tools.ts): `pbfuzz_deviation` degrades to
 * target_only when static analysis is unavailable, but must say so instead of swallowing why.
 */
import { describe, expect, it } from 'vitest'
import { resolveCriticalLocations, withStaticAnalysisNote } from '../src/tools.ts'

describe('resolveCriticalLocations', () => {
  it('reports ok with the count when the provider returns critical locations', async () => {
    const locs = [{ location: 'a.c:1' }, { location: 'b.c:2' }]
    const r = await resolveCriticalLocations(true, async () => locs)
    expect(r.critical).toEqual(locs)
    expect(r.note).toEqual({ status: 'ok', critical_locations: 2 })
  })

  it('surfaces the provider failure as unavailable, with its reason, instead of swallowing it', async () => {
    const r = await resolveCriticalLocations(true, async () => { throw new Error('static analysis: build.cmd exited 2 (undefined symbol)') })
    expect(r.critical).toEqual([])
    expect(r.note.status).toBe('unavailable')
    expect(r.note.reason).toContain('build.cmd exited 2')
  })

  it('stringifies a non-Error rejection', async () => {
    const r = await resolveCriticalLocations(true, async () => { throw 'boom' })
    expect(r.note).toEqual({ status: 'unavailable', reason: 'boom' })
  })

  it('distinguishes "prepared but empty" from a failure', async () => {
    const r = await resolveCriticalLocations(true, async () => [])
    expect(r.note).toEqual({ status: 'no_critical_locations', critical_locations: 0 })
  })

  it('is quiet (status off) and never calls the provider when static analysis is not wanted', async () => {
    let called = false
    const r = await resolveCriticalLocations(false, async () => { called = true; return [{ location: 'x:1' }] })
    expect(called).toBe(false)
    expect(r).toEqual({ critical: [], note: { status: 'off' } })
  })
})

describe('withStaticAnalysisNote', () => {
  it('adds the note next to the engine result fields', () => {
    expect(withStaticAnalysisNote({ mode: 'target_only', hits: 1 }, { status: 'off' }))
      .toEqual({ mode: 'target_only', hits: 1, static_analysis: { status: 'off' } })
  })

  it('wraps a non-object engine result rather than dropping the note', () => {
    expect(withStaticAnalysisNote(null, { status: 'unavailable', reason: 'x' }))
      .toEqual({ result: null, static_analysis: { status: 'unavailable', reason: 'x' } })
  })
})
