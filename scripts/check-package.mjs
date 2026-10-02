#!/usr/bin/env node
/**
 * Verify the npm tarballs are ready to use, by packing them and looking at what a user gets:
 *
 *  - every file the plugin needs at runtime is in the tarball (built `lib/`, `cordis.patch.yml`,
 *    skills, and for dsh-pbfuzz the Python engine, its schemas and PyYAML);
 *  - `package.json` carries what the markets key on (`repository` pointing back at this repo, the
 *    license, `dsh.bundle`);
 *  - the engine from the EXTRACTED dsh-pbfuzz tarball starts and answers `ping` and
 *    `selfcheck.engine` under a Python with no site-packages (`python -S`), i.e. with no PyYAML
 *    installed, and imports `yaml` from the tarball itself.
 *
 * Needs the packages built (`pnpm -r build`) and a Python >= 3.11 (`$PBFUZZ_PYTHON`, else
 * python3, python3.13, python3.12, python3.11). Exits non-zero listing every problem.
 *
 * Usage: node scripts/check-package.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_URL = 'github.com/sgzeng/pbfuzz'

const PACKAGES = [
  {
    dir: 'packages/dsh-pbfuzz',
    name: '@pbfuzz/dsh-pbfuzz',
    engine: true,
    required: [
      'package.json', 'LICENSE', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js',
      'engine/pbfuzz_engine/rpc.py', 'engine/pbfuzz_engine/_contracts_dir.py',
      'engine/yaml/__init__.py', 'engine/PYYAML-LICENSE',
      'contracts/campaign.schema.json', 'contracts/engine-rpc.schema.json', 'contracts/state/state.schema.json',
    ],
    requiredPrefixes: ['skills/pbfuzz/'],
  },
  {
    dir: 'packages/dsh-kanalyzer',
    name: '@pbfuzz/dsh-kanalyzer',
    engine: false,
    required: ['package.json', 'LICENSE', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js'],
    requiredPrefixes: ['skills/'],
  },
]

const problems = []
const fail = message => { problems.push(message) }

/** First interpreter that is Python >= 3.11. */
function findPython() {
  const candidates = [process.env.PBFUZZ_PYTHON, 'python3', 'python3.13', 'python3.12', 'python3.11'].filter(Boolean)
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim() === 'True') return c
  }
  return undefined
}

/** The engine out of the extracted tarball, under `python -S`: ping, then selfcheck.engine. */
function smokeEngine(python, extracted) {
  const engineDir = join(extracted, 'package', 'engine')
  const env = { ...process.env, PYTHONPATH: engineDir }
  for (const k of ['PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONUSERBASE']) delete env[k]
  const yamlOrigin = spawnSync(python, ['-S', '-c', 'import yaml; print(yaml.__file__)'], { encoding: 'utf8', env })
  if (yamlOrigin.status !== 0 || !yamlOrigin.stdout.trim().startsWith(engineDir)) {
    fail(`dsh-pbfuzz: yaml does not come from the tarball (${yamlOrigin.stdout.trim() || yamlOrigin.stderr.trim()})`)
    return
  }
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 2, method: 'selfcheck.engine', params: {} },
  ].map(r => JSON.stringify(r)).join('\n') + '\n'
  const run = spawnSync(python, ['-S', '-m', 'pbfuzz_engine.rpc'], { input: requests, encoding: 'utf8', env, timeout: 60_000 })
  const replies = Object.fromEntries(run.stdout.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l)).map(r => [r.id, r]))
  if (replies[1]?.result?.engineVersion === undefined) { fail(`dsh-pbfuzz: engine ping failed: ${run.stdout.slice(0, 300)} ${run.stderr.slice(0, 300)}`); return }
  const check = replies[2]?.result
  if (check?.status !== 'pass') fail(`dsh-pbfuzz: selfcheck.engine is ${check?.status}: ${JSON.stringify(check ?? replies[2]).slice(0, 400)}`)
  else console.log(`  engine from the tarball: ${check.evidence.join('; ')}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'pbfuzz-check-package-'))
try {
  for (const pkg of PACKAGES) {
    console.log(`== ${pkg.name}`)
    const cwd = join(root, pkg.dir)
    if (!existsSync(join(cwd, 'lib', 'index.js'))) { fail(`${pkg.name}: not built (run pnpm -r build)`); continue }
    if (pkg.engine) execFileSync('node', ['scripts/stage-engine.mjs'], { cwd, stdio: 'inherit' })
    else execFileSync('node', ['../../scripts/copy-license.mjs'], { cwd })
    let tarball
    try {
      // --ignore-scripts: staging was done above, and `prepare` would rebuild what we just built.
      // npm >= 10 runs the package's own `prepare` regardless, and its output lands on stdout, so
      // stdout is not parsed: the tarball is found by listing the (initially empty) directory.
      const before = new Set(readdirSync(scratch))
      execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', scratch], { cwd, stdio: ['ignore', 'ignore', 'inherit'] })
      const made = readdirSync(scratch).filter(f => f.endsWith('.tgz') && !before.has(f))
      if (made.length !== 1) throw new Error(`expected one new tarball in ${scratch}, found ${made.length}`)
      tarball = join(scratch, made[0])
    } finally {
      if (pkg.engine) execFileSync('node', ['scripts/stage-engine.mjs', '--clean'], { cwd, stdio: 'inherit' })
      else rmSync(join(cwd, 'LICENSE'), { force: true })
    }
    const listed = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean)
    const packed = { filename: tarball.slice(scratch.length + 1), size: statSync(tarball).size, files: listed.filter(f => !f.endsWith('/')).map(f => ({ path: f.replace(/^package\//, '') })) }
    const files = new Set(packed.files.map(f => f.path))
    console.log(`  ${packed.filename}: ${files.size} files, ${(packed.size / 1024).toFixed(0)} kB packed`)
    for (const f of pkg.required) if (!files.has(f)) fail(`${pkg.name}: tarball is missing ${f}`)
    for (const p of pkg.requiredPrefixes) if (![...files].some(f => f.startsWith(p))) fail(`${pkg.name}: tarball has nothing under ${p}`)
    for (const f of files) {
      if (/(^|\/)(__pycache__|tests|node_modules)\//.test(f) || /\.pyc$/.test(f)) fail(`${pkg.name}: tarball contains ${f}`)
    }

    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }))
    if (manifest.name !== pkg.name) fail(`${pkg.name}: package.json name is ${manifest.name}`)
    if (manifest.license !== 'PolyForm-Noncommercial-1.0.0') fail(`${pkg.name}: license is ${manifest.license}`)
    const repo = manifest.repository
    if (typeof repo?.url !== 'string' || !repo.url.toLowerCase().includes(REPO_URL)) fail(`${pkg.name}: repository.url must point at ${REPO_URL} (the markets match on it), got ${JSON.stringify(repo)}`)
    if (repo?.directory !== pkg.dir) fail(`${pkg.name}: repository.directory is ${repo?.directory}, expected ${pkg.dir}`)
    const patch = manifest.dsh?.bundle?.patch
    if (typeof patch !== 'string') fail(`${pkg.name}: no dsh.bundle.patch (not installable with dsh plugin add)`)
    else if (!files.has(patch.replace(/^\.\//, ''))) fail(`${pkg.name}: dsh.bundle.patch ${patch} is not in the tarball`)

    if (pkg.engine) {
      const python = findPython()
      if (python === undefined) { fail('no Python >= 3.11 found to smoke-test the engine (set $PBFUZZ_PYTHON)'); continue }
      const extracted = join(scratch, `${pkg.dir.split('/').pop()}-extracted`)
      execFileSync('mkdir', ['-p', extracted])
      execFileSync('tar', ['-xzf', tarball, '-C', extracted])
      smokeEngine(python, extracted)
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error(`\ncheck-package: ${problems.length} problem(s)`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('\ncheck-package: ok')
