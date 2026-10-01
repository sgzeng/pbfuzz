/**
 * Environment verification for `pbfuzz_campaign draft`: build the target, then run it once on a
 * trivial input.
 *
 * These two facts used to be the agent's job — write the scripts, `chmod +x`, run the build, run
 * the target on an empty file — which in a recorded session was four `bash` round trips, each
 * paying DSH's sandbox launcher cost, before the campaign was even drafted. They were then
 * re-verified a third time by a campaign self-check that has since been removed. Doing it here
 * makes the drafted campaign say something that was actually observed, at the moment it is
 * drafted, with no extra model steps: the results go straight into the approval panel.
 *
 * The target is run on an EMPTY input deliberately. This is build/run verification, not an
 * attempt at the bug — that belongs to the PIER loop, inside a run the engine can record.
 *
 * @module @pbfuzz/dsh-pbfuzz/env-verify
 */

import { spawn } from 'node:child_process'
import { type Dirent, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { CampaignVerification } from './core/campaign-yaml.ts'
import type { PbfuzzCampaign } from './core/contracts.ts'

/** How long each step may take before it is killed and reported as a timeout. */
export interface VerifyTimeouts {
  /** The build. Real projects are slow; the default is generous. */
  buildSec: number
  /** One run of the target on an empty input. */
  runSec: number
}

/** The default budgets. */
export const DEFAULT_VERIFY_TIMEOUTS: VerifyTimeouts = { buildSec: 900, runSec: 30 }

/** What one spawned command did. */
interface CommandResult {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  /** stdout and stderr interleaved, tail-trimmed. */
  output: string
}

const OUTPUT_TAIL = 800

/**
 * Run one shell command to completion, capturing a bounded tail of its output.
 * @param command - the shell line.
 * @param cwd - working directory.
 * @param timeoutSec - kill after this many seconds.
 * @param env - extra environment on top of the current process's.
 * @param stdinData - written to stdin and closed; undefined closes stdin immediately.
 * @returns what happened.
 */
async function runCommand(
  command: string,
  cwd: string,
  timeoutSec: number,
  env?: Record<string, string>,
  stdinData?: Buffer,
  signal?: AbortSignal,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    // `detached` makes the shell its own process-group leader, so `process.kill(-pid)` reaches a
    // build's whole child tree (make → cc → …) rather than only the shell — without it those
    // children outlive both the timeout and an external abort.
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    let output = ''
    let timedOut = false
    let aborted = false
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (output.length > OUTPUT_TAIL * 4) output = output.slice(-OUTPUT_TAIL * 2)
    }
    const killGroup = (): void => {
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, timeoutSec * 1000)
    // A cancelled draft (its `flow.signal` aborted) must stop an in-flight build, not leave a
    // 900s child running detached with nothing awaiting it — same cancellation seam as EngineBridge.
    const onAbort = (): void => {
      aborted = true
      killGroup()
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
    child.on('error', (error) => {
      cleanup()
      resolve({ code: null, signal: aborted ? 'SIGKILL' : null, timedOut, output: `${output}${(error as Error).message}` })
    })
    child.on('close', (code, sig) => {
      cleanup()
      resolve({ code, signal: sig, timedOut, output: output.trim().slice(-OUTPUT_TAIL) })
    })
    if (stdinData !== undefined) child.stdin.write(stdinData)
    child.stdin.end()
  })
}

/** One line describing how a command ended. */
function describe(result: CommandResult, timeoutSec: number): string {
  if (result.timedOut) return `timed out after ${timeoutSec}s`
  if (result.signal !== null) return `killed by ${result.signal}`
  return `exit ${result.code ?? '?'}`
}

/** The tail of a command's output, on one line, for the approval panel. */
function tail(result: CommandResult, max = 200): string {
  const text = result.output.split('\n').filter(l => l.trim() !== '').slice(-2).join(' | ')
  return text.length > max ? `…${text.slice(-max)}` : text
}

/**
 * Give a build script the execute bit it needs, when the command names one that lacks it.
 *
 * The command runs as `sh -c <cmd>`, so a script path needs `+x` — and the `write` tool cannot set
 * that. In a recorded session that cost a whole model step spent on nothing but `chmod +x`.
 * Running the script as `sh <file>` instead is not an option: scripts routinely use bash-only
 * `set -o pipefail`, which `/bin/sh` (dash) rejects.
 *
 * Only the command's first word is considered, and only when it is a path (contains `/`) to an
 * existing regular file; `make -j8` or a PATH lookup is left alone.
 * @param command - the build command.
 * @param cwd - where it runs, for a relative path.
 * @returns the file made executable, if any.
 */
export function ensureExecutable(command: string, cwd: string): string | undefined {
  const first = command.trim().split(/\s+/)[0] ?? ''
  if (!first.includes('/')) return undefined
  const path = isAbsolute(first) ? first : join(cwd, first)
  if (!existsSync(path)) return undefined
  const st = statSync(path)
  if (!st.isFile() || (st.mode & 0o100) !== 0) return undefined
  chmodSync(path, st.mode | 0o111)
  return path
}

/** Directory names never counted as build inputs when deciding freshness (VCS, deps, and the
 * campaign output root itself, which the engine and this module write into constantly). */
const FRESHNESS_SKIP_DIRS = new Set(['.git', 'node_modules', '.pbfuzz'])

/**
 * The target binary's path — the first whitespace token of `entry.run_cmd`, resolved against
 * `entry.cwd ?? target.repo` — or `undefined` when it cannot be determined or does not exist.
 * @param campaign - the drafted campaign.
 * @returns the binary path, or `undefined`.
 */
function targetBinaryPath(campaign: PbfuzzCampaign): string | undefined {
  const first = campaign.entry.run_cmd.trim().split(/\s+/)[0] ?? ''
  if (first === '' || first === '@@') return undefined
  const cwd = campaign.entry.cwd ?? campaign.target.repo
  const path = isAbsolute(first) ? first : join(cwd, first)
  return existsSync(path) ? path : undefined
}

/**
 * Whether any regular file under `dir` (recursively, skipping {@link FRESHNESS_SKIP_DIRS}, the
 * campaign output root, and the binary itself) is newer than `mtimeMs`. Errs toward `false` (treat
 * unreadable entries as not-newer) so a filesystem hiccup rebuilds rather than falsely skips.
 * Symlinks are neither followed nor treated as files, so no cycle can hang the walk.
 * @param dir - directory to scan.
 * @param mtimeMs - the binary's mtime to compare against.
 * @param outputRoot - the campaign output dir to exclude.
 * @param binPath - the binary itself, excluded from the comparison.
 * @returns `true` if a newer source file exists.
 */
function anyNewerThan(dir: string, mtimeMs: number, outputRoot: string, binPath: string): boolean {
  let entries: Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return false }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (FRESHNESS_SKIP_DIRS.has(entry.name) || path === outputRoot) continue
      if (anyNewerThan(path, mtimeMs, outputRoot, binPath)) return true
    } else if (entry.isFile() && path !== binPath) {
      try { if (statSync(path).mtimeMs > mtimeMs) return true } catch { /* unreadable: not newer */ }
    }
  }
  return false
}

/**
 * Whether the target binary already exists and is newer than every source file under the build
 * directory — a conservative check so a redundant full rebuild of an unchanged tree is skipped,
 * while any source edit (the canary-insertion case) still forces a rebuild. Any doubt returns
 * `false` (rebuild): a false "stale" only costs a rebuild, a false "fresh" would ship a stale
 * binary, so the asymmetry is deliberate.
 * @param campaign - the drafted campaign.
 * @returns `true` when the build can be safely skipped.
 */
export function isBuildFresh(campaign: PbfuzzCampaign): boolean {
  const bin = targetBinaryPath(campaign)
  if (bin === undefined) return false
  const root = campaign.build?.dir ?? campaign.target.repo
  try {
    const binMtime = statSync(bin).mtimeMs
    return !anyNewerThan(root, binMtime, campaign.output?.dir ?? '', bin)
  } catch {
    return false
  }
}

/**
 * Build the target and run it once on an empty input.
 *
 * Never throws: a failed step is a `{ok: false}` entry with the real output, which the caller puts
 * in front of the user rather than turning into an exception the model has to interpret.
 *
 * The build step is skipped when {@link isBuildFresh} proves the binary is already newer than every
 * source — a redundant full rebuild of an unchanged tree was the single largest avoidable cost in a
 * recorded nginx session (~11 min). The run-on-empty-input step ALWAYS executes, skip or not, so the
 * drafted campaign still states something actually observed (see the module doc comment).
 * @param campaign - the drafted campaign.
 * @param timeouts - per-step budgets.
 * @param signal - aborts an in-flight build/run (a cancelled `draft`); the child group is killed.
 * @returns one entry per step actually attempted.
 */
export async function verifyEnvironment(
  campaign: PbfuzzCampaign,
  timeouts: VerifyTimeouts = DEFAULT_VERIFY_TIMEOUTS,
  signal?: AbortSignal,
): Promise<CampaignVerification[]> {
  const out: CampaignVerification[] = []
  const buildCmd = campaign.build?.cmd
  if (buildCmd !== undefined) {
    if (isBuildFresh(campaign)) {
      out.push({ step: `build (\`${buildCmd}\`)`, ok: true, detail: 'skipped: binary already newer than all sources' })
    } else {
      const cwd = campaign.build?.dir ?? campaign.target.repo
      ensureExecutable(buildCmd, cwd)
      const result = await runCommand(buildCmd, cwd, timeouts.buildSec, undefined, undefined, signal)
      const ok = !result.timedOut && result.code === 0
      out.push({
        step: `build (\`${buildCmd}\`)`,
        ok,
        detail: ok ? `${describe(result, timeouts.buildSec)}${tail(result) === '' ? '' : `: ${tail(result)}`}` : `${describe(result, timeouts.buildSec)}: ${tail(result) || 'no output'}`,
      })
      // A target that did not build cannot be run; say so instead of reporting a second failure
      // whose cause is the first one.
      if (!ok) {
        out.push({ step: 'run on an empty input', ok: false, detail: 'skipped: the build did not succeed' })
        return out
      }
    }
  }

  // A campaign-local scratch dir, never the system /tmp: the plugin writes nothing under /tmp, and
  // routing through it is what led the agent to the guard-denied `cp .pbfuzz/... /tmp/...` detours.
  // `draft` runs verification before `host.save` creates the campaign dir, so ensure it exists.
  // `output.dir` is always set for a real campaign; fall back to the build/repo dir defensively so
  // this never-throws helper stays true to its contract on a partial campaign.
  const scratchParent = campaign.output?.dir ?? campaign.build?.dir ?? campaign.target.repo
  mkdirSync(scratchParent, { recursive: true })
  const dir = mkdtempSync(join(scratchParent, '.verify-'))
  try {
    const inputPath = join(dir, 'empty.bin')
    writeFileSync(inputPath, Buffer.alloc(0))
    const byFile = campaign.entry.input_channel === 'file'
    const command = byFile ? campaign.entry.run_cmd.replace(/@@/g, inputPath) : campaign.entry.run_cmd
    const result = await runCommand(
      command,
      campaign.entry.cwd ?? campaign.target.repo,
      timeouts.runSec,
      campaign.entry.env,
      byFile ? undefined : Buffer.alloc(0),
      signal,
    )
    // Any clean termination proves the command line is right; a target that rejects an empty
    // input with a non-zero status has still demonstrated exactly what this step checks.
    const ok = !result.timedOut && result.signal === null
    out.push({
      step: `run on an empty input (\`${campaign.entry.run_cmd}\`)`,
      ok,
      detail: `${describe(result, timeouts.runSec)}${tail(result) === '' ? '' : `: ${tail(result)}`}`,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return out
}
