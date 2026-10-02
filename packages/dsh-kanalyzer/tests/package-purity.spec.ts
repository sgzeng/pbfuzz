/**
 * dsh-kanalyzer is a general-purpose plugin that "knows nothing about pbfuzz" (contracts/README.md,
 * PLAN.md). Its generated/published output must therefore never mention pbfuzz-specific types —
 * regenerating from a shared, unscoped `contracts/*.schema.json` output previously leaked
 * `PbfuzzCampaign`/`PbfuzzState`/etc. into this package (F15). This test greps every generated
 * TS file this package's codegen step actually produces (`src/generated/`, which `lib/types/**`
 * is compiled from by `scripts/build.mjs`) for pbfuzz-specific identifiers and asserts none show
 * up. `ProviderCapabilities` is one of them, so a stray `analysis-provider.ts` (pbfuzz's internal
 * provider interface) landing in `src/generated/` fails here too.
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

/** Every `.ts`/`.d.ts` file under `dir`, recursively. A missing dir yields []. */
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
})
