/**
 * Process execution with a wall-clock timeout, an address-space limit and bounded memory use.
 * Linux-only by design (the memory limit is `ulimit -v` in a `/bin/sh` trampoline).
 *
 * @module @pbfuzz/dsh-kanalyzer/host/exec
 */

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'

/** Options for one process run. */
export interface RunOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** Address-space limit in MB; omitted = unlimited. */
  memLimitMB?: number
  signal?: AbortSignal
  /** Stream stderr to this file in full (KAMain logs can be large). */
  stderrFile?: string
  /** Keep only stderr lines matching this in memory; default keeps everything up to `maxBuffered`. */
  stderrFilter?: (line: string) => boolean
  /** Byte cap for in-memory stdout/stderr. */
  maxBuffered?: number
  /**
   * Called with each decoded chunk as it arrives, before it is appended to the buffered
   * `stdout`/`stderr` string and before the `maxBuffered` cap is applied — so a caller streaming
   * output (a progress log, a job's `readOutput`) keeps seeing it even once buffering stops. A
   * throwing callback is caught and ignored; it must never abort the run.
   */
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void
}

/** What a run returned. */
export interface RunResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stdout: string
  stderr: string
  elapsedMs: number
}

/**
 * Run `command args…` and settle when it exits. Never rejects for a non-zero exit.
 * @param command - executable.
 * @param args - argv.
 * @param opts - run options.
 * @returns the outcome.
 */
export function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const started = Date.now()
  const max = opts.maxBuffered ?? 8 * 1024 * 1024
  const [cmd, argv] = opts.memLimitMB !== undefined
    ? ['/bin/sh', ['-c', `ulimit -v ${String(opts.memLimitMB * 1024)} && exec "$0" "$@"`, command, ...args]]
    : [command, args]
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd: opts.cwd, env: opts.env ?? process.env as Record<string, string>, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const file = opts.stderrFile !== undefined ? createWriteStream(opts.stderrFile) : undefined
    let stdout = ''
    let stderr = ''
    let partial = ''
    let timedOut = false
    const kill = (): void => { try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }
    const timer = opts.timeoutMs !== undefined ? setTimeout(() => { timedOut = true; kill() }, opts.timeoutMs) : undefined
    const onAbort = (): void => { kill() }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const emit = (chunk: string, stream: 'stdout' | 'stderr'): void => {
      if (opts.onOutput === undefined) return
      try { opts.onOutput(chunk, stream) } catch { /* a caller's callback must not crash the run */ }
    }
    child.stdout.on('data', (b: Buffer) => {
      const chunk = b.toString('utf8')
      emit(chunk, 'stdout')
      if (stdout.length < max) stdout += chunk
    })
    child.stderr.on('data', (b: Buffer) => {
      file?.write(b)
      const chunk = b.toString('utf8')
      emit(chunk, 'stderr')
      const text = partial + chunk
      const parts = text.split('\n')
      partial = parts.pop() ?? ''
      for (const line of parts) {
        if (stderr.length >= max) break
        if (opts.stderrFilter === undefined || opts.stderrFilter(line)) stderr += `${line}\n`
      }
    })
    const finish = (exitCode: number | null, sig: NodeJS.Signals | null): void => {
      if (timer !== undefined) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (partial.length > 0 && (opts.stderrFilter === undefined || opts.stderrFilter(partial))) stderr += partial
      const done = (): void => { resolve({ exitCode, signal: sig, timedOut, stdout, stderr, elapsedMs: Date.now() - started }) }
      if (file !== undefined) file.end(done); else done()
    }
    child.on('error', (err) => { stderr += `spawn failed: ${err.message}\n`; finish(127, null) })
    child.on('close', finish)
  })
}

/** Keep only the KAMain stderr lines `core/stderr.ts` looks at — bounded memory at any verbosity. */
export function kamainStderrFilter(line: string): boolean {
  return line.includes('[WARN]') || line.includes('Reachable: Target: ') || line.includes('Entry function detected')
    || line.includes('=== Target is reachable') || line.startsWith('ERROR (') || line.includes('error loading file')
    || line.startsWith('Total ')
}
