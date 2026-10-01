/**
 * `nproc` build-parallelism defaults for `ltoEnv()`/`wllvmEnv()` (plan section K2): both default
 * `MAKEFLAGS`/`CMAKE_BUILD_PARALLEL_LEVEL` to `-j<nproc>`/`<nproc>` unless the caller env or the
 * base env already defines the variable (an explicitly empty string counts as defined and wins —
 * the documented `env: ['MAKEFLAGS=']` opt-out), and leave both variables absent when `nproc` is
 * omitted, byte-for-byte what `tests/core.spec.ts` already asserts for the no-`nproc` calls.
 */
import { describe, expect, it } from 'vitest'
import { ltoEnv, parallelEnv, toolchainAt, wllvmEnv } from '../src/core/prepare.ts'

const tc = toolchainAt('/usr/lib/llvm-14')

describe('parallelEnv()', () => {
  it('defaults both variables when neither env defines them', () => {
    expect(parallelEnv({}, {}, 6)).toEqual({ MAKEFLAGS: '-j6', CMAKE_BUILD_PARALLEL_LEVEL: '6' })
  })
  it('leaves out a variable the caller env already defines, even as an empty string', () => {
    expect(parallelEnv({ MAKEFLAGS: '' }, {}, 6)).toEqual({ CMAKE_BUILD_PARALLEL_LEVEL: '6' })
    expect(parallelEnv({ MAKEFLAGS: '-j2' }, {}, 6)).toEqual({ CMAKE_BUILD_PARALLEL_LEVEL: '6' })
  })
  it('leaves out a variable the base env already defines', () => {
    expect(parallelEnv({}, { CMAKE_BUILD_PARALLEL_LEVEL: '4' }, 6)).toEqual({ MAKEFLAGS: '-j6' })
  })
  it('is a no-op for a non-positive-integer nproc', () => {
    expect(parallelEnv({}, {}, 0)).toEqual({})
    expect(parallelEnv({}, {}, -1)).toEqual({})
    expect(parallelEnv({}, {}, 1.5)).toEqual({})
  })
})

describe('ltoEnv(): nproc', () => {
  it('defaults MAKEFLAGS/CMAKE_BUILD_PARALLEL_LEVEL when nproc is given and neither env sets them', () => {
    const env = ltoEnv(tc, {}, [], {}, 4)
    expect(env.MAKEFLAGS).toBe('-j4')
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBe('4')
  })
  it('caller env override wins', () => {
    const env = ltoEnv(tc, { MAKEFLAGS: '-j1', CMAKE_BUILD_PARALLEL_LEVEL: '1' }, [], {}, 4)
    expect(env.MAKEFLAGS).toBe('-j1')
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBe('1')
  })
  it('caller env explicit empty string wins (the documented opt-out)', () => {
    const env = ltoEnv(tc, { MAKEFLAGS: '' }, [], {}, 4)
    expect(env.MAKEFLAGS).toBe('')
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBe('4')
  })
  it('base env value wins over the default', () => {
    const env = ltoEnv(tc, {}, [], { MAKEFLAGS: '-j2', CMAKE_BUILD_PARALLEL_LEVEL: '2' }, 4)
    expect(env.MAKEFLAGS).toBe('-j2')
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBe('2')
  })
  it('nproc omitted leaves both variables absent', () => {
    const env = ltoEnv(tc, {}, [], {})
    expect(env.MAKEFLAGS).toBeUndefined()
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBeUndefined()
  })
  it('leaves CFLAGS/CXXFLAGS/LDFLAGS/PATH unchanged from a call without nproc', () => {
    const withNproc = ltoEnv(tc, { CFLAGS: '-DFOO' }, ['/l/libz.a'], { PATH: '/bin' }, 4)
    const without = ltoEnv(tc, { CFLAGS: '-DFOO' }, ['/l/libz.a'], { PATH: '/bin' })
    expect(withNproc.CFLAGS).toBe(without.CFLAGS)
    expect(withNproc.CXXFLAGS).toBe(without.CXXFLAGS)
    expect(withNproc.LDFLAGS).toBe(without.LDFLAGS)
    expect(withNproc.LIBS).toBe(without.LIBS)
    expect(withNproc.PATH).toBe(without.PATH)
    expect(withNproc.CC).toBe(without.CC)
  })
})

describe('wllvmEnv(): nproc', () => {
  it('defaults MAKEFLAGS/CMAKE_BUILD_PARALLEL_LEVEL when nproc is given and neither env sets them', () => {
    const env = wllvmEnv(tc, {}, {}, 8)
    expect(env.MAKEFLAGS).toBe('-j8')
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBe('8')
  })
  it('caller env override wins', () => {
    const env = wllvmEnv(tc, { MAKEFLAGS: '-j1', CMAKE_BUILD_PARALLEL_LEVEL: '1' }, {}, 8)
    expect(env.MAKEFLAGS).toBe('-j1')
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBe('1')
  })
  it('caller env explicit empty string wins (the documented opt-out)', () => {
    const env = wllvmEnv(tc, { MAKEFLAGS: '' }, {}, 8)
    expect(env.MAKEFLAGS).toBe('')
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBe('8')
  })
  it('base env value wins over the default', () => {
    const env = wllvmEnv(tc, {}, { MAKEFLAGS: '-j2', CMAKE_BUILD_PARALLEL_LEVEL: '2' }, 8)
    expect(env.MAKEFLAGS).toBe('-j2')
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBe('2')
  })
  it('nproc omitted leaves both variables absent', () => {
    const env = wllvmEnv(tc, {}, {})
    expect(env.MAKEFLAGS).toBeUndefined()
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBeUndefined()
  })
  it('leaves CFLAGS/CXXFLAGS/PATH unchanged from a call without nproc', () => {
    const withNproc = wllvmEnv(tc, { CFLAGS: '-DFOO' }, { PATH: '/bin' }, 8)
    const without = wllvmEnv(tc, { CFLAGS: '-DFOO' }, { PATH: '/bin' })
    expect(withNproc.CFLAGS).toBe(without.CFLAGS)
    expect(withNproc.CXXFLAGS).toBe(without.CXXFLAGS)
    expect(withNproc.PATH).toBe(without.PATH)
    expect(withNproc.CC).toBe(without.CC)
  })
})
