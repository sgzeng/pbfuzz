#!/usr/bin/env node
/**
 * Stage everything the Python sidecar needs into this package so an npm install is ready to use:
 *
 *   engine/pbfuzz_engine/   the engine (from <repo>/engine/pbfuzz_engine, no tests or caches)
 *   engine/yaml/            pure-Python PyYAML (from <repo>/engine/vendor/yaml), the engine's only
 *                           third-party dependency
 *   contracts/              the JSON Schemas the engine reads at runtime (<repo>/contracts)
 *   LICENSE                 the repo's license text
 *
 * `engineEnv()` (src/engine-bridge.ts) puts `<package>/engine` on the sidecar's PYTHONPATH, and the
 * engine finds `contracts/` two directories above `pbfuzz_engine/`, so no pip install is needed.
 * Run by `prepack` (npm pack / npm publish); the outputs are git-ignored. When the package is
 * already outside the monorepo (nothing to copy from) this does nothing.
 *
 * Usage: node scripts/stage-engine.mjs [--check | --clean]
 *   --check: verify the staged tree, change nothing
 *   --clean: remove the staged files (run by `postpack`, so a pack never leaves a stale copy behind)
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(pkg, '..', '..')
const src = {
  engine: join(repo, 'engine', 'pbfuzz_engine'),
  yaml: join(repo, 'engine', 'vendor', 'yaml'),
  yamlLicense: join(repo, 'engine', 'vendor', 'PYYAML-LICENSE'),
  contracts: join(repo, 'contracts'),
}
const out = { engine: join(pkg, 'engine'), contracts: join(pkg, 'contracts') }

const REQUIRED = [
  'engine/pbfuzz_engine/rpc.py',
  'engine/pbfuzz_engine/_contracts_dir.py',
  'engine/yaml/__init__.py',
  'engine/PYYAML-LICENSE',
  'contracts/campaign.schema.json',
  'contracts/engine-rpc.schema.json',
  'contracts/state/state.schema.json',
  'LICENSE',
]
const missing = () => REQUIRED.filter(f => !existsSync(join(pkg, f)))

if (process.argv.includes('--check')) {
  const m = missing()
  if (m.length > 0) { console.error(`stage-engine: not staged: ${m.join(', ')}`); process.exit(1) }
  console.log('stage-engine: staged tree is complete')
  process.exit(0)
}

if (process.argv.includes('--clean')) {
  // Only when there is a source tree to restage from; a package outside the monorepo keeps its files.
  if (existsSync(src.engine)) {
    rmSync(out.engine, { recursive: true, force: true })
    rmSync(out.contracts, { recursive: true, force: true })
    rmSync(join(pkg, 'LICENSE'), { force: true })
    console.log('stage-engine: removed staged files')
  }
  process.exit(0)
}

if (!existsSync(src.engine)) {
  if (missing().length > 0) { console.error('stage-engine: no engine to stage from and none staged'); process.exit(1) }
  console.log('stage-engine: already staged (no monorepo sources here)')
  process.exit(0)
}

// Tested on the path relative to the copied root, so a checkout under a directory named `tests` still stages.
const skip = (root, p) => /(^|[\\/])(__pycache__|\.pytest_cache|tests)([\\/]|$)|\.pyc$/.test(relative(root, p))
rmSync(out.engine, { recursive: true, force: true })
rmSync(out.contracts, { recursive: true, force: true })
mkdirSync(out.engine, { recursive: true })
cpSync(src.engine, join(out.engine, 'pbfuzz_engine'), { recursive: true, filter: p => !skip(src.engine, p) })
cpSync(src.yaml, join(out.engine, 'yaml'), { recursive: true, filter: p => !skip(src.yaml, p) })
cpSync(src.yamlLicense, join(out.engine, 'PYYAML-LICENSE'))
cpSync(join(repo, 'LICENSE'), join(pkg, 'LICENSE'))
cpSync(src.contracts, out.contracts, { recursive: true, filter: p => !skip(src.contracts, p) && !/\.ts$/.test(p) && !/[\\/]generated([\\/]|$)/.test(p) })

const count = d => readdirSync(d, { recursive: true }).filter(f => statSync(join(d, f)).isFile()).length
const m = missing()
if (m.length > 0) { console.error(`stage-engine: incomplete after staging: ${m.join(', ')}`); process.exit(1) }
console.log(`stage-engine: ${count(out.engine)} engine files, ${count(out.contracts)} contract files`)
