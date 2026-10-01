/**
 * The pbfuzz settings card's field table — a hand-kept mirror of
 * `contracts/pbfuzz-settings.schema.json`. The bundle script's parity check
 * (`scripts/bundle-client.mjs`) compares this table against the schema leaf by
 * leaf (path, kind, default, enum, bounds) and fails the build on any drift, so
 * the card can never render a field the Host does not serve or miss one it does.
 *
 * This module is value-free of any framework import on purpose: the parity
 * check bundles it on its own and imports it in Node.
 */

/** Settings namespace served by W1's host half; the card's slot key. */
export const PBFUZZ_SETTINGS_NS = 'pbfuzz'

/** Namespace of the dsh-kanalyzer plugin; its presence is how the card detects the plugin. */
export const KANALYZER_NS = 'kanalyzer'

/** Card groups, in render order (PLAN §2.8 A). Each is one schema sub-object. */
export const GROUPS = ['tools', 'budget', 'fuzzing', 'onboarding', 'oracleDefaults', 'execution', 'guards', 'status'] as const

/** One card group id (also the schema sub-object key). */
export type GroupId = (typeof GROUPS)[number]

/**
 * How a field is edited: `toggle` boolean, `integer`/`number` numeric text,
 * `text` free string, `enum` one-of menu, `multi` subset of `options`.
 *
 * `?object` is not really an edit kind: it is what the schema-parity check
 * (`kindOf()` in `scripts/bundle-client.mjs`) computes for any leaf whose JSON
 * Schema `type` is not one of the primitives above — currently only
 * `status.envSelfcheck`, the schema's one nested-object leaf. A field of this
 * kind is always `readOnly` and is never staged; the card renders it as
 * computed summary text instead of a control.
 */
export type FieldKind = 'toggle' | 'integer' | 'number' | 'text' | 'enum' | 'multi' | '?object'

/** One editable leaf of the settings section. */
export interface FieldSpec {
  /** Dotted path inside the namespace section, e.g. `tools.staticAnalysis`. */
  readonly id: string
  /** Group this field renders in; equals the first path segment. */
  readonly group: GroupId
  /** Control kind. */
  readonly kind: FieldKind
  /** Schema default, shown while neither the user nor the composition layer carries a value. */
  readonly default: unknown
  /** Allowed values for `enum` and `multi`. */
  readonly options?: readonly string[]
  /** Inclusive lower bound (`minimum`). */
  readonly min?: number
  /** Inclusive upper bound (`maximum`). */
  readonly max?: number
  /** Exclusive lower bound (`exclusiveMinimum`). */
  readonly exclusiveMin?: number
  /** Whether the Host applies a change only on restart; the card marks it. */
  readonly restart?: boolean
  /**
   * Whether the Host writes this field and the card only reads it: no edit
   * control, no override marker, no staging. Currently only `status.envSelfcheck`.
   */
  readonly readOnly?: boolean
}

/** Every field the card renders — exactly the schema's leaves, in schema order. */
export const FIELDS: readonly FieldSpec[] = [
  { id: 'tools.staticAnalysis', group: 'tools', kind: 'enum', default: 'off', options: ['off', 'kanalyzer'] },
  { id: 'tools.corpusAnalysis', group: 'tools', kind: 'toggle', default: true },
  { id: 'tools.deviationDetection', group: 'tools', kind: 'toggle', default: true },
  { id: 'tools.tracer', group: 'tools', kind: 'enum', default: 'auto', options: ['auto', 'gdb', 'lldb', 'pymon', 'jdb', 'off'] },
  { id: 'tools.interactiveDebug', group: 'tools', kind: 'toggle', default: true },

  { id: 'budget.maxPierRounds', group: 'budget', kind: 'integer', default: 5, min: 1, max: 100 },
  { id: 'budget.campaignWallTimeMin', group: 'budget', kind: 'integer', default: 30, min: 1 },
  { id: 'budget.autoContinue', group: 'budget', kind: 'toggle', default: true },
  { id: 'budget.maxConsecutiveForcedContinues', group: 'budget', kind: 'integer', default: 3, min: 1, max: 20 },

  { id: 'fuzzing.maxIters', group: 'fuzzing', kind: 'integer', default: 1000, min: 1 },
  { id: 'fuzzing.execTimeoutSec', group: 'fuzzing', kind: 'number', default: 3, exclusiveMin: 0 },
  { id: 'fuzzing.fuzzTimeoutSec', group: 'fuzzing', kind: 'number', default: 600, exclusiveMin: 0 },
  { id: 'fuzzing.generatorTimeoutSec', group: 'fuzzing', kind: 'number', default: 1, exclusiveMin: 0 },
  { id: 'fuzzing.stage1MinConcreteParams', group: 'fuzzing', kind: 'integer', default: 5, min: 0 },
  { id: 'fuzzing.enableDebuggerForAll', group: 'fuzzing', kind: 'toggle', default: false },

  { id: 'onboarding.interviewPolicy', group: 'onboarding', kind: 'enum', default: 'when-missing', options: ['always', 'when-missing', 'never'] },
  { id: 'onboarding.deriveTargetFrom', group: 'onboarding', kind: 'multi', default: ['patch', 'cve', 'crashTrace'], options: ['patch', 'cve', 'crashTrace'] },
  { id: 'onboarding.defaultOutputRoot', group: 'onboarding', kind: 'text', default: '.pbfuzz' },
  { id: 'onboarding.confirmTimeoutMin', group: 'onboarding', kind: 'integer', default: 0, min: 0 },

  { id: 'oracleDefaults.canaryOnTrigger', group: 'oracleDefaults', kind: 'enum', default: 'log', options: ['abort', 'log'] },
  { id: 'oracleDefaults.reachedPattern', group: 'oracleDefaults', kind: 'text', default: 'PBFUZZ_REACHED:\\s*(\\S+)' },
  { id: 'oracleDefaults.triggeredPattern', group: 'oracleDefaults', kind: 'text', default: 'PBFUZZ_TRIGGERED:\\s*(\\S+)' },

  { id: 'execution.pythonPath', group: 'execution', kind: 'text', default: 'python3', restart: true },
  { id: 'execution.gdbPath', group: 'execution', kind: 'text', default: 'gdb', restart: true },
  { id: 'execution.generatorMemLimitMB', group: 'execution', kind: 'integer', default: 512, min: 16 },
  { id: 'execution.generatorCpuLimitSec', group: 'execution', kind: 'integer', default: 10, min: 1 },
  { id: 'execution.logLevel', group: 'execution', kind: 'enum', default: 'info', options: ['error', 'warn', 'info', 'debug'] },
  { id: 'execution.fuzzBackground', group: 'execution', kind: 'toggle', default: true },

  { id: 'guards.bashGuard', group: 'guards', kind: 'toggle', default: true },
  { id: 'guards.tamperLedger', group: 'guards', kind: 'toggle', default: true },
  { id: 'guards.hideToolsWithoutCampaign', group: 'guards', kind: 'toggle', default: false },

  {
    id: 'status.envSelfcheck',
    group: 'status',
    kind: '?object',
    default: { checkedAt: '', ttlExpiresAt: '', overall: '', items: [] },
    readOnly: true,
  },
]

/**
 * Split a field id into its section path.
 * @param id - dotted field id.
 * @returns the path segments.
 */
export function pathOf(id: string): string[] {
  return id.split('.')
}
