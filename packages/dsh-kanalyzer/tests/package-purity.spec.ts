/**
 * dsh-kanalyzer is a general-purpose plugin that "knows nothing about pbfuzz" (contracts/README.md,
 * PLAN.md). Its generated/published output must therefore never mention pbfuzz-specific types —
 * regenerating from a shared, unscoped `contracts/*.schema.json` output previously leaked
 * `PbfuzzCampaign`/`PbfuzzState`/etc. into this package (F15). This test greps every generated
 * TS file this package's codegen step actually produces (`src/generated/`, which `lib/types/**`
 * is compiled from by `scripts/build.mjs`) for pbfuzz-specific identifiers and asserts none show
 * up. It also does a best-effort check of `lib/types/generated/` when that build output is not
 * older than `src/generated/` (i.e. it reflects the current source, not a stale prior build) —
 * a stale `lib/` from before this fix is a `pnpm run build` away, not a codegen defect, and
 * rebuilding it is out of this test's scope.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

/** Identifiers that only make sense on the pbfuzz side of the contracts; kanalyzer must ship none. */
const FORBIDDEN = [
  'PbfuzzCampaign',
  'PbfuzzState',
  'PbfuzzStateBlocks',
  'PbfuzzSettings',
  'ProviderCapabilities', // contracts/analysis-provider.ts — pbfuzz's internal provider interface
]

/** Every `.ts`/`.d.ts` file under `dir`, recursively. Missing dirs (e.g. an unbuilt lib/) yield []. */
function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) out.push(...tsFilesUnder(full))
    else if (/\.(ts|d\.ts)$/.test(entry)) out.push(full)
  }
  return out
}

describe('package purity: dsh-kanalyzer ships no pbfuzz-specific generated types', () => {
  it('src/generated/ contains none of the pbfuzz-only identifiers', () => {
    const files = tsFilesUnder(join(pkgRoot, 'src', 'generated'))
    expect(files.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      for (const name of FORBIDDEN) {
        if (content.includes(name)) offenders.push(`${file}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('src/generated/ does not ship analysis-provider.ts (pbfuzz-only, kanalyzer has no consumer)', () => {
    expect(existsSync(join(pkgRoot, 'src', 'generated', 'analysis-provider.ts'))).toBe(false)
  })

  it('the built lib/types, when up to date with src/generated/, contains none of them either', () => {
    const srcContracts = join(pkgRoot, 'src', 'generated', 'contracts.ts')
    const libDir = join(pkgRoot, 'lib', 'types')
    if (!existsSync(srcContracts) || !existsSync(libDir)) return // nothing built yet — not this test's job
    const srcMtime = statSync(srcContracts).mtimeMs
    const files = tsFilesUnder(libDir)
    // A lib/ built before this source was regenerated is stale output for a *prior* codegen
    // run, not evidence about the current one — rebuilding it belongs to the package's own
    // `build` script (and the convergence "Ship" step), not to this test.
    if (files.some(f => statSync(f).mtimeMs < srcMtime)) return
    const offenders: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      for (const name of FORBIDDEN) {
        if (content.includes(name)) offenders.push(`${file}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
