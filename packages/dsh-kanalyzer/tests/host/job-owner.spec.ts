/**
 * Task 1 — `KanalyzerRuntime.asJob()` (via `prepare()`/`analyze()`) must register the job under
 * the calling tool's session id (`JobSpec.owner`), not unowned, and must abort the job's own work
 * when the caller's signal aborts.
 *
 * `dsh-jobs-local` (the real registry implementation) is not among this package's peer
 * dependencies and does not resolve from here (only `@deepseek-ai/dsh-jobs`, the interface
 * package, does — see `package.json`), so this uses the minimal cordis `Service` double from
 * `prepare-harness.ts`, registered under the `jobs` name the same way `KanalyzerRuntime`'s own
 * constructor discovers a real one (`ctx.inject(['jobs'], …)`). It records exactly what `asJob()`
 * passes to `start()` — real code, real cordis service resolution, only the job registry itself
 * is a double.
 *
 * Only the subprocess boundary (`run()` in `../../src/host/exec.ts`) is separately mocked, so
 * `doPrepare()`'s own logic (and the `AbortSignal` it forwards into `run()`) runs for real.
 */
import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunResult } from '../../src/host/exec.ts'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import { config, contextWithJobs, fakeAgent, okResult, workspace, type RecordingJobs } from './prepare-harness.ts'

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }))

vi.mock('../../src/host/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/exec.ts')>()
  return { ...actual, run: runMock }
})

describe('asJob() owner + signal (Task 1)', () => {
  let ws: ReturnType<typeof workspace>
  let jobs: RecordingJobs
  let runtime: KanalyzerRuntime

  beforeEach(() => {
    ws = workspace('kanalyzer-job-owner-')
    runMock.mockReset()
    const built = contextWithJobs()
    jobs = built.jobs
    runtime = new KanalyzerRuntime(built.ctx, {
      config: () => config(ws.installDir, ws.llvmPrefix), writeStatus: async () => {}, packageRoot: ws.tmp,
    })
  })

  afterEach(() => {
    rmSync(ws.tmp, { recursive: true, force: true })
  })

  it('registers the job under the caller\'s session id (DSH >= 0.2 JobSpec.owner) when one is threaded through', async () => {
    runMock.mockImplementation(async (): Promise<RunResult> => okResult({ stdout: 'nothing built\n' }))
    const agent = fakeAgent()

    // No bitcode is produced (build "succeeds" but writes nothing) — doPrepare() rejects; only
    // the job's registration (recorded before the work settles) matters to this assertion.
    await runtime.prepare({ repo: ws.repo, buildCmd: 'true', mode: 'lto' }, { agent, signal: new AbortController().signal }).catch(() => {})

    expect(jobs.started).toHaveLength(1)
    expect(jobs.started[0]).toMatchObject({ kind: 'kanalyzer', owner: agent.id })
  })

  it('registers an unowned job (no `owner` key at all) when no caller is threaded through', async () => {
    runMock.mockImplementation(async (): Promise<RunResult> => okResult({ stdout: 'nothing built\n' }))

    await runtime.prepare({ repo: ws.repo, buildCmd: 'true', mode: 'lto' }).catch(() => {})

    expect(jobs.started).toHaveLength(1)
    expect(jobs.started[0]?.kind).toBe('kanalyzer')
    expect('owner' in (jobs.started[0] ?? {})).toBe(false)
  })

  it('aborts the job\'s own work when the caller\'s signal is already aborted', async () => {
    let capturedSignal: AbortSignal | undefined
    runMock.mockImplementation(async (_cmd: string, _args: string[], opts: { signal?: AbortSignal }): Promise<RunResult> => {
      capturedSignal = opts.signal
      return okResult()
    })
    const ac = new AbortController()
    ac.abort('caller cancelled')

    // doPrepare() checks `signal.aborted` right after the build call and throws — a pre-aborted
    // caller signal should reach the internal AbortController before `run()` is ever invoked.
    await expect(runtime.prepare({ repo: ws.repo, buildCmd: 'true', mode: 'lto' }, { signal: ac.signal })).rejects.toThrow(/cancelled/)
    expect(capturedSignal?.aborted).toBe(true)
  })

  // This host runs the whole suite's async work under heavy parallel contention (many vitest
  // workers, plus other concurrent sessions); the default 5s timeout is occasionally too tight
  // for the real fs work (mkdir/writeFile/chmod/symlink for the shim, mkdir+rsync-mock for the
  // isolated tree) doPrepare() now does before it reaches the mocked build call this test waits
  // on. Confirmed non-flaky in isolation; only the full-suite contention makes it slow.
  it('aborts the job\'s own work when the caller\'s signal aborts mid-flight', async () => {
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

    const pending = runtime.prepare({ repo: ws.repo, buildCmd: 'true', mode: 'lto' }, { signal: ac.signal })
    // Let doPrepare() reach and call the mocked run() before we cancel.
    await vi.waitFor(() => expect(capturedSignal).toBeDefined())
    expect(capturedSignal?.aborted).toBe(false)

    ac.abort('caller cancelled mid-flight')
    expect(capturedSignal?.aborted).toBe(true) // asJob()'s internal AbortController mirrors it synchronously

    resolveBuild?.(okResult())
    await expect(pending).rejects.toThrow(/cancelled/)
  }, 60_000)
})
