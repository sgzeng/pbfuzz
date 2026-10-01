/**
 * A long prepare must stop blocking the agent that started it.
 *
 * The recorded session's single `kanalyzer_prepare` call held the turn for 24.6 minutes and the
 * job it registered had no `readOutput`, so `job_output` returned nothing at all — the agent and
 * the user were equally blind. These tests pin the three parts of the fix: the job id is
 * available before the build finishes, the job streams progress and ends with the typed result,
 * and a second prepare against the same tree joins or is refused rather than racing.
 *
 * @module @pbfuzz/dsh-kanalyzer/tests/host/prepare-background
 */
import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOptions, RunResult } from '../../src/host/exec.ts'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import {
  config, contextWithJobs, fakeAgent, fakeRun, okResult, workspace, type RecordingJobs, type RunCall,
} from './prepare-harness.ts'

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }))

vi.mock('../../src/host/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/exec.ts')>()
  return { ...actual, run: runMock }
})

describe('prepareJob(): a build you can watch and leave running', () => {
  let ws: ReturnType<typeof workspace>
  let calls: RunCall[]
  let jobs: RecordingJobs
  let runtime: KanalyzerRuntime

  beforeEach(() => {
    ws = workspace('kanalyzer-bg-')
    calls = []
    runMock.mockReset()
    runMock.mockImplementation(fakeRun(calls))
    const built = contextWithJobs()
    jobs = built.jobs
    runtime = new KanalyzerRuntime(built.ctx, {
      config: () => config(ws.installDir, ws.llvmPrefix), writeStatus: async () => {}, packageRoot: ws.tmp,
    })
  })

  afterEach(() => { rmSync(ws.tmp, { recursive: true, force: true }) })

  const request = () => ({ repo: ws.repo, buildCmd: 'bash build.sh', mode: 'wllvm' as const, program: 'app' })

  it('hands back the job id before the build has finished', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    runMock.mockImplementation(async (command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
      if (command === '/bin/sh') { await held; return okResult() }
      return fakeRun(calls)(command, args, opts)
    })

    const started = runtime.prepareJob(request(), { agent: fakeAgent() })
    expect(started.jobId).toBe('kanalyzer-1')
    expect(started.tree).toContain('.kanalyzer/tree')
    let settled = false
    void started.result.then(() => { settled = true }, () => { settled = true })
    await new Promise(r => setTimeout(r, 10))
    expect(settled).toBe(false)

    release()
    await expect(started.result).rejects.toThrow() // the held build produced no link output
  })

  it('registers a readable, bounded job that ends with the typed result', async () => {
    const started = runtime.prepareJob(request(), { agent: fakeAgent() })
    const result = await started.result
    const spec = jobs.started[0]
    expect(spec?.kind).toBe('kanalyzer')
    expect(spec?.outputLimitBytes).toBe(16 * 1024)
    const readOutput = jobs.hooks[0]?.readOutput
    expect(readOutput).toBeTypeOf('function')
    const text = readOutput?.() ?? ''
    expect(text).toMatch(/^building: \d+ compiled, \d+ linked, \d+s elapsed/)
    // The completion delta is how a detached caller gets the bitcode path back through job_output.
    expect(text).toContain('RESULT ')
    const json = JSON.parse(text.slice(text.indexOf('RESULT ') + 'RESULT '.length).split('\n')[0] ?? '{}') as { bitcode?: string; jobId?: string }
    expect(json.bitcode).toBe(result.bitcode)
    expect(json.jobId).toBe('kanalyzer-1')
    expect(readOutput?.()).not.toContain('RESULT ') // deltas, not a replay
  })

  it('reports a failure through the same channel', async () => {
    runMock.mockImplementation(fakeRun(calls, () => okResult({ exitCode: 1, stderr: 'boom\n' })))
    const started = runtime.prepareJob(request(), { agent: fakeAgent() })
    await expect(started.result).rejects.toThrow(/exit 1/)
    expect(jobs.hooks[0]?.readOutput?.()).toContain('ERROR ')
  })

  it('joins an identical prepare already running for the same agent instead of building twice', async () => {
    const agent = fakeAgent()
    const first = runtime.prepareJob(request(), { agent })
    const second = runtime.prepareJob(request(), { agent })
    expect(second.jobId).toBe(first.jobId)
    expect(await second.result).toEqual(await first.result)
    expect(jobs.started).toHaveLength(1)
    expect(calls.filter(c => c.command === '/bin/sh')).toHaveLength(1)
  })

  it('refuses a different prepare against a tree that is already building, naming the job', async () => {
    const agent = fakeAgent()
    const first = runtime.prepareJob(request(), { agent })
    expect(() => runtime.prepareJob({ ...request(), buildCmd: 'bash other.sh' }, { agent })).toThrow(/already running/)
    expect(() => runtime.prepareJob({ ...request(), buildCmd: 'bash other.sh' }, { agent })).toThrow(/kanalyzer-1/)
    await first.result
  })

  it('refuses to hand one session another session\'s job', async () => {
    // `dsh-jobs` fences job access by owner session, so sharing the id would give the second
    // agent a job it cannot read or kill.
    const first = runtime.prepareJob(request(), { agent: fakeAgent('session-a') })
    expect(() => runtime.prepareJob(request(), { agent: fakeAgent('session-b') })).toThrow(/already running/)
    await first.result
  })

  it('frees the guard once the build settles, so the next prepare is free to run', async () => {
    const agent = fakeAgent()
    await runtime.prepareJob(request(), { agent }).result
    const again = runtime.prepareJob({ ...request(), buildCmd: 'bash build.sh --again' }, { agent })
    expect(again.jobId).toBe('kanalyzer-2')
    await again.result
  })
})
