/**
 * The editable fields of the `kanalyzer` settings namespace, exactly as
 * `contracts/kanalyzer-settings.schema.json` declares them. Every field is a
 * nested path, so writes go through `ConfigForm.mutate()` path ops —
 * `ConfigForm.set(field)` only addresses a top-level key.
 *
 * `status.*` is deliberately absent: the host writes it and the card only reads it.
 */

/** How one field is edited and validated. */
export type FieldKind = 'text' | 'integer' | 'boolean' | 'enum' | 'list'

/** What a field's staged draft holds, by kind. */
export type DraftValue = string | boolean | string[]

/** One editable settings field. */
export interface FieldSpec {
  /** Stable id: the dotted path. */
  id: string
  /** Path inside the namespace section. */
  path: readonly string[]
  kind: FieldKind
  /** Schema default, shown when the resolved section carries no value. */
  fallback: DraftValue
  /** Integer bounds (inclusive). */
  min?: number
  max?: number
  /** Enum choices, as strings (integer enums parse back to numbers). */
  options?: readonly string[]
  /** Text fields: whether an empty draft is a valid value rather than invalid. */
  allowEmpty?: boolean
}

function spec(path: string, kind: FieldKind, fallback: DraftValue, extra: Partial<FieldSpec> = {}): FieldSpec {
  return { id: path, path: path.split('.'), kind, fallback, ...extra }
}

/** Install / build group. */
export const INSTALL_FIELDS: readonly FieldSpec[] = [
  spec('install.installDir', 'text', '~/.dsh/kanalyzer'),
  spec('install.repoUrl', 'text', 'https://github.com/sgzeng/kernel-analyzer.git'),
  spec('install.branch', 'text', 'mzt'),
  // Empty is meaningful: auto-detect (prefers /usr/lib/llvm-14).
  spec('install.llvmPrefix', 'text', '', { allowEmpty: true }),
  spec('install.buildType', 'enum', 'Release', { options: ['Release', 'RelWithDebInfo', 'Debug'] }),
  spec('install.jobs', 'integer', '0', { min: 0 }),
]

/** The six KAMain dump toggles. */
export const DUMP_FIELDS: readonly FieldSpec[] = [
  spec('defaults.dumps.policy', 'boolean', true),
  spec('defaults.dumps.distance', 'boolean', true),
  spec('defaults.dumps.criticalBranch', 'boolean', true),
  spec('defaults.dumps.bidMappingAndFuncInfo', 'boolean', true),
  spec('defaults.dumps.callerCalleeBothWays', 'boolean', true),
  spec('defaults.dumps.annotatedIr', 'boolean', false),
]

/** Default analysis options group (dumps included). */
export const DEFAULT_FIELDS: readonly FieldSpec[] = [
  spec('defaults.verbose', 'enum', '1', { options: ['0', '1', '2', '3'] }),
  spec('defaults.callStackLen', 'integer', '20', { min: 1 }),
  spec('defaults.useTypeBasedCallGraph', 'boolean', true),
  ...DUMP_FIELDS,
  spec('defaults.timeoutSec', 'integer', '1800', { min: 1 }),
  spec('defaults.memLimitMB', 'integer', '16384', { min: 256 }),
  spec('defaults.cacheEnabled', 'boolean', true),
]

/** Standalone-run inputs group: only for `/kanalyzer analyze` by hand. */
export const STANDALONE_FIELDS: readonly FieldSpec[] = [
  spec('standalone.inputFilenames', 'list', []),
  spec('standalone.targetList', 'list', []),
  spec('standalone.entryList', 'list', []),
]

/** Every editable field. */
export const ALL_FIELDS: readonly FieldSpec[] = [...INSTALL_FIELDS, ...DEFAULT_FIELDS, ...STANDALONE_FIELDS]

/** Integer-valued enums store numbers, not strings. */
const NUMERIC_ENUMS = new Set(['defaults.verbose'])

/**
 * Render a stored value as a draft of the field's kind.
 * @param field - the field spec.
 * @param value - the stored value, or undefined when the section has none.
 * @returns the draft.
 */
export function toDraft(field: FieldSpec, value: unknown): DraftValue {
  switch (field.kind) {
    case 'boolean': return typeof value === 'boolean' ? value : field.fallback
    case 'list': return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : field.fallback
    case 'integer':
    case 'enum': return typeof value === 'number' || typeof value === 'string' ? String(value) : field.fallback
    case 'text': return typeof value === 'string' ? value : field.fallback
  }
}

/**
 * Parse a draft into the JSON value a save stores.
 * @param field - the field spec.
 * @param draft - the staged draft.
 * @returns `{ ok: true, value }`, or `{ ok: false }` when the draft is not a value this field accepts.
 */
export function parseDraft(field: FieldSpec, draft: DraftValue): { ok: true; value: unknown } | { ok: false } {
  switch (field.kind) {
    case 'boolean':
      return typeof draft === 'boolean' ? { ok: true, value: draft } : { ok: false }
    case 'list':
      return Array.isArray(draft)
        ? { ok: true, value: draft.map(entry => entry.trim()).filter(entry => entry !== '') }
        : { ok: false }
    case 'enum': {
      if (typeof draft !== 'string' || !(field.options ?? []).includes(draft)) return { ok: false }
      return { ok: true, value: NUMERIC_ENUMS.has(field.id) ? Number(draft) : draft }
    }
    case 'integer': {
      if (typeof draft !== 'string' || !/^\d+$/.test(draft.trim())) return { ok: false }
      const n = Number(draft.trim())
      if (!Number.isSafeInteger(n)) return { ok: false }
      if (field.min !== undefined && n < field.min) return { ok: false }
      if (field.max !== undefined && n > field.max) return { ok: false }
      return { ok: true, value: n }
    }
    case 'text': {
      if (typeof draft !== 'string') return { ok: false }
      const trimmed = draft.trim()
      if (trimmed === '' && field.allowEmpty !== true) return { ok: false }
      return { ok: true, value: trimmed }
    }
  }
}

/**
 * Read a nested value.
 * @param root - the object to read from.
 * @param path - the key path.
 * @returns the value, or undefined when any segment is absent.
 */
export function getAt(root: unknown, path: readonly string[]): unknown {
  let node = root
  for (const key of path) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/**
 * Whether a nested key is present (presence, not value, marks an override).
 * @param root - the object to read from.
 * @param path - the key path.
 * @returns true when every segment exists.
 */
export function hasAt(root: unknown, path: readonly string[]): boolean {
  let node = root
  for (const key of path) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key)) return false
    node = (node as Record<string, unknown>)[key]
  }
  return true
}

/**
 * Structural JSON equality.
 * @param a - left value.
 * @param b - right value.
 * @returns whether both serialize identically.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
