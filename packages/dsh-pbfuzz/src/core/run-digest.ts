/**
 * What one fuzz run found, in the few lines REFLECT needs — handed to the model when the run ends.
 *
 * The engine writes everything a round produces to disk (`state/metrics.json`, and one JSON line
 * per iteration in `runs/session-NNNN/iterations.jsonl`), but nothing on the host side ever read
 * the iteration log, and the job's own `job_output` could not return the run result at all (the
 * job's `readOutput` shadows its final `output`). So in a recorded session the model spent five
 * steps reading those files by hand — `cat`, `ls`, `xxd`, `find`, `cat` — to learn what this
 * digest now states when the job finishes: the counts, the PoC and whether the engine reproduced
 * it, the triggering input's parameters, size and signal, and which breakpoints were hit or never
 * bound.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/run-digest
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PbfuzzCampaign, PbfuzzMetrics } from './contracts.ts'

/** One breakpoint's result in a traced iteration (`tracers/base.py`). */
interface BreakpointRecord {
  location?: string
  hitTimes?: number
  resolved?: boolean
}

/** One `iterations.jsonl` line (`fuzzer.py` `_record`/`_run_one`), as far as this module reads it. */
export interface IterationRecord {
  type?: 'iter_result' | 'error'
  iter?: number
  stage?: number
  parameters?: Record<string, unknown>
  reached?: number
  triggered?: number
  timeout?: boolean
  exit_code?: number | null
  size?: number
  signal?: string
  trace?: { breakpoints?: BreakpointRecord[] }
  /** `type: 'error'` records. */
  phase?: string
  message?: string
  diagnosis?: string
}

/**
 * Parse an `iterations.jsonl`, skipping any line that is not a JSON object (a run killed mid-write
 * leaves a torn last line; that must not cost the rest of the digest).
 * @param path - the file.
 * @returns the records, in file order; empty when the file does not exist.
 */
export function readIterations(path: string): IterationRecord[] {
  if (!existsSync(path)) return []
  const out: IterationRecord[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) out.push(value as IterationRecord)
    } catch { /* torn line */ }
  }
  return out
}

/**
 * The newest run's iteration log under `<campaign dir>/runs/`.
 * @param campaignDir - `<output.dir>`.
 * @returns its path, or undefined when no run has been recorded yet.
 */
export function latestIterationsPath(campaignDir: string): string | undefined {
  const runs = join(campaignDir, 'runs')
  if (!existsSync(runs)) return undefined
  const sessions = readdirSync(runs).filter(n => /^session-\d+$/.test(n)).sort()
  const last = sessions.at(-1)
  return last === undefined ? undefined : join(runs, last, 'iterations.jsonl')
}

/** The first iteration that triggered, which is the one the engine keeps as the PoC. */
export function triggeringIteration(records: IterationRecord[]): IterationRecord | undefined {
  return records.find(r => r.type !== 'error' && (r.triggered ?? 0) > 0)
}

/**
 * The command that reproduces `inputPath` against the campaign's own entry.
 * @param campaign - the campaign.
 * @param inputPath - the PoC.
 * @returns `run_cmd` with the input substituted (file) or redirected (stdin).
 */
export function reproduceCommand(campaign: PbfuzzCampaign, inputPath: string): string {
  const { run_cmd: cmd, input_channel: channel } = campaign.entry
  return channel === 'file' ? cmd.replace(/@@/g, inputPath) : `${cmd} < ${inputPath}`
}

const MAX_PARAMS = 240

/** Per location: total hits across traced iterations, and whether any trace ever bound it. */
function breakpointSummary(records: IterationRecord[]): string | undefined {
  const byLocation = new Map<string, { hits: number; resolved: boolean }>()
  for (const r of records) {
    for (const bp of r.trace?.breakpoints ?? []) {
      if (bp.location === undefined) continue
      const seen = byLocation.get(bp.location) ?? { hits: 0, resolved: false }
      byLocation.set(bp.location, { hits: seen.hits + (bp.hitTimes ?? 0), resolved: seen.resolved || bp.resolved === true })
    }
  }
  if (byLocation.size === 0) return undefined
  const hit = [...byLocation].filter(([, v]) => v.resolved).map(([loc, v]) => `${loc} ×${v.hits}`)
  const unbound = [...byLocation].filter(([, v]) => !v.resolved).map(([loc]) => loc)
  return [
    hit.length > 0 ? `breakpoints hit: ${hit.join(', ')}` : '',
    unbound.length > 0 ? `never bound (a build without -g, or a line with no instruction — fix before trusting a 0): ${unbound.join(', ')}` : '',
  ].filter(s => s !== '').join('; ')
}

/** Everything the digest reads. */
export interface RunDigestInput {
  campaign: PbfuzzCampaign
  metrics: PbfuzzMetrics | undefined
  iterations: IterationRecord[]
  iterationsPath: string | undefined
}

/**
 * The digest itself: a handful of lines, ending with what to do next.
 * @param input - the round's evidence.
 * @returns the text.
 */
export function runDigest(input: RunDigestInput): string {
  const s = input.metrics?.last_session
  const lines: string[] = []
  const stages = [1, 2].map(n => input.iterations.filter(r => r.type !== 'error' && r.stage === n).length)
  lines.push(`this round: ${s?.iterations ?? 0} iterations (stage 1: ${stages[0]}, stage 2: ${stages[1]}), ${s?.reached ?? 0} reached, ${s?.triggered ?? 0} triggered, ${s?.timeouts ?? 0} timeouts, ${s?.errors ?? 0} errors, ${s?.elapsed_sec ?? '?'} s, stopped by ${s?.stopped_by ?? '?'}`)

  const trigger = triggeringIteration(input.iterations)
  if (s?.first_triggering_input !== undefined) {
    const reproduced = s.reproduced_ok !== undefined ? ` — the engine re-ran it: ${s.reproduced_ok}/${s.reproduced_times ?? s.reproduced_ok} reproduced` : ''
    lines.push(`PoC: ${s.first_triggering_input}${reproduced}`)
  }
  if (trigger !== undefined) {
    const params = JSON.stringify(trigger.parameters ?? {})
    const how = trigger.signal !== undefined ? `${trigger.signal} (exit ${trigger.exit_code ?? '?'})` : `exit ${trigger.exit_code ?? '?'}`
    lines.push(`triggering input: iteration ${trigger.iter ?? '?'} (stage ${trigger.stage ?? '?'}), ${trigger.size ?? '?'} bytes, ${how}, params ${params.length > MAX_PARAMS ? `${params.slice(0, MAX_PARAMS)}…` : params}`)
  } else if (s?.best_reaching_input !== undefined) {
    lines.push(`best reaching input (nothing triggered): ${s.best_reaching_input}`)
  }
  const breakpoints = breakpointSummary(input.iterations)
  if (breakpoints !== undefined) lines.push(breakpoints)
  const errors = input.iterations.filter(r => r.type === 'error')
  if (errors.length > 0) {
    const first = errors[0]!
    lines.push(`${errors.length} engine error(s); first: ${first.phase ?? '?'}: ${first.message ?? ''}${first.diagnosis !== undefined ? ` — ${first.diagnosis}` : ''}`)
  }
  if (input.iterationsPath !== undefined) lines.push(`per-iteration log: ${input.iterationsPath}`)
  lines.push((s?.triggered ?? 0) > 0
    ? 'next: pbfuzz_reflect with decision "success" — the PoC, its command and parameters are filled in from this evidence; no need to read job_output or the run files'
    : 'next: pbfuzz_reflect — this is everything job_output or the run files would add')
  return lines.join('\n')
}

/**
 * The digest for a campaign's newest run, read from disk.
 * @param campaign - the campaign.
 * @param campaignDir - `<output.dir>`.
 * @param metrics - `state/metrics.json`, already read.
 * @returns the text.
 */
export function campaignRunDigest(campaign: PbfuzzCampaign, campaignDir: string, metrics: PbfuzzMetrics | undefined): string {
  const iterationsPath = latestIterationsPath(campaignDir)
  return runDigest({ campaign, metrics, iterations: iterationsPath === undefined ? [] : readIterations(iterationsPath), iterationsPath })
}
