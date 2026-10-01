/**
 * F17 — `src/host/settings.ts` (the schemastery `Config` schema and the `StatusWriter`
 * read/write contract it defines) had zero test coverage.
 *
 * Two things are real here, nothing is mocked: schemastery's own default-filling (the same
 * `Config()` call `acceptance-run/work/L1-kanalyzer/driver.mjs` uses to build a runtime against
 * the real installed plugin), and a `KanalyzerRuntime.doctor()` failure round-tripping a
 * `status.*` patch through a `StatusWriter` back into a settings store that `config()` reads —
 * the same read → write → read cycle `src/index.ts`'s in-memory fallback performs when no
 * `dsh-settings` service is mounted.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import { Config, optionDefaults, type StatusWriter } from '../../src/host/settings.ts'

describe('kanalyzer settings (src/host/settings.ts)', () => {
  it('schemastery fills every optional field of a partial config with the documented defaults', () => {
    // `Config`'s .d.ts call signature wants a fully-shaped input, but schemastery itself defaults
    // a genuinely partial object fine at runtime — this is exactly how a real settings document
    // read back from disk (never guaranteed complete after a schema change) gets defaulted, and
    // how `acceptance-run/work/L1-kanalyzer/driver.mjs` builds a runtime's config. Exercise that
    // real behavior directly; the cast only works around the narrower static type.
    const partial = { install: { branch: 'custom-branch' } } as unknown as Parameters<typeof Config>[0]
    const cfg = Config(partial)
    expect(cfg.install.branch).toBe('custom-branch')
    expect(cfg.install.installDir).toBe('~/.dsh/kanalyzer')
    expect(cfg.install.repoUrl).toBe('https://github.com/sgzeng/kernel-analyzer.git')
    expect(cfg.defaults.dumps).toEqual({
      policy: true, distance: true, criticalBranch: true,
      bidMappingAndFuncInfo: true, callerCalleeBothWays: true, annotatedIr: false,
    })
    expect(cfg.status).toEqual({
      installed: false, binaryPath: '', commit: '', llvmVersion: '',
      lastDoctor: '', lastDoctorAt: '', lastDoctorMessage: '',
      // The self-test's wllvm leg records its own verdict and the directory it found, so the card
      // can offer Install wllvm against exactly that check.
      lastWllvm: '', lastWllvmAt: '', lastWllvmMessage: '', wllvmBinDir: '',
    })
    // wllvm is the default prepare mode: it wraps the compiler instead of relying on the build
    // honouring $LDFLAGS, which is what large build systems routinely drop.
    expect(cfg.defaults.prepareMode).toBe('wllvm')
    expect(cfg.install.wllvmBinDir).toBe('')
    // optionDefaults() is the analysis-defaults view read back off the same Config.
    expect(optionDefaults(cfg)).toEqual({
      verbose: cfg.defaults.verbose,
      callStackLen: cfg.defaults.callStackLen,
      useTypeBasedCallGraph: cfg.defaults.useTypeBasedCallGraph,
      dumps: cfg.defaults.dumps,
      timeoutSec: cfg.defaults.timeoutSec,
      memLimitMB: cfg.defaults.memLimitMB,
    })
  })

  describe('status.* read/write round trip', () => {
    let tmp: string

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'kanalyzer-settings-'))
    })

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true })
    })

    it('a doctor() failure patch, written through StatusWriter, reads back out of config()', async () => {
      // A mutable settings store plus the same read()/write() shape `src/index.ts` falls back to
      // when no `dsh-settings` service is mounted (`config = { ...config, status: { ...patch } }`).
      const base = Config()
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
})
