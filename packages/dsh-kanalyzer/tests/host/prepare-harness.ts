/**
 * Shared scaffolding for the host specs that drive `KanalyzerRuntime` with only the subprocess
 * boundary faked (prepare isolation/reuse/background/failure, query memo, delivery, reachability):
 * `rsync` really copies, the "build" really writes its link output, `extract-bc` really writes
 * bitcode. Everything else — path mapping, the shim install, the memo, the single-flight guard —
 * is the real code under test.
 *
 * @module @pbfuzz/dsh-kanalyzer/tests/host/prepare-harness
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobStart } from '@deepseek-ai/dsh-jobs'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KANALYZER_DIR } from '../../src/core/isolation.ts'
import type { RunOptions, RunResult } from '../../src/host/exec.ts'
import type { Config } from '../../src/host/settings.ts'
import { NM_FUZZ } from '../fixtures.ts'

/** One recorded subprocess invocation. */
export interface RunCall { command: string; args: string[]; opts: RunOptions }

/** A successful `run()` outcome, overridable field by field. */
export function okResult(over: Partial<RunResult> = {}): RunResult {
  return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', elapsedMs: 1, ...over }
}

/** Fully-defaulted settings pointing at a throwaway install dir and LLVM prefix. */
export function config(installDir: string, llvmPrefix: string, over: Partial<Config['defaults']> = {}): Config {
  return {
    install: { installDir, repoUrl: '', branch: 'mzt', llvmPrefix, buildType: 'Release', jobs: 0, wllvmBinDir: '' },
    defaults: {
      verbose: 1, callStackLen: 20, useTypeBasedCallGraph: true, timeoutSec: 1800, memLimitMB: 16384,
      cacheEnabled: false, prepareMode: 'wllvm',
      dumps: { policy: true, distance: true, criticalBranch: true, bidMappingAndFuncInfo: true, callerCalleeBothWays: true, annotatedIr: false },
      ...over,
    },
    standalone: { inputFilenames: [], targetList: [], entryList: [] },
    status: { installed: false, binaryPath: '', commit: '', llvmVersion: '', lastDoctor: '', lastDoctorAt: '', lastDoctorMessage: '', lastWllvm: '', lastWllvmAt: '', lastWllvmMessage: '', wllvmBinDir: '' },
  }
}

/**
 * A throwaway workspace: a checkout with one source file, and an LLVM prefix with a clang in it.
 * @param prefix - temp directory name prefix.
 * @param llvmDir - the LLVM prefix's directory name; a name carrying no version (`llvm`) means no
 *   versioned shim names (`clang-14`) are installed.
 */
export function workspace(prefix = 'kanalyzer-prepare-', llvmDir = 'llvm-14'): { tmp: string; repo: string; llvmPrefix: string; installDir: string } {
  const tmp = mkdtempSync(join(tmpdir(), prefix))
  const repo = join(tmp, 'proj')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'main.c'), 'int main(void) { return 0; }\n')
  writeFileSync(join(repo, 'build.sh'), '#!/bin/sh\nexit 0\n')
  const llvmPrefix = join(tmp, llvmDir)
  mkdirSync(join(llvmPrefix, 'bin'), { recursive: true })
  writeFileSync(join(llvmPrefix, 'bin', 'clang'), '')
  return { tmp, repo, llvmPrefix, installDir: join(tmp, 'install') }
}

/**
 * A `run()` implementation that fakes the four subprocesses a wllvm prepare shells out to.
 * @param calls - every invocation is appended here, in order.
 * @param onBuild - extra work to perform when the build command runs (e.g. fail it).
 * @returns the mock implementation.
 */
export function fakeRun(calls: RunCall[], onBuild?: (opts: RunOptions) => RunResult | undefined) {
  return async (command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ command, args, opts })
    if (command === 'rsync') {
      const from = (args[args.length - 2] ?? '').replace(/\/$/, '')
      const to = (args[args.length - 1] ?? '').replace(/\/$/, '')
      mkdirSync(to, { recursive: true })
      // Entry by entry, skipping `.kanalyzer`: the destination lives inside the source, which
      // `cpSync` refuses wholesale and which the real `--exclude=/.kanalyzer/` is there to handle.
      for (const entry of readdirSync(from)) {
        if (entry === KANALYZER_DIR) continue
        cpSync(join(from, entry), join(to, entry), { recursive: true })
      }
      return okResult()
    }
    if (command === '/bin/sh') {
      const early = onBuild?.(opts)
      if (early !== undefined) return early
      // The "build" produces the link output the caller named, where a real one would.
      writeFileSync(join(opts.cwd ?? '.', 'app'), 'ELF\n')
      return okResult({ stdout: 'built app\n' })
    }
    if (command === 'extract-bc') {
      writeFileSync(args[1] ?? join(opts.cwd ?? '.', 'app.0.0.preopt.bc'), 'BC\n')
      return okResult()
    }
    if (command.endsWith('llvm-nm')) return okResult({ stdout: NM_FUZZ })
    throw new Error(`unexpected run(): ${command} ${args.join(' ')}`)
  }
}

/** Records every `JobStart` and runs it, so a spec can inspect hooks and ids. */
export class RecordingJobs extends Service {
  readonly started: JobStart[] = []
  readonly hooks: ReturnType<JobStart['run']>[] = []

  /** @param ctx - the test's cordis context. */
  constructor(ctx: Context) { super(ctx, 'jobs') }

  /**
   * @param spec - the job registration.
   * @returns the generated id, synchronously, exactly as the real registry does.
   */
  start(spec: JobStart): string {
    this.started.push(spec)
    this.hooks.push(spec.run())
    return `${spec.kind}-${String(this.started.length)}`
  }
}

/** A stand-in agent; `asJob()` only ever forwards it by identity, and reads `id` for the guard. */
export function fakeAgent(id = 'session-test'): Agent {
  return { id } as unknown as Agent
}

/** A cordis context with a recording job registry attached. */
export function contextWithJobs(): { ctx: Context; jobs: RecordingJobs } {
  const ctx = new Context()
  const jobs = new RecordingJobs(ctx)
  return { ctx, jobs }
}
