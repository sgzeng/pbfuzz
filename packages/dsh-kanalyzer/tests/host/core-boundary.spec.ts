/**
 * `src/core` is deliberately free of `@deepseek-ai/*` imports — that is what lets `tsconfig.core.json`
 * (and the core specs) typecheck and run on a machine with no harness linked in, and what carves
 * `tests/host` (which must import those peers to fake the subprocess boundary) out of it. CI does
 * not run `typecheck:core`, so this is the only automatic check that the boundary still holds.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('core/host boundary (F17)', () => {
  it('src/core stays free of @deepseek-ai/* imports', () => {
    const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))
    const glob = (dir: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) out.push(...glob(full))
        else if (entry.endsWith('.ts')) out.push(full)
      }
      return out
    }
    const offenders: string[] = []
    for (const file of glob(join(pkgRoot, 'src', 'core'))) {
      const content = readFileSync(file, 'utf8')
      if (/@deepseek-ai\//.test(content)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
