import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AnalysisProvider } from '../src/core/contracts.ts'
import { campaignLayout, defaultOutputDir, activePointerPath } from '../src/core/paths.ts'
import { PBFUZZ_TOOLS, visibleTools, KANALYZER_TOOLS } from '../src/core/phases.ts'
import { providerAppliesTo, ProviderRegistry } from '../src/core/registry.ts'
import { diagnosisQuestion, formatHeadlessDiagnosis, unresolvedTargetDiagnosis } from '../src/core/remedies.ts'
import { loadSkills, parseSkill } from '../src/skills.ts'
import { settings } from './fixtures.ts'

const here = dirname(fileURLToPath(import.meta.url))

describe('tool visibility', () => {
  // kanalyzer is never gated by pbfuzz — it is a standalone plugin the user may drive with no
  // campaign at all — so its names are in every list below.
  const KA = [...KANALYZER_TOOLS].sort()
  const withKa = (...pbfuzzTools: string[]): string[] => [...pbfuzzTools, ...KA].sort()

  it('is constant for a whole session: the same set in every phase', () => {
    const s = settings()
    const all = visibleTools({ hasConfirmedCampaign: true, settings: s, providerPresent: false })
    // Everything except `pbfuzz_callgraph`, whose backing static analysis is off in the fixture.
    expect(all).toHaveLength(PBFUZZ_TOOLS.length - 1 + KANALYZER_TOOLS.length)
    expect(all).not.toContain('pbfuzz_callgraph')
    // The signature has no `phase` at all any more — that is the point. Re-deriving it any number
    // of times gives the same array, so `ctx.tools.restrict()` never has to be re-applied and the
    // model's prompt prefix survives a PIER transition.
    expect(visibleTools({ hasConfirmedCampaign: true, settings: s, providerPresent: false })).toEqual(all)
  })

  it('hides pbfuzz tools whose backing analysis is off or has no provider — never kanalyzer\'s', () => {
    const on = settings({ tools: { staticAnalysis: 'kanalyzer' } })
    const withProvider = visibleTools({ hasConfirmedCampaign: true, settings: on, providerPresent: true })
    expect(withProvider).toContain('pbfuzz_callgraph')
    expect(withProvider).toContain('pbfuzz_deviation')
    expect(visibleTools({ hasConfirmedCampaign: true, settings: on, providerPresent: false })).not.toContain('pbfuzz_callgraph')

    const noTracer = visibleTools({ hasConfirmedCampaign: true, settings: settings({ tools: { tracer: 'off' } }), providerPresent: true })
    expect(noTracer).not.toContain('pbfuzz_trace')
    const noCorpus = visibleTools({ hasConfirmedCampaign: true, settings: settings({ tools: { corpusAnalysis: false } }), providerPresent: true })
    expect(noCorpus).not.toContain('pbfuzz_corpus')

    // kanalyzer's own tools are exempt from every one of those switches.
    for (const list of [withProvider, noTracer, noCorpus]) expect(list).toEqual(expect.arrayContaining(KA))
  })

  it('hideToolsWithoutCampaign, off by default, still works when switched on', () => {
    const hide = settings({ guards: { hideToolsWithoutCampaign: true } })
    expect(visibleTools({ hasConfirmedCampaign: false, settings: hide, providerPresent: false }))
      .toEqual(withKa('pbfuzz_campaign', 'pbfuzz_probe'))
    expect(visibleTools({ hasConfirmedCampaign: true, settings: hide, providerPresent: false })).toContain('pbfuzz_plan')
    // Default: the set does not depend on whether a campaign exists either.
    const s = settings()
    expect(visibleTools({ hasConfirmedCampaign: false, settings: s, providerPresent: false }))
      .toEqual(visibleTools({ hasConfirmedCampaign: true, settings: s, providerPresent: false }))
  })
})

describe('ProviderRegistry', () => {
  const fake = (id: string): AnalysisProvider => ({
    describe: () => ({ id, displayName: id, languages: ['c'], criticalLocations: true, callGraph: true, requiresPrepare: true }),
  } as unknown as AnalysisProvider)

  it('first registration is active; dispose (plugin unload) removes it and notifies', () => {
    const r = new ProviderRegistry()
    let changes = 0
    r.onChange(() => { changes++ })
    const a = r.register(fake('kanalyzer'))
    r.register(fake('codeql'))
    expect(r.active()?.describe().id).toBe('kanalyzer')
    a.dispose()
    a.dispose()
    expect(r.active()?.describe().id).toBe('codeql')
    expect(r.list().map(p => p.id)).toEqual(['codeql'])
    expect(changes).toBe(3)
  })

  it('language applicability', () => {
    expect(providerAppliesTo(fake('k').describe(), 'python')).toBe(false)
    expect(providerAppliesTo(fake('k').describe(), 'c')).toBe(true)
  })
})

describe('layout, snapshot, remedies, projection, skills', () => {
  it('layout matches what the host and the engine read', () => {
    const l = campaignLayout('/r/.pbfuzz/c1')
    expect(l).toMatchObject({
      stateFile: '/r/.pbfuzz/c1/state/state.json',
      metricsFile: '/r/.pbfuzz/c1/state/metrics.json',
    })
    expect(defaultOutputDir('/r/', '.pbfuzz', 'c1')).toBe('/r/.pbfuzz/c1')
    expect(activePointerPath('/r', '.pbfuzz')).toBe('/r/.pbfuzz/active')
  })

  it('diagnoses render for ask_user_question and for headless logs', () => {
    const d = unresolvedTargetDiagnosis('a.c:10', ['a.c:11', 'a.c:12'])
    const q = diagnosisQuestion(d, 'q1')
    expect(q.options.map(o => o.label).slice(0, 2)).toEqual(['Use a.c:11 instead', 'Use a.c:12 instead'])
    expect(q.detail).toContain('a.c:10')
    const log = formatHeadlessDiagnosis(d)
    expect(log).toMatch(/static analysis failed/)
    expect(log).toMatch(/\[disable_static_analysis\]/)
  })

  it('parses the bundled skill', () => {
    expect(parseSkill('no frontmatter', 'p')).toBeUndefined()
    const skills = loadSkills(join(here, '..', 'skills'))
    // One skill, not five: `/pbfuzz` injects its body directly, and a campaign that used to load
    // three of them paid ~9.2k tokens of largely duplicated instruction to do it.
    expect(skills.map(s => s.name)).toEqual(['pbfuzz'])
    expect(skills[0]!.content.length).toBeLessThan(12_000)
  })

  it('Config schema mirrors pbfuzz-settings.schema.json defaults', () => {
    const schema = JSON.parse(readFileSync(join(here, '..', '..', '..', 'contracts', 'pbfuzz-settings.schema.json'), 'utf8'))
    const defaults: Record<string, Record<string, unknown>> = {}
    for (const [group, g] of Object.entries<any>(schema.properties)) {
      defaults[group] = {}
      for (const [k, v] of Object.entries<any>(g.properties)) defaults[group]![k] = v.default
    }
    expect(defaults).toEqual(settings())
  })
})
