/**
 * `ctx.kanalyzer` — the Service implementing `contracts/kanalyzer-api.ts`.
 *
 * Linux x86-64 only. Everything decisive (status derivation, parsing, remapping, cache keys)
 * lives in `../core` and is unit-tested; this file is the I/O around it.
 *
 * @module @pbfuzz/dsh-kanalyzer/host/runtime
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { access, chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { cpus, homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type {
  AnalyzeRequest, AnalyzeResult, DumpFiles, DumpKind, DumpSelection, KanalyzerDoctor, KanalyzerService, KanalyzerStatus,
  PrebuiltImportRequest, PrebuiltImportResult, PrebuiltImporter, PreparedBitcode, PrepareRequest, PrepareResult,
  QueryRequest, QueryResult,
} from '../api.ts'
import { cacheKey } from '../core/cache.ts'
import {
  parseBidMapping, parseCriticalBranches, parseDistance, parseFuncInfo, parseGuidEdges, parsePolicy,
  type BidMappingRow, type FuncInfoRow,
} from '../core/dumps.ts'
import {
  candidateLlvmPrefixes, expandHome, llvmPrefixFromCMakeCache, looksLikeLtoArchive,
} from '../core/install.ts'
import {
  intoTree, isolationFor, KANALYZER_DIR, prepareIdentityKey, rewriteBuildCmd, type Isolation,
} from '../core/isolation.ts'
import { buildArgs, DUMP_FILES, resolveOptions, selectedDumpFiles, type ResolvedOptions } from '../core/options.ts'
import { basename, RepoIndex, targetListEntry } from '../core/paths.ts'
import { missingRequiredDumps, resolveDumpFiles } from '../core/prebuilt.ts'
import {
  inferEntries, ltoBuildCmdProblem, ltoEnv, PREOPT_SUFFIX, selectBitcode, toolchainAt, wllvmEnv, type Toolchain,
} from '../core/prepare.ts'
import { runQuery } from '../core/query.ts'
import { renderShimScript, shimNames, type FlagProfile, type ShimParams } from '../core/shim.ts'
import { analyzeFromDumps } from '../core/result.ts'
import { parseStderr } from '../core/stderr.ts'
import { blockIndex, heuristicInstructionLines, type BlockIndex } from '../core/status.ts'
import { kamainStderrFilter, run } from './exec.ts'
import { optionDefaults, type Config, type StatusWriter } from './settings.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    kanalyzer: KanalyzerRuntime
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    kanalyzer: 'kanalyzer'
  }
}

/** Construction options handed over by the plugin entry. */
export interface RuntimeOptions {
  /** Current resolved settings (settings layer when mounted, else the entry config). */
  config: () => Config
  writeStatus: StatusWriter
  /** Package root, for `selftest/`. */
  packageRoot: string
}

/** One `importPrebuilt()` registration: where the dumps are, and the name each kind resolved to. */
interface ImportedDumps {
  dir: string
  files: DumpFiles
}

/**
 * Identity threaded from a model-facing tool call into {@link KanalyzerRuntime.asJob}, so a
 * long-running kanalyzer job registers as that call's, not as an anonymous one: whose agent owns
 * it (session-scoped visibility, cleaned up on that agent's disposal, killable from the job UI),
 * and whose cancellation should also abort the job's own internal work.
 */
export interface JobCaller {
  /** Registers the job under this agent. Omitted registers an unowned job, open to any caller. */
  agent?: Agent
  /** Aborts the job's internal `AbortController` when the initiating tool call itself is cancelled. */
  signal?: AbortSignal
}

/**
 * Caller choices that deliberately stay out of the frozen `PrepareRequest`
 * (`contracts/kanalyzer-api.ts`), so adding them regenerates nothing and every existing consumer
 * keeps its exact behaviour.
 */
export interface PrepareOptions {
  /**
   * Build in an isolated copy of the checkout with sanitizers stripped and `-O0 -g -fPIC`
   * forced (the default), instead of the caller's own tree with the project's own flags.
   */
  isolate?: boolean
  /** Ignore the source-freshness memo (and wipe the isolated tree) and rebuild from scratch. */
  force?: boolean
}

/** One prepare that is already running against a repo, for the single-flight guard. */
interface InFlightPrepare {
  /** The owning agent's id; a different owner may not join another session's job. */
  owner: string
  /** {@link prepareIdentityKey} of the request, so only an identical repeat dedupes. */
  identity: string
  jobId?: JobId
  promise: Promise<PreparedBitcode>
}

const SOURCE_EXT = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inc)$/
// `.kanalyzer` holds this plugin's own isolated build tree; walking into it would index the copy
// alongside the original and make every prepare memo look stale the moment it built anything.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg', KANALYZER_DIR])

/** Files that are not source but still decide what a build produces, for the prepare memo. */
const BUILD_FILE = /(^|\/)(Makefile|makefile|GNUmakefile|CMakeLists\.txt|meson\.build|configure|configure\.ac|Makefile\.am|[^/]+\.(mk|sh|cmake|proto))$/

/** Bytes of job output the model may see per read; `dsh-tool-jobs` truncates to this. */
const JOB_OUTPUT_LIMIT = 16 * 1024

/** Walk a tree, yielding files; bounded so a huge repo cannot stall a call. */
async function walk(root: string, accept: (rel: string) => boolean, limit = 200_000): Promise<string[]> {
  const out: string[] = []
  const stack = ['']
  while (stack.length > 0 && out.length < limit) {
    const rel = stack.pop() ?? ''
    let entries
    try { entries = await readdir(join(root, rel), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(r) } else if (e.isFile() && accept(r)) out.push(r)
    }
  }
  return out.sort()
}

async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest('hex')
}

async function readIfExists(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch { return undefined }
}

/**
 * Whether any source or build file under `root` changed since `since`.
 *
 * The prepare memo's staleness test. Short-circuits on the first newer file and skips
 * {@link SKIP_DIRS}, so the isolated tree's own build output can never invalidate the memo that
 * produced it. Blind spots are real and documented in the skill: a removed file does not make
 * anything newer, and a flag change that touches no file at all is invisible — `force: true` is
 * the answer to both.
 * @param root - the project checkout.
 * @param since - epoch ms of the previous successful prepare.
 * @param limit - bound on files examined, so a pathological tree cannot stall a call.
 * @returns true when the previous bitcode may be out of date.
 */
async function anyFileNewer(root: string, since: number, limit = 200_000): Promise<boolean> {
  let seen = 0
  const stack = ['']
  while (stack.length > 0 && seen < limit) {
    const rel = stack.pop() ?? ''
    let entries
    try { entries = await readdir(join(root, rel), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(r); continue }
      if (!e.isFile() || !(SOURCE_EXT.test(r) || BUILD_FILE.test(r))) continue
      seen++
      const st = await stat(join(root, r)).catch(() => undefined)
      if (st !== undefined && st.mtimeMs > since) return true
    }
  }
  return false
}

/**
 * The live view of a running prepare: what the job's `readOutput()` hands the model.
 *
 * A real session blocked an agent for 24.6 minutes on one `kanalyzer_prepare` call that
 * registered a job with no `readOutput` at all, so `job_output` had nothing to return and
 * neither the agent nor the user could tell a slow build from a hung one. Each read is a delta:
 * a progress summary counted from the shim's append-only log, whatever build output arrived
 * since the last read, and — once — the final `RESULT {json}` or `ERROR …` line, which is how a
 * detached caller gets the typed result back through `job_output`.
 */
class PrepareProgress {
  private offset = 0
  private compiles = 0
  private links = 0
  private last = ''
  private tail = ''
  private final: string | undefined
  private sent = false
  private readonly startedAt = Date.now()

  /** @param progressFile - the file the compiler shim appends one line per invocation to. */
  constructor(private readonly progressFile: string) {}

  /** Buffer raw build output; only a bounded tail survives until the next read drains it. */
  onOutput(chunk: string): void { this.tail = `${this.tail}${chunk}`.slice(-2000) }

  /** Record the line the final delta ends with (the typed result, or the failure). */
  finish(text: string): void { this.final = text }

  /** @returns everything that happened since the previous call. */
  read(): string {
    let fresh = ''
    try {
      const text = readFileSync(this.progressFile, 'utf8')
      if (text.length > this.offset) { fresh = text.slice(this.offset); this.offset = text.length }
    } catch { /* the build has not started writing yet */ }
    for (const line of fresh.split('\n')) {
      const parts = line.split(' ')
      if (parts[1] === 'compile') { this.compiles++; this.last = parts.slice(2).join(' ') }
      else if (parts[1] === 'link') { this.links++; this.last = parts.slice(2).join(' ') }
    }
    const elapsed = Math.round((Date.now() - this.startedAt) / 1000)
    const out = [`building: ${String(this.compiles)} compiled, ${String(this.links)} linked, ${String(elapsed)}s elapsed${this.last === '' ? '' : ` — last: ${this.last}`}`]
    if (this.tail !== '') { out.push(this.tail.trimEnd()); this.tail = '' }
    if (this.final !== undefined && !this.sent) { this.sent = true; out.push(this.final) }
    return `${out.join('\n')}\n`
  }
}

/** A growing log file exposed as `readOutput()` deltas, for the analyze job's KAMain stderr. */
class FileTail {
  private path: string | undefined
  private offset = 0

  /** Point the tail at the file once the caller knows which one it is. */
  setPath(path: string): void { this.path = path; this.offset = 0 }

  /** @returns the bytes appended since the previous call. */
  read(): string {
    if (this.path === undefined) return ''
    try {
      const text = readFileSync(this.path, 'utf8')
      if (text.length <= this.offset) return ''
      const delta = text.slice(this.offset)
      this.offset = text.length
      return delta
    } catch { return '' }
  }
}

/**
 * The selected dump files that are really present in a run directory, in the plugin's canonical
 * names — what `AnalyzeResult.dumpFiles` reports, and so what the caller can read in `outputDir`.
 * @param dir - the run's output directory.
 * @param dumps - the run's resolved dump selection.
 * @returns the existing dump file names, in dump-selection order.
 */
function dumpFilesIn(dir: string, dumps: Required<DumpSelection>): string[] {
  return selectedDumpFiles(dumps).filter(f => existsSync(join(dir, f)))
}

/**
 * Whether a run directory already holds everything an index run would have produced — the block
 * mapping, the function info and the call graph both ways.
 * @param dir - a completed run's output directory.
 * @returns true when `query()` can read it instead of invoking KAMain again.
 */
function hasIndexDumps(dir: string): boolean {
  return [DUMP_FILES.bidMapping, DUMP_FILES.funcInfo, DUMP_FILES.callerCallee, DUMP_FILES.calleeCaller]
    .every(f => existsSync(join(dir, f)))
}

/** The `ctx.kanalyzer` service. */
export class KanalyzerRuntime extends Service implements KanalyzerService, PrebuiltImporter {
  private jobs: JobRegistry | undefined
  /**
   * bitcode or imported handle → the checkout it came from, plus any mirror roots (the isolated
   * analysis tree), recorded by prepare()/importPrebuilt() for repo-path remapping. KAMain writes
   * absolute paths from wherever the build ran, so the copy's paths must resolve back to the
   * user's own checkout.
   */
  private readonly prepared = new Map<string, { repo: string; aliases: string[] }>()
  /** Repo root (+ aliases) → its index, so a query does not re-walk the tree every call. */
  private readonly repoIndexMemo = new Map<string, RepoIndex>()
  /** Absolute file path → its parsed dump, keyed on size+mtime. */
  private readonly parseMemo = new Map<string, { size: number; mtimeMs: number; value: unknown }>()
  /** Absolute file path → its sha256, keyed on size+mtime. */
  private readonly digestMemo = new Map<string, { size: number; mtimeMs: number; digest: string }>()
  /** Repo root → the prepare already running against it. */
  private readonly inFlight = new Map<string, InFlightPrepare>()
  /** bitcode → output dir of its latest targeted analysis, for `critical` queries. */
  private readonly lastAnalysis = new Map<string, string>()
  /** Block index (bid → location/function), keyed on the two dumps it is built from. */
  private readonly blockIndexMemo = new Map<string, { stamp: string; value: BlockIndex }>()
  /** Bitcode path → the sanitizer symbol found in it (undefined = none), keyed on size and mtime. */
  private readonly sanitizerMemo = new Map<string, { size: number; mtimeMs: number; marker: string | undefined }>()
  /** Imported prebuilt dump directories, by handle. Queried without ever invoking KAMain. */
  private readonly imported = new Map<string, ImportedDumps>()

  /**
   * @param ctx - plugin context.
   * @param options - settings source, status writer, package root.
   */
  constructor(ctx: Context, private readonly options: RuntimeOptions) {
    super(ctx, 'kanalyzer')
    // Jobs are optional: without a job registry every long operation still runs, inline.
    ctx.inject(['jobs'], (jctx) => {
      this.jobs = jctx.jobs
      jctx.effect(() => () => { this.jobs = undefined })
    })
  }

  private get installDir(): string { return expandHome(this.options.config().install.installDir, homedir()) }
  private get checkout(): string { return join(this.installDir, 'kernel-analyzer') }
  private get binary(): string { return join(this.checkout, 'build', 'lib', 'KAMain') }

  /** Resolve the LLVM prefix KAMain was built against (CMakeCache), else the configured/auto-detected one. */
  private async llvmPrefix(): Promise<string | undefined> {
    const cache = await readIfExists(join(this.checkout, 'build', 'CMakeCache.txt'))
    const fromCache = cache !== undefined ? llvmPrefixFromCMakeCache(cache) : undefined
    const cands = [...(fromCache ? [fromCache] : []), ...candidateLlvmPrefixes(this.options.config().install.llvmPrefix)]
    for (const p of cands) if (existsSync(join(p, 'bin', 'clang'))) return p
    return undefined
  }

  private async toolchain(): Promise<Toolchain> {
    const prefix = await this.llvmPrefix()
    if (prefix === undefined) throw new Error('No LLVM 10–16 toolchain found (looked at kanalyzer.install.llvmPrefix and /usr/lib/llvm-{14,15,16,13,12,11,10}). Run /kanalyzer build.')
    return toolchainAt(prefix)
  }

  /**
   * Run `work` as a DSH job when a job registry with a controller is available, else inline.
   * The returned promise always carries the real result — this call itself stays foreground
   * (awaited synchronously by the tool that invoked it), the job registration only makes the
   * work owned, visible and independently killable while it runs.
   * @param caller - the initiating tool call's agent/signal, when there is one; see {@link JobCaller}.
   */
  private asJob<T>(
    label: string, work: (signal: AbortSignal) => Promise<T>, caller?: JobCaller,
    hooks?: { readOutput?: () => string; outputLimitBytes?: number; onStarted?: (id: JobId) => void },
  ): Promise<T> {
    const ac = new AbortController()
    const callerSignal = caller?.signal
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) ac.abort(callerSignal.reason)
      else callerSignal.addEventListener('abort', () => { ac.abort(callerSignal.reason) }, { once: true })
    }
    let started: Promise<T> | undefined
    const begin = (): Promise<T> => (started ??= work(ac.signal))
    if (this.jobs !== undefined) {
      try {
        // `start()` runs the producer synchronously and returns the id synchronously, so a caller
        // that wants to hand the id back before the work finishes gets it here.
        const id = this.jobs.start({
          kind: 'kanalyzer',
          label,
          ...(caller?.agent !== undefined ? { owner: caller.agent } : {}),
          ...(hooks?.outputLimitBytes !== undefined ? { outputLimitBytes: hooks.outputLimitBytes } : {}),
          run: () => {
            const p = begin()
            return {
              cancel: (reason?: string) => { ac.abort(reason) },
              done: p.then(
                () => ({ status: 'completed' as const }),
                (e: unknown) => ({ status: ac.signal.aborted ? 'killed' as const : 'failed' as const, detail: e instanceof Error ? e.message : String(e) }),
              ),
              ...(hooks?.readOutput !== undefined ? { readOutput: hooks.readOutput } : {}),
            }
          },
        })
        hooks?.onStarted?.(id)
      } catch {
        // No controller serves this job's owner in this composition: run inline.
      }
    }
    return begin()
  }

  /** @inheritdoc */
  async status(): Promise<KanalyzerStatus> {
    try { await access(this.binary) } catch { return { installed: false } }
    const git = await run('git', ['-C', this.checkout, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })
    const prefix = await this.llvmPrefix()
    const ver = prefix !== undefined ? await run(join(prefix, 'bin', 'llvm-config'), ['--version'], { timeoutMs: 10_000 }) : undefined
    return {
      installed: true,
      binaryPath: this.binary,
      ...(git.exitCode === 0 ? { commit: git.stdout.trim() } : {}),
      ...(ver?.exitCode === 0 ? { llvmVersion: ver.stdout.trim() } : {}),
    }
  }

  /** @inheritdoc */
  async doctor(): Promise<KanalyzerDoctor> {
    const evidence: string[] = []
    const status = await this.status()
    // The wllvm leg's own verdict, recorded separately so the settings card can offer its Install
    // button against exactly this check rather than parsing a prose message. `undefined` until the
    // leg runs at all (an early failure below never gets that far).
    let wllvm: { ok: boolean; message: string; binDir?: string } | undefined
    const finish = async (ok: boolean, reason?: string): Promise<KanalyzerDoctor> => {
      await this.options.writeStatus({
        installed: status.installed,
        binaryPath: status.binaryPath ?? '',
        commit: status.commit ?? '',
        llvmVersion: status.llvmVersion ?? '',
        lastDoctor: ok ? 'pass' : 'fail',
        lastDoctorAt: new Date().toISOString(),
        lastDoctorMessage: ok ? evidence.join(' | ').slice(0, 2000) : (reason ?? 'failed'),
        ...wllvm === undefined ? {} : {
          lastWllvm: wllvm.ok ? 'pass' as const : 'fail' as const,
          lastWllvmAt: new Date().toISOString(),
          lastWllvmMessage: wllvm.message.slice(0, 2000),
        },
        // Discovering where wllvm actually lives is the point of the leg: `pip install --user` and
        // virtualenvs both put it somewhere the build subprocess does not necessarily see. Recorded
        // in `status` (host-written) — `install.wllvmBinDir` stays the user's own override.
        ...wllvm?.binDir === undefined ? {} : { wllvmBinDir: wllvm.binDir },
      }).catch(() => { /* a read-only settings provider must not turn a doctor result into a throw */ })
      return ok ? { ok, status, evidence } : { ok, status, evidence, reason }
    }
    if (!status.installed) return finish(false, `KAMain not found at ${this.binary}. Press Build in the kanalyzer settings or run /kanalyzer build.`)
    evidence.push(`binary ${status.binaryPath ?? ''} commit ${status.commit ?? '?'} llvm ${status.llvmVersion ?? '?'}`)
    const expectPath = join(this.options.packageRoot, 'selftest', 'expect.json')
    const exp = JSON.parse(await readFile(expectPath, 'utf8')) as {
      source: string; program: string; target: string; targetFunction: string; commentLine: string; entry: string
      edge: { caller: string; callee: string }; criticalFunction: string
    }
    let tc: Toolchain
    try { tc = await this.toolchain() } catch (e) { return finish(false, (e as Error).message) }
    const dir = await mkdtemp(join(tmpdir(), 'kanalyzer-doctor-'))
    try {
      await copyFile(join(this.options.packageRoot, 'selftest', exp.source), join(dir, exp.source))
      const cc = await run(tc.cc, ['-O0', '-g', '-fPIC', '-flto', '-fuse-ld=lld', '-Wl,-plugin-opt=save-temps', exp.source, '-o', exp.program], { cwd: dir, timeoutMs: 120_000 })
      const bc = join(dir, `${exp.program}${PREOPT_SUFFIX}`)
      if (!existsSync(bc)) return finish(false, `LTO compile of the sample did not produce ${basename(bc)} (exit ${String(cc.exitCode)}): ${cc.stderr.slice(-800)}`)
      evidence.push(`compiled selftest with ${tc.cc} -flto → ${basename(bc)}`)
      this.prepared.set(bc, { repo: dir, aliases: [] })

      const good = await this.analyze({ bitcode: bc, targets: [exp.target], entries: [exp.entry], force: true, timeoutSec: 300 })
      evidence.push(`analyze ${exp.target}: status=${good.status} targets=${String(good.targets.length)} critical=${String(good.criticalBranches.length)} reachableFns=${String(good.reachableFunctions)}/${String(good.totalFunctions)}`)
      if (good.status !== 'ok') return finish(false, `self-test analysis returned ${good.status}: ${good.reason ?? ''}`)
      const t = good.targets.find(x => x.function === exp.targetFunction && x.distance === 0)
      if (!t) return finish(false, `target did not resolve to ${exp.targetFunction} at distance 0: ${JSON.stringify(good.targets)}`)
      if (good.criticalBranches.length === 0) return finish(false, 'critical branch list is empty; the exit branch in foo should be critical')
      if (!good.criticalBranches.some(c => c.function === exp.criticalFunction)) evidence.push(`note: no critical branch attributed to ${exp.criticalFunction}`)
      const callers = await this.query({ op: 'callers', bitcode: bc, fn: exp.edge.callee })
      evidence.push(`callers(${exp.edge.callee}) = [${callers.results.join(', ')}]`)
      if (!callers.results.includes(exp.edge.caller)) return finish(false, `call edge ${exp.edge.caller}→${exp.edge.callee} missing from the call graph`)

      const bad = await this.analyze({ bitcode: bc, targets: [exp.commentLine], entries: [exp.entry], force: true, timeoutSec: 300 })
      const near = bad.unresolved?.[0]?.nearbyCandidates ?? []
      evidence.push(`analyze comment line ${exp.commentLine}: status=${bad.status} nearby=[${near.join(', ')}]`)
      if (bad.status !== 'no_target') return finish(false, `a comment-line target was reported as ${bad.status}, not no_target — silent-failure detection is broken`)

      // The wllvm leg. `defaults.prepareMode` is `wllvm` by default, so a prepare that nobody
      // configured takes this path — leaving it unverified would mean the self-test passes while
      // the mode most callers actually get is broken. It is a real end-to-end run (wrap, build,
      // extract-bc), never a `which` check, for the same reason the rest of doctor is.
      wllvm = await this.checkWllvm(tc, dir, exp.source, evidence)
      if (!wllvm.ok) return finish(false, `wllvm is the default prepare mode and it is not usable: ${wllvm.message}`)
      return finish(true)
    } catch (e) {
      return finish(false, `doctor crashed: ${(e as Error).message}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * The self-test's wllvm leg: can `mode: 'wllvm'` actually produce bitcode on this machine?
   *
   * A real wrap-build-extract of the selftest sample, not a `which` probe — an installed-but-broken
   * wllvm (wrong Python, no LLVM_COMPILER_PATH, a stale wrapper) resolves on PATH and still fails at
   * build time, which is precisely the failure this is supposed to catch before a user hits it.
   *
   * It also answers *where* wllvm lives. The package installs through pip, so its executables land
   * in a virtualenv or `~/.local/bin`, and the host process's own PATH frequently does not include
   * either; recording the directory is what lets {@link doPrepare} put it on the build subprocess's
   * PATH afterwards. Candidate directories are tried in turn and the first one that works wins.
   * @param tc - the resolved LLVM toolchain.
   * @param dir - the doctor's scratch directory, already holding the sample source.
   * @param source - the sample source filename.
   * @param evidence - the doctor's running evidence list, appended to.
   * @returns the leg's verdict, its human-readable message, and the bin directory that worked.
   */
  private async checkWllvm(tc: Toolchain, dir: string, source: string, evidence: string[]): Promise<{ ok: boolean; message: string; binDir?: string }> {
    const configured = (this.options.config().install.wllvmBinDir ?? '').trim()
    const home = homedir()
    // Ask Python where it is: wllvm is a pip package, so the interpreter that can import it sits
    // next to the wrappers. This is what finds an existing virtualenv install — the common case on
    // a machine where someone already pip-installed wllvm into an environment that is not on the
    // host's PATH — so the self-test can record it instead of provoking a redundant reinstall.
    const fromPython = await run('python3', ['-c', 'import wllvm, os, sys; print(os.path.dirname(sys.executable))'], { timeoutMs: 30_000 })
      .then(r => (r.exitCode === 0 ? r.stdout.trim() : ''))
      .catch(() => '')
    // '' means "whatever the host PATH already provides" and is tried first: when wllvm is properly
    // on PATH there is nothing to record and nothing to override.
    const candidates = [...new Set([
      '',
      ...configured === '' ? [] : [expandHome(configured, home)],
      ...fromPython === '' ? [] : [fromPython],
      join(home, '.local', 'bin'),
    ])]
    const program = 'wllvmcheck'
    const failures: string[] = []
    for (const binDir of candidates) {
      const base = process.env as Record<string, string | undefined>
      const withPath = binDir === '' ? base : { ...base, PATH: `${binDir}:${base.PATH ?? '/usr/bin:/bin'}` }
      const env = wllvmEnv(tc, {}, withPath)
      const where = binDir === '' ? 'PATH' : binDir
      const built = await run('/bin/sh', ['-c', `$CC $CFLAGS ${source} -o ${program}`], { cwd: dir, env, timeoutMs: 180_000 })
      if (built.exitCode !== 0) {
        failures.push(`${where}: wllvm build failed (exit ${String(built.exitCode)}): ${(built.stderr || built.stdout).slice(-300)}`)
        continue
      }
      const out = join(dir, `${program}${PREOPT_SUFFIX}`)
      const ex = await run('extract-bc', ['-o', out, join(dir, program)], { env, timeoutMs: 180_000 })
      if (ex.exitCode !== 0 || !existsSync(out)) {
        failures.push(`${where}: extract-bc failed (exit ${String(ex.exitCode)}): ${ex.stderr.slice(-300)}`)
        continue
      }
      await rm(out, { force: true })
      await rm(join(dir, program), { force: true })
      const message = `wllvm end-to-end via ${where}: built ${program} and extracted bitcode`
      evidence.push(message)
      return binDir === '' ? { ok: true, message } : { ok: true, message, binDir }
    }
    const message = [
      'wllvm could not build and extract the self-test sample.',
      'It needs the `wllvm`, `wllvm++` and `extract-bc` executables (pip package `wllvm`) reachable from this host.',
      ...failures,
    ].join('\n')
    evidence.push('wllvm end-to-end: FAILED')
    return { ok: false, message }
  }

  /**
   * @inheritdoc
   * @param caller - the initiating tool call's agent/signal, when there is one (see {@link JobCaller}); an internal caller with no live tool call omits it.
   */
  prepare(request: PrepareRequest, caller?: JobCaller, opts: PrepareOptions = {}): Promise<PreparedBitcode> {
    return this.prepareJob(request, caller, opts).result
  }

  /**
   * Start a prepare and hand back its job id straight away, alongside the promise of the real
   * result — so a tool can wait a few seconds and then let the model get on with something else
   * instead of blocking a turn for the length of a build.
   *
   * Single-flight per checkout: an identical repeat from the same agent joins the running job
   * rather than starting a second build in the same tree, and a *different* request against a
   * tree that is already building is refused by name instead of racing it. The guard is keyed by
   * owner as well as path because `dsh-jobs` fences job access by session — silently handing one
   * session another's job id would produce a job it cannot read or kill.
   * @param request - the prepare request.
   * @param caller - the initiating tool call's agent/signal, when there is one.
   * @param opts - isolation and cache choices (see {@link PrepareOptions}).
   * @returns the job id (when a job registry is attached), the isolated tree, and the result.
   */
  prepareJob(request: PrepareRequest, caller?: JobCaller, opts: PrepareOptions = {}): { jobId?: JobId; tree?: string; result: Promise<PreparedBitcode> } {
    const repo = resolve(request.repo)
    const isolate = opts.isolate ?? true
    const iso = isolationFor(repo)
    const mode = request.mode ?? this.options.config().defaults.prepareMode ?? 'wllvm'
    const identity = prepareIdentityKey({
      repo, buildCmd: request.buildCmd, mode, profile: isolate ? 'analysis' : 'passthrough', isolate,
      ...(request.cwd !== undefined ? { cwd: resolve(request.cwd) } : {}),
      ...(request.program !== undefined ? { program: request.program } : {}),
      ...(request.ltoLibs !== undefined ? { ltoLibs: request.ltoLibs } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
    })
    const owner = caller?.agent?.id ?? ''
    const treeField = isolate ? { tree: iso.tree } : {}
    const running = this.inFlight.get(repo)
    if (running !== undefined) {
      if (running.owner === owner && running.identity === identity) {
        return { ...(running.jobId !== undefined ? { jobId: running.jobId } : {}), ...treeField, result: running.promise }
      }
      throw new Error([
        `a kanalyzer prepare${running.jobId === undefined ? '' : ` (job ${running.jobId})`} is already running against ${repo}.`,
        'Two builds in one tree would race. Wait for it to finish (you are notified when the job settles,',
        'and job_output shows its progress), kill it with job_kill, or prepare a different checkout.',
      ].join('\n'))
    }
    const progress = new PrepareProgress(iso.progress)
    const entry: InFlightPrepare = { owner, identity, promise: Promise.resolve() as unknown as Promise<PreparedBitcode> }
    const work = this.asJob(
      `kanalyzer prepare (${mode}) ${request.program ?? basename(repo)}`,
      signal => this.doPrepare(request, signal, { isolate, force: opts.force === true }, progress),
      caller,
      {
        readOutput: () => progress.read(),
        outputLimitBytes: JOB_OUTPUT_LIMIT,
        onStarted: (id) => { entry.jobId = id },
      },
    )
    entry.promise = work.then(
      (result) => {
        this.inFlight.delete(repo)
        const full = { ...result, ...(entry.jobId !== undefined ? { jobId: entry.jobId } : {}) }
        // The last delta a detached caller reads: `job_output` is the only channel a background
        // prepare has back to the model, and a progress line alone would not name the bitcode.
        progress.finish(`RESULT ${JSON.stringify(full)}`)
        return full
      },
      (error: unknown) => {
        this.inFlight.delete(repo)
        progress.finish(`ERROR ${error instanceof Error ? error.message : String(error)}`)
        throw error
      },
    )
    this.inFlight.set(repo, entry)
    return { ...(entry.jobId !== undefined ? { jobId: entry.jobId } : {}), ...treeField, result: entry.promise }
  }

  /**
   * Copy the checkout into the isolated analysis tree.
   *
   * No `--delete`: the copy is meant to stay warm, so a second prepare re-syncs changed sources
   * and leaves the object files a previous build produced, which is what makes an incremental
   * rebuild possible at all. `force: true` wipes the tree instead.
   * @param repo - the checkout.
   * @param tree - the copy.
   * @param signal - abort signal of the owning job.
   */
  private async syncTree(repo: string, tree: string, signal: AbortSignal): Promise<void> {
    await mkdir(tree, { recursive: true })
    const rs = await run('rsync', ['-a', `--exclude=/${KANALYZER_DIR}/`, `${repo}/`, `${tree}/`], { signal, timeoutMs: 3_600_000 })
    if (rs.exitCode !== 0) {
      throw new Error([
        `could not copy ${repo} into the isolated analysis tree ${tree} (rsync exit ${String(rs.exitCode)}).`,
        'kanalyzer_prepare builds in a copy so your own build tree and binaries are never modified.',
        'Install rsync, or pass isolate: false to build in the checkout itself (which then keeps the',
        "project's own flags, sanitizers included).",
        (rs.stderr || rs.stdout).slice(-500),
      ].join('\n'))
    }
  }

  /**
   * Write the compiler shims and put them first on the build's `PATH`.
   *
   * This is what makes a build script that hardcodes `export CC=clang` work: a real session had
   * to `sed`-patch the user's script because `kanalyzer_prepare` injects its toolchain purely as
   * environment variables, which the script's own `export` lines then overwrote. One script is
   * installed under every common compiler name; it removes this directory from `PATH` before
   * exec'ing, so it can never call itself.
   * @param params - the rendered script's parameters.
   * @param llvmPrefix - the analyser's LLVM prefix, for the versioned shim names.
   */
  private async installShim(params: ShimParams, llvmPrefix: string): Promise<void> {
    await rm(params.shimDir, { recursive: true, force: true })
    await mkdir(params.shimDir, { recursive: true })
    const script = join(params.shimDir, 'kanalyzer-shim.sh')
    await writeFile(script, renderShimScript(params))
    await chmod(script, 0o755)
    const major = /llvm-(\d+)/.exec(llvmPrefix)?.[1]
    for (const name of shimNames(major)) {
      await symlink(script, join(params.shimDir, name)).catch(() => { /* already linked */ })
    }
  }

  /** @returns the memo entry for this exact build, when the checkout still has one. */
  private async readPrepareMemo(path: string, key: string): Promise<{ preparedAt: number; result: PrepareResult } | undefined> {
    const text = await readIfExists(path)
    if (text === undefined) return undefined
    try {
      const all = JSON.parse(text) as Record<string, { preparedAt?: unknown; result?: unknown }>
      const hit = all[key]
      if (hit === undefined || typeof hit.preparedAt !== 'number' || typeof hit.result !== 'object' || hit.result === null) return undefined
      return { preparedAt: hit.preparedAt, result: hit.result as PrepareResult }
    } catch { return undefined }
  }

  /** Record this build so an unchanged checkout can skip the next one. */
  private async writePrepareMemo(path: string, key: string, entry: { preparedAt: number; result: PrepareResult }): Promise<void> {
    let all: Record<string, unknown> = {}
    const text = await readIfExists(path)
    if (text !== undefined) { try { all = JSON.parse(text) as Record<string, unknown> } catch { all = {} } }
    all[key] = entry
    await writeFile(path, `${JSON.stringify(all, null, 2)}\n`).catch(() => { /* a read-only workspace must not fail a good build */ })
  }

  private async doPrepare(req: PrepareRequest, signal: AbortSignal, opts: { isolate: boolean; force: boolean }, progress?: PrepareProgress): Promise<PreparedBitcode> {
    const cfg = this.options.config()
    // `mode` is optional on the wire: a caller that does not care gets the deployment default
    // (`defaults.prepareMode`, itself `wllvm`), so the mode a large project usually needs is what
    // you get without asking for it.
    const mode = req.mode ?? cfg.defaults.prepareMode ?? 'wllvm'
    const { isolate, force } = opts
    // An isolated build owns its own flags, so the shim can force them onto every compiler
    // invocation; an in-tree build must keep the project's, because that tree's output is the
    // binary the user actually runs.
    const profile: FlagProfile = isolate ? 'analysis' : 'passthrough'
    // Both checks run BEFORE the build: each describes a request that cannot possibly succeed, and
    // finding that out after a full build costs the caller the whole build time for nothing (a real
    // session burned 8s on the first of these, then three more tool calls misdiagnosing it).
    // The first only applies without the shim — with it, the LTO flags reach the compiler on the
    // argv whatever the command line says, which is the whole point of installing it.
    if (!isolate) {
      const problem = ltoBuildCmdProblem(req.buildCmd, mode)
      if (problem !== undefined) throw new Error(problem)
    }
    if (mode === 'wllvm' && req.program === undefined) {
      throw new Error([
        'mode "wllvm" needs `program`: the basename of the linked binary to extract bitcode from (e.g. "readelf").',
        'wllvm embeds bitcode in each object and `extract-bc` recovers the whole-program module from the final link output,',
        'so unlike mode "lto" there is nothing to find without knowing which binary that is.',
        'Pass `program`, or use mode "lto" for a project whose build honours $CFLAGS/$LDFLAGS.',
      ].join('\n'))
    }
    const tc = await this.toolchain()
    const repo = resolve(req.repo)
    const callerCwd = resolve(req.cwd ?? repo)
    const iso = isolationFor(repo)
    const libs = req.ltoLibs ?? []
    for (const lib of libs) {
      const fh = await open(lib, 'r').catch(() => { throw new Error(`ltoLibs entry not found: ${lib}`) })
      const buf = new Uint8Array(4 * 1024 * 1024)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      await fh.close()
      if (!looksLikeLtoArchive(buf.subarray(0, bytesRead))) {
        throw new Error(`${lib} is not an LTO (bitcode) archive. Rebuild it with CC=${tc.cc} CFLAGS="-O0 -g -fPIC -flto" AR=${tc.ar}; a native archive links but silently drops its functions from the call graph.`)
      }
    }
    const warnings: string[] = []
    if (!isolate) {
      warnings.push([
        'isolate: false — the build ran in your own tree with the project\'s own flags.',
        'If those include -fsanitize=..., almost every "critical branch" KAMain reports is a sanitizer',
        'check rather than a real source branch (measured: 37,634 of 37,678 on a real nginx build), so',
        'treat distances and critical branches from this bitcode as unusable.',
      ].join(' '))
    }
    const identity = prepareIdentityKey({
      repo, buildCmd: req.buildCmd, mode, profile, isolate,
      ...(req.cwd !== undefined ? { cwd: callerCwd } : {}),
      ...(req.program !== undefined ? { program: req.program } : {}),
      ...(req.ltoLibs !== undefined ? { ltoLibs: req.ltoLibs } : {}),
      ...(req.env !== undefined ? { env: req.env } : {}),
    })
    const decorate = (result: PrepareResult, cached: boolean): PreparedBitcode => ({
      ...result,
      mode,
      profile,
      warnings,
      cached,
      ...(isolate ? { tree: iso.tree } : {}),
      note: isolate
        ? `Bitcode was built in the isolated copy ${iso.tree} with sanitizers stripped and -O0 -g -fPIC forced; your own build tree and binaries were not modified.`
        : `Bitcode was built in ${repo} itself, with the project's own flags.`,
    })

    // Reuse: the same build against a checkout nothing has touched since produces the same
    // bitcode, and a repeat of this exact call used to cost the full build again.
    if (!force) {
      const hit = await this.readPrepareMemo(iso.memo, identity)
      if (hit !== undefined && existsSync(hit.result.bitcode) && !(await anyFileNewer(repo, hit.preparedAt))) {
        for (const bc of hit.result.allBitcode) this.prepared.set(bc, { repo, aliases: isolate ? [iso.tree] : [] })
        return decorate(hit.result, true)
      }
    }

    await mkdir(iso.root, { recursive: true })
    // Everything this plugin writes into the workspace lives under one hidden directory, and none
    // of it belongs in the user's history.
    await writeFile(join(iso.root, '.gitignore'), '*\n').catch(() => { /* read-only workspace */ })
    let buildRoot = repo
    let buildCwd = callerCwd
    let buildCmd = req.buildCmd
    if (isolate) {
      if (force) await rm(iso.tree, { recursive: true, force: true })
      await this.syncTree(repo, iso.tree, signal)
      buildRoot = iso.tree
      buildCwd = intoTree(repo, iso.tree, callerCwd)
      buildCmd = rewriteBuildCmd(req.buildCmd, repo, iso.tree)
    }

    const nproc = Math.max(1, cpus().length)
    await writeFile(iso.progress, '').catch(() => { /* progress is best-effort */ })
    await this.installShim({
      mode, profile, realCc: tc.cc, realCxx: tc.cxx, shimDir: iso.shim, progressFile: iso.progress, nproc,
    }, tc.prefix)

    const base = process.env as Record<string, string | undefined>
    // wllvm ships as a Python package, so its executables land wherever pip put them — a virtualenv
    // or `~/.local/bin` — neither of which the host process necessarily has on PATH. Prepending the
    // recorded directory is what makes an installed-but-unreachable wllvm actually usable; the
    // self-test discovers and records it.
    const wllvmBin = ((cfg.install.wllvmBinDir ?? '').trim() || (cfg.status.wllvmBinDir ?? '').trim())
    const withWllvmPath = wllvmBin === ''
      ? base
      : { ...base, PATH: `${expandHome(wllvmBin, homedir())}:${base.PATH ?? '/usr/bin:/bin'}` }
    const env = mode === 'lto' ? ltoEnv(tc, req.env, libs, base, nproc) : wllvmEnv(tc, req.env, withWllvmPath, nproc)
    // The shims go ahead of everything, including the analyser's own bin directory: a build script
    // that re-exports CC=clang has to land on one of them for any of this to take effect.
    env.PATH = `${iso.shim}:${env.PATH ?? '/usr/bin:/bin'}`
    const since = Date.now() - 2000
    const build = await run('/bin/sh', ['-c', buildCmd], {
      cwd: buildCwd, env, signal, maxBuffered: 256 * 1024,
      ...(progress !== undefined ? { onOutput: (chunk: string) => { progress.onOutput(chunk) } } : {}),
    })
    if (signal.aborted) throw new Error('prepare cancelled')
    const tail = (build.stderr || build.stdout).slice(-1500)
    if (build.exitCode !== 0) throw new Error(`build command failed (exit ${String(build.exitCode)}):\n${tail}`)

    let found: string[]
    if (mode === 'lto') {
      const roots = [...new Set([buildCwd, buildRoot])]
      found = []
      for (const root of roots) {
        for (const rel of await walk(root, r => r.endsWith(PREOPT_SUFFIX))) {
          const abs = join(root, rel)
          if ((await stat(abs)).mtimeMs >= since) found.push(abs)
        }
      }
      if (found.length === 0) {
        // Everything a caller needs to diagnose this without a second round-trip. The build output
        // in particular used to be captured into `tail` and then dropped on this path, so the job
        // reported only "(no new output)" and the agent had to re-derive the cause by hand.
        throw new Error([
          `The build finished but produced no *${PREOPT_SUFFIX}.`,
          `Command run: ${buildCmd}`,
          `In: ${buildCwd}`,
          ...(isolate
            ? ['The build ran in the isolated copy; a command that writes through an absolute path outside the',
               'checkout builds somewhere else entirely, which looks exactly like this. Use paths relative to `cwd`.']
            : ['The LTO flags are passed as environment variables and are never appended to your command line:',
               `  CFLAGS=${env.CFLAGS ?? ''}`,
               `  CXXFLAGS=${env.CXXFLAGS ?? ''}`,
               `  LDFLAGS=${env.LDFLAGS ?? ''}`,
               'Most likely, in order: the command drives the compiler directly without referencing $CXXFLAGS/$CFLAGS/$LDFLAGS;',
               'the build system dropped LDFLAGS so lld never ran with -plugin-opt=save-temps; or objects were reused from an',
               'earlier non-LTO build (pass force: true to rebuild from scratch). Mode "wllvm" avoids all three by wrapping the compiler.']),
          tail === '' ? '(the build produced no output)' : `Build output (tail):\n${tail}`,
        ].join('\n'))
      }
    } else {
      // `program` is already validated at the top of doPrepare(), before the build runs.
      const bins = (await walk(buildCwd, r => basename(r) === req.program)).map(r => join(buildCwd, r))
      const bin = bins[0]
      if (bin === undefined) {
        throw new Error([
          `wllvm build finished but no file named ${req.program ?? ''} was found under ${buildCwd}.`,
          ...(isolate
            ? [`The build ran in the isolated copy of ${repo}; if your command writes through an absolute path`,
               'outside the checkout, it built somewhere else. Use paths relative to `cwd`.']
            : []),
        ].join('\n'))
      }
      const out = `${bin}${PREOPT_SUFFIX}`
      const ex = await run('extract-bc', ['-o', out, bin], { env, timeoutMs: 600_000 })
      if (ex.exitCode !== 0 || !existsSync(out)) throw new Error(`extract-bc failed (is wllvm installed? pip install wllvm): ${ex.stderr.slice(-800)}`)
      found = [out]
    }
    const { selected, all } = selectBitcode(found, req.program)
    if (selected === undefined) throw new Error(`No bitcode for program "${req.program ?? ''}"; the build produced: ${all.map(p => basename(p)).join(', ')}`)
    const nm = await run(tc.nm, ['--defined-only', selected], { timeoutMs: 300_000 })
    if (nm.exitCode !== 0) throw new Error(`${tc.nm} failed (exit ${String(nm.exitCode)}): ${nm.stderr.slice(-800)}`)
    const { entries, nFuncs } = inferEntries(nm.stdout)
    for (const bc of all) this.prepared.set(bc, { repo, aliases: isolate ? [iso.tree] : [] })
    // A fresh build means the checkout's file set may have changed under any index built from it.
    this.repoIndexMemo.clear()
    const result: PrepareResult = { bitcode: selected, allBitcode: all, entries, nFuncs }
    await this.writePrepareMemo(iso.memo, identity, { preparedAt: Date.now(), result })
    return decorate(result, false)
  }

  /** @inheritdoc */
  async importPrebuilt(request: PrebuiltImportRequest): Promise<PrebuiltImportResult> {
    const started = Date.now()
    const dir = resolve(request.dir)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (error) {
      throw new Error(`prebuilt_dir ${dir} is not a readable directory: ${(error as Error).message}`)
    }
    const { files, ambiguous } = resolveDumpFiles(names, request.program)
    if (ambiguous.length > 0) {
      const detail = ambiguous.map(a => `${DUMP_FILES[a.kind]} (${a.candidates.join(', ')})`).join('; ')
      throw new Error(`prebuilt_dir ${dir} holds more than one candidate per dump: ${detail} — point it at the directory holding one program's results, or set analysis.static.program`)
    }
    const read = async (kind: DumpKind): Promise<string | undefined> => {
      const name = files[kind]
      return name === undefined ? undefined : readIfExists(join(dir, name))
    }
    const [distance, criticalBranch, bidMapping, funcInfo, callerCallee] = await Promise.all([
      read('distance'), read('criticalBranch'), read('bidMapping'), read('funcInfo'), read('callerCallee'),
    ])
    const repo = request.repo !== undefined ? await this.repoIndexFor(resolve(request.repo)) : undefined
    // No process and no stderr log: an import stands in for a run that exited cleanly, and success
    // is still claimed only from the dumps (a distance-0 row, func info) — never from this object.
    const result = await analyzeFromDumps({
      texts: { distance, criticalBranch, bidMapping, funcInfo, callerCallee },
      process: { exitCode: 0, signal: null, timedOut: false },
      stderr: parseStderr(''),
      requestedTargets: request.targets ?? [],
      missingDumps: missingRequiredDumps(files),
      entries: [],
      outputDir: dir,
      elapsedMs: Date.now() - started,
      ...(repo !== undefined ? { repo } : {}),
    })
    const handle = dir
    this.imported.set(handle, { dir, files })
    if (request.repo !== undefined) this.prepared.set(handle, { repo: resolve(request.repo), aliases: [] })
    return { ...result, handle, files, dumpFiles: Object.values(files).sort() }
  }

  /**
   * @inheritdoc
   * @param caller - the initiating tool call's agent/signal, when there is one (see {@link JobCaller}); an internal caller with no live tool call (e.g. `index()`, `doctor()`'s self-test) omits it.
   */
  analyze(request: AnalyzeRequest, caller?: JobCaller): Promise<AnalyzeResult> {
    // KAMain already streams its verbose log to a file, so making the job readable costs nothing
    // and turns a silent multi-minute analysis into one the user can watch.
    const tail = new FileTail()
    return this.asJob(
      `kanalyzer analyze ${basename(request.bitcode)} (${String(request.targets.length)} target(s))`,
      signal => this.doAnalyze(request, signal, tail),
      caller,
      { readOutput: () => tail.read(), outputLimitBytes: JOB_OUTPUT_LIMIT },
    )
  }

  /** @inheritdoc */
  index(bitcode: string): Promise<AnalyzeResult> {
    return this.analyze({ bitcode, targets: [], dumps: { bidMappingAndFuncInfo: true, callerCalleeBothWays: true, policy: false, distance: false, criticalBranch: false, annotatedIr: false } })
  }

  private async doAnalyze(req: AnalyzeRequest, signal: AbortSignal, tail?: FileTail): Promise<AnalyzeResult> {
    const started = Date.now()
    const cfg = this.options.config()
    const options = resolveOptions(req, optionDefaults(cfg))
    const fail = (reason: string, outputDir = ''): AnalyzeResult => ({
      status: 'error', targets: [], criticalBranches: [], reachableFunctions: 0, totalFunctions: 0,
      entriesUsed: options.entries, outputDir, dumpFiles: [], elapsedMs: Date.now() - started, cached: false, reason,
    })
    const st = await this.status()
    if (!st.installed) return fail(`KAMain is not built (${this.binary} missing). Press Build in the kanalyzer settings or run /kanalyzer build.`)
    if (!existsSync(req.bitcode)) return fail(`bitcode not found: ${req.bitcode}`)
    const bad = options.targets.filter(t => targetListEntry(t) === undefined)
    if (bad.length > 0) return fail(`malformed target(s), expected file:line: ${bad.join(', ')}`)

    const notes = await this.bitcodeNotes(req.bitcode)
    const key = cacheKey(await this.digestOf(req.bitcode), st.commit ?? 'unknown', options)
    const cacheDir = join(this.installDir, 'cache', key)
    const resultFile = join(cacheDir, 'result.json')
    // Where the user-visible dump files go: the caller's explicit choice, else the cache
    // directory itself. The cache stays the canonical store either way — `query()` and future
    // cache hits read it, never the delivered copy.
    const deliverDir = req.outputDir === undefined || req.outputDir === '' ? undefined : resolve(req.outputDir)
    if (cfg.defaults.cacheEnabled && req.force !== true) {
      const hit = await readIfExists(resultFile)
      if (hit !== undefined) {
        const r = JSON.parse(hit) as AnalyzeResult
        if (options.targets.length > 0) await this.rememberAnalysis(req.bitcode, cacheDir)
        const delivered = await this.deliverDumps(cacheDir, deliverDir, options.dumps)
        return {
          ...r,
          cached: true,
          outputDir: delivered ?? r.outputDir,
          dumpFiles: dumpFilesIn(cacheDir, options.dumps),
          elapsedMs: Date.now() - started,
          ...(notes.length > 0 ? { notes } : {}),
        }
      }
    }
    await rm(cacheDir, { recursive: true, force: true })
    await mkdir(cacheDir, { recursive: true })
    const paths = { outputDir: cacheDir, targetListFile: join(cacheDir, 'targets.txt'), entryListFile: join(cacheDir, 'entries.txt'), stderrLog: join(cacheDir, 'kamain.stderr.log') }
    tail?.setPath(paths.stderrLog)
    await writeFile(paths.targetListFile, [...new Set(options.targets.map(t => targetListEntry(t) ?? ''))].sort().join('\n') + '\n')
    if (options.entries.length > 0) await writeFile(paths.entryListFile, options.entries.join('\n') + '\n')
    await writeFile(join(cacheDir, 'command.json'), JSON.stringify({ binary: this.binary, args: buildArgs(req.bitcode, options, paths) }, null, 2))

    const proc = await run(this.binary, buildArgs(req.bitcode, options, paths), {
      cwd: cacheDir, timeoutMs: options.timeoutSec * 1000, memLimitMB: options.memLimitMB, signal,
      stderrFile: paths.stderrLog, stderrFilter: kamainStderrFilter,
    })
    const result = await this.interpret(req, options, cacheDir, proc, started)
    if (result.status !== 'error' || !proc.timedOut) await writeFile(resultFile, JSON.stringify(result, null, 2))
    if (options.targets.length > 0) await this.rememberAnalysis(req.bitcode, cacheDir)
    const delivered = result.status !== 'error' ? await this.deliverDumps(cacheDir, deliverDir, options.dumps) : undefined
    return {
      ...result,
      ...(delivered !== undefined ? { outputDir: delivered } : {}),
      dumpFiles: result.status === 'error' ? [] : dumpFilesIn(cacheDir, options.dumps),
      ...(notes.length > 0 ? { notes: [...(result.notes ?? []), ...notes] } : {}),
    }
  }

  /**
   * Copy the dump files one run produced (or a cache entry still holds) into the directory the
   * caller asked for, so the user finds the results in a predictable place. Only a successful
   * analysis calls this: a failed one delivers nothing and leaves whatever an earlier analysis
   * put in the directory untouched. Returns the delivery directory, or undefined when there is
   * nothing to deliver (no directory requested, or it is the cache directory itself).
   */
  private async deliverDumps(cacheDir: string, deliverDir: string | undefined, dumps: Required<DumpSelection>): Promise<string | undefined> {
    if (deliverDir === undefined || resolve(deliverDir) === resolve(cacheDir)) return undefined
    await mkdir(deliverDir, { recursive: true })
    for (const f of selectedDumpFiles(dumps)) {
      // A dump KAMain never wrote is simply absent; `interpret()` has already turned a missing
      // selected dump into a failed analysis, which delivers nothing at all.
      const from = join(cacheDir, f)
      const to = join(deliverDir, f)
      const [src, dst] = await Promise.all([stat(from).catch(() => undefined), stat(to).catch(() => undefined)])
      if (src === undefined) continue
      // A cache hit re-delivers the same bytes every time; these dumps run to tens of megabytes.
      if (dst !== undefined && dst.size === src.size && dst.mtimeMs >= src.mtimeMs) continue
      await copyFile(from, to).catch(() => { /* not produced by this run */ })
    }
    return deliverDir
  }

  private async interpret(
    req: AnalyzeRequest, options: ResolvedOptions, outputDir: string,
    proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stderr: string }, started: number,
  ): Promise<AnalyzeResult> {
    const read = (f: string): Promise<string | undefined> => readIfExists(join(outputDir, f))
    const [distance, criticalBranch, bidMapping, funcInfo, callerCallee] = await Promise.all([
      read(DUMP_FILES.distance), read(DUMP_FILES.criticalBranch), read(DUMP_FILES.bidMapping), read(DUMP_FILES.funcInfo),
      read(DUMP_FILES.callerCallee),
    ])
    const missing: string[] = []
    for (const f of selectedDumpFiles(options.dumps)) if (!existsSync(join(outputDir, f))) missing.push(f)
    const repo = await this.repoIndex(req.bitcode)
    return analyzeFromDumps({
      texts: { distance, criticalBranch, bidMapping, funcInfo, callerCallee },
      process: { exitCode: proc.exitCode, signal: proc.signal, timedOut: proc.timedOut },
      stderr: parseStderr(proc.stderr),
      requestedTargets: options.targets,
      missingDumps: missing,
      entries: options.entries,
      outputDir,
      elapsedMs: Date.now() - started,
      ...(repo !== undefined ? { repo } : {}),
      fallbackInstructionLines: requested => this.instructionLinesFromSource(requested, repo),
    })
  }

  /** Source-text fallback for a target that resolved to nothing and has no bid-mapping rows. */
  private async instructionLinesFromSource(requested: string, repo: RepoIndex | undefined): Promise<number[]> {
    const file = requested.replace(/:\d+(:\d+)?$/, '')
    const cands = repo?.candidates(basename(file)) ?? []
    const src = cands[0] !== undefined && repo ? await readIfExists(join(repo.repo, cands[0])) : await readIfExists(file)
    return src !== undefined ? heuristicInstructionLines(src) : []
  }

  /**
   * @param root - the checkout to index.
   * @param aliases - mirror roots whose absolute paths must resolve back into `root` (the isolated
   *   analysis tree, since KAMain recorded the paths the build actually compiled).
   * @returns a repo index over the source files under `root`, memoized: every `query()` used to
   *   re-walk the whole tree (7,662 entries, 1.3–3 s, on the nginx case) before answering.
   */
  private async repoIndexFor(root: string, aliases: string[] = []): Promise<RepoIndex> {
    const key = `${root}\u0000${aliases.join('\u0000')}`
    const hit = this.repoIndexMemo.get(key)
    if (hit !== undefined) return hit
    const index = new RepoIndex(root, await walk(root, r => SOURCE_EXT.test(r)), aliases)
    this.repoIndexMemo.set(key, index)
    return index
  }

  private async repoIndex(bitcode: string): Promise<RepoIndex | undefined> {
    const prepared = this.prepared.get(bitcode)
    if (prepared === undefined) return undefined
    return this.repoIndexFor(prepared.repo, prepared.aliases)
  }

  /**
   * sha256 of a file, memoized on its size and mtime.
   * @param path - the file to digest.
   * @returns its hex digest.
   */
  private async digestOf(path: string): Promise<string> {
    const st = await stat(path).catch(() => undefined)
    if (st === undefined) return sha256File(path)
    const hit = this.digestMemo.get(path)
    if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.digest
    const digest = await sha256File(path)
    this.digestMemo.set(path, { size: st.size, mtimeMs: st.mtimeMs, digest })
    return digest
  }

  /**
   * Parse one dump file, memoized on its size and mtime.
   *
   * Parsing is what made a query expensive: `bid_loc_mapping.txt` alone is 132k rows and ~6 s to
   * turn into objects on a slow host, and every single `query()` call used to redo all seven
   * dumps from scratch.
   * @param dir - the run directory holding the dump.
   * @param file - the dump's file name.
   * @param parse - its parser.
   * @returns the parsed value.
   */
  private async parsedDump<T>(dir: string, file: string, parse: (text: string) => T): Promise<T> {
    const path = join(dir, file)
    const st = await stat(path).catch(() => undefined)
    if (st === undefined) return parse('')
    const hit = this.parseMemo.get(path)
    if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value as T
    const value = parse((await readIfExists(path)) ?? '')
    this.parseMemo.set(path, { size: st.size, mtimeMs: st.mtimeMs, value })
    return value
  }

  /**
   * A file's size+mtime as one short string, or `''` when it does not exist. The same staleness
   * test {@link parsedDump} uses, in a form several files can be concatenated into.
   * @param path - the file to stamp.
   * @returns the stamp.
   */
  private async stampOf(path: string): Promise<string> {
    const st = await stat(path).catch(() => undefined)
    return st === undefined ? '' : `${String(st.size)}:${String(st.mtimeMs)}`
  }

  /**
   * Build {@link blockIndex} once per dump pair instead of once per query.
   *
   * The two Maps it builds span the whole block mapping — 131,935 rows and ~0.3 s on the nginx
   * case — and every distance-bearing op walks them per row. {@link parsedDump} already keeps the
   * parsed rows resident; this keeps the index derived from them resident too.
   * @param dir - the run directory the two dumps came from.
   * @param bidMapping - parsed block mapping.
   * @param funcInfo - parsed function info.
   * @returns the lookup, rebuilt only when either dump changed on disk.
   */
  private async blocksFor(dir: string, bidMapping: BidMappingRow[], funcInfo: FuncInfoRow[]): Promise<BlockIndex> {
    const stamp = `${await this.stampOf(join(dir, DUMP_FILES.bidMapping))}|${await this.stampOf(join(dir, DUMP_FILES.funcInfo))}`
    const hit = this.blockIndexMemo.get(dir)
    if (hit !== undefined && hit.stamp === stamp) return hit.value
    const value = blockIndex(bidMapping, funcInfo)
    this.blockIndexMemo.set(dir, { stamp, value })
    return value
  }

  /**
   * What the bitcode itself says about how it was built, memoized on size+mtime like every other
   * per-file fact here.
   *
   * Sanitizer-instrumented bitcode is the one case worth interrupting for: ASan turns every memory
   * access into a check whose failure arm is `call @__asan_report_*; unreachable`, so those arms
   * become exit blocks — most of the `-1` rows and most of the "critical branches" then describe
   * the sanitizer, not the program. `kanalyzer_prepare` strips the flags; a hand-built `.bc`
   * (as in the audited session) does not.
   * @param bitcode - the bitcode about to be analysed.
   * @returns notes to attach to the result, empty when there is nothing to say.
   */
  private async bitcodeNotes(bitcode: string): Promise<string[]> {
    const marker = await this.sanitizerMarker(bitcode)
    if (marker === undefined) return []
    return [
      `This bitcode is sanitizer-instrumented (${marker} present). Each sanitizer check's failure arm is an `
      + 'exit block, so most `-1` distance rows and most critical branches describe the sanitizer rather than the '
      + 'program. Rebuild with kanalyzer_prepare (it strips sanitizer flags) for an analysis about your own code.',
    ]
  }

  /** @returns the first sanitizer symbol found in the bitcode, or undefined; memoized on size+mtime. */
  private async sanitizerMarker(bitcode: string): Promise<string | undefined> {
    const st = await stat(bitcode).catch(() => undefined)
    if (st === undefined) return undefined
    const hit = this.sanitizerMemo.get(bitcode)
    if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.marker
    // Bitcode is a binary blob; the symbol names are plain bytes in its string table, so a scan
    // for them costs one read and no LLVM tooling.
    const text = await readFile(bitcode, 'latin1').catch(() => undefined)
    const marker = ['__asan_report_', '__msan_', '__tsan_', '__ubsan_handle_'].find(m => text?.includes(m))
    this.sanitizerMemo.set(bitcode, { size: st.size, mtimeMs: st.mtimeMs, marker })
    return marker
  }

  /** The file recording, per bitcode, which cache directory holds its latest targeted analysis.
   * Beside the cache, not inside it: a cache entry is one analysis, and this is a pointer at them. */
  private get analysisPointerFile(): string { return join(this.installDir, 'last-analysis.json') }

  /**
   * Record a targeted analysis as this bitcode's latest, in memory and on disk.
   *
   * In-memory alone, a `dsh web` restart loses the pointer and the next `query()` silently answers
   * from the *index* run, which has no distance dump at all — an empty distance table that reads
   * exactly like "unreachable". The pointer is a hint, not a cache: {@link analysisDirFor} drops it
   * again if the directory or its distance dump is gone.
   * @param bitcode - the analysed bitcode, as the caller names it.
   * @param cacheDir - the cache directory that run wrote.
   */
  private async rememberAnalysis(bitcode: string, cacheDir: string): Promise<void> {
    this.lastAnalysis.set(bitcode, cacheDir)
    const merged = { ...(await this.readAnalysisPointers()), [bitcode]: cacheDir }
    await writeFile(this.analysisPointerFile, JSON.stringify(merged, null, 2)).catch(() => { /* a hint that cannot be written is still only a hint */ })
  }

  /** @returns the persisted bitcode → cache-dir map, empty when absent or unreadable. */
  private async readAnalysisPointers(): Promise<Record<string, string>> {
    const text = await readIfExists(this.analysisPointerFile)
    if (text === undefined) return {}
    try {
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, string> : {}
    } catch { return {} }
  }

  /**
   * @param bitcode - the queried bitcode.
   * @returns the directory of its latest targeted analysis — from this process, else the persisted
   *   pointer — or undefined when none is known or the recorded one no longer holds a distance dump.
   */
  private async analysisDirFor(bitcode: string): Promise<string | undefined> {
    const known = this.lastAnalysis.get(bitcode) ?? (await this.readAnalysisPointers())[bitcode]
    if (known === undefined || !existsSync(join(known, DUMP_FILES.distance))) return undefined
    this.lastAnalysis.set(bitcode, known)
    return known
  }

  /** @inheritdoc */
  async query(request: QueryRequest): Promise<QueryResult> {
    const imported = this.imported.get(request.bitcode)
    if (imported !== undefined) return this.queryImported(request, imported)
    const analysisDir = await this.analysisDirFor(request.bitcode)
    // A targeted analysis already wrote the call graph and block mapping an index run would
    // produce — byte-identical for the mapping and func info, same edge set for the call graph —
    // so reuse them. The first query of a session used to spend a whole second KAMain invocation
    // (17.5 s on the nginx case) re-deriving data the analyze a moment earlier had just written.
    let indexDir = analysisDir !== undefined && hasIndexDumps(analysisDir) ? analysisDir : undefined
    if (indexDir === undefined) {
      const idx = await this.index(request.bitcode)
      if (idx.status === 'error') throw new Error(`cannot index ${request.bitcode}: ${idx.reason ?? 'unknown error'}`)
      indexDir = idx.outputDir
    }
    const bidMapping = await this.parsedDump(indexDir, DUMP_FILES.bidMapping, parseBidMapping)
    const funcInfo = await this.parsedDump(indexDir, DUMP_FILES.funcInfo, parseFuncInfo)
    const critDir = analysisDir ?? indexDir
    // Block ids are assigned deterministically per bitcode, so the index's mapping decodes a targeted run's critical dump.
    return runQuery(request, {
      funcInfo,
      bidMapping,
      callerCallee: await this.parsedDump(indexDir, DUMP_FILES.callerCallee, parseGuidEdges),
      calleeCaller: await this.parsedDump(indexDir, DUMP_FILES.calleeCaller, parseGuidEdges),
      critical: await this.parsedDump(critDir, DUMP_FILES.criticalBranch, parseCriticalBranches),
      // Distance and policy come from the same targeted-analysis directory as the critical dump:
      // an index run has no targets, so its own dumps carry no distance-to-target at all.
      distance: await this.parsedDump(critDir, DUMP_FILES.distance, parseDistance),
      policy: await this.parsedDump(critDir, DUMP_FILES.policy, parsePolicy),
      blocks: await this.blocksFor(indexDir, bidMapping, funcInfo),
      // Distance ops read the targeted run; without one they answer empty, which must not be
      // mistaken for "nothing reaches the target". `runQuery` says so in the result's `note`.
      analyzed: analysisDir !== undefined,
      ...(await this.repoIndex(request.bitcode).then(r => (r ? { repo: r } : {}))),
    })
  }

  /**
   * Answer a query from an imported dump directory.
   *
   * Same parsers, same path remapping, same `runQuery` as the live path above — only the place the
   * dumps come from differs. An import has exactly one directory, so unlike a live run there is no
   * separate analysis directory to take the critical-branch dump from.
   */
  private async queryImported(request: QueryRequest, imported: ImportedDumps): Promise<QueryResult> {
    const read = async (kind: DumpKind): Promise<string> => {
      const name = imported.files[kind]
      return name === undefined ? '' : ((await readIfExists(join(imported.dir, name))) ?? '')
    }
    const bidMapping = parseBidMapping(await read('bidMapping'))
    const funcInfo = parseFuncInfo(await read('funcInfo'))
    const repo = await this.repoIndex(request.bitcode)
    return runQuery(request, {
      funcInfo,
      bidMapping,
      callerCallee: parseGuidEdges(await read('callerCallee')),
      calleeCaller: parseGuidEdges(await read('calleeCaller')),
      critical: parseCriticalBranches(await read('criticalBranch')),
      distance: parseDistance(await read('distance')),
      policy: parsePolicy(await read('policy')),
      blocks: blockIndex(bidMapping, funcInfo),
      // An import carries whatever dumps it was given; a distance dump among them is the analysis.
      analyzed: imported.files.distance !== undefined,
      ...(repo !== undefined ? { repo } : {}),
    })
  }

  /** @returns the package-relative path of a file, for diagnostics. */
  relativeToPackage(path: string): string { return relative(this.options.packageRoot, path) }
}
