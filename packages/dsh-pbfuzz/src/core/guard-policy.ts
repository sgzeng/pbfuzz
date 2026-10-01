/**
 * The one decision function a later wave's `ctx.tools.guard()` registration calls.
 *
 * Ported from `engine/hooks/pbfuzz_hooks/guards.py`'s `state_guard`, `phase_gate` and
 * `bash_guard` (the three `PreToolUse` guards; `digest`/`resume`/`stop_guard` are `PostToolUse`/
 * `UserPromptSubmit`/`Stop` concerns with their own native seams, owned by a later wave — see the
 * rewrite plan's native-seam table). `ctx.tools.guard()` itself is synchronous, evaluated after
 * every `tools/pre-execute` listener, and monotonic — no guard can force-allow a call another
 * guard denied — so `decide()` below only ever narrows: it returns `undefined` (allow) or a
 * formatted denial (`digest.ts`'s `formatDeny()`), never anything else.
 *
 * Under this rewrite's P3 design change the agent no longer writes campaign state directly: a
 * family of pbfuzz tools (`pbfuzz_plan`, `pbfuzz_fuzz`, `pbfuzz_reflect`, `pbfuzz_campaign`) owns
 * every state write, each validating its own input before touching disk. That collapses
 * `state_guard`'s old schema-validation branch (`guards.py`'s ~140 lines of JSON-Schema checking
 * plus FSM-transition validation) to one rule: any `write`/`edit` whose resolved path falls under
 * the campaign's state directory is denied outright, pointing at the tool that owns that file.
 * `schema.py`'s validator has no port here at all — that whole class of check now lives in a
 * different module (`core/state-blocks.ts`) owned by a different tool.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/guard-policy
 */

import type { PbfuzzPhase, PbfuzzSettings, SelfcheckItemName } from './contracts.ts'
import { toolEnabledInSettings } from './phases.ts'
import { NEXT_STEP } from './fsm.ts'
import { formatDeny } from './digest.ts'
import { bashGuardVerdict } from './bash-guard.ts'
import { POLICY } from '../generated/policy.ts'

/**
 * Everything the guard needs about the calling agent's campaign; `undefined` = no active campaign
 * in this workspace. All fields are already resolved in memory by the caller — this module does
 * ZERO file I/O and ZERO network I/O, matching `ctx.tools.guard()`'s synchronous contract.
 */
export interface GuardView {
  /** The current PIER phase. */
  phase: PbfuzzPhase
  /** Whether `pbfuzz_campaign confirm` has been called (`campaign.confirmed === true`). */
  confirmed: boolean
  /** Absolute path, campaign's `.pbfuzz/<id>/state` directory. */
  stateDir: string
  /** The settings sections this module reads; a subset of `PbfuzzSettings` so a caller can hand
   * over less than the whole resolved settings object. */
  settings: Pick<PbfuzzSettings, 'guards' | 'budget' | 'tools'>
  /** Whether an analysis provider (kanalyzer) is actually registered. Currently unused by
   * `decide()` — `phase_gate` in `guards.py` never checked provider presence either, that is a
   * `visibleTools()`-only concern (PLAN's "visibility is not enforcement" split) — kept here for
   * shape-parity with `phases.ts`'s `VisibilityInput` and for a future rule that might need it. */
  providerPresent: boolean
  /** Tool names this DSH deployment actually registers for interactive debugging (feature-detected
   * by the caller from `ctx.tools.schemas()` — this release likely has none, so this is normally
   * `[]`). These are the OPEN/SEND-equivalent actions only: `guards.py`'s `_terminal_gate` deliberately
   * never gated `terminal_read`/`terminal_list`/`terminal_signal`/`terminal_close` at all ("they
   * start nothing, and a session opened in REFLECT must stay inspectable and closable after the
   * phase moves on") — this module assumes the caller only ever puts the start/send-equivalent
   * names in this list, never the housekeeping ones, so branch 5 below never needs to special-case
   * them itself. */
  terminalToolNames: readonly string[]
}

/** Minimal shape of a `ToolExecution` this module needs; the real one has more fields. */
export interface GuardExec {
  /** The tool name as the model invoked it. */
  name: string
  /** For `write`/`edit`: the ALREADY-RESOLVED absolute path of `file_path`/`path`, if present and
   * a string. The caller does path resolution (it needs the agent's cwd); this module never
   * touches paths beyond a string prefix check. */
  resolvedPath?: string
  /** For `bash`: the command string, if present. */
  bashCommand?: string
}

/** Which self-check item backs each tool, narrowed to a lookup that tolerates an unknown tool
 * name. Only pbfuzz's OWN tools are keys: `tools.staticAnalysis` and the `static_analysis`
 * self-check decide whether *pbfuzz* uses static analysis in its pipeline (hence
 * `pbfuzz_callgraph`), not whether the user may drive the separate kanalyzer plugin directly —
 * so the `kanalyzer_*` names are deliberately absent and fall through as allowed. kanalyzer
 * diagnoses its own unavailability through `kanalyzer_doctor`; pbfuzz must not switch off a
 * plugin it does not own. Mirrors `phases.ts`'s identical narrowing of the same
 * `POLICY.toolBacking`. */
const TOOL_BACKING: Partial<Record<string, SelfcheckItemName>> = POLICY.toolBacking

/** The settings path backing each optional self-check item, for the "which switch to flip" text
 * in a `phase-gate/disabled` denial. `engine`/`oracle` are deliberately absent: neither has a
 * settings switch (`toolEnabledInSettings` always returns `true` for them), so a denial naming
 * them here is structurally unreachable — see the call site. */
const SETTING_NAME: Partial<Record<SelfcheckItemName, string>> = {
  static_analysis: 'tools.staticAnalysis',
  corpus: 'tools.corpusAnalysis',
  deviation: 'tools.deviationDetection',
  tracer: 'tools.tracer',
}

/**
 * Whether `path` lies under `dir`, with a path-separator boundary so a sibling directory that
 * merely shares a name prefix (e.g. `state2/` next to `state/`) never false-positives.
 * @param path - an absolute, already-resolved path.
 * @param dir - an absolute directory path, no trailing separator required.
 * @returns whether `path` is `dir` itself or lies inside it.
 */
function isUnderDir(path: string, dir: string): boolean {
  const normalized = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return path === normalized || path.startsWith(`${normalized}/`)
}

/** The final path segment of `path`. */
function basename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

/**
 * The tools to suggest in a `phase-gate/phase` denial's "use one of ..." text. Mirrors
 * `guards.py`'s `_legal_tools()`: before a confirmed campaign, while
 * `guards.hideToolsWithoutCampaign` is on, only the no-campaign tool set is offered (the same
 * carve-out `phases.ts`'s `visibleTools()` applies for the identical state) — otherwise the
 * phase's own tools, plus the literal `kanalyzer_*` wildcard when kanalyzer is available in this
 * phase at all (not expanded to individual names, matching the Python original).
 * @param view - the guard view.
 * @returns the tool names to suggest, in the order `guards.py` would print them.
 */
function legalToolsSuggestion(view: GuardView): string[] {
  if (!view.confirmed && view.settings.guards.hideToolsWithoutCampaign) {
    return [...POLICY.noCampaignTools].sort()
  }
  const tools: string[] = [...(POLICY.phaseTools[view.phase] ?? [])].sort()
  // Always suggestable: kanalyzer is neither phase-gated nor governed by pbfuzz's own
  // `tools.staticAnalysis` switch any more (see {@link phaseGateDenial}), so there is no state in
  // which its tools are legal to call but wrong to name here.
  if ((POLICY.kanalyzerPhases as readonly string[]).includes(view.phase)) tools.push('kanalyzer_*')
  return tools
}

/** Denies for the always-owned-elsewhere family: any `write`/`edit` under the state directory. */
function stateWriteDenial(name: string, resolvedPath: string, view: GuardView): string | undefined {
  if (!isUnderDir(resolvedPath, view.stateDir)) return undefined
  const file = basename(resolvedPath)
  if (file === 'metrics.json') {
    return formatDeny(
      'state-write/metrics-engine-only',
      name,
      `${name} targets state/metrics.json, which only the fuzzing engine may write (it is REFLECT's trusted evidence)`,
      'read metrics.json instead; to change it, run pbfuzz_fuzz',
    )
  }
  return formatDeny(
    'state-write/owned-by-tool',
    name,
    `${name} would write ${file} directly under the campaign's state directory, which pbfuzz's own tools now own`,
    'use pbfuzz_plan / pbfuzz_fuzz / pbfuzz_reflect / pbfuzz_campaign instead of write/edit for state files',
  )
}

/** `bash`: best-effort tamper detection via `bash-guard.ts`. */
function bashDenial(name: string, exec: GuardExec, view: GuardView): string | undefined {
  if (!view.settings.guards.bashGuard) return undefined
  const command = typeof exec.bashCommand === 'string' ? exec.bashCommand : ''
  const verdict = bashGuardVerdict(command, view.stateDir)
  if (!verdict.denied) return undefined
  return formatDeny(
    'bash-guard/state-tamper',
    name,
    `this shell command would modify pbfuzz state (${JSON.stringify(verdict.target)} with ${JSON.stringify(verdict.mutation)}); state changes must go through pbfuzz's own tools, and metrics.json only through the engine`,
    'read-only commands (cat, jq, grep) are fine; if the command only touches other files, split it so it no longer mentions the state directory',
  )
}

/**
 * The interactive-debugging terminal tools: legal only in REFLECT, and only while
 * `tools.interactiveDebug` is on. Ported from `guards.py`'s `_terminal_gate`. Both sub-cases share
 * one rule id (`phase-gate/terminal`) — a deliberate simplification versus `guards.py`, which used
 * `phase_gate/phase`/`phase_gate/disabled` here too (the same two rules `decide()`'s phase-gate and
 * backing-item branches use below); giving the terminal case its own rule id keeps a dashboard
 * that groups by rule from conflating "this pbfuzz tool is wrong for this phase" with "the
 * terminal is wrong for this phase", which are different operator-facing situations even though
 * the underlying Python used the same string for both.
 */
function terminalDenial(name: string, view: GuardView): string | undefined {
  if (view.phase !== 'REFLECT') {
    return formatDeny(
      'phase-gate/terminal',
      name,
      `${name} (interactive debugging in DSH's terminal) is only legal in REFLECT, not in phase ${view.phase}`,
      `${NEXT_STEP[view.phase]}; the terminal is available again once the campaign reaches REFLECT`,
    )
  }
  if (!view.settings.tools.interactiveDebug) {
    return formatDeny(
      'phase-gate/terminal',
      name,
      `${name} needs interactive debugging, which is turned off in settings (tools.interactiveDebug)`,
      'analyse this round with pbfuzz_trace / pbfuzz_deviation instead (the user can enable interactive debugging in Settings → pbfuzz)',
    )
  }
  return undefined
}

/** `pbfuzz_*`/`kanalyzer_*`: the phase gate plus the backing-item (settings + self-check) check. */
function phaseAndBackingDenial(name: string, view: GuardView): string | undefined {
  const isKanalyzer = name.startsWith('kanalyzer_')
  // The unconfirmed-campaign kanalyzer carve-out is checked by the caller (decide()) before this
  // function is reached at all, matching guards.py's branch order (standalone kanalyzer analysis
  // is never phase-gated while unconfirmed, regardless of what follows here).
  const phaseTools: readonly string[] = POLICY.phaseTools[view.phase] ?? []
  const allowed = isKanalyzer ? (POLICY.kanalyzerPhases as readonly string[]).includes(view.phase) : phaseTools.includes(name)
  if (!allowed) {
    const why = view.phase === 'STOPPED'
      ? 'the PIER budget or wall clock is exhausted and the campaign is over'
      : `${name} is not legal in phase ${view.phase}`
    return formatDeny('phase-gate/phase', name, why, `use one of ${legalToolsSuggestion(view).join(', ')}; ${NEXT_STEP[view.phase]}`)
  }

  const item = TOOL_BACKING[name]
  if (item === undefined) return undefined
  if (!toolEnabledInSettings(item, view.settings)) {
    // Unreachable for 'engine'/'oracle': toolEnabledInSettings() always returns true for them
    // (neither has a settings switch), so SETTING_NAME[item] below is only ever read for one of
    // the four optional items that do have one.
    return formatDeny(
      'phase-gate/disabled',
      name,
      `${name} needs ${item.replace(/_/g, ' ')}, which is turned off in settings (${SETTING_NAME[item] ?? item})`,
      `continue without it — ${NEXT_STEP[view.phase]} (the user can enable it in Settings → pbfuzz)`,
    )
  }
  return undefined
}

/** The decision core, wrapped by {@link decide} in a try/catch so nothing here can ever throw
 * past this module's boundary. */
function decideInner(view: GuardView, exec: GuardExec): string | undefined {
  const name = typeof exec?.name === 'string' ? exec.name : ''
  const isPbfuzzOrKanalyzer = name.startsWith('pbfuzz_') || name.startsWith('kanalyzer_')
  const terminalToolNames = Array.isArray(view.terminalToolNames) ? view.terminalToolNames : []
  const isTerminal = terminalToolNames.includes(name)
  if (!isPbfuzzOrKanalyzer && name !== 'write' && name !== 'edit' && name !== 'bash' && !isTerminal) {
    return undefined // not a gated call
  }

  if (name === 'write' || name === 'edit') {
    const resolvedPath = typeof exec?.resolvedPath === 'string' ? exec.resolvedPath : undefined
    if (resolvedPath === undefined) return undefined
    return stateWriteDenial(name, resolvedPath, view)
  }

  if (name === 'bash') {
    return bashDenial(name, exec, view)
  }

  if (isTerminal) {
    return terminalDenial(name, view)
  }

  const isKanalyzer = name.startsWith('kanalyzer_')
  if (isKanalyzer && !view.confirmed) {
    // An unconfirmed campaign does not gate standalone kanalyzer use: the campaign's
    // tools.staticAnalysis setting says nothing about whether the user may ask kanalyzer
    // directly. Matches the host-side carve-out in phases.ts's visibleTools().
    return undefined
  }

  return phaseAndBackingDenial(name, view)
}

/**
 * The one entry point a later wave's `ctx.tools.guard()` callback calls. Pure, synchronous, and
 * MUST NEVER THROW for any input (including a garbage/malformed `exec` shape) — every internal
 * branch runs inside a try/catch here, and any exception becomes an authored, signed deny
 * (fail-closed) rather than an exception escaping the callback: `ctx.tools.guard()` has no
 * try/catch of its own, so a throw here would surface as an opaque tool error with no reason
 * shown to the model, for every tool call in the session, not just pbfuzz's.
 * @param view - the calling agent's campaign state, or `undefined` when none is active.
 * @param exec - the tool call being decided on.
 * @returns `undefined` to allow, a formatted deny string (`digest.ts`'s `formatDeny()`) to deny.
 */
export function decide(view: GuardView | undefined, exec: GuardExec): string | undefined {
  if (view === undefined) return undefined // no active campaign; zero-cost no-op.
  try {
    return decideInner(view, exec)
  } catch (error) {
    const name = typeof (exec as { name?: unknown } | null | undefined)?.name === 'string' ? (exec as { name: string }).name : 'unknown-tool'
    const message = error instanceof Error ? error.message : String(error)
    return formatDeny(
      'guard-error',
      name,
      `pbfuzz's guard threw while deciding on this call (${message}); denying rather than risking a silent bypass`,
      `retry the call; if this keeps happening, tell the user pbfuzz's guard is broken`,
    )
  }
}
