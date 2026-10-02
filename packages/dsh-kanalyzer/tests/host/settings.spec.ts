/**
 * F17 — the `StatusWriter` read/write contract `src/host/settings.ts` defines.
 *
 * Nothing is mocked: a `KanalyzerRuntime.doctor()` failure round-trips a `status.*` patch through a
 * `StatusWriter` back into a settings store that `config()` reads — the same read → write → read
 * cycle `src/index.ts`'s in-memory fallback performs when no `dsh-settings` service is mounted.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import { Config, resolveConfig, type StatusWriter } from '../../src/host/settings.ts'

describe('kanalyzer settings status.* read/write round trip (src/host/settings.ts)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kanalyzer-settings-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('resolveConfig reads the live Volatile references the DSH >= 0.2 loader hands the plugin', () => {
    // The loader parses the entry through `Config`; every leaf comes back as a `Volatile<T>` whose
    // `.get()` is the current snapshot. A plugin must never see (or compare) the reference itself.
    const parsed = Config({ install: { branch: 'custom-branch' } } as unknown as Parameters<typeof Config>[0])
    expect(typeof (parsed.install.branch as unknown as { get: unknown }).get).toBe('function')
    const cfg = resolveConfig(parsed)
    expect(cfg.install.branch).toBe('custom-branch')
    expect(cfg.install.installDir).toBe('~/.dsh/kanalyzer')
    expect(cfg.status.installed).toBe(false)
  })

  it('a doctor() failure patch, written through StatusWriter, reads back out of config()', async () => {
    // A mutable settings store plus the same read()/write() shape `src/index.ts` falls back to
    // when no `dsh-settings` service is mounted (`config = { ...config, status: { ...patch } }`).
    const base = resolveConfig()
    let store = { ...base, install: { ...base.install, installDir: join(tmp, 'empty-install') } }
    const writeStatus: StatusWriter = async (patch) => {
      store = { ...store, status: { ...store.status, ...patch } }
    }
    const configFn = (): typeof store => store

    // Before any write, status is untouched.
    expect(configFn().status.lastDoctor).toBe('')
    expect(configFn().status.installed).toBe(false)

    const runtime = new KanalyzerRuntime(new Context(), { config: configFn, writeStatus, packageRoot: tmp })
    const result = await runtime.doctor()

    expect(result.ok).toBe(false)
    // The write from inside doctor() is visible through the same configFn() the runtime reads —
    // a real round trip, not just an assertion on doctor()'s own return value.
    expect(configFn().status.lastDoctor).toBe('fail')
    expect(configFn().status.lastDoctorMessage).toMatch(/KAMain not found/)
    expect(configFn().status.installed).toBe(false)
    expect(configFn().status.lastDoctorAt).not.toBe('')
  })
})
