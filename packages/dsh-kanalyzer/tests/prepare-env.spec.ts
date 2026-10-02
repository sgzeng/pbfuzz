/**
 * `nproc` build-parallelism defaults for `ltoEnv()`/`wllvmEnv()` (plan section K2): both default
 * `MAKEFLAGS`/`CMAKE_BUILD_PARALLEL_LEVEL` to `-j<nproc>`/`<nproc>` unless the caller env or the
 * base env already defines the variable (an explicitly empty string counts as defined and wins —
 * the documented `env: ['MAKEFLAGS=']` opt-out), and leave both variables absent when `nproc` is
 * omitted.
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

type Env = Record<string, string>
type BaseEnv = Record<string, string | undefined>

// Each builder has its own call into parallelEnv(), so each gets the same wiring checks.
describe.each<[string, (callerEnv: Env, baseEnv: BaseEnv, nproc?: number) => Env]>([
  ['ltoEnv', (callerEnv, baseEnv, nproc) => ltoEnv(tc, callerEnv, [], baseEnv, nproc)],
  ['wllvmEnv', (callerEnv, baseEnv, nproc) => wllvmEnv(tc, callerEnv, baseEnv, nproc)],
])('%s(): nproc', (_name, build) => {
  it('defaults MAKEFLAGS/CMAKE_BUILD_PARALLEL_LEVEL when nproc is given and neither env sets them', () => {
    const env = build({}, {}, 4)
    expect(env.MAKEFLAGS).toBe('-j4')
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBe('4')
  })
  it('keeps a value the caller env sets (even the empty opt-out string) or the base env sets', () => {
    const env = build({ MAKEFLAGS: '' }, { CMAKE_BUILD_PARALLEL_LEVEL: '2' }, 4)
    expect(env.MAKEFLAGS).toBe('')
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBe('2')
  })
  it('nproc omitted leaves both variables absent', () => {
    const env = build({}, {})
    expect(env.MAKEFLAGS).toBeUndefined()
    expect(env.CMAKE_BUILD_PARALLEL_LEVEL).toBeUndefined()
  })
})
