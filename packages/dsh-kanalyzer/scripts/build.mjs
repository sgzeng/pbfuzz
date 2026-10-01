#!/usr/bin/env node
/**
 * Build the host half of @pbfuzz/dsh-kanalyzer.
 *
 * - `lib/index.js`: one ESM bundle of `src/index.ts` (esbuild), every `@deepseek-ai/*` peer and
 *   node builtin kept external. Needs nothing but esbuild, so it always succeeds.
 * - `lib/types/**`: declarations from `tsc --emitDeclarationOnly`. That needs the harness peers
 *   resolvable, which is only true where the pinned deepseek-harness is installed.
 * - `lib/client.js`: built by W8's client build when `src/client/` exists (not owned here).
 *
 * `prepare` (run by git installs and by every workspace `pnpm install`) calls this WITHOUT
 * `--strict`: a missing harness downgrades the declaration step to a warning instead of breaking
 * the install of every other package in the workspace. `build` passes `--strict`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const strict = process.argv.includes('--strict')

const { build } = await import('esbuild')
await build({
  entryPoints: [join(pkg, 'src/index.ts')],
  outfile: join(pkg, 'lib/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
})
console.log('dsh-kanalyzer: wrote lib/index.js')

const tsc = spawnSync('npx', ['tsc', '-p', join(pkg, 'tsconfig.json'), '--emitDeclarationOnly'], { stdio: 'inherit', cwd: pkg })
if (tsc.status !== 0) {
  const msg = 'dsh-kanalyzer: declaration emit failed (are the @deepseek-ai/* harness peers installed?)'
  if (strict) { console.error(msg); process.exit(1) }
  console.warn(`${msg} — continuing because this is not a --strict build`)
}

// W8 owns the client bundle and its build script; run it when present.
const clientBuild = join(pkg, 'scripts/build-client.mjs')
if (existsSync(clientBuild)) {
  const c = spawnSync(process.execPath, [clientBuild], { stdio: 'inherit', cwd: pkg })
  if (c.status !== 0 && strict) process.exit(1)
}
