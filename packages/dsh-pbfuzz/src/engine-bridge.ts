/**
 * The Python engine sidecar: spawned on demand, restarted when `execution.pythonPath` changes,
 * spoken to through {@link EngineRpcClient}.
 *
 * @module @pbfuzz/dsh-pbfuzz/engine-bridge
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { EngineRpcClient, type RpcMethod, type RpcProgressListener } from './core/rpc.ts'

/**
 * argv after the interpreter: W2's server, which serves NDJSON JSON-RPC on stdio when run this
 * way (`engine/pbfuzz_engine/rpc.py` delegates to the package entry point).
 */
export const ENGINE_ARGV = ['-m', 'pbfuzz_engine.rpc'] as const

/**
 * Environment that lets `python -m pbfuzz_engine.rpc` import the engine without a pip install:
 * `PYTHONPATH` gains the engine source directory, found as `$PBFUZZ_ENGINE_DIR`, the in-repo
 * `<repo>/engine` (a development checkout wins, so a staged copy is never stale there), or the
 * copy shipped in the npm package at `<package>/engine` (engine + pure-Python PyYAML, staged by
 * `scripts/stage-engine.mjs`; nothing to pip install). Empty when none exists, i.e. the engine is
 * expected to be installed into `execution.pythonPath`, which then also needs PyYAML.
 * @param packageRoot - the dsh-pbfuzz package root.
 * @param env - the environment to extend (defaults to this process's).
 * @returns extra environment for the sidecar.
 */
export function engineEnv(packageRoot: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const candidates = [env.PBFUZZ_ENGINE_DIR, join(packageRoot, '..', '..', 'engine'), join(packageRoot, 'engine')]
  const dir = candidates.find((d): d is string => d !== undefined && d !== '' && existsSync(join(d, 'pbfuzz_engine', 'rpc.py')))
  if (dir === undefined) return {}
  const abs = resolve(dir)
  const existing = env.PYTHONPATH
  return { PYTHONPATH: existing !== undefined && existing !== '' ? `${abs}${delimiter}${existing}` : abs }
}

/** The value of `execution.pythonPath` meaning "pick an interpreter for me". */
export const DEFAULT_PYTHON = 'python3'

/** Interpreters tried, in order, when `execution.pythonPath` is left at {@link DEFAULT_PYTHON}. */
const PYTHON_CANDIDATES = [DEFAULT_PYTHON, 'python3.15', 'python3.14', 'python3.13', 'python3.12', 'python3.11'] as const

/** Interpreter chosen for the default, kept for the process lifetime: a probe costs a process spawn. */
let resolvedDefault: string | undefined

/**
 * Whether `command` is a Python >= 3.11 (the engine's floor). Runs `command` once, briefly.
 * @param command - interpreter name or path.
 */
function isPython311(command: string): boolean {
  const run = spawnSync(command, ['-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf8', timeout: 1_500 })
  return run.status === 0 && run.stdout.trim() === 'True'
}

/**
 * The interpreter the sidecar is spawned with. A configured value other than {@link DEFAULT_PYTHON}
 * is used as is. The default resolves to the first of `python3`, `python3.13`, `python3.12`,
 * `python3.11` that is Python >= 3.11, because the engine needs it and a distribution's `python3`
 * may be older (Ubuntu 22.04 ships 3.10). When none qualifies it stays `python3`, so the failure
 * is the engine's own diagnosed one (`selfcheck.engine`: "the engine needs Python >= 3.11").
 * @param configured - `execution.pythonPath`.
 * @param isSuitable - the version probe; injectable for tests.
 * @returns the command to spawn.
 */
export function resolvePythonPath(configured: string, isSuitable: (command: string) => boolean = isPython311): string {
  if (configured !== DEFAULT_PYTHON) return configured
  const real = isSuitable === isPython311
  if (real && resolvedDefault !== undefined) return resolvedDefault
  const found = PYTHON_CANDIDATES.find(isSuitable)
  if (found === undefined) return DEFAULT_PYTHON // not remembered: the user may install Python and retry
  if (real) resolvedDefault = found
  return found
}

/** Options for the sidecar. */
export interface EngineBridgeOptions {
  pythonPath: string
  /** Extra environment (e.g. PYTHONPATH pointing at the repo's `engine/`). */
  env?: Record<string, string>
  /** stderr sink; stderr is log only. */
  log?: (line: string) => void
}

/**
 * Environment variable names never forwarded to the sidecar. The sidecar runs model-written
 * generator/extractor Python (`pbfuzz_extract_parameters`, `pbfuzz_fuzz`'s `generator_code`) in a
 * subprocess it controls, so anything in this process's own environment that looks like a
 * credential (harness API keys, session tokens, …) must not leak into code the model wrote.
 * Case-insensitive; matches anywhere in the name, matching `KEY`/`SECRET`/`TOKEN`/`PASSWORD`
 * verbatim rather than only as a whole segment, since real-world credential env vars are
 * inconsistently cased and delimited (`OPENAI_API_KEY`, `apiKey`, `DATABASE_PASSWORD`, …) and a
 * false positive here (dropping some unrelated `*KEY*` variable the interpreter or a library
 * happens to read) is far cheaper than a false negative that leaks a real secret.
 */
const SENSITIVE_ENV_NAME = /KEY|SECRET|TOKEN|PASSWORD/i

/**
 * Drop every environment variable whose name matches {@link SENSITIVE_ENV_NAME}. Exported for
 * tests; `ensure()` is the one real caller.
 * @param env - the merged environment about to be handed to `spawn()`.
 * @returns the same entries, minus anything credential-shaped.
 */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (SENSITIVE_ENV_NAME.test(name)) continue
    scrubbed[name] = value
  }
  return scrubbed
}

/** How long `stop()` waits for a graceful `SIGTERM` exit before escalating to `SIGKILL`. */
const STOP_GRACE_MS = 3_000

/** How long `stop()` waits after `SIGKILL` before giving up on the process ever confirming exit. */
const STOP_KILL_GRACE_MS = 1_000

/** Lazily started, restartable engine sidecar. */
export class EngineBridge {
  private child: ChildProcessWithoutNullStreams | undefined
  private client: EngineRpcClient | undefined
  private readonly progress = new Set<RpcProgressListener>()

  constructor(private options: EngineBridgeOptions) {}

  /**
   * Change options (merged over the current ones, so an `env` set at construction survives a
   * settings change); a new `pythonPath` restarts the sidecar at the next call.
   * @param options - the options to change.
   */
  reconfigure(options: Partial<EngineBridgeOptions>): void {
    const next = { ...this.options, ...options }
    const restart = next.pythonPath !== this.options.pythonPath
    this.options = next
    if (restart) void this.stop()
  }

  /**
   * Call one engine method, starting the sidecar if needed.
   * @param method - RPC method.
   * @param params - parameters.
   * @param signal - caller cancellation.
   * @returns the result value.
   */
  call(method: RpcMethod, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.ensure().call(method, params, signal)
  }

  /** Observe progress notifications from any call. */
  onProgress(listener: RpcProgressListener): () => void {
    this.progress.add(listener)
    return () => { this.progress.delete(listener) }
  }

  /**
   * Terminate the sidecar and wait for it to actually reach quiet — not just for the kill signal
   * to be sent — before resolving: a teardown that issues a kill and returns before the process
   * has actually stopped leaves an orphan the next `ensure()` cannot detect (defensive-patterns.md).
   * Progress listeners are cleared first so nothing observes a half-torn-down child; in-flight RPC
   * calls reject through the existing `closeListeners` chain `ensure()` already wires to the
   * child's own `'exit'` handler, so there is nothing extra to fail here.
   *
   * `SIGTERM` first, `SIGKILL` after {@link STOP_GRACE_MS} if the process has not exited, and a
   * short final wait after that — a process that ignores `SIGKILL` too is not something this
   * bridge can wait out forever, and `stop()` must still return so plugin teardown is not held
   * hostage by a wedged interpreter.
   *
   * NEVER rejects. `host.ts`'s `dispose()` (frozen this wave) calls this without awaiting it —
   * exactly the shape a synchronous plugin-disposal effect needs, since `dispose()` itself cannot
   * become async without a host.ts change outside this wave's file ownership — so a rejection here
   * would become an unhandled promise rejection with nothing in that call site to catch it. Every
   * internal failure is caught and logged instead.
   * @returns once the sidecar process has exited, or the bounded grace period has elapsed.
   */
  async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    this.client = undefined
    this.progress.clear()
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
    try {
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          resolve()
        }
        child.once('exit', () => {
          clearTimeout(graceTimer)
          finish()
        })
        const graceTimer = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* already gone */ }
          setTimeout(finish, STOP_KILL_GRACE_MS)
        }, STOP_GRACE_MS)
        child.kill('SIGTERM')
      })
    } catch (error) {
      this.options.log?.(`engine sidecar teardown: ${(error as Error).message}`)
    }
  }

  private ensure(): EngineRpcClient {
    if (this.client !== undefined && this.child?.exitCode === null) return this.client
    const python = resolvePythonPath(this.options.pythonPath)
    const child = spawn(python, [...ENGINE_ARGV], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Scrubbed: this sidecar runs model-written generator/extractor Python, so no host-process
      // credential (a harness API key, a session token, …) may reach it (see SENSITIVE_ENV_NAME).
      env: scrubEnv({ ...process.env, ...this.options.env }),
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim() !== '') this.options.log?.(line)
    })
    const closeListeners: ((reason: string) => void)[] = []
    const close = (reason: string): void => { for (const l of closeListeners) l(reason) }
    child.on('error', error => { close(`failed to start ${python}: ${error.message}`) })
    child.on('exit', (code, sig) => { close(`exited with ${sig ?? `code ${code}`}`) })
    const client = new EngineRpcClient({
      write: line => { child.stdin.write(line) },
      onData: listener => { child.stdout.on('data', listener) },
      onClose: listener => { closeListeners.push(listener) },
    })
    client.onProgress(n => { for (const l of this.progress) l(n) })
    this.child = child
    this.client = client
    return client
  }
}
