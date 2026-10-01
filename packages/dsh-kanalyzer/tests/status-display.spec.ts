import { describe, expect, it } from 'vitest'
import type { CriticalBranch } from '../src/api.ts'
import { criticalBranchesForDisplay } from '../src/core/status.ts'

function b(fn: string, location: string, distance: number): CriticalBranch {
  return { function: fn, location, distance }
}

describe('criticalBranchesForDisplay', () => {
  it('sorts resolved rows by distance ascending, then location, then function', () => {
    const branches = [
      b('main', 'a.c:9', 5),
      b('foo', 'z.c:1', 0),
      b('bar', 'a.c:1', 0),
    ]
    expect(criticalBranchesForDisplay(branches).branches).toEqual([
      b('bar', 'a.c:1', 0),
      b('foo', 'z.c:1', 0),
      b('main', 'a.c:9', 5),
    ])
  })

  it('breaks a distance tie by location, then by function', () => {
    const branches = [
      b('z', 'same.c:1', 3),
      b('a', 'same.c:1', 3),
      b('m', 'same.c:1', 3),
    ]
    expect(criticalBranchesForDisplay(branches).branches).toEqual([
      b('a', 'same.c:1', 3),
      b('m', 'same.c:1', 3),
      b('z', 'same.c:1', 3),
    ])
  })

  it('caps resolved rows at limit and marks the result truncated', () => {
    const branches = Array.from({ length: 5 }, (_, i) => b(`f${String(i)}`, `a.c:${String(i)}`, i))
    const out = criticalBranchesForDisplay(branches, 2)
    expect(out.branches).toEqual([b('f0', 'a.c:0', 0), b('f1', 'a.c:1', 1)])
    expect(out.total).toBe(5)
    expect(out.shown).toBe(2)
    expect(out.unresolved).toBe(0)
    expect(out.truncated).toBe(true)
  })

  it('counts distance<0 and bid: placeholders as unresolved and drops them from branches', () => {
    const branches = [
      b('a', 'a.c:1', 0),
      b('', 'bid:1234', -1),
      b('caller', 'a.c:5', -1),
      b('callee', 'bid:5678', 10),
    ]
    const out = criticalBranchesForDisplay(branches)
    expect(out.total).toBe(4)
    expect(out.unresolved).toBe(3)
    expect(out.shown).toBe(1)
    expect(out.branches).toEqual([b('a', 'a.c:1', 0)])
    expect(out.truncated).toBe(false)
  })

  it('an all-unresolved input yields no branches and no truncation', () => {
    const branches = [
      b('', 'bid:1', -1),
      b('x', 'a.c:1', -1),
      b('', 'bid:2', 4),
    ]
    const out = criticalBranchesForDisplay(branches, 150)
    expect(out.branches).toEqual([])
    expect(out.total).toBe(3)
    expect(out.shown).toBe(0)
    expect(out.unresolved).toBe(3)
    expect(out.truncated).toBe(false)
  })

  it('a limit larger than the resolved count returns everything, untruncated', () => {
    const branches = [b('a', 'a.c:1', 2), b('b', 'a.c:2', 0), b('c', 'bid:9', -1)]
    const out = criticalBranchesForDisplay(branches, 150)
    expect(out.branches).toEqual([b('b', 'a.c:2', 0), b('a', 'a.c:1', 2)])
    expect(out.shown).toBe(2)
    expect(out.truncated).toBe(false)
  })
})
