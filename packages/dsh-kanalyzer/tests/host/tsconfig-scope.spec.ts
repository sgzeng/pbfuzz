/**
 * F17 — formalizing the "tests/host/ needs @deepseek-ai/* to mock the subprocess boundary, so it
 * cannot be part of the harness-free `tsconfig.core.json`" rule that config's own "// why" block
 * already documents (and that F18 first violated in practice by adding
 * `tests/host/runtime.spec.ts` while the config's blanket `"tests"` include still covered it).
 *
 * This is the one part of F17 with a real, mechanical red/green: `tsconfig.core.json` either
 * excludes `tests/host` or it doesn't. The other new specs under `tests/host/` exercise the
 * runtime behavior itself (doctor/prepare/analyze error paths, a settings round trip) and pass
 * against the already-correct host implementation; this one exercises the scoping rule.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('tsconfig.core.json scoping (F17)', () => {
  it('excludes tests/host, the only tests directory allowed to import @deepseek-ai/*', () => {
    const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))
    const raw = readFileSync(join(pkgRoot, 'tsconfig.core.json'), 'utf8')
    const parsed = JSON.parse(raw) as { include?: string[]; exclude?: string[] }
    // The blanket "tests" include must stay (core-only specs keep typechecking against src/core).
    expect(parsed.include).toContain('tests')
    expect(parsed.exclude ?? []).toContain('tests/host')
  })

  it('src/core stays free of @deepseek-ai/* imports (the rule tests/host is carved out of)', () => {
    // Not a re-check of every file — just confirms the documented boundary this exclusion exists
    // for is still true, so the two facts (the rule and the carve-out) don't silently drift apart.
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
