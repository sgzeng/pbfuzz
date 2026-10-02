/**
 * One-time setup for the real-DSH tests: put the NEWEST DeepSeek Harness on disk, build and pack
 * both plugins, and install them into a scratch profile exactly as a user would (`dsh plugin add`).
 *
 * The DSH version is never pinned. It is whatever npm's `latest` is when the run starts; set
 * `PBFUZZ_DSH_VERSION` only to reproduce a failure against a specific release. That is the point of
 * these tests: the plugins are checked against the DSH users will actually install next, not the
 * one the lockfile happens to hold.
 *
 * The plugins run their own engine: the packed plugin ships it (with a vendored PyYAML) and
 * `execution.pythonPath` is left at its default, so the only requirement is a `python3` >= 3.11 on
 * PATH, exactly as for a user.
 *
 * Environment:
 *   PBFUZZ_DSH_DIR      where the DSH install lives (default: <repo>/.dsh-real; CI caches it)
 *   PBFUZZ_DSH_VERSION  a version or dist-tag to test instead of `latest`
 *   PBFUZZ_SKIP_BUILD   1 = use the plugins as already built (the CI job builds them in a step)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestProject } from 'vitest/node'

export interface RealDshSetup {
  /** The installed DSH launcher package directory (`.../node_modules/@deepseek-ai/dsh`). */
  readonly dshPackageDir: string
  /** The version that was installed and is under test. */
  readonly version: string
  /** A DSH home holding the prepared profile; every spec boots a private copy of it. */
  readonly homeTemplate: string
  readonly profile: string
}

declare module 'vitest' {
  export interface ProvidedContext {
    realDsh: RealDshSetup
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = 'itest'

function run(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options, env: { ...process.env, ...options.env } })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${result.status ?? result.signal}):\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout.trim()
}

/** The concrete version `wanted` (a dist-tag or version) resolves to on npm right now. */
function resolveVersion(wanted: string): string {
  const out = /^\d/.test(wanted)
    ? run('npm', ['view', `@deepseek-ai/dsh@${wanted}`, 'version'])
    : run('npm', ['view', '@deepseek-ai/dsh', `dist-tags.${wanted}`])
  const version = out.split('\n').pop()?.trim().split(' ').pop()?.replace(/['"]/g, '')
  if (!version) throw new Error(`could not resolve @deepseek-ai/dsh@${wanted} on npm`)
  return version
}

function installedVersion(dir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(dir, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')) as { version: string }).version
  } catch {
    return undefined
  }
}

export default function setup(project: TestProject): () => void {
  const dshDir = resolve(process.env.PBFUZZ_DSH_DIR ?? join(ROOT, '.dsh-real'))
  const wanted = process.env.PBFUZZ_DSH_VERSION ?? 'latest'

  // 1. The DSH under test.
  let version: string
  try {
    version = resolveVersion(wanted)
  } catch (error) {
    // Offline on a dev machine: a previous install is better than nothing. CI must never do this,
    // or "always the newest" would silently become "whatever was cached".
    const have = installedVersion(dshDir)
    if (process.env.CI || have === undefined) throw error
    console.warn(`[dsh-tests] cannot reach npm (${(error as Error).message.split('\n')[0]}); reusing installed DSH ${have}`)
    version = have
  }
  if (installedVersion(dshDir) !== version) {
    console.log(`[dsh-tests] installing @deepseek-ai/dsh@${version} into ${dshDir}`)
    rmSync(dshDir, { recursive: true, force: true })
    mkdirSync(dshDir, { recursive: true })
    run('npm', ['install', '--silent', '--no-audit', '--no-fund', '--prefix', dshDir, `@deepseek-ai/dsh@${version}`])
  }
  console.log(`[dsh-tests] DSH under test: ${version} (${wanted === 'latest' ? 'npm latest' : `requested ${wanted}`})`)
  const dshBin = join(dshDir, 'node_modules/.bin/dsh')
  const dshPackageDir = join(dshDir, 'node_modules/@deepseek-ai/dsh')

  // 2. The plugins, built and packed the way build.sh ships them.
  if (process.env.PBFUZZ_SKIP_BUILD !== '1') run('pnpm', ['run', 'build'], { cwd: ROOT })
  const scratch = mkdtempSync(join(tmpdir(), 'pbfuzz-dsh-real-'))
  const dist = join(scratch, 'dist')
  mkdirSync(dist)
  run('npm', ['pack', '--silent', '--pack-destination', dist, join(ROOT, 'packages/dsh-pbfuzz'), join(ROOT, 'packages/dsh-kanalyzer')])
  const tarball = (prefix: string): string => {
    const file = readdirSync(dist).find(name => name.startsWith(prefix))
    if (!file) throw new Error(`npm pack produced no ${prefix}*.tgz in ${dist}`)
    return join(dist, file)
  }

  // 3. A profile with both plugins, installed by the real CLI (this is also where DSH admits the
  //    plugins against their declared peer ranges, so a latest DSH outside the range fails here).
  const home = join(scratch, 'home')
  for (const prefix of ['pbfuzz-dsh-pbfuzz-', 'pbfuzz-dsh-kanalyzer-']) {
    try {
      run(dshBin, ['plugin', '--profile', PROFILE, 'add', tarball(prefix)], { env: { DSH_HOME: home } })
    } catch (error) {
      throw new Error(`DSH ${version} would not install ${prefix}*.tgz. If its message names a peer range, the plugins' range is stale: run node scripts/bump-dsh.mjs ${version}.\n${(error as Error).message}`)
    }
  }
  if (!existsSync(join(home, 'profiles', PROFILE, 'package.json'))) throw new Error('dsh plugin add did not create the profile')

  project.provide('realDsh', { dshPackageDir, version, homeTemplate: home, profile: PROFILE })
  return () => { rmSync(scratch, { recursive: true, force: true }) }
}
