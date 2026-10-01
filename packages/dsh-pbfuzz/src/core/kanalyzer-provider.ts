/**
 * The kanalyzer adapter: an `AnalysisProvider` over `ctx.kanalyzer` (`contracts/kanalyzer-api.ts`).
 *
 * Pure with respect to DSH — it receives the service object — so the logic that decides whether
 * static analysis really works on this target is unit-testable with a fake service. The host half
 * constructs it only inside `ctx.inject(['kanalyzer'], …)`.
 *
 * {@link KanalyzerProvider.ensureReady} is the only entry point that builds or analyses anything,
 * and every query calls it first. It replaced a campaign self-check that prepared the provider
 * eagerly at campaign start, whether or not the campaign ever asked a static-analysis question,
 * and re-ran kanalyzer's whole `doctor()` (a sample LTO build plus two forced analyses) each time.
 *
 * @module @pbfuzz/dsh-pbfuzz/core/kanalyzer-provider
 */

import type {
  AnalysisProvider,
  AnalyzeResult,
  KanalyzerService,
  PbfuzzCampaign,
  PrepareOutcome,
  ProviderCapabilities,
  ProviderLocation,
  ProviderReady,
} from './contracts.ts'
import { disableTool, MANUAL, RETRY, unresolvedTargetDiagnosis } from './remedies.ts'

/**
 * The link output a campaign's `entry.run_cmd` runs, for kanalyzer's `wllvm` mode.
 *
 * `run_cmd` is a shell line like `/path/to/readelf @@` or `./build/fuzz_target @@`, so the first
 * token names the binary and its basename is what `extract-bc` needs. Deliberately conservative:
 * anything that does not look like a plain path to an executable (an interpreter invocation, a
 * variable, a pipeline) yields `undefined` and the caller reports that rather than guessing.
 * @param runCmd - the campaign's `entry.run_cmd`, when it has one.
 * @returns the program basename, or `undefined` when it cannot be read off confidently.
 */
export function programFromRunCmd(runCmd: string | undefined): string | undefined {
  if (runCmd === undefined) return undefined
  // Any shell construct anywhere on the line means the first token is not necessarily the program
  // being analysed (`cat @@ | ./x` runs `./x`), so decline the whole line rather than read the
  // wrong end of it.
  if (/[$`|;&<>()]/.test(runCmd)) return undefined
  const first = runCmd.trim().split(/\s+/)[0]
  if (first === undefined || first === '' || first.includes('=')) return undefined
  const name = first.split('/').pop()
  if (name === undefined || name === '' || name.startsWith('-')) return undefined
  // Interpreters run a script named later on the line; their own basename is never the link output.
  if (/^(sh|bash|zsh|python[\d.]*|perl|ruby|node|java|env)$/.test(name)) return undefined
  return name
}

/** KAMain's call-stack depth for pbfuzz's analyses. Was a campaign field, but `draftCampaign()`
 * only ever wrote this one value and no answer could change it, so it is a constant. */
const CALL_STACK_LEN = 20

/** The dumps pbfuzz needs; passed explicitly so the user's kanalyzer toggles never matter. */
export const PBFUZZ_DUMPS = {
  policy: true,
  distance: true,
  criticalBranch: true,
  bidMappingAndFuncInfo: true,
  callerCalleeBothWays: true,
  annotatedIr: false,
} as const

/**
 * The prebuilt-import extension dsh-kanalyzer implements on top of the frozen `KanalyzerService`
 * (`packages/dsh-kanalyzer/src/api.ts`, `PrebuiltImporter`).
 *
 * It is deliberately not a member of `contracts/kanalyzer-api.ts`: that file is frozen and shared,
 * and a capability only a host able to read an existing dump directory provides does not belong in
 * every consumer's view of the service. pbfuzz restates the slice it uses here — exactly as it does
 * for the frozen interfaces themselves — and detects it structurally, so a kanalyzer build without
 * it is reported honestly instead of falling back to a rebuild.
 */
interface PrebuiltImporter {
  importPrebuilt(request: { dir: string; targets?: string[]; program?: string; repo?: string }): Promise<PrebuiltImport>
}

/** What `importPrebuilt` answers: the live-run result shape, plus the handle later queries take. */
type PrebuiltImport = AnalyzeResult & { handle: string; files: Partial<Record<string, string>> }

/** Remedies when a prebuilt campaign fails: there is nothing to rebuild — the dumps are the input. */
const PREBUILT_REMEDIES: { id: string; label: string; detail?: string; effect?: string }[] = [
  {
    id: 'fix_prebuilt_dir',
    label: 'Point `analysis.static.prebuilt_dir` at the right directory',
    detail: 'It must hold that target\'s KAMain text outputs: distance.cfg.txt, critical_BBs.txt, bid_loc_mapping.txt, function_info.txt, caller-callee.txt and callee-caller.txt, bare or prefixed with the link output name.',
    effect: 'edit_campaign',
  },
  {
    id: 'use_bitcode',
    label: 'Or set `analysis.static.bitcode` to analyse a known bitcode instead',
    detail: 'Works when no complete dump set exists, but KAMain runs again and must be installed.',
    effect: 'edit_campaign',
  },
  { ...RETRY, effect: 'retry' },
  { ...disableTool('static_analysis', 'The run continues without it.'), effect: 'disable_tool' },
  { ...MANUAL, effect: 'manual' },
]

/** Whether this campaign asks for results a previous KAMain run already produced. */
function isPrebuilt(s: NonNullable<NonNullable<PbfuzzCampaign['analysis']>['static']>): boolean {
  return s.mode === 'prebuilt' || s.prebuilt_dir !== undefined
}

/** `AnalysisProvider` backed by the standalone dsh-kanalyzer plugin. */
export class KanalyzerProvider implements AnalysisProvider {
  /** Query handle of the most recent successful prepare: a bitcode path, or an imported prebuilt directory. */
  private bitcode: string | undefined
  private lastAnalysis: AnalyzeResult | undefined
  /** {@link ensureReady}'s memo, keyed by campaign id. */
  private ready: { id: string; outcome: ProviderReady } | undefined

  constructor(private readonly service: KanalyzerService) {}

  /** Capabilities: C/C++ via LLVM bitcode, with critical branches and a call graph. */
  describe(): ProviderCapabilities {
    return {
      id: 'kanalyzer',
      displayName: 'kanalyzer (KAMain)',
      languages: ['c', 'cpp'],
      criticalLocations: true,
      callGraph: true,
      requiresPrepare: true,
    }
  }

  /**
   * Bring the campaign's static analysis into a queryable state — three real branches, in order:
   * import the results a previous KAMain run already produced (`mode: prebuilt` with
   * `prebuilt_dir`), reuse a known bitcode, or run the LTO/wllvm rebuild that produces one.
   *
   * The order is deliberate. `prebuilt_dir` says the analysis is already done (Magma's
   * `SKIP_STATIC_ANALYSIS` path), so it wins over a `bitcode` the campaign may also carry, and it
   * never runs KAMain or a build.
   * @param campaign - the campaign.
   * @returns the outcome with discovered fields for provenance.
   */
  async prepare(campaign: PbfuzzCampaign): Promise<PrepareOutcome> {
    const s = campaign.analysis?.static ?? {}
    if (isPrebuilt(s)) return this.preparePrebuilt(campaign)
    if (s.bitcode !== undefined) {
      this.bitcode = s.bitcode
      return { ok: true, handle: s.bitcode, evidence: [`reusing campaign bitcode ${s.bitcode}`] }
    }
    const buildCmd = campaign.build?.cmd
    if (buildCmd === undefined) {
      return { ok: false, evidence: [], reason: 'no build command: set `build.cmd` so kanalyzer can rebuild with LTO' }
    }
    // wllvm unless the campaign asks for lto: it wraps the compiler instead of relying on the build
    // honouring $LDFLAGS, which is what large/complex build systems routinely drop.
    const mode = s.mode === 'lto' ? 'lto' : 'wllvm'
    // wllvm needs to know which link output to extract bitcode from. The campaign already says
    // which binary it runs, so derive it rather than making every existing campaign grow a field:
    // an explicit `analysis.static.program` still wins.
    const program = s.program ?? programFromRunCmd(campaign.entry?.run_cmd)
    if (mode === 'wllvm' && program === undefined) {
      return { ok: false, evidence: [], reason: 'wllvm prepare needs the linked binary\'s name: set `analysis.static.program`, or write `entry.run_cmd` so it starts with the executable to analyse' }
    }
    const result = await this.service.prepare({
      repo: campaign.target.repo,
      buildCmd,
      ...campaign.build?.dir !== undefined ? { cwd: campaign.build.dir } : {},
      ...program !== undefined ? { program } : {},
      mode,
      ...s.lto_libs !== undefined ? { ltoLibs: s.lto_libs } : {},
    })
    this.bitcode = result.bitcode
    return {
      ok: true,
      handle: result.bitcode,
      discovered: { 'analysis.static.bitcode': result.bitcode, 'analysis.static.entries': result.entries },
      evidence: [
        `kanalyzer prepare (${mode}) → ${result.bitcode} (${result.nFuncs} functions, ${result.allBitcode.length} bitcode files)`,
        `entries found: ${result.entries.join(', ') || 'none'}`,
      ],
    }
  }

  /**
   * The prebuilt branch: register a directory of KAMain text dumps with the service and answer
   * every later query (`callers`/`callees`/`functionAt`/`criticalLocations`) from it.
   *
   * Nothing here touches KAMain, LLVM or a build command — the analysis already ran, possibly on
   * another machine, which is exactly why such a campaign has none of those by design.
   * @param campaign - the campaign.
   * @returns the outcome, with the handle later queries take.
   */
  private async preparePrebuilt(campaign: PbfuzzCampaign): Promise<PrepareOutcome> {
    const s = campaign.analysis?.static ?? {}
    const dir = s.prebuilt_dir
    if (dir === undefined) {
      return {
        ok: false,
        evidence: [],
        reason: '`analysis.static.mode` is "prebuilt" but `analysis.static.prebuilt_dir` is not set: point it at the directory holding this target\'s KAMain text outputs',
      }
    }
    const importer = this.service as KanalyzerService & Partial<PrebuiltImporter>
    if (typeof importer.importPrebuilt !== 'function') {
      return {
        ok: false,
        evidence: [],
        reason: 'this kanalyzer build cannot import prebuilt results (no `importPrebuilt` on `ctx.kanalyzer`): update the kanalyzer plugin, or give the campaign a bitcode or a build command instead',
      }
    }
    const imported = await importer.importPrebuilt({
      dir,
      targets: campaign.bug.targets.map(t => t.location),
      ...s.program !== undefined ? { program: s.program } : {},
      repo: campaign.target.repo,
    })
    this.bitcode = imported.handle
    this.lastAnalysis = imported
    const found = Object.values(imported.files).sort()
    return {
      ok: imported.status !== 'error',
      handle: imported.handle,
      evidence: [
        `imported prebuilt KAMain results from ${imported.outputDir}: ${found.join(', ')} (${found.length} dump files — no build, no KAMain run)`,
        `import status=${imported.status}, ${imported.targets.length} targets resolved, ${imported.criticalBranches.length} critical branches, ${imported.reachableFunctions}/${imported.totalFunctions} functions reachable`,
        ...(imported.reason !== undefined ? [`import refused: ${imported.reason}`] : []),
      ],
      ...(imported.status === 'error' ? { reason: `prebuilt results in ${dir} are unusable: ${imported.reason ?? 'unknown error'}` } : {}),
    }
  }

  async callers(fn: string, handle?: string): Promise<string[]> {
    return this.query('callers', fn, handle)
  }

  async callees(fn: string, handle?: string): Promise<string[]> {
    return this.query('callees', fn, handle)
  }

  async functionAt(location: string, handle?: string): Promise<string | undefined> {
    const bitcode = handle ?? this.bitcode
    if (bitcode === undefined) return undefined
    const r = await this.service.query({ op: 'functionAt', bitcode, location })
    return r.results[0]
  }

  async criticalLocations(handle?: string): Promise<ProviderLocation[]> {
    if (this.lastAnalysis !== undefined && (handle === undefined || handle === this.bitcode)) {
      return this.lastAnalysis.criticalBranches.map(b => ({ location: b.location, function: b.function, distance: b.distance }))
    }
    const bitcode = handle ?? this.bitcode
    if (bitcode === undefined) return []
    const r = await this.service.query({ op: 'critical', bitcode })
    return r.results.map(location => ({ location }))
  }

  /**
   * Bring this campaign's static analysis into a queryable state, once.
   *
   * Memoized per campaign id: the first query pays prepare + analyze, every later one is free.
   * A failure is remembered too, so a broken build is diagnosed once rather than retried on every
   * call — a fresh `KanalyzerProvider` (plugin reload) or a different campaign clears it.
   * @param campaign - the campaign whose targets are analysed.
   * @returns ok with evidence, or the failure with concrete remedies.
   */
  async ensureReady(campaign: PbfuzzCampaign): Promise<ProviderReady> {
    if (this.ready?.id === campaign.id) return this.ready.outcome
    const outcome = await this.bringUp(campaign)
    this.ready = { id: campaign.id, outcome }
    return outcome
  }

  /** {@link ensureReady}'s body, without the memo. */
  private async bringUp(campaign: PbfuzzCampaign): Promise<ProviderReady> {
    const evidence: string[] = []
    const s = campaign.analysis?.static ?? {}
    const prebuilt = isPrebuilt(s)
    let prep: PrepareOutcome
    try {
      prep = await this.prepare(campaign)
    } catch (error) {
      evidence.push(`kanalyzer prepare threw: ${(error as Error).message}`)
      return {
        ok: false,
        evidence,
        reason: prebuilt ? `prebuilt import failed: ${(error as Error).message}` : `bitcode preparation failed: ${(error as Error).message}`,
        remedies: withEffects(prebuilt ? PREBUILT_REMEDIES : [
          { id: 'use_wllvm', label: 'Retry with the wllvm fallback', detail: 'For build systems that drop LDFLAGS.', effect: 'edit_campaign' },
          { ...RETRY, effect: 'retry' },
          { ...disableTool('static_analysis', 'Deviation detection degrades to target-only.'), effect: 'disable_tool' },
          { ...MANUAL, effect: 'manual' },
        ]),
      }
    }
    evidence.push(...prep.evidence)
    if (!prep.ok || prep.handle === undefined) {
      return {
        ok: false,
        evidence,
        reason: prep.reason ?? (prebuilt ? 'prebuilt import produced no results' : 'prepare produced no bitcode'),
        remedies: withEffects(prebuilt ? PREBUILT_REMEDIES : [RETRY, disableTool('static_analysis', 'The run continues without it.'), MANUAL]),
      }
    }
    if (prebuilt) {
      // prepare() already imported it; analyze() here would invoke KAMain, which is exactly what
      // this mode exists to avoid (and what a machine without it cannot do).
      if (this.lastAnalysis === undefined) {
        return { ok: false, evidence, reason: 'prebuilt import produced no results', remedies: withEffects(PREBUILT_REMEDIES) }
      }
    } else {
      const analysis = await this.service.analyze({
        bitcode: prep.handle,
        targets: campaign.bug.targets.map(t => t.location),
        ...s.entries !== undefined ? { entries: s.entries } : {},
        callStackLen: CALL_STACK_LEN,
        typeBasedCallgraph: true,
        dumps: PBFUZZ_DUMPS,
      })
      this.lastAnalysis = analysis
      evidence.push(`kanalyzer analyze → status=${analysis.status}, ${analysis.targets.length} targets resolved, ${analysis.criticalBranches.length} critical branches, ${analysis.reachableFunctions}/${analysis.totalFunctions} functions reachable, entries ${analysis.entriesUsed.join(',')}${analysis.cached ? ' (cached)' : ''}`)
    }
    const analysis = this.lastAnalysis!
    if (analysis.status === 'no_target') {
      const u = analysis.unresolved?.[0]
      const d = unresolvedTargetDiagnosis(u?.requested ?? campaign.bug.targets[0]?.location ?? '?', u?.nearbyCandidates ?? [])
      return { ok: false, evidence, reason: d.diagnosis, remedies: withEffects(d.remedies) }
    }
    if (analysis.status === 'unreachable') {
      return {
        ok: false,
        evidence,
        reason: `targets resolved but no entry (${analysis.entriesUsed.join(', ')}) reaches them in the call graph`,
        remedies: withEffects(prebuilt ? PREBUILT_REMEDIES : [
          { id: 'edit_entries', label: 'Correct `analysis.static.entries`', detail: 'Name the harness entry that calls into the target.', effect: 'edit_campaign' },
          { id: 'lto_libs', label: 'LTO-build static dependency libraries', detail: 'A statically linked library outside the bitcode truncates the call graph.', effect: 'edit_campaign' },
          disableTool('static_analysis', 'Deviation detection degrades to target-only.'),
          MANUAL,
        ]),
      }
    }
    if (analysis.status === 'error') {
      return {
        ok: false,
        evidence,
        reason: prebuilt ? `imported results are unusable: ${analysis.reason ?? 'unknown error'}` : analysis.reason ?? 'KAMain failed',
        remedies: withEffects(prebuilt ? PREBUILT_REMEDIES : [RETRY, disableTool('static_analysis', 'The run continues without it.'), MANUAL]),
      }
    }
    return { ok: true, evidence }
  }

  private async query(op: 'callers' | 'callees', fn: string, handle?: string): Promise<string[]> {
    const bitcode = handle ?? this.bitcode
    if (bitcode === undefined) return []
    return (await this.service.query({ op, bitcode, fn })).results
  }
}

/** Provider remedies require `effect`; default any missing one to `manual`. */
function withEffects(remedies: { id: string; label: string; detail?: string; effect?: string }[]): NonNullable<ProviderReady['remedies']> {
  return remedies.map(r => ({ ...r, effect: (r.effect ?? 'manual') as NonNullable<ProviderReady['remedies']>[number]['effect'] }))
}
