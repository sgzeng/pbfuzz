/**
 * The README's Development section says `pnpm run test:engine` runs pytest against "the Python
 * engine" with no extra setup beyond the Quick Start's `./build.sh`. That only holds if the venv
 * `build.sh` creates actually has pytest installed (`engine/pyproject.toml`'s `dev` extra) and
 * `test:engine`'s default interpreter is that venv rather than a bare system `python3` — which,
 * on a fresh machine, has neither pyyaml nor pytest. Before this fix, `./build.sh` followed by
 * `pnpm run test:engine` failed with "No module named pytest": the venv was built with
 * `pip install -e engine` (no `[dev]`), and the script's `${PBFUZZ_PYTHON:-python3}` fallback
 * never pointed at it anyway. CI never hits this — it installs `'.[dev]'` into its own interpreter
 * and sets `PBFUZZ_PYTHON` explicitly — so nothing there would have caught a regression here.
 * These two file-content checks encode the fix as an invariant.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

describe('build.sh installs the engine with its dev extra', () => {
  it('pip installs "engine[dev]", not plain "engine" (pytest must land in the built venv)', () => {
    const buildSh = readFileSync(join(repoRoot, 'build.sh'), 'utf8')
    const installLine = buildSh.split('\n').find(line => line.includes('pip install') && line.includes('engine'))
    expect(installLine, 'build.sh should pip-install the engine package into engine/.venv').toBeDefined()
    expect(installLine).toMatch(/engine\[dev\]/)
  })
})

describe('package.json "test:engine" defaults to the build.sh venv', () => {
  it('falls back to engine/.venv/bin/python, not a bare "python3", when PBFUZZ_PYTHON is unset', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const script = pkg.scripts['test:engine']
    expect(script, 'package.json must define a test:engine script').toBeDefined()
    // The script runs with cwd already changed to engine/, so the venv is ".venv/bin/python" from there.
    expect(script).toMatch(/\$\{PBFUZZ_PYTHON:-\.venv\/bin\/python\}/)
  })
})
