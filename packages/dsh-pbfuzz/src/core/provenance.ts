/**
 * Provenance bookkeeping for campaign fields.
 *
 * Contract rule 2: every campaign field the agent inferred carries provenance, so the
 * confirmation panel can show the user exactly what pbfuzz decided on its own rather than what
 * they said. Inference without a visible evidence trail is the failure mode this prevents.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/provenance
 */

import type { Provenance, ProvenanceEntry, ValueSource } from './contracts.ts'

/** A value plus how it was decided, as the questionnaire and the inference passes produce it. */
export interface SourcedValue<T> {
  value: T
  source: ValueSource
  /** The concrete observation behind the value (`llvm-nm found …`), not a restatement of it. */
  evidence?: string
  confirmed?: boolean
}

/** Accumulates `provenance` while a campaign draft is assembled field by field. */
export class ProvenanceBuilder {
  private readonly entries = new Map<string, ProvenanceEntry>()

  /**
   * Record how one dotted field path was decided.
   *
   * Defense-in-depth (F2): callers are expected to normalize answers into `{value, source,
   * evidence}` before this point (see `normalizeDraftAnswers` in `core/campaign.ts`), but this
   * guard means a caller that skips that step gets a field-named error instead of the raw
   * `Cannot read properties of undefined (reading 'source')` TypeError this method used to throw
   * when `sourced` was missing entirely.
   * @param path - dotted campaign field path, e.g. `entry.run_cmd`.
   * @param sourced - the value and its provenance.
   * @returns the recorded value, so callers can assign and record in one expression.
   */
  record<T>(path: string, sourced: SourcedValue<T>): T {
    if (typeof sourced !== 'object' || sourced === null || Array.isArray(sourced) || typeof (sourced as { source?: unknown }).source !== 'string') {
      const got = sourced === undefined ? 'undefined'
        : sourced === null ? 'null'
        : Array.isArray(sourced) ? 'an array'
        : typeof sourced === 'object' ? 'an object with no (or a non-string) source'
        : `a ${typeof sourced}`
      throw new Error(`campaign field "${path}" must be {value, source, evidence} (or a plain value, which the draft normalizer coerces automatically) — got ${got}`)
    }
    this.entries.set(path, {
      source: sourced.source,
      ...sourced.evidence !== undefined ? { evidence: sourced.evidence } : {},
      ...sourced.confirmed !== undefined ? { confirmed: sourced.confirmed } : {},
    })
    return sourced.value
  }

  /**
   * Mark one recorded field as explicitly approved by the user. Called after the plan-review
   * panel returns Approve, so a later reader can tell a confirmed inference from a raw one.
   * @param path - dotted campaign field path.
   */
  confirm(path: string): void {
    const entry = this.entries.get(path)
    if (entry !== undefined) this.entries.set(path, { ...entry, confirmed: true })
  }

  /** Mark every recorded field as user-approved (the Approve verdict covers the whole yaml). */
  confirmAll(): void {
    for (const path of [...this.entries.keys()]) this.confirm(path)
  }

  /** The paths whose values the agent decided rather than the user. */
  inferredPaths(): string[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => entry.source === 'inferred' || entry.source === 'agent_built')
      .map(([path]) => path)
      .sort()
  }

  /** Inferred paths that carry no evidence — a draft-time bug, surfaced by `validateCampaign`. */
  unevidencedPaths(): string[] {
    return [...this.entries.entries()]
      .filter(([, entry]) => (entry.source === 'inferred' || entry.source === 'agent_built')
        && (entry.evidence === undefined || entry.evidence.trim() === ''))
      .map(([path]) => path)
      .sort()
  }

  /** The accumulated provenance map, key-sorted so a redraft produces a stable yaml diff. */
  build(): Provenance {
    const out: Provenance = {}
    for (const path of [...this.entries.keys()].sort()) out[path] = this.entries.get(path)!
    return out
  }

  /** Seed from an existing campaign's provenance, for the Revise → regenerate path. */
  static from(provenance: Provenance | undefined): ProvenanceBuilder {
    const builder = new ProvenanceBuilder()
    for (const [path, entry] of Object.entries(provenance ?? {})) builder.entries.set(path, entry)
    return builder
  }
}

/**
 * Render one provenance entry as the trailing yaml comment the confirmation panel shows.
 * @param entry - the provenance entry.
 * @returns the comment text without the leading `#`, or undefined for user-supplied values.
 */
export function provenanceComment(entry: ProvenanceEntry): string | undefined {
  if (entry.source === 'user') return undefined
  const label = entry.source === 'agent_built' ? 'agent-built' : entry.source
  return entry.evidence === undefined ? label : `${label}: ${entry.evidence}`
}
