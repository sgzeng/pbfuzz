/**
 * `pbfuzz.campaign.yaml` serialization, and the summary the approval panel shows.
 *
 * The yaml is target-project facts only. It used to annotate every inferred field with a trailing
 * `# inferred: <evidence>` comment AND serialize the same evidence again as a `provenance:` block,
 * which for a single-file target produced a 12.8 KB file whose ~80% was the same 22 sentences
 * twice — and the approval panel rendered the whole thing, so the user read it all. Evidence now
 * reaches the user exactly once, in {@link campaignReviewMarkdown}, and is not persisted.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/campaign-yaml
 */

import { dirname } from 'node:path'
import { Document, parse } from 'yaml'
import type { PbfuzzCampaign } from './contracts.ts'

/**
 * Serialize a campaign.
 *
 * `output.dir` is left out when it is the directory the file is written to — which it always is
 * for a drafted campaign — because the loaders fall back to exactly that. An absolute path that
 * merely restates where the file already is was one more line to read, and made the campaign
 * impossible to move.
 * @param campaign - the campaign document.
 * @param at - where the yaml is being written, when known.
 * @returns yaml text.
 */
export function campaignToYaml(campaign: PbfuzzCampaign, at?: string): string {
  const { output, ...rest } = campaign
  const value = at !== undefined && dirname(at) === output.dir ? rest : campaign
  // The engine and the guards read this file with PyYAML, which is YAML 1.1: a bare `off`,
  // `on`, `yes` or `no` loads as a boolean (so `tracer: off` became False and every engine call
  // rejected the campaign). Serializing with the 1.1 schema quotes those strings; the output
  // stays plain YAML that the 1.2 parser in parseCampaignYaml reads identically.
  const doc = new Document(value, { version: '1.1' })
  return doc.toString({ lineWidth: 0, directives: false })
}

/**
 * Fill in `output.dir` when the file leaves it out: it is then the directory holding the file (see
 * {@link campaignToYaml}). Anything that is not a mapping is returned as is, for validation to
 * report.
 * @param parsed - the parsed yaml.
 * @param fileDir - the directory the campaign file is in.
 * @returns the campaign with `output.dir` set.
 */
export function withDefaultOutputDir(parsed: unknown, fileDir: string): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed
  const c = parsed as Record<string, unknown>
  const output = typeof c.output === 'object' && c.output !== null ? c.output as Record<string, unknown> : {}
  return output.dir !== undefined ? parsed : { ...c, output: { ...output, dir: fileDir } }
}

/**
 * Parse campaign yaml. Validation is separate (`validateCampaign`) so a hand-written headless
 * campaign gets a full issue list rather than the first parse error.
 * @param text - yaml text.
 * @returns the parsed value.
 */
export function parseCampaignYaml(text: string): unknown {
  return parse(text)
}

/**
 * What the target runs and how a run is judged, one fact per line.
 *
 * Each is a markdown list item on purpose: the panel renders `detail` as markdown, and plain
 * consecutive lines collapse into a single run-on paragraph there — which is exactly what a
 * campaign summary must not look like.
 */
function summaryLines(c: PbfuzzCampaign): string[] {
  const lines = [
    `- **Target** \`${c.target.repo}\`${c.target.language !== undefined ? ` (${c.target.language})` : ''}`,
    ...c.bug.targets.map(t => `- **Bug** \`${t.location}\`${t.condition !== undefined ? ` — ${t.condition}` : ''}`),
    `- **Run** \`${c.entry.run_cmd}\`${c.entry.cwd !== undefined ? ` in \`${c.entry.cwd}\`` : ''} (input by ${c.entry.input_channel})`,
  ]
  if (c.build?.cmd !== undefined) lines.push(`- **Build** \`${c.build.cmd}\`${c.build.dir !== undefined ? ` in \`${c.build.dir}\`` : ''}`)
  lines.push(c.oracle.mode === 'preexisting'
    ? `- **Oracle** the target's own markers — reached \`${c.oracle.reached_pattern}\`, triggered \`${c.oracle.triggered_pattern}\``
    : `- **Oracle** pbfuzz canaries to insert — reached \`${c.oracle.reached_pattern}\`, triggered \`${c.oracle.triggered_pattern}\``)
  const s = c.analysis?.static
  if (s !== undefined && s.enabled !== false) lines.push(`- **Static analysis** ${s.mode ?? 'wllvm'}${s.program !== undefined ? ` on \`${s.program}\`` : ''}${s.entries !== undefined ? `, entries ${s.entries.join(', ')}` : ''}`)
  const corpus = c.analysis?.corpus
  if (corpus?.enabled === true) lines.push(`- **Seeds** \`${corpus.seeds_dir!}\``)
  if (c.tracer !== undefined) lines.push(`- **Tracer** ${c.tracer}`)
  lines.push(`- **Output** \`${c.output.dir}\``)
  return lines
}

/** One verified environment step, as `draft` actually ran it. */
export interface CampaignVerification {
  step: string
  ok: boolean
  detail: string
}

/**
 * The approval panel's markdown: a decision-sized summary, then what was verified, then how the
 * inferred fields were decided. The full yaml is on disk and named here rather than inlined —
 * the panel renders in a ~520px scroll pane, so a 155-line document arrived as a wall to scroll.
 * @param campaign - the drafted campaign.
 * @param options - automatic decisions, verification results, per-field evidence, and the yaml path.
 * @returns markdown for the question's `detail`.
 */
export function campaignReviewMarkdown(campaign: PbfuzzCampaign, options: {
  decisions?: string[]
  verification?: CampaignVerification[]
  evidence?: Record<string, string>
  path?: string
} = {}): string {
  const lines = ['## pbfuzz campaign', '', ...summaryLines(campaign)]
  const verification = options.verification ?? []
  if (verification.length > 0) {
    lines.push('', '**Verified just now:**', ...verification.map(v => `- ${v.ok ? '✓' : '✗'} ${v.step} — ${v.detail}`))
  }
  const decisions = options.decisions ?? []
  if (decisions.length > 0) lines.push('', '**Automatic decisions:**', ...decisions.map(d => `- ${d}`))
  const evidence = Object.entries(options.evidence ?? {})
  if (evidence.length > 0) {
    lines.push('', '**How pbfuzz decided:**', ...evidence.map(([field, why]) => `- \`${field}\` — ${why}`))
  }
  if (options.path !== undefined) lines.push('', `Full campaign: \`${options.path}\``)
  return lines.join('\n')
}
