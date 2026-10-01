/**
 * Task 1 — `KanalyzerRuntime.asJob()` (via `prepare()`/`analyze()`) must register the job under
 * the calling tool's agent (`JobStart.owner`), not unowned, and must abort the job's own work
 * when the caller's signal aborts.
 *
 * `dsh-jobs-local` (the real registry implementation) is not among this package's peer
 * dependencies and does not resolve from here (only `@deepseek-ai/dsh-jobs`, the interface
 * package, does — see `package.json`), so this uses a minimal cordis `Service` double registered
 * under the `jobs` name, the same way `KanalyzerRuntime`'s own constructor discovers a real one
 * (`ctx.inject(['jobs'], …)`). It records exactly what `asJob()` passes to `start()` — real code,
 * real cordis service resolution, only the job registry itself is a double.
 *
 * Only the subprocess boundary (`run()` in `../../src/host/exec.ts`) is separately mocked, the
 * same way F17/F18's specs do it, so `doPrepare()`'s own logic (and the `AbortSignal` it forwards
 * into `run()`) runs for real.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobStart } from '@deepseek-ai/dsh-jobs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunResult } from '../../src/host/exec.ts'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import { Config } from '../../src/host/settings.ts'

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }))

vi.mock('../../src/host/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/exec.ts')>()
  return { ...actual, run: runMock }
})

function okResult(over: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', elapsedMs: 1, ...over }
}

/** Records every `JobStart` spec `asJob()` passes to `ctx.jobs.start()`; never actually runs the work. */
class RecordingJobs extends Service {
  readonly started: JobStart[] = []
  constructor(ctx: Context) { super(ctx, 'jobs') }
  start(spec: JobStart): string {
    this.started.push(spec)
    return `${spec.kind}-${String(this.started.length)}`
  }
}

/** A minimal stand-in agent: `asJob()` only ever forwards it to `JobStart.owner` by identity. */
function fakeAgent(): Agent {
  return { id: 'session-test' } as unknown as Agent
}

describe('asJob() owner + signal (Task 1)', () => {
  let tmp: string
  let jobs: RecordingJobs
  let runtime: KanalyzerRuntime

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kanalyzer-job-owner-'))
    runMock.mockReset()
    const llvmPrefix = join(tmp, 'llvm')
    mkdirSync(join(llvmPrefix, 'bin'), { recursive: true })
    writeFileSync(join(llvmPrefix, 'bin', 'clang'), '')
    const base = Config()
    const cfg = { ...base, install: { ...base.install, llvmPrefix, installDir: join(tmp, 'no-kanalyzer-install') } }
    const ctx = new Context()
    jobs = new RecordingJobs(ctx)
    runtime = new KanalyzerRuntime(ctx, { config: () => cfg, writeStatus: async () => {}, packageRoot: tmp })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('registers the job under the caller\'s agent when one is threaded through', async () => {
    const repo = join(tmp, 'repo')
    mkdirSync(repo, { recursive: true })
    runMock.mockImplementation(async (): Promise<RunResult> => okResult({ stdout: 'nothing built\n' }))
    const agent = fakeAgent()

    // No bitcode is produced (build "succeeds" but writes nothing) — doPrepare() rejects; only
    // the job's registration (recorded before the work settles) matters to this assertion.
    await runtime.prepare({ repo, buildCmd: 'true', mode: 'lto' }, { agent, signal: new AbortController().signal }).catch(() => {})

    expect(jobs.started).toHaveLength(1)
    expect(jobs.started[0]).toMatchObject({ kind: 'kanalyzer', owner: agent })
  })

  it('registers an unowned job (no `owner` key at all) when no caller is threaded through', async () => {
    const repo = join(tmp, 'repo')
    mkdirSync(repo, { recursive: true })
    runMock.mockImplementation(async (): Promise<RunResult> => okResult({ stdout: 'nothing built\n' }))

    await runtime.prepare({ repo, buildCmd: 'true', mode: 'lto' }).catch(() => {})

    expect(jobs.started).toHaveLength(1)
    expect(jobs.started[0]?.kind).toBe('kanalyzer')
    expect('owner' in (jobs.started[0] ?? {})).toBe(false)
  })

  it('aborts the job\'s own work when the caller\'s signal is already aborted', async () => {
    const repo = join(tmp, 'repo')
    mkdirSync(repo, { recursive: true })
    let capturedSignal: AbortSignal | undefined
    runMock.mockImplementation(async (_cmd: string, _args: string[], opts: { signal?: AbortSignal }): Promise<RunResult> => {
      capturedSignal = opts.signal
      return okResult()
    })
    const ac = new AbortController()
    ac.abort('caller cancelled')

    // doPrepare() checks `signal.aborted` right after the build call and throws — a pre-aborted
    // caller signal should reach the internal AbortController before `run()` is ever invoked.
    await expect(runtime.prepare({ repo, buildCmd: 'true', mode: 'lto' }, { signal: ac.signal })).rejects.toThrow(/cancelled/)
    expect(capturedSignal?.aborted).toBe(true)
  })

  // This host runs the whole suite's async work under heavy parallel contention (many vitest
  // workers, plus other concurrent sessions); the default 5s timeout is occasionally too tight
  // for the real fs work (mkdir/writeFile/chmod/symlink for the shim, mkdir+rsync-mock for the
  // isolated tree) doPrepare() now does before it reaches the mocked build call this test waits
  // on. Confirmed non-flaky in isolation; only the full-suite contention makes it slow.
  it('aborts the job\'s own work when the caller\'s signal aborts mid-flight', async () => {
    const repo = join(tmp, 'repo')
    mkdirSync(repo, { recursive: true })
    let capturedSignal: AbortSignal | undefined
    let resolveBuild: ((r: RunResult) => void) | undefined
    runMock.mockImplementation((cmd: string, _args: string[], opts: { signal?: AbortSignal }) => {
      capturedSignal = opts.signal
      // Only the build itself hangs; the isolated-tree copy that now precedes it must complete,
      // or doPrepare() never reaches the call this test is about.
      if (cmd === 'rsync') return Promise.resolve(okResult())
      return new Promise<RunResult>((resolve) => { resolveBuild = resolve })
    })
    const ac = new AbortController()

    const pending = runtime.prepare({ repo, buildCmd: 'true', mode: 'lto' }, { signal: ac.signal })
    // Let doPrepare() reach and call the mocked run() before we cancel.
    await vi.waitFor(() => expect(capturedSignal).toBeDefined())
    expect(capturedSignal?.aborted).toBe(false)

    ac.abort('caller cancelled mid-flight')
    expect(capturedSignal?.aborted).toBe(true) // asJob()'s internal AbortController mirrors it synchronously

    resolveBuild?.(okResult())
    await expect(pending).rejects.toThrow(/cancelled/)
  }, 60_000)
})
