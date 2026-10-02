/**
 * `settings.ts` under DSH >= 0.2: the loader parses the plugin's entry through `SettingsSchema` and
 * hands over a live `Volatile<T>` reference per `.volatile()` leaf; `resolveSettings` is the one
 * place that turns that back into plain `PbfuzzSettings`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveSettings, SettingsSchema } from '../src/settings.ts'

const here = dirname(fileURLToPath(import.meta.url))

type Reference = { get(): unknown }
const isReference = (value: unknown): value is Reference => typeof (value as Reference | undefined)?.get === 'function'

/** Every leaf the settings card can edit, as a dotted path. */
function leaves(value: unknown, path: string[] = []): string[] {
  if (isReference(value) || typeof value !== 'object' || value === null || Array.isArray(value)) return [path.join('.')]
  return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]))
}

describe('pbfuzz settings under the DSH >= 0.2 loader', () => {
  it('the loader sees a Volatile reference on every leaf (DSH only exposes volatile fields to the settings form)', () => {
    const parsed = SettingsSchema({} as never) as unknown as Record<string, unknown>
    const plain = leaves(parsed).filter(path => !isReference(path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], parsed)))
    expect(plain).toEqual([])
    expect(isReference((parsed.tools as Record<string, unknown>).tracer)).toBe(true)
  })

  it('resolveSettings reads the references the loader hands over', () => {
    const parsed = SettingsSchema({ tools: { tracer: 'gdb' }, budget: { maxPierRounds: 9 } } as never)
    const resolved = resolveSettings(parsed)
    expect(resolved.tools.tracer).toBe('gdb')
    expect(resolved.budget.maxPierRounds).toBe(9)
    expect(isReference(resolved.tools.tracer)).toBe(false)
  })

  it('resolveSettings still accepts plain / partial values and fills every default', () => {
    expect(resolveSettings({ execution: { pythonPath: '/venv/bin/python' } }).execution.pythonPath).toBe('/venv/bin/python')
    expect(resolveSettings(undefined).fuzzing.maxIters).toBe(1000)
  })

  it('resolved defaults equal the frozen JSON schema defaults', () => {
    const schema = JSON.parse(readFileSync(join(here, '..', '..', '..', 'contracts', 'pbfuzz-settings.schema.json'), 'utf8'))
    const resolved = resolveSettings({}) as unknown as Record<string, Record<string, unknown>>
    for (const [group, g] of Object.entries<{ properties: Record<string, { default?: unknown; type?: string }> }>(schema.properties)) {
      for (const [key, field] of Object.entries(g.properties)) {
        if (field.default === undefined) continue
        expect(resolved[group]![key], `${group}.${key}`).toEqual(field.default)
      }
    }
  })
})
