/**
 * A query must not re-run KAMain, and must not re-parse dumps it already parsed.
 *
 * In the recorded session nine `kanalyzer_query` calls cost 72 s. The first spent 17.5 s running
 * KAMain a second time to build an index whose block mapping and call graph the targeted analysis
 * seconds earlier had already written; the other eight each re-read and re-parsed all seven dump
 * files (132k rows in the block mapping alone) from disk.
 *
 * @module @pbfuzz/dsh-kanalyzer/tests/host/query-memo
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunOptions, RunResult } from '../../src/host/exec.ts'
import { KanalyzerRuntime } from '../../src/host/runtime.ts'
import { config, okResult } from './prepare-harness.ts'

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }))

vi.mock('../../src/host/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/host/exec.ts')>()
  return { ...actual, run: runMock }
})

/** A minimal but structurally real dump set: one function, two blocks, one critical branch. */
const DUMPS: Record<string, string> = {
  'bid_loc_mapping.txt': '1001,11,900,/w/aaa.c:10\n1002,12,900,/w/aaa.c:11\n',
  'function_info.txt': '900,target,/w/aaa.c,1,20\n',
  'caller-callee.txt': '900,900\n',
  'callee-caller.txt': '900,900\n',
  'distance.cfg.txt': '1001,11,aaa.c:10,0.000000\n1002,12,aaa.c:11,-1\n##########\nfun:target\n',
  'critical_BBs.txt': '1001,1002\n',
  'policy.txt': '1001,1000.000000,inf,1002,1001\n',
}

const STDERR = 'Total 1 file(s)\nInput Filename : app.0.0.preopt.bc\n=== Target is reachable ===\n'

describe('query(): no second KAMain run, no re-parsing', () => {
  let tmp: string
  let bitcode: string
  let runtime: KanalyzerRuntime
  let kamainRuns: number

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'kanalyzer-query-memo-'))
    const installDir = join(tmp, 'install')
    const llvmPrefix = join(tmp, 'llvm-14')
    mkdirSync(join(llvmPrefix, 'bin'), { recursive: true })
    writeFileSync(join(llvmPrefix, 'bin', 'clang'), '')
    // status() only reports `installed` when the built binary is really there.
    mkdirSync(join(installDir, 'kernel-analyzer', 'build', 'lib'), { recursive: true })
    writeFileSync(join(installDir, 'kernel-analyzer', 'build', 'lib', 'KAMain'), '')
    bitcode = join(tmp, 'app.0.0.preopt.bc')
    writeFileSync(bitcode, 'BC\n')

    kamainRuns = 0
    runMock.mockReset()
    runMock.mockImplementation(async (command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
      if (command === 'git') return okResult({ stdout: 'deadbeef\n' })
      if (command.endsWith('llvm-config')) return okResult({ stdout: '14.0.6\n' })
      if (command.endsWith('KAMain')) {
        kamainRuns++
        // Only the dumps this invocation asked for, as KAMain itself behaves: an index run has no
        // targets and writes no distance/policy/critical dump at all.
        for (const [name, text] of Object.entries(DUMPS)) {
          if (args.some(a => a.endsWith(`=${join(opts.cwd ?? tmp, name)}`))) writeFileSync(join(opts.cwd ?? tmp, name), text)
        }
        return okResult({ stderr: STDERR })
      }
      throw new Error(`unexpected run(): ${command}`)
    })

    runtime = new KanalyzerRuntime(new Context(), {
      config: () => config(installDir, llvmPrefix), writeStatus: async () => {}, packageRoot: tmp,
    })
    const analysis = await runtime.analyze({ bitcode, targets: ['aaa.c:10'] })
    expect(analysis.status).toBe('ok')
    expect(kamainRuns).toBe(1)
  })

  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  const functionAt = async (): Promise<string[]> =>
    (await runtime.query({ op: 'functionAt', bitcode, location: '/w/aaa.c:10' })).results

  it('answers from the targeted analysis instead of running KAMain again', async () => {
    for (let i = 0; i < 5; i++) expect(await functionAt()).toEqual(['target'])
    expect(kamainRuns).toBe(1)
  })

  /** Where the targeted analysis left its dumps. */
  const analysisDir = (): string =>
    (runtime as unknown as { lastAnalysis: Map<string, string> }).lastAnalysis.get(bitcode) ?? ''

  /** A fixed mtime, so "unchanged" means byte-for-byte equal rather than merely close. */
  const PINNED = new Date(1_700_000_000_000)

  /** Rewrite a dump in place at the same length and the same mtime — only a re-read would notice. */
  const rewriteInvisibly = (file: string, from: string, to: string): void => {
    const path = join(analysisDir(), file)
    expect(from.length).toBe(to.length)
    writeFileSync(path, readFileSync(path, 'utf8').replace(from, to))
    utimesSync(path, PINNED, PINNED)
  }

  it('reuses the parsed dump when neither size nor mtime moved', async () => {
    utimesSync(join(analysisDir(), 'function_info.txt'), PINNED, PINNED)
    expect(await functionAt()).toEqual(['target'])
    rewriteInvisibly('function_info.txt', 'target', 'tarxet')
    expect(await functionAt()).toEqual(['target'])
  })

  it('re-reads a dump once its mtime moves', async () => {
    utimesSync(join(analysisDir(), 'function_info.txt'), PINNED, PINNED)
    expect(await functionAt()).toEqual(['target'])
    rewriteInvisibly('function_info.txt', 'target', 'tarxet')
    const when = new Date(Date.now() + 5_000)
    utimesSync(join(analysisDir(), 'function_info.txt'), when, when)
    expect(await functionAt()).toEqual(['tarxet'])
  })

  it('still falls back to an index run when no targeted analysis exists for that bitcode', async () => {
    const other = join(tmp, 'other.0.0.preopt.bc')
    writeFileSync(other, 'BC2\n')
    expect((await runtime.query({ op: 'functionAt', bitcode: other, location: '/w/aaa.c:10' })).results).toEqual(['target'])
    expect(kamainRuns).toBe(2)
  })

  it('builds the block index once across many queries, and again when the mapping changes', async () => {
    const memo = (runtime as unknown as { blockIndexMemo: Map<string, { value: unknown }> }).blockIndexMemo
    for (let i = 0; i < 5; i++) await functionAt()
    const built = memo.get(analysisDir())?.value
    expect(built).toBeDefined()
    // Same object across calls: the two 132k-row Maps are not rebuilt per query.
    for (let i = 0; i < 3; i++) await functionAt()
    expect(memo.get(analysisDir())?.value).toBe(built)
    // …but a changed mapping must not be answered from the stale index.
    const path = join(analysisDir(), 'bid_loc_mapping.txt')
    writeFileSync(path, readFileSync(path, 'utf8') + '1003,13,900,/w/aaa.c:12\n')
    await functionAt()
    expect(memo.get(analysisDir())?.value).not.toBe(built)
  })

  /**
   * A restart is the dangerous case: `lastAnalysis` lives in memory, so a fresh process used to
   * answer every distance query from the *index* run — which has no distance dump at all — and
   * return an empty table that reads exactly like "nothing reaches the target".
   */
  it('finds the targeted analysis again after a restart, instead of answering from the index run', async () => {
    const installDir = join(tmp, 'install')
    const llvmPrefix = join(tmp, 'llvm-14')
    const restarted = new KanalyzerRuntime(new Context(), {
      config: () => config(installDir, llvmPrefix), writeStatus: async () => {}, packageRoot: tmp,
    })
    const r = await restarted.query({ op: 'distances', bitcode })
    expect(r.results).toEqual(['target@/w/aaa.c:10=0.0'])
    expect(r.note).toBeUndefined()
    expect(kamainRuns).toBe(1)
  })

  it('says there is no analysis rather than answering an empty distance table', async () => {
    const other = join(tmp, 'other.0.0.preopt.bc')
    writeFileSync(other, 'BC2\n')
    const r = await runtime.query({ op: 'distances', bitcode: other })
    expect(r.results).toEqual([])
    expect(r.note).toMatch(/No targeted kanalyzer_analyze/)
  })
})
