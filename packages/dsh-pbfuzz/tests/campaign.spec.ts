import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateArgs } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { APPROVE, confirm, draft, REVISE, type FlowContext } from '../src/campaign-flow.ts'
import {
  ANSWERS_PARAMETER_SCHEMA,
  confirmCampaign,
  disableAnalysis,
  draftCampaign,
  normalizeDraftAnswers,
  validateCampaign,
  type CampaignDraftInput,
} from '../src/core/campaign.ts'
import { campaignReviewMarkdown, campaignToYaml, parseCampaignYaml } from '../src/core/campaign-yaml.ts'
import { PbfuzzHost, type AgentLike } from '../src/host.ts'
import type { QuestionAsker } from '../src/recovery.ts'
import { draftInput, settings } from './fixtures.ts'

/**
 * The shape an agent actually sends: the campaign's own field names, nested, snake_case, plain
 * values. There is no `{value, source, evidence}` wrapper anywhere — the wrapper existed on most
 * leaves but not on six of them, which is exactly what failed a live `draft` call
 * (`"answers.id" must be a string`) after the skill promised it was universal.
 */
const ANSWERS = {
  id: 'libpng-png006',
  target: { repo: '/magma/targets/libpng', language: 'c' },
  bug: {
    targets: [{ location: 'pngrutil.c:3159', condition: 'info_ptr->free_me & PNG_FREE_EXIF' }],
  },
  entry: {
    kind: 'api',
    harness: 'src/libpng_read_fuzzer.cc',
    harness_function: 'LLVMFuzzerTestOneInput',
    run_cmd: '/magma/targets/libpng/work/libpng_read_fuzzer @@',
    input_channel: 'file',
    cwd: '/magma/targets/libpng/work',
    env: { ASAN_OPTIONS: 'detect_leaks=0' },
  },
  oracle: { mode: 'preexisting', reached_pattern: 'MAGMA: Bug (\\S+) reached', triggered_pattern: 'MAGMA: Bug (\\S+) triggered' },
  build: { cmd: './build.sh', dir: '/magma/targets/libpng' },
  analysis: {
    static: { mode: 'lto', program: 'libpng_read_fuzzer', bitcode: '/work/f.0.0.preopt.bc', entries: ['LLVMFuzzerTestOneInput'], lto_libs: ['/work/libz.a'] },
    corpus: { seeds_dir: '/magma/targets/libpng/corpus' },
  },
  output: { dir: '/magma/targets/libpng/.pbfuzz/libpng-png006' },
  evidence: { 'entry.run_cmd': 'the harness binary build.sh produces; ran it once on an empty file' },
}

const schemaErrors = (answers: unknown): string[] =>
  validateArgs({ answers: ANSWERS_PARAMETER_SCHEMA }, { answers }).map(e => String(e))

describe('ANSWERS_PARAMETER_SCHEMA (validated with the real validateArgs())', () => {
  it('accepts the campaign-shaped payload an agent sends', () => {
    expect(schemaErrors(ANSWERS)).toEqual([])
  })

  it('accepts the minimum: id, target.repo, one bug target, and the entry', () => {
    expect(schemaErrors({
      id: 'min-1',
      target: { repo: '/src' },
      bug: { targets: [{ location: 'a.c:1' }] },
      entry: { kind: 'executable', run_cmd: './a @@', input_channel: 'file' },
    })).toEqual([])
  })

  it('rejects a provenance wrapper, which no longer exists anywhere', () => {
    expect(schemaErrors({ ...ANSWERS, target: { repo: { value: '/src', source: 'user' } } }).join('\n')).toMatch(/target\.repo/)
  })

  it('rejects a field of the wrong type and an enum value outside the declared set', () => {
    expect(schemaErrors({ ...ANSWERS, id: 42 }).join('\n')).toMatch(/id/)
    expect(schemaErrors({ ...ANSWERS, target: { repo: '/src', language: 'rust' } }).join('\n')).toMatch(/language/)
  })

  it('rejects a missing required field and a missing required section', () => {
    const { entry: _entry, ...noEntry } = ANSWERS
    expect(schemaErrors(noEntry).join('\n')).toMatch(/entry/)
    expect(schemaErrors({ ...ANSWERS, target: { language: 'c' } }).join('\n')).toMatch(/target\.repo/)
  })

  it('rejects the fields settings decide, so the agent never has to read them', () => {
    for (const extra of [{ analysis: { deviation: { enabled: true } } }, { notes: 'x' }, { provenance: {} }, { confirmed_at: 'now' }]) {
      expect(schemaErrors({ ...ANSWERS, ...extra }).length, JSON.stringify(extra)).toBeGreaterThan(0)
    }
  })

  it('a schema-clean payload flows through normalizeDraftAnswers unchanged in meaning', () => {
    expect(schemaErrors(ANSWERS)).toEqual([])
    const normalized = normalizeDraftAnswers(ANSWERS)
    expect(normalized.id).toBe('libpng-png006')
    expect(normalized.entry.env).toEqual({ ASAN_OPTIONS: 'detect_leaks=0' })
    expect(normalized.bug.targets[0]!.condition).toBe('info_ptr->free_me & PNG_FREE_EXIF')
    expect(normalized.evidence).toEqual({ 'entry.run_cmd': 'the harness binary build.sh produces; ran it once on an empty file' })
  })
})

describe('normalizeDraftAnswers', () => {
  it('names the offending field instead of throwing a raw TypeError', () => {
    expect(() => normalizeDraftAnswers({ ...ANSWERS, id: ['x'] })).toThrow(/^answers\.id must be a non-empty string/)
    expect(() => normalizeDraftAnswers({ ...ANSWERS, bug: { targets: [{ location: 7 }] } })).toThrow(/^answers\.bug\.targets\[0\]\.location/)
    expect(() => normalizeDraftAnswers({ ...ANSWERS, entry: { ...ANSWERS.entry, env: { A: 1 } } })).toThrow(/^answers\.entry\.env\.A/)
    expect(() => normalizeDraftAnswers('nope')).toThrow(/^answers must be an object/)
  })

  it('names each required field that is missing', () => {
    expect(() => normalizeDraftAnswers({ target: { repo: '/src' }, bug: { targets: [{ location: 'a.c:1' }] }, entry: ANSWERS.entry })).toThrow(/^answers\.id/)
    expect(() => normalizeDraftAnswers({ id: 'x', bug: { targets: [{ location: 'a.c:1' }] }, entry: ANSWERS.entry })).toThrow(/^answers\.target\.repo/)
    expect(() => normalizeDraftAnswers({ id: 'x', target: { repo: '/src' }, entry: ANSWERS.entry })).toThrow(/^answers\.bug\.targets/)
  })

  it('drops undefined optionals rather than emitting them as null', () => {
    const normalized = normalizeDraftAnswers({
      id: 'min-1',
      target: { repo: '/src' },
      bug: { targets: [{ location: 'a.c:1' }] },
      entry: { kind: 'executable', run_cmd: './a @@', input_channel: 'file' },
    })
    expect(Object.keys(normalized.target)).toEqual(['repo'])
    expect('oracle' in normalized).toBe(false)
    expect('tracer' in normalized).toBe(false)
  })
})

describe('draftCampaign', () => {
  it('fills the values settings decide, so no answer has to name them', () => {
    const s = settings({ tools: { staticAnalysis: 'off', corpusAnalysis: false, deviationDetection: false } })
    const { campaign, validation } = draftCampaign(draftInput(), s, false)
    expect(validation.ok, JSON.stringify(validation.issues)).toBe(true)
    expect(campaign.oracle.reached_pattern).toBe(s.oracleDefaults.reachedPattern)
    expect(campaign.oracle.triggered_pattern).toBe(s.oracleDefaults.triggeredPattern)
    // The default canary behaviour is not restated in the file.
    expect(campaign.oracle.canary_on_trigger).toBeUndefined()
    expect(campaign.output.dir).toBe('/src/binutils/.pbfuzz/readelf-1')
    expect(campaign.confirmed).toBe(false)
  })

  it('writes tracer only when the campaign overrides the setting', () => {
    expect(draftCampaign(draftInput(), settings(), false).campaign.tracer).toBeUndefined()
    expect(draftCampaign(draftInput({ tracer: 'lldb' }), settings(), false).campaign.tracer).toBe('lldb')
  })

  it('turns corpus analysis off with a recorded reason when there are no seeds', () => {
    const { campaign, decisions } = draftCampaign(draftInput(), settings({ tools: { corpusAnalysis: true } }), false)
    expect(campaign.analysis?.corpus).toEqual({ enabled: false, disabled_reason: 'no seeds supplied' })
    expect(decisions.join(' ')).toMatch(/Corpus analysis off/)
  })

  it('keeps corpus on when seeds exist', () => {
    const input = draftInput({ analysis: { corpus: { seeds_dir: '/seeds' } } })
    const { campaign } = draftCampaign(input, settings({ tools: { corpusAnalysis: true } }), true)
    expect(campaign.analysis?.corpus).toEqual({ enabled: true, seeds_dir: '/seeds' })
  })

  it('degrades deviation to target_only without static analysis and uses critical_bb with it', () => {
    const off = draftCampaign(draftInput(), settings({ tools: { staticAnalysis: 'off', deviationDetection: true } }), false)
    expect(off.campaign.analysis?.deviation).toEqual({ enabled: true, mode: 'target_only' })
    expect(off.decisions.join(' ')).toMatch(/target_only/)
    const on = draftCampaign(draftInput(), settings({ tools: { staticAnalysis: 'kanalyzer', deviationDetection: true } }), false)
    expect(on.campaign.analysis?.deviation).toEqual({ enabled: true, mode: 'critical_bb' })
  })

  it('omits analysis sections for tools off in settings', () => {
    const { campaign } = draftCampaign(draftInput(), settings({ tools: { staticAnalysis: 'off', corpusAnalysis: false, deviationDetection: false } }), false)
    expect(campaign.analysis).toBeUndefined()
  })

  it('carries the static-analysis inputs the provider reads, and nothing it would not', () => {
    // `program` only names what to extract bitcode from — with `bitcode` given it is never read.
    // `enabled: true` just restated the setting.
    const input = draftInput({ analysis: { static: { mode: 'lto', program: 'p', bitcode: '/b.bc', entries: ['main'] } } })
    const { campaign } = draftCampaign(input, settings({ tools: { staticAnalysis: 'kanalyzer' } }), false)
    expect(campaign.analysis?.static).toEqual({ mode: 'lto', bitcode: '/b.bc', entries: ['main'] })
  })

  it('writes no static-analysis section at all when the agent has no inputs for it', () => {
    // The analyzer builds its own bitcode on first use; an `analysis: static: enabled: true` block
    // would only restate the setting.
    const { campaign } = draftCampaign(draftInput(), settings({ tools: { staticAnalysis: 'kanalyzer', corpusAnalysis: false, deviationDetection: false } }), false)
    expect(campaign.analysis).toBeUndefined()
  })
})

describe('validateCampaign cross-field rules', () => {
  const base = (): Record<string, unknown> => JSON.parse(JSON.stringify(draftCampaign(draftInput(), settings(), false).campaign)) as Record<string, unknown>
  const paths = (c: unknown): string[] => validateCampaign(c).issues.map(i => i.path)

  it('requires @@ iff input_channel is file', () => {
    const c = base()
    ;(c.entry as Record<string, unknown>).run_cmd = './readelf -a'
    expect(paths(c)).toContain('entry.run_cmd')
    const stdin = base()
    ;(stdin.entry as Record<string, unknown>).input_channel = 'stdin'
    expect(paths(stdin)).toContain('entry.run_cmd')
  })

  it('checks required fields, location patterns and oracle regexes', () => {
    const c = base()
    ;(c.bug as Record<string, unknown>).targets = [{ location: 'no-line' }]
    expect(paths(c)).toContain('bug.targets[0].location')
    const bad = base()
    ;(bad.oracle as Record<string, unknown>).reached_pattern = '('
    expect(paths(bad)).toContain('oracle.reached_pattern')
    const noRepo = base()
    ;(noRepo.target as Record<string, unknown>).repo = 'relative/path'
    expect(paths(noRepo)).toContain('target.repo')
  })

  it('requires disabled_reason and rejects unknown top-level fields', () => {
    const c = base()
    c.analysis = { static: { enabled: false } }
    expect(paths(c)).toContain('analysis.static.disabled_reason')
    const extra = base()
    extra.provenance = {}
    extra.notes = 'x'
    expect(paths(extra)).toEqual(expect.arrayContaining(['provenance', 'notes']))
  })

  it('refuses critical_bb deviation when static analysis is switched off for the campaign', () => {
    const c = base()
    c.analysis = { static: { enabled: false, disabled_reason: 'no LTO toolchain' }, deviation: { enabled: true, mode: 'critical_bb' } }
    expect(paths(c)).toContain('analysis.deviation.mode')
    // An absent static section means "as the settings say", which draft already resolved.
    c.analysis = { deviation: { enabled: true, mode: 'critical_bb' } }
    expect(paths(c)).not.toContain('analysis.deviation.mode')
  })

  it('rejects non-mappings', () => {
    expect(validateCampaign(null).ok).toBe(false)
    expect(validateCampaign([]).ok).toBe(false)
  })
})

describe('confirm / disable', () => {
  it('confirmCampaign sets confirmed and changes nothing else', () => {
    const { campaign } = draftCampaign(draftInput(), settings(), false)
    const confirmed = confirmCampaign(campaign)
    expect(confirmed.confirmed).toBe(true)
    expect({ ...confirmed, confirmed: false }).toEqual({ ...campaign, confirmed: false })
  })

  it('disableAnalysis records the reason and degrades deviation when static goes off', () => {
    const { campaign } = draftCampaign(draftInput(), settings({ tools: { staticAnalysis: 'kanalyzer', deviationDetection: true } }), false)
    const off = disableAnalysis(campaign, 'static', 'KAMain is not built')
    expect(off.analysis?.static).toMatchObject({ enabled: false, disabled_reason: 'KAMain is not built' })
    expect(off.analysis?.deviation?.mode).toBe('target_only')
  })
})

describe('campaign yaml', () => {
  it('carries no evidence and round-trips', () => {
    const { campaign } = draftCampaign(draftInput(), settings(), false)
    const yaml = campaignToYaml(campaign)
    expect(yaml).not.toMatch(/# inferred:|# agent-built:|provenance:|^notes:/m)
    expect(parseCampaignYaml(yaml)).toEqual(campaign)
    expect(validateCampaign(parseCampaignYaml(yaml)).ok).toBe(true)
  })

  it('stays small: a single-file target is a screenful, not a document', () => {
    // The campaign this fixture drafts used to serialize at 155 lines / 12.8 KB, ~80% of it the
    // same evidence twice. Every line below is a fact the engine, the provider or a guard reads.
    const { campaign } = draftCampaign(draftInput(), settings(), false)
    const yaml = campaignToYaml(campaign)
    expect(yaml.split('\n').length).toBeLessThan(40)
    expect(yaml.length).toBeLessThan(1200)
  })
})

describe('campaignReviewMarkdown', () => {
  const { campaign } = draftCampaign(draftInput(), settings({ tools: { staticAnalysis: 'off', corpusAnalysis: false, deviationDetection: false } }), false)

  it('summarises the decision rather than reprinting the campaign', () => {
    const md = campaignReviewMarkdown(campaign, { path: '/tmp/pbfuzz.campaign.yaml' })
    expect(md).toContain('binutils/readelf.c:1234')
    expect(md).toContain('/src/binutils/binutils/readelf -a @@')
    expect(md).toContain('/tmp/pbfuzz.campaign.yaml')
    expect(md).not.toContain('version: 1')
    expect(md.split('\n').length).toBeLessThan(20)
  })

  it('shows what was verified and how each inference was made', () => {
    const md = campaignReviewMarkdown(campaign, {
      verification: [{ step: 'build (`./build.sh`)', ok: true, detail: 'exit 0' }, { step: 'run on an empty input', ok: false, detail: 'timed out after 30s' }],
      evidence: { 'entry.run_cmd': 'main() takes one argv' },
      decisions: ['Corpus analysis off: no seeds supplied.'],
    })
    expect(md).toContain('✓ build (`./build.sh`) — exit 0')
    expect(md).toContain('✗ run on an empty input — timed out after 30s')
    expect(md).toContain('`entry.run_cmd` — main() takes one argv')
    expect(md).toContain('Corpus analysis off')
  })
})

describe('confirm() Revise staleness', () => {
  function agentIn(cwd: string): AgentLike {
    return { id: `agent:${cwd}`, session: { header: { cwd } }, ctx: { tools: { restrict: () => () => {} } } }
  }

  /** A `QuestionAsker` that answers `campaign-review` questions from a fixed script, in order. */
  function scriptedAsker(script: { selected: string[]; custom?: string }[]): QuestionAsker & { calls: number } {
    let i = 0
    return {
      get calls() { return i },
      async ask(request) {
        const step = script[Math.min(i, script.length - 1)]!
        i++
        const id = request.questions[0]!.id
        return { answers: [{ id, selected: step.selected, custom: step.custom }] }
      },
    }
  }

  function flowWithAsker(root: string, script: { selected: string[]; custom?: string }[]): FlowContext & { asker: QuestionAsker & { calls: number } } {
    const host = new PbfuzzHost(() => settings(), { info() {}, warn() {} }, () => new Set<string>())
    const asker = scriptedAsker(script)
    return { host, agent: agentIn(root), asker, signal: new AbortController().signal }
  }

  /** A draft input with no build/run scripts, so `draft`'s environment verification stays to the
   * single `run_cmd` probe (which fails harmlessly here — the binary does not exist). */
  const inputAt = (root: string, id: string, over: Partial<CampaignDraftInput> = {}): CampaignDraftInput =>
    draftInput({ id, target: { repo: root }, ...over })

  it('rejects a stale re-confirm after Revise, without an intervening draft()', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-confirm-revise-')))
    const flow = flowWithAsker(root, [
      { selected: [REVISE], custom: 'use -x flag instead of -a' },
      { selected: [APPROVE], custom: '' },
    ])

    const d1 = await draft(flow, inputAt(root, 'confirm-revise-1'))
    expect(d1.ok, JSON.stringify(d1.issues)).toBe(true)
    expect(d1.yaml).toMatch(/-a @@/)

    const c1 = await confirm(flow)
    expect(c1.verdict).toBe('revise')
    if (c1.verdict === 'revise') expect(c1.feedback).toBe('use -x flag instead of -a')

    // The agent (bug, confusion, truncated context) calls confirm() again without calling draft()
    // to incorporate the feedback. This must not silently approve the stale, pre-Revise draft.
    const c2 = await confirm(flow, d1.draftVersion)
    expect(c2.verdict).not.toBe('approved')

    const onDisk = readFileSync(d1.path!, 'utf8')
    expect(onDisk).toContain('confirmed: false')
    expect(onDisk).toMatch(/-a @@/)
  })

  it('a redraft after Revise clears the staleness and a confirm with the new draftVersion succeeds', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-confirm-revise-')))
    const flow = flowWithAsker(root, [
      { selected: [REVISE], custom: 'switch to -x' },
      { selected: [APPROVE], custom: '' },
    ])

    const d1 = await draft(flow, inputAt(root, 'confirm-revise-2'))
    expect(d1.ok, JSON.stringify(d1.issues)).toBe(true)
    expect((await confirm(flow)).verdict).toBe('revise')

    const base = inputAt(root, 'confirm-revise-2')
    const d2 = await draft(flow, inputAt(root, 'confirm-revise-2', {
      entry: { ...base.entry, run_cmd: `${root}/binutils/readelf -x @@` },
    }))
    expect(d2.ok, JSON.stringify(d2.issues)).toBe(true)
    expect(d2.draftVersion).not.toBe(d1.draftVersion)

    const c2 = await confirm(flow, d2.draftVersion)
    expect(c2.verdict).toBe('approved')
    if (c2.verdict === 'approved') {
      const onDisk = readFileSync(c2.path, 'utf8')
      expect(onDisk).toContain('confirmed: true')
      expect(onDisk).toMatch(/-x @@/)
      // Approving is what opens PLAN now; there is no self-check between the two.
      expect(c2.phase).toBe('PLAN')
    }
  })

  it('confirm rejects an explicitly stale draftVersion even with no pending Revise', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-confirm-revise-')))
    const flow = flowWithAsker(root, [{ selected: [APPROVE], custom: '' }])
    const d1 = await draft(flow, inputAt(root, 'confirm-revise-3'))
    expect(d1.ok).toBe(true)
    expect((await confirm(flow, 'not-a-real-version')).verdict).toBe('error')
  })
})
