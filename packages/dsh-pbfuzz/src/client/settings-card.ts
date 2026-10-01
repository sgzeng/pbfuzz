/**
 * Controller behind the pbfuzz settings card: staged form, kanalyzer detection
 * and the Self-check action.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace, SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { PathForm, type FieldState, type FormShell } from './card-form.ts'
import { FIELDS, KANALYZER_NS } from './settings-model.ts'

/** Field id of the read-only `status.envSelfcheck` leaf (settings-model.ts). */
const ENV_SELFCHECK_FIELD_ID = 'status.envSelfcheck'

/**
 * Command the Self-check button dispatches (plan's native-seam table: the
 * Host half's `/pbfuzz selfcheck` handler runs the environment self-check —
 * engine ping, contracts version, sandbox round trip, static-analysis/tracer
 * availability — and writes `status.envSelfcheck`).
 */
export const SELFCHECK_COMMAND = '/pbfuzz selfcheck'

/** What dispatching the self-check command reported. */
export type CommandOutcome =
  /** The Host admitted the command; `failed` mirrors a handler error result. */
  | { kind: 'admitted'; failed: boolean; text: string }
  /** No `/pbfuzz selfcheck` command is registered yet. */
  | { kind: 'unknown' }
  /** The call itself was refused (transport / RPC error). */
  | { kind: 'refused'; message: string }

/**
 * The DSH surface the Self-check action needs — dsh-kanalyzer's
 * `KanalyzerCardHost` dispatch-then-reload shape, narrowed to this card's
 * needs. `client/index.ts`'s `hostOf()` builds the real one over `ctx`.
 * Stays optional here (not required by the constructor) so a test can
 * construct a card without one; the button then reports the command as
 * unavailable instead of throwing.
 */
export interface PbfuzzCardHost {
  /** Dispatch `/pbfuzz selfcheck`. */
  executeCommand(line: string): Promise<CommandOutcome>
  /**
   * Re-read the namespace from the Host (status has no push channel).
   * @returns whether a fresh view was folded in.
   */
  reloadSettings(): Promise<boolean>
}

/** Locale keys (see locales.ts) the Self-check action's state may carry. */
export type SelfcheckMessageKey =
  | 'card.selfcheckRunning' | 'card.selfcheckPass' | 'card.selfcheckWarn' | 'card.selfcheckFail'
  | 'card.selfcheckNoStatus' | 'card.selfcheckUnavailable' | 'card.selfcheckRefused'

/**
 * Honest progress of the Self-check button. `detail` is raw Host/command
 * text, shown verbatim; the verdict itself always comes from the Host-written
 * `status.envSelfcheck.overall`, never merely from a dispatch succeeding.
 */
export type SelfcheckState =
  | { phase: 'idle' }
  | { phase: 'pending'; messageKey: SelfcheckMessageKey }
  | { phase: 'success'; messageKey: SelfcheckMessageKey; detail?: string }
  | { phase: 'failure'; messageKey: SelfcheckMessageKey; detail?: string }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether the dsh-kanalyzer plugin is present. Detected, not assumed: the
 * plugin's host half registers the `kanalyzer` settings namespace, and the
 * describe mirror lists every namespace a live Host plugin registered.
 * `unknown` until the Host has answered once.
 */
export type KanalyzerPresence = 'installed' | 'missing' | 'unknown'

/** What the card renders. */
export interface PbfuzzCardState extends FormShell {
  /** Per-field control state keyed by field id. */
  fields: Record<string, FieldState>
  /** kanalyzer plugin presence. */
  kanalyzer: KanalyzerPresence
  /** Progress of the Self-check button. */
  selfcheck: SelfcheckState
}

/** The face the card's slot registration injects. */
export interface PbfuzzCardFace {
  hooks: {
    /** Bound by the renderer as `usePbfuzzCard`. */
    pbfuzzCard: SnapshotStore<PbfuzzCardState>
  }
  /** Stage typed text. */
  editText: (id: string, text: string) => void
  /** Stage a chosen value. */
  editValue: (id: string, value: unknown) => void
  /** Stage a reset to the composition layer. */
  resetField: (id: string) => void
  /** Write all staged edits. */
  save: () => void
  /** Drop all staged edits. */
  discard: () => void
  /** Dispatch `/pbfuzz selfcheck`, then reload settings for a fresh `status.envSelfcheck`. */
  selfcheck: () => void
}

/** Bridges the `pbfuzz` scope and the describe mirror onto the card's snapshot. */
export class PbfuzzCardController {
  private readonly form: PathForm
  private readonly store: SnapshotStore<PbfuzzCardState>
  private readonly disposers: (() => void)[] = []
  private selfcheckState: SelfcheckState = { phase: 'idle' }

  /**
   * @param scope - bound `pbfuzz` scope.
   * @param describe - shared describe face, read for the served-namespace list.
   * @param host - the DSH adapter for the Self-check button; undefined until a
   *   parallel wave wires `index.ts` to build one over `ctx`.
   */
  constructor(
    scope: SettingsScope<unknown>,
    private readonly describe: SettingsDescribeFace,
    private readonly host?: PbfuzzCardHost,
  ) {
    this.form = new PathForm(scope, () => { this.publish() })
    this.store = createSnapshotStore(this.project())
    this.disposers.push(scope.subscribe(() => { this.publish() }))
    this.disposers.push(describe.subscribe(() => { this.publish() }))
    void describe.ensure()
  }

  /** @returns the injected face. */
  inject(): PbfuzzCardFace {
    return {
      hooks: { pbfuzzCard: this.store },
      editText: (id, text) => { this.form.editText(id, text) },
      editValue: (id, value) => { this.form.editValue(id, value) },
      resetField: (id) => { this.form.reset(id) },
      save: () => { void this.form.save() },
      discard: () => { this.form.discard() },
      selfcheck: () => { void this.runSelfcheck() },
    }
  }

  /** Stop following the scope and the mirror. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
  }

  private kanalyzer(): KanalyzerPresence {
    const view = this.describe.getSnapshot().view
    if (view === undefined) return 'unknown'
    return view.namespaces.some(row => row.ns === KANALYZER_NS) ? 'installed' : 'missing'
  }

  /** @returns the resolved `status.envSelfcheck` fields the Self-check action tracks. */
  private envSelfcheck(): { checkedAt: string; overall: string } {
    const value = this.form.field(ENV_SELFCHECK_FIELD_ID).value as
      { checkedAt?: unknown; overall?: unknown } | undefined
    return {
      checkedAt: typeof value?.checkedAt === 'string' ? value.checkedAt : '',
      overall: typeof value?.overall === 'string' ? value.overall : '',
    }
  }

  /**
   * Self-check: `/pbfuzz selfcheck`. The verdict is the Host-written
   * `status.envSelfcheck.overall`, so a pass is never inferred from a mere dispatch.
   */
  private async runSelfcheck(): Promise<void> {
    if (this.selfcheckState.phase === 'pending') return
    if (this.host === undefined) {
      this.selfcheckState = { phase: 'failure', messageKey: 'card.selfcheckUnavailable' }
      this.publish()
      return
    }
    const baseline = this.envSelfcheck().checkedAt
    this.selfcheckState = { phase: 'pending', messageKey: 'card.selfcheckRunning' }
    this.publish()
    let outcome: CommandOutcome
    try {
      outcome = await this.host.executeCommand(SELFCHECK_COMMAND)
    } catch (error) {
      this.selfcheckState = { phase: 'failure', messageKey: 'card.selfcheckRefused', detail: errorText(error) }
      this.publish()
      return
    }
    if (outcome.kind !== 'admitted') {
      this.selfcheckState = outcome.kind === 'unknown'
        ? { phase: 'failure', messageKey: 'card.selfcheckUnavailable' }
        : { phase: 'failure', messageKey: 'card.selfcheckRefused', detail: outcome.message }
      this.publish()
      return
    }
    await this.host.reloadSettings()
    const after = this.envSelfcheck()
    if (after.checkedAt !== '' && after.checkedAt !== baseline) {
      this.selfcheckState = after.overall === 'fail'
        ? { phase: 'failure', messageKey: 'card.selfcheckFail' }
        : { phase: 'success', messageKey: after.overall === 'warn' ? 'card.selfcheckWarn' : 'card.selfcheckPass' }
    } else {
      // The Host did not stamp a fresh verdict: report the command's own
      // reply, and say so, rather than guessing a pass.
      this.selfcheckState = outcome.failed
        ? { phase: 'failure', messageKey: 'card.selfcheckRefused', detail: outcome.text }
        : { phase: 'success', messageKey: 'card.selfcheckNoStatus', detail: outcome.text }
    }
    this.publish()
  }

  private project(): PbfuzzCardState {
    const fields: Record<string, FieldState> = {}
    for (const spec of FIELDS) fields[spec.id] = this.form.field(spec.id)
    return { ...this.form.shell(), fields, kanalyzer: this.kanalyzer(), selfcheck: this.selfcheckState }
  }

  private publish(): void {
    const next = this.project()
    // Keep the snapshot reference until something the card shows moved
    // (DSH reactive rule 5): unrelated settings commits refresh the mirror.
    if (JSON.stringify(next) === JSON.stringify(this.store.getSnapshot())) return
    this.store.set(next)
  }
}
