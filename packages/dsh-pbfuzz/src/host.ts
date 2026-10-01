/**
 * Host-side campaign state: settings source, provider registry, engine bridge, the active
 * campaign per workspace, file I/O for the `.pbfuzz/<id>/` layout, and per-agent tool visibility.
 * The tools and the command are thin layers over this; so is `state-writer.ts` (the only place
 * `state/*.json` is ever written) and `guards.ts` (the native `ctx.tools.guard()` wiring, built on
 * {@link PbfuzzHost.guardView}).
 *
 * @module @pbfuzz/dsh-pbfuzz/host
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { PbfuzzDashboardView } from './client/dashboard-contract.ts'
import type {
  PbfuzzCampaign,
  PbfuzzMetrics,
  PbfuzzSettings,
  PbfuzzState,
} from './core/contracts.ts'
import { campaignToYaml, parseCampaignYaml, withDefaultOutputDir, type CampaignVerification } from './core/campaign-yaml.ts'
import { validateCampaign } from './core/campaign.ts'
import { buildDashboardView } from './core/dashboard.ts'
import type { GuardView } from './core/guard-policy.ts'
import { NEXT_STEP } from './core/fsm.ts'
import { activePointerPath, campaignLayout, type CampaignLayout } from './core/paths.ts'
import { visibleTools, PBFUZZ_TOOLS, KANALYZER_TOOLS } from './core/phases.ts'
import { ProviderRegistry } from './core/registry.ts'
import { EngineBridge } from './engine-bridge.ts'

/** Minimal view of a DSH agent this module needs; structurally satisfied by `Agent`. */
export interface AgentLike {
  readonly id: string
  readonly session: { readonly header: { readonly cwd?: string } }
  readonly ctx: { tools: { restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void } }
}

/** Draft-time material for the approval panel. Not part of the campaign. */
export interface CampaignReview {
  decisions?: string[]
  verification?: CampaignVerification[]
  evidence?: Record<string, string>
}

/** One loaded campaign and where it lives. */
export interface ActiveCampaign {
  campaign: PbfuzzCampaign
  /** Absolute path of the yaml. */
  path: string
  layout: CampaignLayout
  /** What the approval panel shows: automatic decisions, what `draft` verified, and the
   * evidence the agent supplied per field. Draft-time only; never written to the yaml. */
  review: CampaignReview
  /** True for `/pbfuzz run` — failures log diagnosis + options and exit non-zero, never prompt. */
  headless: boolean
  /** `path`'s mtime when this was loaded/saved, so `active()` can notice an out-of-band edit. */
  mtimeMs: number
  /**
   * Content hash of `campaign` (F3), recomputed on every `load()`/`save()` — i.e. on every
   * `draft`. `confirm()` uses it to detect a stale re-confirm: a Revise that was never followed
   * by a redraft leaves this unchanged, and a caller-supplied version that no longer matches
   * (either case) is refused rather than silently approved.
   */
  draftVersion: string
  /**
   * Set by `confirm()` when the user picks Revise; plugin-internal only (never written to the
   * yaml or any contract). Cleared implicitly by the next `draft()`/`save()`, which replaces this
   * whole object with a fresh one that has no `pendingRevision`.
   */
  pendingRevision?: { feedback: string; sinceVersion: string }
}

/**
 * Stable content hash of a campaign (F3's `draftVersion`): derived from the serialized yaml, not
 * from `Date.now()`/random, so the same draft always hashes the same and any real content change
 * (including an incorporated Revise) changes it.
 */
export function campaignContentHash(campaign: PbfuzzCampaign): string {
  return createHash('sha256').update(campaignToYaml(campaign)).digest('hex').slice(0, 16)
}

/** Whether two already-sorted-by-construction name lists hold the same names. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i])
}

/** Read JSON, returning undefined for a missing or unparsable file. */
export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * Write `content` to `path`, creating parent directories as needed. Exported for
 * `state-writer.ts`, the only other module that writes under a campaign's `.pbfuzz/<id>/` layout.
 *
 * Atomic (temp file in the same directory + `renameSync`), mirroring the engine's own
 * `metrics.py` writer (`tempfile.mkstemp` + `os.replace`) rather than a plain truncate-then-write:
 * `writeFileSync`'s default `'w'` flag truncates the target before writing, so a process kill
 * (OOM, disk full, restart) mid-write would otherwise leave a corrupt/truncated file that
 * `readJson()` reads back identically to "file absent" — silently resetting `checkSafeUpdate`'s
 * (RULE_SAFE_UPDATE) on-disk baseline to empty and letting the next write drop ids that were
 * never actually gone (Wave D fsm-attack F4). A same-directory rename is atomic on one filesystem:
 * a reader always observes either the whole old content or the whole new content, never a tear.
 */
export function writeFile(path: string, content: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

/** The plugin's host state. One instance per plugin fiber. */
export class PbfuzzHost {
  readonly providers = new ProviderRegistry()
  readonly engine: EngineBridge
  private readonly campaigns = new Map<string, ActiveCampaign>()
  private readonly restrictions = new Map<string, { agent: AgentLike; deny: readonly string[]; dispose: () => void }>()
  /**
   * Every agent `refresh()` has ever been called for, restricted or not (N6). `restrictions`
   * only holds agents currently denying at least one tool, so an agent that started fully
   * visible — zero denials, nothing to dispose — would otherwise vanish from `refreshAll()`
   * forever and never be revisited when settings/providers later change (e.g. a static-analysis
   * provider gets uninstalled after the agent already saw its full tool catalog).
   */
  private readonly knownAgents = new Map<string, AgentLike>()

  constructor(
    private settingsSource: () => PbfuzzSettings,
    private readonly log: { info(msg: string): void; warn(msg: string): void },
    private readonly globalToolNames: () => ReadonlySet<string>,
    engineEnvironment: Record<string, string> = {},
  ) {
    const settings = settingsSource()
    this.engine = new EngineBridge({
      pythonPath: settings.execution.pythonPath,
      env: engineEnvironment,
      log: line => { log.info(`engine: ${line}`) },
    })
    this.providers.onChange(() => { this.refreshAll() })
  }

  /** Current resolved settings. */
  settings(): PbfuzzSettings {
    return this.settingsSource()
  }

  /** Swap the settings source (installSection attach/detach). */
  setSettingsSource(source: () => PbfuzzSettings): void {
    this.settingsSource = source
  }

  /** Re-derive everything settings feed: engine interpreter, visibility. */
  onSettingsChanged(): void {
    const s = this.settings()
    this.engine.reconfigure({ pythonPath: s.execution.pythonPath, log: line => { this.log.info(`engine: ${line}`) } })
    this.refreshAll()
  }

  /** The workspace an agent works in. */
  cwdOf(agent: AgentLike | undefined): string {
    return agent?.session.header.cwd ?? process.cwd()
  }

  /**
   * Resolve a possibly relative path against the agent's workspace, lexically normalized
   * (`..`/`.`/duplicate-slash collapsed) exactly like `dsh-fs-local`'s own `resolve(cwd, path)`
   * resolves the real `write`/`edit` tool's target. Node's `resolve()` already discards `cwd` when
   * `path` is itself absolute, so one call handles both cases — an earlier version special-cased
   * absolute paths by returning them unmodified, which left `guard-policy.ts`'s `isUnderDir()`
   * string-prefix check comparing an un-normalized string against the real (normalized) write
   * target: `write({file_path:'<stateDir>/../state/state.json'})` looked like it was outside
   * `stateDir` to the guard while the real fs backend resolved it right back inside (Wave D
   * fsm-attack F1 — a full state-directory guard bypass).
   */
  resolvePath(agent: AgentLike | undefined, path: string): string {
    return resolve(this.cwdOf(agent), path)
  }

  /** The campaign bound to an agent's workspace, loading it from the active pointer if needed. */
  active(agent: AgentLike | undefined): ActiveCampaign | undefined {
    const cwd = this.cwdOf(agent)
    const cached = this.campaigns.get(cwd)
    if (cached !== undefined) {
      // A tool call (draft/confirm) always goes through save()/load(), which keeps this
      // in step; a direct edit of the yaml — the documented fallback for a field `draft` has no
      // input for (found live in V1: analysis.static.call_stack_len) — does not. Re-reading a
      // handful of bytes on every call is cheap; serving a stale object that then gets written
      // straight back over the edit on the next confirm is not.
      const currentMtime = existsSync(cached.path) ? statSync(cached.path).mtimeMs : undefined
      if (currentMtime === cached.mtimeMs) return cached
      try {
        return this.load(agent, cached.path, cached.headless)
      } catch (error) {
        this.log.warn(`pbfuzz: active campaign at ${cached.path} changed on disk and failed to reload: ${(error as Error).message}`)
        return undefined
      }
    }
    const root = this.settings().onboarding.defaultOutputRoot
    const pointer = activePointerPath(cwd, root)
    if (!existsSync(pointer)) return undefined
    const named = readFileSync(pointer, 'utf8').split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
    if (named === '') return undefined
    // Resolve exactly as the guards do (engine/hooks/pbfuzz_hooks/context.py), or the hooks and the
    // tools disagree about whether a campaign exists: an absolute directory, else an id/path under
    // <cwd>/<outputRoot>, else a path relative to the workspace. The yaml lives in the campaign
    // directory, or — hand-written for headless runs — in the workspace root.
    const dir = isAbsolute(named) ? named : [join(cwd, root, named), resolve(cwd, named)].find(d => existsSync(d))
    if (dir === undefined || !existsSync(dir)) return undefined
    const yamlPath = [campaignLayout(dir).campaignFile, join(cwd, 'pbfuzz.campaign.yaml')].find(p => existsSync(p))
    if (yamlPath === undefined) return undefined
    try {
      return this.load(agent, yamlPath, false)
    } catch (error) {
      this.log.warn(`pbfuzz: active campaign at ${yamlPath} failed to load: ${(error as Error).message}`)
      return undefined
    }
  }

  /**
   * Load and validate a campaign yaml, binding it to the agent's workspace.
   * @throws Error listing every validation issue.
   */
  load(agent: AgentLike | undefined, yamlPath: string, headless: boolean): ActiveCampaign {
    const path = this.resolvePath(agent, yamlPath)
    const parsed = withDefaultOutputDir(parseCampaignYaml(readFileSync(path, 'utf8')), dirname(path))
    const validation = validateCampaign(parsed)
    if (!validation.ok) {
      throw new Error(`campaign ${path} is invalid:\n${validation.issues.map(i => `  - ${i.path}: ${i.message}`).join('\n')}`)
    }
    const campaign = parsed as PbfuzzCampaign
    const active: ActiveCampaign = {
      campaign,
      path,
      layout: campaignLayout(campaign.output.dir),
      review: {},
      headless,
      mtimeMs: statSync(path).mtimeMs,
      draftVersion: campaignContentHash(campaign),
    }
    this.bind(agent, active)
    return active
  }

  /** Persist a campaign (yaml beside its state dir), bind it, and write pointer + snapshot. */
  save(agent: AgentLike | undefined, campaign: PbfuzzCampaign, review: CampaignReview = {}, headless = false): ActiveCampaign {
    const layout = campaignLayout(campaign.output.dir)
    writeFile(layout.campaignFile, campaignToYaml(campaign, layout.campaignFile))
    const active: ActiveCampaign = {
      campaign,
      path: layout.campaignFile,
      layout,
      review,
      headless,
      mtimeMs: statSync(layout.campaignFile).mtimeMs,
      draftVersion: campaignContentHash(campaign),
    }
    this.bind(agent, active)
    return active
  }

  /**
   * F3: record that the user picked Revise on the campaign currently active for this agent's
   * workspace, so a subsequent `confirm()` — before any intervening `draft()` — can refuse to
   * silently approve the unmodified draft. A no-op if there is no active campaign (defensive; the
   * caller has always just read one from `active()`).
   * @param agent - the calling agent, for its workspace.
   * @param feedback - what the user asked to change.
   */
  markRevisionPending(agent: AgentLike | undefined, feedback: string): void {
    const active = this.active(agent)
    if (active === undefined) return
    active.pendingRevision = { feedback, sinceVersion: active.draftVersion }
  }

  private bind(agent: AgentLike | undefined, active: ActiveCampaign): void {
    const cwd = this.cwdOf(agent)
    this.campaigns.set(cwd, active)
    const root = this.settings().onboarding.defaultOutputRoot
    writeFile(activePointerPath(active.campaign.target.repo, root), `${active.layout.dir}\n`)
    if (resolve(active.campaign.target.repo) !== resolve(cwd)) {
      // active() resolves `.pbfuzz/active` against the session workspace; mirror it there too.
      writeFile(activePointerPath(cwd, root), `${active.layout.dir}\n`)
    }
    if (agent !== undefined) this.refresh(agent)
  }

  /**
   * Write the INIT state cursor if none exists yet, or if the one on disk belongs to a different
   * campaign; `state-writer.ts`'s `advancePhase()` writes every later phase, called from pbfuzz's
   * own tools — never the agent directly.
   *
   * A bare exists-check here would let a new campaign silently inherit a stale `state.json` — from
   * a prior, unrelated campaign that reused the same `output.dir`/id, or from a `write` planted
   * before this campaign was ever confirmed (pre-confirm, `guards.ts` has no active campaign to gate
   * against yet, so `write`/`edit` are completely unguarded) — landing the new campaign in whatever
   * phase/`pier_round` the stale file said, including a crafted large-negative `pier_round` that
   * would neutralize `roundWithinBudget()` for effectively the campaign's whole lifetime (Wave D
   * fsm-attack F5). Comparing `campaign_id` closes that: only a state file this exact campaign
   * itself produced is ever trusted as a real cursor.
   */
  ensureInitState(active: ActiveCampaign): void {
    const existing = existsSync(active.layout.stateFile) ? readJson<PbfuzzState>(active.layout.stateFile) : undefined
    if (existing !== undefined && existing.campaign_id === active.campaign.id) return
    if (existing !== undefined) {
      this.log.warn(`pbfuzz: ${active.layout.stateFile} belongs to a different campaign (${existing.campaign_id}) — reinitializing to INIT for ${active.campaign.id}`)
    }
    const now = new Date().toISOString()
    const state: PbfuzzState = {
      campaign_id: active.campaign.id,
      phase: 'INIT',
      status: 'campaign confirmed; canaries and self-check pending',
      current_task: 'insert canaries and rebuild',
      next_action: NEXT_STEP.INIT,
      pier_round: 0,
      started_at: now,
      updated_at: now,
    }
    writeFile(active.layout.stateFile, `${JSON.stringify(state, null, 2)}\n`)
  }

  state(active: ActiveCampaign): PbfuzzState | undefined {
    return readJson<PbfuzzState>(active.layout.stateFile)
  }

  metrics(active: ActiveCampaign): PbfuzzMetrics | undefined {
    return readJson<PbfuzzMetrics>(active.layout.metricsFile)
  }

  /** Whether the seeds dir exists and holds at least one file. */
  seedsAvailable(dir: string): boolean {
    try {
      return readdirSync(dir).length > 0
    } catch {
      return false
    }
  }

  /**
   * The full dashboard view for an agent's workspace, read fresh from the campaign files:
   * state.json, the PLAN blocks and metrics.json. Denials are not on disk; the
   * session projection folds them from `tool/result` events whose error carries `guard-policy.ts`'s
   * denial format (`projection.ts`).
   * @param agent - the calling agent, for its workspace.
   * @returns the view, or undefined without an active campaign.
   */
  dashboard(agent: AgentLike | undefined): PbfuzzDashboardView | undefined {
    const active = this.active(agent)
    if (active === undefined) return undefined
    const block = (name: string): unknown => readJson<unknown>(join(active.layout.stateDir, name))
    return buildDashboardView({
      campaignId: active.campaign.id,
      targets: active.campaign.bug.targets.map(t => t.location),
      maxPierRounds: this.settings().budget.maxPierRounds,
      state: this.state(active),
      blocks: {
        bugPredicates: block('bug_predicates.json'),
        preconditions: block('preconditions.json'),
        rootCauses: block('root_causes.json'),
        triggerPlans: block('trigger_plans.json'),
      },
      metrics: this.metrics(active),
      now: new Date().toISOString(),
    })
  }

  /**
   * Apply tool visibility for one agent with `ctx.tools.restrict()`. Visibility only —
   * enforcement is `guard-policy.ts`'s `decide()`, wired as a native `ctx.tools.guard()` in
   * `guards.ts`. Only globally registered names may be named, so the deny list is intersected
   * with the registry (kanalyzer tools exist only with kanalyzer).
   */
  refresh(agent: AgentLike): void {
    this.knownAgents.set(agent.id, agent)
    const visible = new Set(visibleTools({
      hasConfirmedCampaign: this.active(agent)?.campaign.confirmed === true,
      settings: this.settings(),
      providerPresent: this.providers.active() !== undefined,
    }))
    const known = this.globalToolNames()
    const deny = [...PBFUZZ_TOOLS, ...KANALYZER_TOOLS].filter(t => known.has(t) && !visible.has(t))
    const existing = this.restrictions.get(agent.id)
    // Re-applying an identical restriction would hand DSH a fresh tool-schema array for the same
    // set; `dsh-agent-loop`'s `toolsChanged()` compares canonical headers so that is not supposed
    // to matter, but there is nothing to gain from finding out — an unchanged set is left alone.
    if (existing !== undefined && sameSet(existing.deny, deny)) return
    existing?.dispose()
    this.restrictions.delete(agent.id)
    if (deny.length === 0) return
    try {
      this.restrictions.set(agent.id, { agent, deny, dispose: agent.ctx.tools.restrict({ deny }) })
    } catch (error) {
      this.log.warn(`pbfuzz: could not restrict tools for ${agent.id}: ${(error as Error).message}`)
    }
  }

  /**
   * Build the {@link GuardView} `guard-policy.ts`'s `decide()` needs for this agent's workspace —
   * the one thing `guards.ts`'s native `ctx.tools.guard()` callback calls before delegating.
   * Synchronous and read-only: `state.json` is a few hundred bytes, so re-reading it fresh on
   * every gated call (rather than caching) is cheap and can never serve a decision against a
   * stale phase.
   * @param agent - the calling agent, for its workspace.
   * @param terminalToolNames - interactive-debugging tool names this deployment actually
   *   registers, feature-detected by the caller from `ctx.tools.schemas()`.
   * @returns the view, or undefined without an active campaign (the guard is then a no-op).
   */
  guardView(agent: AgentLike | undefined, terminalToolNames: readonly string[]): GuardView | undefined {
    const active = this.active(agent)
    if (active === undefined) return undefined
    const state = this.state(active)
    return {
      phase: state?.phase ?? 'INIT',
      confirmed: active.campaign.confirmed === true,
      stateDir: active.layout.stateDir,
      settings: this.settings(),
      providerPresent: this.providers.active() !== undefined,
      terminalToolNames,
    }
  }

  /**
   * Re-apply visibility for every agent we have ever touched (N6) — not only the ones currently
   * restricted, so an agent that started fully visible is still revisited when settings or
   * providers change later.
   */
  refreshAll(): void {
    for (const agent of [...this.knownAgents.values()]) this.refresh(agent)
  }

  /** Lift every restriction and stop the sidecar (plugin disposal). */
  dispose(): void {
    for (const { dispose } of this.restrictions.values()) {
      try { dispose() } catch { /* agent already gone */ }
    }
    this.restrictions.clear()
    this.knownAgents.clear()
    this.engine.stop()
  }
}
