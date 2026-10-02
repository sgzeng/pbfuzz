#!/usr/bin/env node
/**
 * Publish both plugin packages to npm as `<major>.<minor>.<commit count>` (major.minor from
 * packages/dsh-pbfuzz/package.json, count = `git rev-list --count HEAD`), tagged `latest`.
 * The version is set in the working tree only (and put back afterwards); nothing is committed.
 *
 * Safety checks, each fatal: a shallow clone (the count would be wrong); a version already on the
 * registry that was published from a different commit (history was rewritten); a `latest` that is
 * already newer than this build (a re-run of an old workflow must not move `latest` backwards).
 * A version already published from this very commit is skipped, so re-running is harmless.
 *
 * Needs a full git history, the packages built (`pnpm -r build`) and npm credentials
 * (`NODE_AUTH_TOKEN`). `npm publish` runs each package's prepack (stages the engine) and
 * postpack. Pass `--dry-run` to go through the motions without publishing.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const PACKAGES = ['packages/dsh-pbfuzz', 'packages/dsh-kanalyzer']

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const read = dir => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))

if (git('rev-parse', '--is-shallow-repository') === 'true') throw new Error('shallow clone: the commit count would be wrong (checkout with fetch-depth: 0)')
const [major, minor] = read(PACKAGES[0]).version.split('.')
const count = Number(git('rev-list', '--count', 'HEAD'))
if (!Number.isInteger(count) || count < 1) throw new Error(`unexpected commit count: ${count}`)
const version = `${major}.${minor}.${count}`
const head = git('rev-parse', 'HEAD')

/** `npm view <spec> <field> --json`, or undefined when the registry says E404; anything else throws. */
function view(spec, field) {
  try {
    const out = execFileSync('npm', ['view', spec, field, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    return out === '' ? undefined : JSON.parse(out)
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`
    if (/E404|404 Not Found|is not in this registry/.test(text)) return undefined
    throw new Error(`npm view ${spec} ${field} failed: ${text.slice(0, 400)}`)
  }
}

const originals = new Map(PACKAGES.map(dir => [dir, readFileSync(join(root, dir, 'package.json'), 'utf8')]))
try {
  for (const dir of PACKAGES) {
    const { name } = read(dir)
    const published = view(`${name}@${version}`, 'gitHead')
    if (published !== undefined) {
      if (published === head) { console.log(`${name}@${version} is already on npm (same commit), skipping`); continue }
      throw new Error(`${name}@${version} is on npm but was published from ${published ?? 'an unknown commit'}, not ${head}: history was rewritten. Bump the minor in ${PACKAGES[0]}/package.json.`)
    }
    const latest = view(name, 'dist-tags.latest')
    const latestCount = typeof latest === 'string' ? Number(latest.split('.')[2]) : 0
    if (typeof latest === 'string' && latest.split('.').slice(0, 2).join('.') === `${major}.${minor}` && latestCount > count) {
      console.log(`${name}: latest is ${latest}, newer than this build (${version}); not moving latest backwards`)
      continue
    }
    const cwd = join(root, dir)
    execFileSync('npm', ['pkg', 'set', `version=${version}`], { cwd, stdio: 'inherit' })
    const args = ['publish', '--access', 'public', '--tag', 'latest', ...(process.env.GITHUB_ACTIONS === 'true' ? ['--provenance'] : [])]
    if (dryRun) args.push('--dry-run')
    console.log(`${dryRun ? 'would publish' : 'publishing'} ${name}@${version}`)
    execFileSync('npm', args, { cwd, stdio: 'inherit' })
  }
} finally {
  for (const [dir, text] of originals) writeFileSync(join(root, dir, 'package.json'), text)
}
