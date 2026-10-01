/**
 * The kanalyzer card's controller: a staged form over the nested `kanalyzer`
 * settings namespace, plus the Build / Self-test / Refresh actions.
 *
 * It is DOM- and service-free. It reads and writes through a `SettingsScope`
 * and reaches the rest of DSH through the narrow {@link KanalyzerCardHost}
 * adapter, which `index.ts` builds from `ctx`. That keeps the logic unit-testable
 * without a DSH runtime.
 *
 * Writes are one atomic `scope.mutate()` of path ops. `scope.set(field)` only
 * addresses a top-level key and every field here is nested.
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { KanalyzerSettings } from '../generated/contracts.ts'
import {
  ALL_FIELDS, getAt, hasAt, jsonEqual, parseDraft, toDraft,
  type DraftValue, type FieldSpec,
} from './fields.ts'

/** Namespace this card edits (spelled here: a client bundle must not import the Host half). */
export const KANALYZER_NS = 'kanalyzer'

/** Command lines the buttons dispatch. W4 owns their handlers. */
export const BUILD_COMMAND = '/kanalyzer build'
export const DOCTOR_COMMAND = '/kanalyzer doctor'
export const INSTALL_DEPS_COMMAND = '/kanalyzer install-deps'

/** What dispatching one command line reported. */
export type CommandOutcome =
  /** The session's agent admitted the command; `failed` mirrors a handler error result. */
  | { kind: 'admitted'; failed: boolean; text: string }
  /** No `/kanalyzer` command is registered: the Host half is not mounted. */
  | { kind: 'unknown' }
  /** The call itself was refused (transport / RPC error). */
  | { kind: 'refused'; message: string }

/** The DSH surface the controller needs. `index.ts` implements it over `ctx`. */
export interface KanalyzerCardHost {
  /**
   * Create a visible session.
   * @param cwd - working directory, or undefined for the Host default.
   * @returns the new session id.
   */
  createSession(cwd: string | undefined): Promise<string>
  /** Dispatch one slash-command line into a session. */
  executeCommand(sessionId: string, line: string): Promise<CommandOutcome>
  /** Reveal a session in the main view / sidebar. */
  openSession(sessionId: string): void
  /**
   * Re-read the namespace from the Host (status is written with no push channel).
   * @returns whether a fresh view was folded in.
   */
  reloadSettings(): Promise<boolean>
}

/** One control's state. */
export interface FieldState {
  /** Draft the control renders. */
  value: DraftValue
  /** Whether saving would leave a user-layer entry. */
  overridden: boolean
  /** Whether the draft is not a value this field accepts (blocks saving). */
  invalid: boolean
  /** Whether a save would change this field. */
  dirty: boolean
}

/** Read-only status written by the Host. */
export interface StatusView {
  installed: boolean
  binaryPath: string
  commit: string
  llvmVersion: string
  lastDoctor: '' | 'pass' | 'fail'
  lastDoctorAt: string
  lastDoctorMessage: string
  lastWllvm: '' | 'pass' | 'fail'
  lastWllvmAt: string
  lastWllvmMessage: string
}

/**
 * Honest progress of one button. `messageKey` is a locale key; `detail` is raw
 * Host text (an error message or a command's reply), shown verbatim.
 */
export type ActionState =
  | { phase: 'idle' }
  | { phase: 'pending'; messageKey: ActionMessageKey; sessionId?: string }
  | { phase: 'success'; messageKey: ActionMessageKey; detail?: string; sessionId?: string }
  | { phase: 'failure'; messageKey: ActionMessageKey; detail?: string; sessionId?: string }

/** Locale keys an action state may carry. */
export type ActionMessageKey =
  | 'actCreating' | 'actDispatching' | 'actBuildRunning' | 'actBuildDone'
  | 'actWaitingDoctor' | 'actDoctorPass' | 'actDoctorFail' | 'actDoctorNoStatus'
  | 'actCreateFailed' | 'actCommandMissing' | 'actRefused' | 'actHandlerError'
  | 'actBinaryNotFound'
  | 'actInstallingDeps' | 'actInstallDepsPass' | 'actInstallDepsFail'

/** Everything the card renders. */
export interface KanalyzerCardState {
  /** False while the namespace is not served (the Host half is not mounted): the card renders nothing. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  fields: Record<string, FieldState>
  dirty: boolean
  invalid: boolean
  saving: boolean
  /** The last save did not land as staged; drafts are kept for correction. */
  saveFailed: boolean
  status: StatusView
  /** Whether the build agent ran from the Host default directory because `installDir` could not be used as a cwd. */
  buildCwdFallback: boolean
  build: ActionState
  doctor: ActionState
  installDeps: ActionState
  refreshing: boolean
  /** The last refresh could not reach the Host. */
  refreshFailed: boolean
}

/** Actions the card's slot entry injects. */
export interface KanalyzerCardActions {
  edit: (fieldId: string, value: DraftValue) => void
  resetField: (fieldId: string) => void
  save: () => void
  discard: () => void
  build: () => void
  doctor: () => void
  installDeps: () => void
  refresh: () => void
  openSession: (sessionId: string) => void
}

/** Minimal observable the slot renderer binds as a `use<Name>` selector hook. */
export interface CardObservable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** The registration-side face: snapshot hook source plus actions. */
export interface KanalyzerCardFace extends KanalyzerCardActions {
  hooks: {
    /** Bound by the renderer as `useKanalyzerCard`. */
    kanalyzerCard: CardObservable<KanalyzerCardState>
  }
}

interface Staged {
  value: DraftValue
  /** Reset: saving clears the user-layer entry whatever the draft shows. */
  clear: boolean
}

type PathOp =
  | { op: 'set'; path: string[]; value: never }
  | { op: 'unset'; path: string[] }

const FIELD_BY_ID = new Map(ALL_FIELDS.map(field => [field.id, field]))

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Bridges the `kanalyzer` scope and the host adapter onto the card. */
export class KanalyzerCardController {
  private readonly staged = new Map<string, Staged>()
  private readonly listeners = new Set<() => void>()
  private readonly offScope: () => void
  private snapshot: KanalyzerCardState
  private saving = false
  private saveFailed = false
  private build: ActionState = { phase: 'idle' }
  private doctor: ActionState = { phase: 'idle' }
  private installDeps: ActionState = { phase: 'idle' }
  private buildCwdFallback = false
  private refreshing = false
  private refreshFailed = false
  /** Status seen when a build started; a change to it is what completes the build. */
  private buildBaseline: StatusView | undefined
  /** `lastDoctorAt` when a self-test started; a newer stamp is its verdict. */
  private doctorBaseline: string | undefined
  /** `lastWllvmAt` when install-deps started; a newer stamp is its verdict. */
  private installDepsBaseline: string | undefined
  private disposed = false

  /**
   * @param scope - the bound `kanalyzer` settings scope.
   * @param host - the DSH adapter.
   */
  constructor(
    private readonly scope: SettingsScope<KanalyzerSettings>,
    private readonly host: KanalyzerCardHost,
  ) {
    this.snapshot = this.project()
    this.offScope = scope.subscribe(() => { this.onScopeChange() })
  }

  /** @returns the face the slot registration injects. */
  inject(): KanalyzerCardFace {
    return {
      hooks: {
        kanalyzerCard: {
          getSnapshot: () => this.snapshot,
          subscribe: (listener) => {
            this.listeners.add(listener)
            return () => { this.listeners.delete(listener) }
          },
        },
      },
      edit: (fieldId, value) => { this.stage(fieldId, { value, clear: false }) },
      resetField: (fieldId) => {
        const field = this.field(fieldId)
        this.stage(fieldId, { value: toDraft(field, getAt(this.scope.getSnapshot().base, field.path)), clear: true })
      },
      save: () => { void this.save() },
      discard: () => {
        this.staged.clear()
        this.saveFailed = false
        this.publish()
      },
      build: () => { void this.runBuild() },
      doctor: () => { void this.runDoctor() },
      installDeps: () => { void this.runInstallDeps() },
      refresh: () => { void this.refresh() },
      openSession: (sessionId) => { this.host.openSession(sessionId) },
    }
  }

  /** Stop observing the scope. */
  dispose(): void {
    this.disposed = true
    this.offScope()
    this.listeners.clear()
  }

  /** @returns the current card state (for tests and non-React callers). */
  getState(): KanalyzerCardState {
    return this.snapshot
  }

  // ---- form -------------------------------------------------------------

  /**
   * Write every staged edit as one atomic mutation, then re-read what the Host kept.
   * @returns settlement after the write.
   */
  async save(): Promise<void> {
    const plan = this.plan()
    if (plan === undefined || plan.length === 0 || this.saving) return
    this.saving = true
    this.saveFailed = false
    this.publish()
    let landed: boolean
    try {
      await this.scope.mutate(plan)
      // The Host is the authority on what was accepted: read it back.
      const user = this.scope.getSnapshot().user
      landed = plan.every(op => op.op === 'unset'
        ? !hasAt(user, op.path)
        : jsonEqual(getAt(user, op.path), op.value))
    } catch {
      landed = false
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.saveFailed = !landed
    this.publish()
  }

  /** @returns the path ops a save performs, or undefined when a draft is invalid. */
  private plan(): PathOp[] | undefined {
    const ops: PathOp[] = []
    const snap = this.scope.getSnapshot()
    for (const [id, staged] of this.staged) {
      const field = this.field(id)
      const path = [...field.path]
      if (staged.clear) {
        if (hasAt(snap.user, field.path)) ops.push({ op: 'unset', path })
        continue
      }
      const parsed = parseDraft(field, staged.value)
      if (!parsed.ok) return undefined
      // Unchanged from what is in force: writing it would only mint an override.
      if (jsonEqual(parsed.value, this.effective(field))) continue
      ops.push({ op: 'set', path, value: parsed.value as never })
    }
    return ops
  }

  /** @returns the stored (resolved) value of a field, parsed back from its draft form. */
  private effective(field: FieldSpec): unknown {
    const parsed = parseDraft(field, toDraft(field, getAt(this.scope.getSnapshot().value, field.path)))
    return parsed.ok ? parsed.value : undefined
  }

  private fieldState(field: FieldSpec): FieldState {
    const snap = this.scope.getSnapshot()
    const staged = this.staged.get(field.id)
    if (staged === undefined) {
      return {
        value: toDraft(field, getAt(snap.value, field.path)),
        overridden: hasAt(snap.user, field.path),
        invalid: false,
        dirty: false,
      }
    }
    if (staged.clear) {
      return { value: staged.value, overridden: false, invalid: false, dirty: hasAt(snap.user, field.path) }
    }
    const parsed = parseDraft(field, staged.value)
    return {
      value: staged.value,
      overridden: parsed.ok ? true : hasAt(snap.user, field.path),
      invalid: !parsed.ok,
      dirty: !parsed.ok || !jsonEqual(parsed.value, this.effective(field)),
    }
  }

  private stage(fieldId: string, staged: Staged): void {
    this.field(fieldId)
    this.staged.set(fieldId, staged)
    this.saveFailed = false
    this.publish()
  }

  private field(fieldId: string): FieldSpec {
    const field = FIELD_BY_ID.get(fieldId)
    // Every call site names a declared field; an unknown one is a wiring bug.
    if (field === undefined) throw new Error(`kanalyzer card has no field ${fieldId}`)
    return field
  }

  // ---- status & actions -------------------------------------------------

  private status(): StatusView {
    const s = this.scope.getSnapshot().value?.status ?? {}
    return {
      installed: s.installed === true,
      binaryPath: s.binaryPath ?? '',
      commit: s.commit ?? '',
      llvmVersion: s.llvmVersion ?? '',
      lastDoctor: s.lastDoctor ?? '',
      lastDoctorAt: s.lastDoctorAt ?? '',
      lastDoctorMessage: s.lastDoctorMessage ?? '',
      lastWllvm: s.lastWllvm ?? '',
      lastWllvmAt: s.lastWllvmAt ?? '',
      lastWllvmMessage: s.lastWllvmMessage ?? '',
    }
  }

  /** The draft installDir if valid, else the stored one: Build acts on what the user sees. */
  private installDir(): string {
    const field = this.field('install.installDir')
    const state = this.fieldState(field)
    const parsed = parseDraft(field, state.value)
    return parsed.ok && typeof parsed.value === 'string' ? parsed.value : String(field.fallback)
  }

  /**
   * Create a session in `cwd`, falling back to the Host default directory: on a
   * first build `installDir` usually does not exist yet, and the build agent is
   * the one that creates it.
   */
  private async openWorkSession(cwd: string): Promise<{ sessionId: string; fallback: boolean }> {
    try {
      return { sessionId: await this.host.createSession(cwd), fallback: false }
    } catch {
      return { sessionId: await this.host.createSession(undefined), fallback: true }
    }
  }

  /**
   * Build / Rebuild: a visible session running `/kanalyzer build`, so the user
   * can watch the clone/deps/build and approve anything that needs it (e.g. sudo).
   * It succeeds only when the Host reports a (new) installed binary.
   */
  async runBuild(): Promise<void> {
    if (this.build.phase === 'pending') return
    this.build = { phase: 'pending', messageKey: 'actCreating' }
    this.publish()
    let sessionId: string
    try {
      const created = await this.openWorkSession(this.installDir())
      sessionId = created.sessionId
      this.buildCwdFallback = created.fallback
    } catch (error) {
      this.build = { phase: 'failure', messageKey: 'actCreateFailed', detail: errorText(error) }
      this.publish()
      return
    }
    // Baseline BEFORE dispatch: a synchronous handler may write status while it runs.
    this.buildBaseline = this.status()
    this.build = { phase: 'pending', messageKey: 'actDispatching', sessionId }
    this.publish()
    const outcome = await this.dispatch(sessionId, BUILD_COMMAND)
    // Show the session either way: a failed dispatch is easier to diagnose in it.
    this.host.openSession(sessionId)
    if (outcome.kind !== 'admitted' || outcome.failed) {
      this.buildBaseline = undefined
      this.build = this.outcomeFailure(outcome, sessionId)
      this.publish()
      return
    }
    // Only if the status write did not already settle it during dispatch.
    if (this.build.phase === 'pending') {
      this.build = { phase: 'pending', messageKey: 'actBuildRunning', sessionId }
      this.publish()
    }
    // The agent may already be done if the handler was synchronous.
    await this.refresh()
  }

  /**
   * Self-test: `/kanalyzer doctor`. The verdict is the Host-written
   * `status.lastDoctor`, so a pass is never inferred from a mere dispatch.
   */
  async runDoctor(): Promise<void> {
    if (this.doctor.phase === 'pending') return
    this.doctor = { phase: 'pending', messageKey: 'actCreating' }
    this.publish()
    let sessionId: string
    try {
      sessionId = (await this.openWorkSession(this.installDir())).sessionId
    } catch (error) {
      this.doctor = { phase: 'failure', messageKey: 'actCreateFailed', detail: errorText(error) }
      this.publish()
      return
    }
    this.doctorBaseline = this.status().lastDoctorAt
    this.doctor = { phase: 'pending', messageKey: 'actDispatching', sessionId }
    this.publish()
    const outcome = await this.dispatch(sessionId, DOCTOR_COMMAND)
    if (outcome.kind !== 'admitted') {
      this.doctorBaseline = undefined
      this.doctor = this.outcomeFailure(outcome, sessionId)
      this.publish()
      return
    }
    // A synchronous handler may already have stamped the verdict during dispatch.
    if (this.doctor.phase !== 'pending') return
    this.doctor = { phase: 'pending', messageKey: 'actWaitingDoctor', sessionId }
    this.publish()
    await this.refresh()
    if (this.doctor.phase !== 'pending') return
    // The Host did not stamp a verdict: report the command's own reply, and
    // say so, rather than guessing a pass.
    this.doctorBaseline = undefined
    const notFound = !this.status().installed
    this.doctor = outcome.failed || notFound
      ? {
          phase: 'failure',
          messageKey: notFound ? 'actBinaryNotFound' : 'actHandlerError',
          detail: outcome.text,
          sessionId,
        }
      : { phase: 'success', messageKey: 'actDoctorNoStatus', detail: outcome.text, sessionId }
    this.publish()
  }

  /**
   * Install wllvm: `/kanalyzer install-deps` (`pip install --user wllvm`, then a
   * self-test rerun). Same create/baseline/dispatch/openSession shape as
   * {@link runBuild}; the verdict is the Host-written `status.lastWllvm`, watched
   * off `lastWllvmAt` the way {@link runDoctor} watches `lastDoctorAt`.
   */
  async runInstallDeps(): Promise<void> {
    if (this.installDeps.phase === 'pending') return
    this.installDeps = { phase: 'pending', messageKey: 'actCreating' }
    this.publish()
    let sessionId: string
    try {
      sessionId = (await this.openWorkSession(this.installDir())).sessionId
    } catch (error) {
      this.installDeps = { phase: 'failure', messageKey: 'actCreateFailed', detail: errorText(error) }
      this.publish()
      return
    }
    // Baseline BEFORE dispatch: a synchronous handler may write status while it runs.
    this.installDepsBaseline = this.status().lastWllvmAt
    this.installDeps = { phase: 'pending', messageKey: 'actDispatching', sessionId }
    this.publish()
    const outcome = await this.dispatch(sessionId, INSTALL_DEPS_COMMAND)
    // Show the session either way: a failed dispatch is easier to diagnose in it.
    this.host.openSession(sessionId)
    if (outcome.kind !== 'admitted' || outcome.failed) {
      this.installDepsBaseline = undefined
      this.installDeps = this.outcomeFailure(outcome, sessionId)
      this.publish()
      return
    }
    // Only if the status write did not already settle it during dispatch.
    if (this.installDeps.phase === 'pending') {
      this.installDeps = { phase: 'pending', messageKey: 'actInstallingDeps', sessionId }
      this.publish()
    }
    // The agent may already be done if the handler was synchronous.
    await this.refresh()
  }

  /**
   * Re-read the namespace from the Host on demand.
   * @returns settlement after the reload.
   */
  async refresh(): Promise<void> {
    this.refreshing = true
    this.refreshFailed = false
    this.publish()
    let ok = false
    try {
      ok = await this.host.reloadSettings()
    } catch {
      ok = false
    }
    this.refreshing = false
    this.refreshFailed = !ok
    this.onScopeChange()
  }

  private async dispatch(sessionId: string, line: string): Promise<CommandOutcome> {
    try {
      return await this.host.executeCommand(sessionId, line)
    } catch (error) {
      return { kind: 'refused', message: errorText(error) }
    }
  }

  private outcomeFailure(outcome: CommandOutcome, sessionId: string): ActionState {
    switch (outcome.kind) {
      case 'unknown': return { phase: 'failure', messageKey: 'actCommandMissing', sessionId }
      case 'refused': return { phase: 'failure', messageKey: 'actRefused', detail: outcome.message, sessionId }
      case 'admitted': return { phase: 'failure', messageKey: 'actHandlerError', detail: outcome.text, sessionId }
    }
  }

  /** Settle pending actions from the Host-written status. */
  private onScopeChange(): void {
    const status = this.status()
    const base = this.buildBaseline
    if (this.build.phase === 'pending' && base !== undefined && status.installed
      && (!base.installed || status.commit !== base.commit || status.binaryPath !== base.binaryPath)) {
      this.build = {
        phase: 'success',
        messageKey: 'actBuildDone',
        detail: status.binaryPath,
        ...(this.build.sessionId !== undefined ? { sessionId: this.build.sessionId } : {}),
      }
      this.buildBaseline = undefined
    }
    if (this.doctor.phase === 'pending' && this.doctorBaseline !== undefined
      && status.lastDoctorAt !== '' && status.lastDoctorAt !== this.doctorBaseline) {
      const sessionId = this.doctor.sessionId
      const extra = sessionId !== undefined ? { sessionId } : {}
      this.doctor = status.lastDoctor === 'pass'
        ? { phase: 'success', messageKey: 'actDoctorPass', detail: status.lastDoctorMessage, ...extra }
        : {
            phase: 'failure',
            messageKey: status.installed ? 'actDoctorFail' : 'actBinaryNotFound',
            detail: status.lastDoctorMessage,
            ...extra,
          }
      this.doctorBaseline = undefined
    }
    if (this.installDeps.phase === 'pending' && this.installDepsBaseline !== undefined
      && status.lastWllvmAt !== '' && status.lastWllvmAt !== this.installDepsBaseline) {
      const sessionId = this.installDeps.sessionId
      const extra = sessionId !== undefined ? { sessionId } : {}
      this.installDeps = status.lastWllvm === 'pass'
        ? { phase: 'success', messageKey: 'actInstallDepsPass', detail: status.lastWllvmMessage, ...extra }
        : { phase: 'failure', messageKey: 'actInstallDepsFail', detail: status.lastWllvmMessage, ...extra }
      this.installDepsBaseline = undefined
    }
    this.publish()
  }

  // ---- projection -------------------------------------------------------

  private project(): KanalyzerCardState {
    const snap = this.scope.getSnapshot()
    const fields: Record<string, FieldState> = {}
    for (const field of ALL_FIELDS) fields[field.id] = this.fieldState(field)
    const states = Object.values(fields)
    return {
      available: snap.status === 'ready',
      writable: snap.writable,
      fields,
      dirty: states.some(state => state.dirty),
      invalid: states.some(state => state.invalid),
      saving: this.saving,
      saveFailed: this.saveFailed,
      status: this.status(),
      buildCwdFallback: this.buildCwdFallback,
      build: this.build,
      doctor: this.doctor,
      installDeps: this.installDeps,
      refreshing: this.refreshing,
      refreshFailed: this.refreshFailed,
    }
  }

  private publish(): void {
    if (this.disposed) return
    this.snapshot = this.project()
    for (const listener of [...this.listeners]) listener()
  }
}
