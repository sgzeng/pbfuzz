import { describe, expect, it, vi } from 'vitest'
import { envItemFromCache, isEnvSelfcheckFresh, readOrRunEnvSelfcheck, type EnvSelfcheckCache } from '../src/env-selfcheck.ts'

const okPing = async () => ({ engineVersion: '1.2.3', contractsVersion: '1', python: 'python 3.12.0' })
const okEngine = async () => ({ ok: true, status: 'pass' as const, evidence: ['sandbox round trip ok'] })

describe('isEnvSelfcheckFresh', () => {
  it('an empty/missing cache is never fresh', () => {
    expect(isEnvSelfcheckFresh(undefined, () => 0)).toBe(false)
    expect(isEnvSelfcheckFresh({ checkedAt: '', ttlExpiresAt: '', overall: '', items: [] }, () => 0)).toBe(false)
  })

  it('fresh before ttlExpiresAt, stale after it', () => {
    const cache: EnvSelfcheckCache = { checkedAt: '2026-01-01T00:00:00.000Z', ttlExpiresAt: '2026-01-02T00:00:00.000Z', overall: 'pass', items: [] }
    const day = 24 * 60 * 60 * 1000
    expect(isEnvSelfcheckFresh(cache, () => Date.parse('2026-01-01T12:00:00.000Z'))).toBe(true)
    expect(isEnvSelfcheckFresh(cache, () => Date.parse('2026-01-01T00:00:00.000Z') + day + 1)).toBe(false)
  })
})

describe('envItemFromCache', () => {
  it('a cache with no items degrades to fail rather than silently passing the gate', () => {
    const cache: EnvSelfcheckCache = { checkedAt: 'x', ttlExpiresAt: 'y', overall: 'pass', items: [] }
    expect(envItemFromCache(cache).status).toBe('fail')
  })
})

describe('readOrRunEnvSelfcheck', () => {
  it('reuses a fresh cache without calling the ports', async () => {
    const ping = vi.fn(okPing)
    const engine = vi.fn(okEngine)
    const cache: EnvSelfcheckCache = { checkedAt: '2026-01-01T00:00:00.000Z', ttlExpiresAt: '2026-01-02T00:00:00.000Z', overall: 'pass', items: [{ name: 'engine', status: 'pass' }] }
    const outcome = await readOrRunEnvSelfcheck({ ping, engine }, cache, () => Date.parse('2026-01-01T12:00:00.000Z'))
    expect(outcome.ranFresh).toBe(false)
    expect(outcome.item).toEqual({ name: 'engine', status: 'pass' })
    expect(ping).not.toHaveBeenCalled()
    expect(engine).not.toHaveBeenCalled()
  })

  it('runs a fresh check and returns a cache value when nothing is cached', async () => {
    const ping = vi.fn(okPing)
    const engine = vi.fn(okEngine)
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z')
    const outcome = await readOrRunEnvSelfcheck({ ping, engine }, undefined, () => nowMs, 1000)
    expect(outcome.ranFresh).toBe(true)
    expect(outcome.item.status).toBe('pass')
    expect(ping).toHaveBeenCalledOnce()
    expect(outcome.cache.checkedAt).toBe(new Date(nowMs).toISOString())
    expect(outcome.cache.ttlExpiresAt).toBe(new Date(nowMs + 1000).toISOString())
  })

  it('surfaces a failing engine check rather than caching a false pass', async () => {
    const ping = vi.fn(okPing)
    const engine = vi.fn(async () => ({ ok: false, status: 'fail' as const, evidence: [], reason: 'sandbox round trip failed' }))
    const outcome = await readOrRunEnvSelfcheck({ ping, engine }, undefined, () => 0, 1000)
    expect(outcome.item.status).toBe('fail')
    expect(outcome.cache.overall).toBe('fail')
  })
})
