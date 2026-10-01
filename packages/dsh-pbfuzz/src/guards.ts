/**
 * The one native `ctx.tools.guard()` registration — phase gating, the state-directory/
 * metrics.json write invariant, and best-effort bash tamper detection, all decided by the pure
 * `core/guard-policy.ts::decide()` — plus the `tools/result` bash tamper audit ledger.
 *
 * @module @pbfuzz/dsh-pbfuzz/guards
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { bashGuardVerdict } from './core/bash-guard.ts'
import { formatDeny } from './core/digest.ts'
import { decide, type GuardExec } from './core/guard-policy.ts'
import type { AgentLike, PbfuzzHost } from './host.ts'

/**
 * The interactive-debugging terminal tool names this DSH deployment actually registers, read
 * fresh from `ctx.tools.schemas()` rather than hardcoded. Verified against the installed runtime
 * (0.1.5-rc.1/rc.2): there is no installed `@deepseek-ai/dsh-tool-terminal`-equivalent package at
 * all in this deployment, so no tool is ever named `terminal_open`/`terminal_send` and this
 * normally returns `[]` — matching `docs/verification-notes.md`'s own live finding ("`terminal_open`
 * does not exist in DSH 0.1.5-rc.1"). Feature-detecting here rather than hardcoding the names into
 * `core/guard-policy.ts` (which does not, and must not, read `ctx` at all — see its own module doc
 * comment) means a future deployment that DOES install a real terminal-tool package is gated
 * correctly with no code change, as long as it registers under these same two names; the callback
 * only ever needs the OPEN/SEND-equivalent names (`guard-policy.ts`'s `GuardView.terminalToolNames`
 * doc comment explains why the housekeeping ones — read/list/signal/close — must never be listed
 * here).
 * @param ctx - plugin context.
 * @returns the currently registered OPEN/SEND-equivalent terminal tool names (usually empty).
 */
function terminalToolNames(ctx: Context): string[] {
  return ctx.tools.schemas()
    .map(schema => schema.name)
    .filter(name => name === 'terminal_open' || name === 'terminal_send')
}

/** For `write`/`edit`: the raw (unresolved) path argument, trying `file_path` first (what
 * `@deepseek-ai/dsh-tool-fs`'s real `write`/`edit` tools both use) then `path` defensively, in
 * case a differently-shaped filesystem tool is ever gated the same way. */
function rawPathArgument(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  if (typeof record.file_path === 'string') return record.file_path
  if (typeof record.path === 'string') return record.path
  return undefined
}

/**
 * Build the {@link GuardExec} `core/guard-policy.ts::decide()` needs from a real `ToolExecution`.
 * @param host - the plugin host, for path resolution.
 * @param exec - the tool call being decided on.
 * @returns the narrowed, guard-policy-shaped view of the call.
 */
function guardExecOf(host: PbfuzzHost, exec: Readonly<ToolExecution>): GuardExec {
  const agent = exec.agent as AgentLike | undefined
  if (exec.name === 'write' || exec.name === 'edit') {
    const raw = rawPathArgument(exec.arguments)
    return raw === undefined ? { name: exec.name } : { name: exec.name, resolvedPath: host.resolvePath(agent, raw) }
  }
  if (exec.name === 'bash') {
    const args = exec.arguments as { command?: unknown } | undefined
    return typeof args?.command === 'string' ? { name: exec.name, bashCommand: args.command } : { name: exec.name }
  }
  return { name: exec.name }
}

/**
 * Register the single native guard. GLOBAL (`ctx.tools.guard()`, not `agent.ctx.tools.guard()`) —
 * deliberate, not an oversight: `core/guard-policy.ts::decide()` already has its own zero-cost fast
 * path for a call this module has no reason to gate (`view === undefined`, checked below BEFORE
 * this function does anything else — no `ctx.tools.schemas()` clone, no campaign file read — and,
 * inside `decide()` itself, a non-gated tool name), so a global registration is exactly as cheap
 * for a non-pbfuzz session as a per-agent one would be. Registering globally is also simpler: one
 * registration in `apply()`, no per-agent lifecycle (attach on `agent/created`, detach on
 * `agent/disposed`) to manage for a guard whose actual decision already depends only on the
 * calling agent's own workspace, read fresh from `host` on every call.
 *
 * The pre-check below (`host.active(agent) === undefined` → return `undefined` immediately) is
 * what actually delivers that zero-cost path: `host.guardView()`'s OWN internal fast exit already
 * makes it cheap to call unconditionally on every gated tool call, but `terminalToolNames(ctx)` is
 * a plain array this module must build BEFORE calling `guardView()` (its parameter, not a lazy
 * thunk — `host.ts` is frozen this wave), and `ctx.tools.schemas()` clones one schema per globally
 * visible tool. Without this pre-check, every tool call in every session — including one that has
 * never touched pbfuzz at all — would pay that clone on every call, defeating the exact "zero-cost
 * for non-pbfuzz sessions" property a global registration is supposed to preserve.
 *
 * The whole callback body — not just the call into `decide()` — is wrapped in one try/catch.
 * `decide()`'s own "MUST NEVER THROW" contract (`core/guard-policy.ts`) only covers what happens
 * once it has a `GuardView` in hand; `host.active()`/`host.guardView()`/`terminalToolNames()` all
 * run BEFORE that, in this module, so a throw from any of them would otherwise escape straight to
 * `ctx.tools.guard()` — which, per that same doc comment, has no try/catch of its own — as an
 * opaque, unsigned tool error, defeating the fail-closed design this rewrite settled on (an
 * assembled smoke test driving the real dsh-tools dispatch caught exactly this gap: forcing
 * `host.guardView()` to throw produced a denial, since dsh-tools' own runtime happens to catch an
 * uncaught guard exception too, but with the raw thrown message rather than the authored
 * `[pbfuzz:guard-error]` deny `decide()` produces for an internal exception it can see). Catching
 * here as well closes that gap: EVERY internal exception in this guard, wherever it originates,
 * now produces the identical signed, actionable deny.
 * @param ctx - plugin context.
 * @param host - the plugin's host state.
 */
export function installGuard(ctx: Context, host: PbfuzzHost): void {
  ctx.tools.guard((exec) => {
    try {
      const agent = exec.agent as AgentLike | undefined
      if (host.active(agent) === undefined) return undefined
      const view = host.guardView(agent, terminalToolNames(ctx))
      return decide(view, guardExecOf(host, exec))
    } catch (error) {
      const name = typeof exec.name === 'string' ? exec.name : 'unknown-tool'
      const message = error instanceof Error ? error.message : String(error)
      return formatDeny(
        'guard-error',
        name,
        `pbfuzz's guard threw while deciding on this call (${message}); denying rather than risking a silent bypass`,
        'retry the call; if this keeps happening, tell the user pbfuzz\'s guard is broken',
      )
    }
  })
}

/** One line of `<campaign dir>/tamper-ledger.jsonl` (the filename `core/bash-guard.ts`'s own
 * `CAMPAIGN_FILES` table already reserves as a protected path). */
interface TamperLedgerEntry {
  at: string
  tool: string
  command: string
  target: string
  mutation: string
  /** Whether the call actually landed (`false` when the live guard denied it; `true` when it
   * matched `bashGuardVerdict` but ran anyway — e.g. `guards.bashGuard` was off in settings — which
   * is exactly the case an audit-only ledger exists to make visible). */
  allowed: boolean
}

/** Best-effort append; a failed ledger write (a missing campaign dir, a full disk) must never
 * affect the tool call it is observing — the guard has already made its allow/deny decision by the
 * time this runs, and this ledger is audit-only. */
function appendTamperLedgerEntry(campaignDir: string, entry: TamperLedgerEntry): void {
  const path = join(campaignDir, 'tamper-ledger.jsonl')
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(entry)}\n`)
  } catch { /* audit-only: never surfaced to the call site */ }
}

/**
 * Register the bash tamper audit-ledger observer on `tools/result` — the seam the plan's
 * native-seam table names for this ("审计 ledger | `tools/result` 观察者"). Observational only:
 * `bashGuardVerdict` is re-run independently of whatever the live guard decided (it takes no
 * settings at all — see its own module doc comment), so this records EVERY command that mentions a
 * protected path with a mutation in the same clause, whether the guard actually blocked it
 * (`guards.bashGuard` on) or let it through (`guards.bashGuard` off) — the second case being
 * precisely what an audit trail needs to catch. Gated by `settings.guards.tamperLedger`; never
 * blocks anything, never throws past its own boundary.
 * @param ctx - plugin context.
 * @param host - the plugin's host state.
 */
export function installTamperLedger(ctx: Context, host: PbfuzzHost): void {
  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    if (exec.name !== 'bash') return
    const agent = exec.agent as AgentLike | undefined
    const active = host.active(agent)
    if (active === undefined || !host.settings().guards.tamperLedger) return
    const args = exec.arguments as { command?: unknown } | undefined
    const command = typeof args?.command === 'string' ? args.command : ''
    const verdict = bashGuardVerdict(command, active.layout.stateDir)
    if (!verdict.denied) return
    appendTamperLedgerEntry(active.layout.dir, {
      at: new Date().toISOString(),
      tool: exec.name,
      command,
      target: verdict.target ?? '',
      mutation: verdict.mutation ?? '',
      allowed: !result.isError,
    })
  })
}

/**
 * Install everything this module owns.
 * @param ctx - plugin context.
 * @param host - the plugin's host state.
 */
export function installGuards(ctx: Context, host: PbfuzzHost): void {
  installGuard(ctx, host)
  installTamperLedger(ctx, host)
}
