/**
 * dsh-kanalyzer — a general-purpose LLVM static-analysis plugin for DeepSeek Harness.
 *
 * Publishes `ctx.kanalyzer` (see `./api.ts`, mirroring `contracts/kanalyzer-api.ts`), the
 * `kanalyzer_*` tools, the `/kanalyzer` command, the `kanalyzer` settings namespace, and the
 * `kanalyzer` / `kanalyzer-build` skills. Every optional collaborator (tools, commands, settings,
 * jobs, skills) is picked up through `ctx.inject`, so the service works in any composition.
 *
 * @module @pbfuzz/dsh-kanalyzer
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandHome } from './core/install.ts'
import { parseSkillFile } from './core/skill.ts'
import { registerCommands } from './host/commands.ts'
import { KanalyzerRuntime } from './host/runtime.ts'
import { Config, KANALYZER_NS, resolveConfig, type StatusWriter } from './host/settings.ts'
import { registerTools } from './host/tools.ts'

export type * from './api.ts'
export { KanalyzerRuntime } from './host/runtime.ts'
export { KANALYZER_NS } from './host/settings.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Restated from `@deepseek-ai/cordis-plugin-loader` (a transitive dependency of DSH, not ours):
     * emitted to the owning fiber after the loader commits an edit to this entry's `.volatile()`
     * config fields. Identical signature, so the two declarations merge.
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

export const name = 'dsh-kanalyzer'
export const inject: string[] = []
export { Config }

/** `lib/index.js` is bundled one level below the package root. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Plugin entry.
 * @param ctx - host context.
 * @param config - entry config (composition layer).
 */
export function apply(ctx: Context, config: Config): void {
  // The loader hands over live `Volatile` references. Settings are resolved once and re-resolved
  // after the loader commits a form edit (`loader/volatile-update`, below).
  let resolved: Config | undefined
  // Status written while no settings service could take it: keeps `status()` consumers current.
  let memoryStatus: Partial<Config['status']> = {}
  const source = (): Config => {
    resolved ??= resolveConfig(config)
    return { ...resolved, status: { ...resolved.status, ...memoryStatus } }
  }
  let runtime: KanalyzerRuntime | undefined

  const writeStatus: StatusWriter = async (patch) => {
    const settings = ctx.get('settings')
    if (settings !== undefined) {
      try { await settings.update(KANALYZER_NS, { status: patch }); return } catch { /* fall through to memory */ }
    }
    memoryStatus = { ...memoryStatus, ...patch }
  }

  // The only thing derived from the settings source is the persisted install status: moving
  // `install.installDir` or `install.llvmPrefix` points at a different (or no) KAMain, so the
  // recorded binary/commit/LLVM and the last doctor verdict go stale. Re-derive and write back
  // only on a real difference — the write re-enters onChange, which then finds nothing to do.
  let refreshing = false
  let rerun = false
  const refreshInstallStatus = (): void => {
    if (refreshing) { rerun = true; return }
    refreshing = true
    void (async () => {
      do {
        rerun = false
        if (runtime === undefined) return
        // Create installDir up front: the settings card opens the Build session with it as cwd, and
        // a missing directory made that session fall back to the default cwd, which put every clone
        // and build write outside the agent's workspace (a sandbox escalation per step).
        await mkdir(expandHome(source().install.installDir, homedir()), { recursive: true }).catch(() => { /* reported by doctor */ })
        const found = await runtime.status()
        const recorded = source().status
        const next = {
          installed: found.installed,
          binaryPath: found.binaryPath ?? '',
          commit: found.commit ?? '',
          llvmVersion: found.llvmVersion ?? '',
        }
        const moved = recorded.binaryPath !== next.binaryPath || recorded.commit !== next.commit
        if (!moved && recorded.installed === next.installed && recorded.llvmVersion === next.llvmVersion) continue
        // A doctor verdict describes one binary; it says nothing about a different one.
        await writeStatus(moved ? { ...next, lastDoctor: '', lastDoctorAt: '', lastDoctorMessage: '' } : next)
      } while (rerun)
    })().catch(() => { /* a read-only settings provider must not break a settings change */ })
      .finally(() => { refreshing = false })
  }

  // Settings (DSH ≥ 0.2): this entry's volatile fields are edited in place; the loader announces the
  // change to the owning fiber.
  ctx.on('loader/volatile-update', () => {
    resolved = undefined
    refreshInstallStatus()
  })
  // kanalyzer ships its own settings card, so the generic schema-generated page stays off.
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
  })

  ctx.plugin(KanalyzerRuntime, { config: () => source(), writeStatus, packageRoot: PACKAGE_ROOT })
  ctx.inject(['kanalyzer'], (rctx) => {
    runtime = rctx.kanalyzer
    refreshInstallStatus()
    rctx.effect(() => () => { runtime = undefined })
  })

  ctx.inject(['tools', 'kanalyzer'], (tctx) => { registerTools(tctx) })
  ctx.inject(['commands', 'kanalyzer'], (cctx) => { registerCommands(cctx, () => source(), PACKAGE_ROOT) })
  ctx.inject(['skills'], (kctx) => {
    const root = join(PACKAGE_ROOT, 'skills')
    for (const dir of readdirSync(root)) {
      const path = join(root, dir, 'SKILL.md')
      const parsed = parseSkillFile(readFileSync(path, 'utf8'))
      if (parsed === undefined) continue
      kctx.skills.register({ ...parsed, path, source: 'bundled', resourceBase: { kind: 'directory', path: join(root, dir) } })
    }
  })
}
