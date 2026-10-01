/**
 * TTL-cached environment self-check: engine ping/version/sandbox-round-trip health, the one
 * self-check item with no campaign dependency (`core/selfcheck.ts`'s `runEnvSelfcheck`), cached
 * under the `pbfuzz` settings section's `status.envSelfcheck` so campaign start reads it instead
 * of re-running it on the critical path.
 *
 * This module is settings-service-agnostic on purpose: it converts between the cached JSON shape
 * (`contracts/pbfuzz-settings.schema.json`'s `status.envSelfcheck`) and a `SelfcheckItem`, and
 * decides freshness — the actual `ctx.settings.update()` read/write glue, and the `/pbfuzz
 * selfcheck` command surface that triggers it, live in a later wave (`command.ts`/`guards.ts`).
 *
 * @module @pbfuzz/dsh-pbfuzz/env-selfcheck
 */

import type { PbfuzzSettings, SelfcheckItem } from './core/contracts.ts'
import { runEnvSelfcheck, type SelfcheckPorts } from './core/selfcheck.ts'

/** The `status.envSelfcheck` shape (`contracts/pbfuzz-settings.schema.json`), narrowed to what
 * this module reads/writes — matches `PbfuzzSettings['status']['envSelfcheck']`. */
export type EnvSelfcheckCache = NonNullable<PbfuzzSettings['status']['envSelfcheck']>

/** Default TTL: environment facts (interpreter version, contracts version, sandbox round trip)
 * change only on a deploy/upgrade, not per campaign — a day is generous headroom without ever
 * feeling stale to a user who just fixed something and wants to see it reflected immediately
 * (they re-run `/pbfuzz selfcheck` by hand; this TTL only governs the *implicit* reuse). */
export const ENV_SELFCHECK_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Whether a cached env self-check is still within its TTL. An empty/missing `checkedAt` (the
 * schema's default, before any self-check has ever run) is never fresh.
 * @param cache - the cached value read from settings, if any.
 * @param now - clock, injected for tests.
 * @returns whether the cache may be reused without a fresh engine round trip.
 */
export function isEnvSelfcheckFresh(cache: EnvSelfcheckCache | undefined, now: () => number): boolean {
  if (cache === undefined || cache.checkedAt === undefined || cache.checkedAt === '') return false
  const expiresAt = cache.ttlExpiresAt === undefined ? Number.NaN : Date.parse(cache.ttlExpiresAt)
  return !Number.isNaN(expiresAt) && now() < expiresAt
}

/** The cached value's one item, reconstructed as a `SelfcheckItem` for `runSelfcheck`'s
 * `cachedEnvItem` parameter. `runEnvSelfcheck` only ever produces the `engine` item, so a cache
 * with no items (never checked, or a malformed settings value) degrades to a `fail` rather than
 * silently passing the gate on nothing. */
export function envItemFromCache(cache: EnvSelfcheckCache): SelfcheckItem {
  const first = cache.items?.[0]
  if (first === undefined) return { name: 'engine', status: 'fail', reason: 'no cached environment self-check item' }
  return { name: 'engine', status: first.status, ...first.reason !== undefined && first.reason !== '' ? { reason: first.reason } : {} }
}

/** A fresh `SelfcheckItem` reshaped for `status.envSelfcheck`. */
function toCache(item: SelfcheckItem, checkedAtMs: number, ttlMs: number): EnvSelfcheckCache {
  return {
    checkedAt: new Date(checkedAtMs).toISOString(),
    ttlExpiresAt: new Date(checkedAtMs + ttlMs).toISOString(),
    overall: item.status === 'fail' ? 'fail' : item.status === 'warn' ? 'warn' : 'pass',
    items: [{ name: item.name, status: item.status, ...item.reason !== undefined ? { reason: item.reason } : {} }],
  }
}

/** Outcome of {@link readOrRunEnvSelfcheck}. */
export interface EnvSelfcheckOutcome {
  /** For `runSelfcheck`'s `cachedEnvItem` parameter. */
  item: SelfcheckItem
  /** The value to persist to `settings.status.envSelfcheck` — identical to what was passed in
   * when `ranFresh` is false (the caller may skip the settings write in that case). */
  cache: EnvSelfcheckCache
  /** Whether this call actually talked to the engine (cache was missing/stale), vs. reused it. */
  ranFresh: boolean
}

/**
 * Reuse a fresh cached environment self-check, or run one now and return what to cache.
 *
 * This is the one function a `/pbfuzz selfcheck`-style command and a campaign-start code path
 * both call: the command always wants `ranFresh` behaviour available on demand (a user who just
 * fixed something expects to see it reflected — pass `cached: undefined` to force a fresh run),
 * while campaign start wants the cheap path (pass whatever is currently in settings and let the
 * TTL decide).
 * @param ports - the two engine ports `runEnvSelfcheck` needs.
 * @param cached - the currently cached value from `settings.status.envSelfcheck`, if any.
 * @param now - clock, injected for tests; defaults to `Date.now`.
 * @param ttlMs - how long a fresh result stays valid; defaults to {@link ENV_SELFCHECK_TTL_MS}.
 * @returns the item to use now, and the cache value to persist (only meaningfully different from
 *   `cached` when `ranFresh` is true).
 */
export async function readOrRunEnvSelfcheck(
  ports: Pick<SelfcheckPorts, 'ping' | 'engine'>,
  cached: EnvSelfcheckCache | undefined,
  now: () => number = Date.now,
  ttlMs: number = ENV_SELFCHECK_TTL_MS,
): Promise<EnvSelfcheckOutcome> {
  if (isEnvSelfcheckFresh(cached, now)) return { item: envItemFromCache(cached!), cache: cached!, ranFresh: false }
  const item = await runEnvSelfcheck(ports, now)
  return { item, cache: toCache(item, now(), ttlMs), ranFresh: true }
}
