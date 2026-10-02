/**
 * Boot the REAL DeepSeek Harness in this process: the same `runProfile()` the `dsh` binary calls,
 * over a scratch DSH home holding a profile that has pbfuzz and kanalyzer installed. Nothing from
 * `@deepseek-ai/*` is mocked; the only thing that never happens is a model call (no spec submits
 * a message to a provider, and API keys are stripped from the environment as a second guard).
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inject } from 'vitest'

/** The slice of a live cordis `Context` these specs touch. DSH's own typings live in the install under test. */
export interface RealCtx {
  get(name: string): any
  on(event: string, listener: (...args: any[]) => any): () => void
  readonly fiber: { state: number }
}

export interface RealDsh {
  readonly ctx: RealCtx
  /** The DSH version under test. */
  readonly version: string
  /** This boot's private DSH home (profile, settings document, sessions). */
  readonly home: string
  /** Absolute path of the booted profile directory. */
  readonly profileDir: string
  /** The interpreter (with `pbfuzz_engine`) the plugin is told to spawn the engine with. */
  readonly python: string
  /** Import a module from the DSH install under test (resolved from the launcher package). */
  load(specifier: string): Promise<any>
  dispose(): Promise<void>
}

/** cordis `Fiber` state value for a fully started tree. */
export const FIBER_ACTIVE = 2

export async function bootRealDsh(): Promise<RealDsh> {
  const setup = inject('realDsh')
  const home = mkdtempSync(join(tmpdir(), 'pbfuzz-dsh-home-'))
  cpSync(setup.homeTemplate, home, { recursive: true, verbatimSymlinks: true })
  process.env.DSH_HOME = home
  // Plugins that keep state under `~` (kanalyzer's install dir) must not touch the real one.
  const userHome = join(home, 'user-home')
  mkdirSync(userHome)
  process.env.HOME = userHome
  // A model call would cost money and make the specs non-deterministic; make one impossible.
  for (const key of Object.keys(process.env)) if (/^(DEEPSEEK|OPENAI|ANTHROPIC)\w*(KEY|TOKEN)$/.test(key)) delete process.env[key]

  const require = createRequire(join(setup.dshPackageDir, 'package.json'))
  const load = (specifier: string): Promise<any> => import(pathToFileURL(require.resolve(specifier)).href)
  const { loadLayeredEnv } = await load('@deepseek-ai/dsh-app-boot')
  const { runProfile } = await load('@deepseek-ai/dsh/profile-boot')

  const { ctx, shutdown } = await runProfile({ environment: loadLayeredEnv('dsh'), profile: setup.profile, patchFiles: [], args: [] })
  // install.sh points `execution.pythonPath` at the interpreter that has the engine; so do we.
  await ctx.get('settings').update('pbfuzz', { execution: { pythonPath: setup.python } })
  return {
    ctx,
    version: setup.version,
    python: setup.python,
    home,
    profileDir: join(home, 'profiles', setup.profile),
    load,
    async dispose() {
      await shutdown.shutdown(0)
      rmSync(home, { recursive: true, force: true })
    },
  }
}
