/**
 * Type-level proof that src/api.ts is exactly contracts/kanalyzer-api.ts (both directions),
 * plus a check that the host settings defaults equal the frozen settings schema defaults.
 * `tsc -p tsconfig.core.json` is what enforces the type half; vitest runs the value half.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type * as C from '../../../contracts/kanalyzer-api.ts'
import type * as L from '../src/api.ts'
import { BUILTIN_DEFAULTS } from '../src/core/options.ts'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const assertSame = <T extends true>(): T => true as T

assertSame<Same<C.KanalyzerService, L.KanalyzerService>>()
assertSame<Same<C.AnalyzeRequest, L.AnalyzeRequest>>()
assertSame<Same<C.AnalyzeResult, L.AnalyzeResult>>()
assertSame<Same<C.PrepareRequest, L.PrepareRequest>>()
assertSame<Same<C.PrepareResult, L.PrepareResult>>()
assertSame<Same<C.QueryRequest, L.QueryRequest>>()
assertSame<Same<C.QueryResult, L.QueryResult>>()
assertSame<Same<C.KanalyzerDoctor, L.KanalyzerDoctor>>()
assertSame<Same<C.KanalyzerStatus, L.KanalyzerStatus>>()
assertSame<Same<C.DumpSelection, L.DumpSelection>>()

interface SchemaNode { default?: unknown; properties?: Record<string, SchemaNode> }

describe('settings schema parity', () => {
  it('BUILTIN_DEFAULTS equal the frozen schema defaults', () => {
    const path = fileURLToPath(new URL('../../../contracts/kanalyzer-settings.schema.json', import.meta.url))
    const schema = JSON.parse(readFileSync(path, 'utf8')) as SchemaNode
    const d = schema.properties?.defaults?.properties ?? {}
    expect(BUILTIN_DEFAULTS.verbose).toBe(d.verbose?.default)
    expect(BUILTIN_DEFAULTS.callStackLen).toBe(d.callStackLen?.default)
    expect(BUILTIN_DEFAULTS.useTypeBasedCallGraph).toBe(d.useTypeBasedCallGraph?.default)
    expect(BUILTIN_DEFAULTS.timeoutSec).toBe(d.timeoutSec?.default)
    expect(BUILTIN_DEFAULTS.memLimitMB).toBe(d.memLimitMB?.default)
    const dumps = d.dumps?.properties ?? {}
    for (const [k, v] of Object.entries(BUILTIN_DEFAULTS.dumps)) expect(v, k).toBe(dumps[k]?.default)
  })
})
