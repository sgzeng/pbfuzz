/**
 * Staged form over the nested `pbfuzz` settings section.
 *
 * Mirrors the discipline of DSH's own plugin cards (edits are staged and
 * written only on Save, overrides are detected by user-layer key PRESENCE),
 * but cannot import that model: the client bundle-purity gate forbids value
 * imports across plugins. Unlike DSH's flat cards, every pbfuzz field lives one
 * level down (`tools.staticAnalysis`), so writes go through `scope.mutate` with
 * full paths, batched into one revision-fenced mutation per save.
 */

import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { FIELDS, pathOf, type FieldSpec } from './settings-model.ts'

/** The write one staged edit performs on save. */
export type FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

/** One field as its control renders it. */
export interface FieldState {
  /** Effective value: staged, else section value, else schema default. */
  value: unknown
  /** Draft text for text-like controls. */
  text: string
  /** Whether saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** Whether the draft is not a value this field accepts (blocks save). */
  invalid: boolean
}

/** Card-level state. */
export interface FormShell {
  /** `ready` once the namespace is served; `loading` before; `unavailable` when not served. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether a save would write anything. */
  dirty: boolean
  /** Whether any staged draft is invalid. */
  invalid: boolean
  /** Whether a save is in flight. */
  saving: boolean
  /** Whether the last save did not land as staged. */
  failed: boolean
}

interface Staged {
  text: string
  write: FieldWrite | undefined
}

/**
 * Read a nested value.
 * @param root - object to walk.
 * @param path - segments.
 * @returns the value, or undefined when any segment is missing.
 */
export function getAt(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/**
 * Whether a nested key is present (presence, not value, marks an override).
 * @param root - object to walk.
 * @param path - segments.
 * @returns true when the last segment is an own key of its parent.
 */
export function hasAt(root: unknown, path: readonly string[]): boolean {
  const parent = getAt(root, path.slice(0, -1))
  if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) return false
  return Object.hasOwn(parent, path[path.length - 1] as string)
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Render a value as draft text.
 * @param value - stored value.
 * @returns its text form.
 */
function format(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

/**
 * Render `status.envSelfcheck`'s value as a one-line, read-only summary.
 * It is the schema's only nested-object leaf (`kind: '?object'`, see
 * settings-model.ts): the bundle script's schema-parity check needs the whole
 * object as one card field, so it is never staged for edit — only summarized.
 * @param value - the resolved `status.envSelfcheck` object.
 * @returns a joined summary string, or `''` when nothing has run yet.
 */
function summarizeEnvSelfcheck(value: unknown): string {
  const v = value as { checkedAt?: unknown; overall?: unknown; items?: unknown } | undefined
  const overall = typeof v?.overall === 'string' ? v.overall : ''
  const checkedAt = typeof v?.checkedAt === 'string' ? v.checkedAt : ''
  const items = Array.isArray(v?.items) ? v.items.length : 0
  if (overall === '' && checkedAt === '') return ''
  const parts = [overall === '' ? 'unknown' : overall, `${items} item${items === 1 ? '' : 's'}`]
  if (checkedAt !== '') parts.push(checkedAt)
  return parts.join(' · ')
}

/**
 * Parse draft text for a text-like field.
 * @param spec - field spec.
 * @param text - what the user typed.
 * @returns the write, or undefined when invalid.
 */
export function parseText(spec: FieldSpec, text: string): FieldWrite | undefined {
  if (spec.kind === 'text') return text === '' ? { kind: 'clear' } : { kind: 'set', value: text }
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'clear' }
  if (spec.kind === 'integer' && !/^-?\d+$/.test(trimmed)) return undefined
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return undefined
  if (spec.min !== undefined && n < spec.min) return undefined
  if (spec.max !== undefined && n > spec.max) return undefined
  if (spec.exclusiveMin !== undefined && n <= spec.exclusiveMin) return undefined
  return { kind: 'set', value: n }
}

/** Stages edits over the `pbfuzz` scope and writes them on save. */
export class PathForm {
  private readonly specs = new Map<string, FieldSpec>(FIELDS.map(spec => [spec.id, spec]))
  private readonly staged = new Map<string, Staged>()
  private saving = false
  private failed = false

  /**
   * @param scope - bound scope of the `pbfuzz` namespace.
   * @param changed - called after every local state change (the controller republishes).
   */
  constructor(private readonly scope: SettingsScope<unknown>, private readonly changed: () => void) {}

  /** @returns the card-level state. */
  shell(): FormShell {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      status: snapshot.status,
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.write === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  /**
   * @param id - field id.
   * @returns the control state.
   */
  field(id: string): FieldState {
    const spec = this.spec(id)
    const path = pathOf(id)
    const section = getAt(this.scope.getSnapshot().value, path)
    if (spec.readOnly === true) {
      const value = section ?? spec.default
      return { value, text: summarizeEnvSelfcheck(value), overridden: false, invalid: false }
    }
    const stored = hasAt(this.scope.getSnapshot().user, path)
    const staged = this.staged.get(id)
    if (staged === undefined) {
      const value = section ?? spec.default
      return { value, text: format(value), overridden: stored, invalid: false }
    }
    const write = staged.write
    const value = write === undefined
      ? section ?? spec.default
      : write.kind === 'set' ? write.value : this.baseValue(id)
    return { value, text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined }
  }

  /**
   * Stage typed text for an integer/number/text field.
   * @param id - field id.
   * @param text - draft text.
   */
  editText(id: string, text: string): void {
    const spec = this.spec(id)
    if (spec.readOnly === true) return
    this.stage(id, { text, write: parseText(spec, text) })
  }

  /**
   * Stage a value for a toggle/enum/multi field.
   * @param id - field id.
   * @param value - chosen value.
   */
  editValue(id: string, value: unknown): void {
    if (this.spec(id).readOnly === true) return
    this.stage(id, { text: format(value), write: { kind: 'set', value } })
  }

  /**
   * Stage a clear so the field re-inherits the composition layer.
   * @param id - field id.
   */
  reset(id: string): void {
    if (this.spec(id).readOnly === true) return
    this.stage(id, { text: format(this.baseValue(id)), write: { kind: 'clear' } })
  }

  /** Drop every staged edit. */
  discard(): void {
    if (this.staged.size === 0 && !this.failed) return
    this.staged.clear()
    this.failed = false
    this.changed()
  }

  /**
   * Write every staged edit as one atomic mutation, then check what the Host kept.
   * @returns settlement after the write and the read-back.
   */
  async save(): Promise<void> {
    const plan = this.plan()
    if (plan.length === 0 || this.saving || plan.some(item => item.write === undefined)) return
    const ops: SettingsPathOpView[] = plan.map(({ id, write }) => write?.kind === 'set'
      ? { op: 'set', path: pathOf(id), value: write.value } as SettingsPathOpView
      : { op: 'unset', path: pathOf(id) } as SettingsPathOpView)
    this.saving = true
    this.failed = false
    this.changed()
    let landed = false
    try {
      await this.scope.mutate(ops)
      const user = this.scope.getSnapshot().user
      landed = plan.every(({ id, write }) => write?.kind === 'set'
        ? same(getAt(user, pathOf(id)), write.value)
        : !hasAt(user, pathOf(id)))
    } catch (error) {
      console.error('[pbfuzz] settings save failed:', error)
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.changed()
  }

  private plan(): { id: string; write: FieldWrite | undefined }[] {
    const out: { id: string; write: FieldWrite | undefined }[] = []
    const snapshot = this.scope.getSnapshot()
    for (const [id, staged] of this.staged) {
      const path = pathOf(id)
      const stored = hasAt(snapshot.user, path)
      const write = staged.write
      if (write === undefined) out.push({ id, write })
      else if (write.kind === 'clear') { if (stored) out.push({ id, write }) }
      else if (!(stored && same(getAt(snapshot.user, path), write.value))
        && !same(getAt(snapshot.value, path) ?? this.spec(id).default, write.value)) out.push({ id, write })
    }
    return out
  }

  private stage(id: string, edit: Staged): void {
    this.staged.set(id, edit)
    this.failed = false
    this.changed()
  }

  private baseValue(id: string): unknown {
    return getAt(this.scope.getSnapshot().base, pathOf(id)) ?? this.spec(id).default
  }

  private spec(id: string): FieldSpec {
    const spec = this.specs.get(id)
    if (spec === undefined) throw new Error(`pbfuzz card has no field ${id}`)
    return spec
  }
}
