/**
 * Cache key: `sha256(bitcode digest + KAMain commit + resolved options)`.
 *
 * Pure: the bitcode digest is computed by the host (streaming sha256 of the file) and passed in.
 *
 * @module @pbfuzz/dsh-kanalyzer/core/cache
 */

import { createHash } from 'node:crypto'
import { cacheKeyMaterial, type ResolvedOptions } from './options.ts'

/**
 * @param bitcodeDigest - sha256 of the bitcode contents.
 * @param kamainCommit - kernel-analyzer commit (`unknown` when not a git checkout, which disables reuse across rebuilds only in the conservative direction: a rebuild with the same commit reuses).
 * @param options - resolved options.
 * @returns a hex key, stable across target/entry ordering.
 */
export function cacheKey(bitcodeDigest: string, kamainCommit: string, options: ResolvedOptions): string {
  return createHash('sha256').update(cacheKeyMaterial(bitcodeDigest, kamainCommit, options)).digest('hex')
}

/** Separate key for query/index data, which does not depend on targets. */
export function indexKey(bitcodeDigest: string, kamainCommit: string, typeBasedCallgraph: boolean): string {
  return createHash('sha256').update(JSON.stringify({ i: 1, bitcodeDigest, kamainCommit, typeBasedCallgraph })).digest('hex')
}
