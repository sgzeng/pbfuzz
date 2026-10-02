import { describe, expect, it } from 'vitest'
import type { PbfuzzPhase } from '../src/core/contracts.ts'
import type { GuardExec, GuardView } from '../src/core/guard-policy.ts'
import { decide } from '../src/core/guard-policy.ts'
import { NEXT_STEP } from '../src/core/fsm.ts'
import { settings } from './fixtures.ts'

const STATE_DIR = '/repo/.pbfuzz/c1/state'

function view(over: Partial<GuardView> = {}): GuardView {
  return {
    phase: 'INIT',
    confirmed: true,
    stateDir: STATE_DIR,
    settings: settings(),
    providerPresent: false,
    terminalToolNames: ['terminal_open', 'terminal_send'],
    ...over,
  }
}

function exec(name: string, over: Partial<GuardExec> = {}): GuardExec {
  return { name, ...over }
}

/** `Next legal action: ` always names something concrete, never a bare period. */
function assertNextAction(denial: string): void {
  const tail = denial.split('Next legal action:')[1]?.trim() ?? ''
  expect(tail.length).toBeGreaterThan(10)
  expect(tail.endsWith('.')).toBe(true)
}

describe('decide — fast paths (branches 1-2)', () => {
  it('no active campaign is a zero-cost allow, for anything', () => {
    expect(decide(undefined, exec('pbfuzz_fuzz'))).toBeUndefined()
    expect(decide(undefined, exec('write', { resolvedPath: '/repo/.pbfuzz/c1/state/state.json' }))).toBeUndefined()
    expect(decide(undefined, exec('bash', { bashCommand: 'rm -rf .pbfuzz' }))).toBeUndefined()
  })

  it('a call that is not pbfuzz_*/kanalyzer_*/write/edit/bash/terminal is never gated', () => {
    expect(decide(view(), exec('grep'))).toBeUndefined()
    expect(decide(view(), exec('read'))).toBeUndefined()
    expect(decide(view({ phase: 'STOPPED' }), exec('ls'))).toBeUndefined()
  })
})

describe('decide — state-directory write/edit (branch 3)', () => {
  it('a write/edit outside the state directory is ignored', () => {
    expect(decide(view(), exec('edit', { resolvedPath: '/repo/src/x.c' }))).toBeUndefined()
  })

  it('a write/edit with no resolvedPath at all is ignored', () => {
    expect(decide(view(), exec('write'))).toBeUndefined()
  })

  it('a sibling directory that shares a name prefix does not false-positive (path-separator boundary)', () => {
    expect(decide(view(), exec('write', { resolvedPath: '/repo/.pbfuzz/c1/state2/notes.json' }))).toBeUndefined()
    expect(decide(view(), exec('write', { resolvedPath: '/repo/.pbfuzz/c1/state' }))).toBeDefined() // stateDir itself
  })

  it('metrics.json is always denied, naming pbfuzz_fuzz as the owner', () => {
    for (const tool of ['write', 'edit']) {
      const denial = decide(view(), exec(tool, { resolvedPath: `${STATE_DIR}/metrics.json` }))
      expect(denial).toBeDefined()
      expect(denial).toContain('[pbfuzz:state-write/metrics-engine-only]')
      expect(denial).toContain(`DENIED (${tool})`)
      expect(denial).toContain('only the fuzzing engine may write')
      expect(denial).toContain('pbfuzz_fuzz')
      assertNextAction(denial!)
    }
  })

  it('every other file under the state directory is denied too, pointing at the owning tools — including state.json itself (P3: the agent never writes it directly any more)', () => {
    for (const name of ['state.json', 'bug_predicates.json', 'notes.json', 'fuzz_plan.json']) {
      const denial = decide(view(), exec('write', { resolvedPath: `${STATE_DIR}/${name}` }))
      expect(denial, name).toBeDefined()
      expect(denial).toContain('[pbfuzz:state-write/owned-by-tool]')
      expect(denial).toContain(name)
      expect(denial).toContain('pbfuzz_plan / pbfuzz_fuzz / pbfuzz_reflect / pbfuzz_campaign')
      assertNextAction(denial!)
    }
  })
})

describe('decide — bash (branch 4)', () => {
  it('guards.bashGuard=false makes it fully advisory', () => {
    const v = view({ settings: settings({ guards: { bashGuard: false } }) })
    expect(decide(v, exec('bash', { bashCommand: 'rm -rf .pbfuzz' }))).toBeUndefined()
  })

  it('a read-only command is allowed', () => {
    expect(decide(view(), exec('bash', { bashCommand: 'cat .pbfuzz/c1/state/state.json' }))).toBeUndefined()
  })

  it('a tampering command is denied, naming the target and the mutation', () => {
    const denial = decide(view(), exec('bash', { bashCommand: 'rm -rf .pbfuzz/c1/state/state.json' }))
    expect(denial).toBeDefined()
    expect(denial).toContain('[pbfuzz:bash-guard/state-tamper]')
    expect(denial).toContain('DENIED (bash)')
    expect(denial).toContain('.pbfuzz')
    expect(denial).toContain('rm')
    expect(denial).toContain('pbfuzz\'s own tools')
    assertNextAction(denial!)
  })

  it('a missing bashCommand is treated as the empty string, never throws, never denies', () => {
    expect(decide(view(), exec('bash'))).toBeUndefined()
  })
})

describe('decide — terminal gate (branch 5)', () => {
  const NON_REFLECT: PbfuzzPhase[] = ['INIT', 'PLAN', 'IMPLEMENT', 'EXECUTE', 'SUCCESS', 'STOPPED']

  it('terminal_open/terminal_send are only legal in REFLECT', () => {
    for (const phase of NON_REFLECT) {
      for (const tool of ['terminal_open', 'terminal_send']) {
        const denial = decide(view({ phase }), exec(tool))
        expect(denial, `${tool} in ${phase}`).toBeDefined()
        expect(denial).toContain('[pbfuzz:phase-gate/terminal]')
        expect(denial).toContain(`only legal in REFLECT, not in phase ${phase}`)
        assertNextAction(denial!)
      }
    }
    expect(decide(view({ phase: 'REFLECT' }), exec('terminal_open'))).toBeUndefined()
    expect(decide(view({ phase: 'REFLECT' }), exec('terminal_send'))).toBeUndefined()
  })

  it('needs tools.interactiveDebug on, even in REFLECT', () => {
    const v = view({ phase: 'REFLECT', settings: settings({ tools: { interactiveDebug: false } }) })
    const denial = decide(v, exec('terminal_open'))
    expect(denial).toContain('[pbfuzz:phase-gate/terminal]')
    expect(denial).toContain('tools.interactiveDebug')
    expect(denial).toContain('pbfuzz_trace')
  })
})

describe('decide — kanalyzer standalone carve-out (branch 6)', () => {
  it('an unconfirmed campaign never gates kanalyzer_*, in any phase', () => {
    for (const phase of ['INIT', 'PLAN', 'EXECUTE', 'REFLECT', 'STOPPED'] as PbfuzzPhase[]) {
      const v = view({ phase, confirmed: false })
      for (const tool of ['kanalyzer_doctor', 'kanalyzer_prepare', 'kanalyzer_analyze', 'kanalyzer_query']) {
        expect(decide(v, exec(tool)), `${tool} in ${phase}`).toBeUndefined()
      }
    }
  })
})

describe('decide — phase gate for pbfuzz_*/kanalyzer_* (branch 7)', () => {
  it('INIT allows pbfuzz_campaign/pbfuzz_probe/pbfuzz_trace/pbfuzz_corpus, denies pbfuzz_fuzz naming pbfuzz_campaign as an alternative', () => {
    for (const tool of ['pbfuzz_campaign', 'pbfuzz_probe', 'pbfuzz_trace', 'pbfuzz_corpus']) {
      expect(decide(view({ phase: 'INIT' }), exec(tool)), tool).toBeUndefined()
    }
    const denial = decide(view({ phase: 'INIT' }), exec('pbfuzz_fuzz'))
    expect(denial).toContain('[pbfuzz:phase-gate/phase]')
    expect(denial).toContain('pbfuzz_fuzz is not legal in phase INIT')
    expect(denial).toContain('pbfuzz_campaign')
    expect(denial).toContain(NEXT_STEP.INIT)
  })

  it('EXECUTE allows pbfuzz_fuzz, denies pbfuzz_deviation (still phase-gated); kanalyzer is not gated at all', () => {
    const v = view({ phase: 'EXECUTE' })
    expect(decide(v, exec('pbfuzz_fuzz'))).toBeUndefined()
    expect(decide(v, exec('pbfuzz_deviation'))).toContain('[pbfuzz:phase-gate/phase]')
    // Allowed even with the default settings, where pbfuzz's own static analysis is off: neither
    // the phase nor `tools.staticAnalysis` is pbfuzz's business to enforce on another plugin's
    // read-only tools. pbfuzz's own static-analysis tool stays gated by that switch.
    expect(decide(v, exec('kanalyzer_analyze'))).toBeUndefined()
    expect(decide(v, exec('pbfuzz_callgraph'))).toContain('[pbfuzz:phase-gate/phase]')
  })

  it('REFLECT allows pbfuzz_deviation/pbfuzz_trace, denies pbfuzz_fuzz naming pbfuzz_deviation as an alternative', () => {
    const v = view({ phase: 'REFLECT' })
    expect(decide(v, exec('pbfuzz_deviation'))).toBeUndefined()
    expect(decide(v, exec('pbfuzz_trace'))).toBeUndefined()
    const denial = decide(v, exec('pbfuzz_fuzz'))
    expect(denial).toContain('pbfuzz_deviation')
  })

  it('STOPPED explains itself as budget/wall-clock exhaustion, not a generic phase mismatch', () => {
    const denial = decide(view({ phase: 'STOPPED' }), exec('pbfuzz_fuzz'))
    expect(denial).toContain('budget or wall clock is exhausted')
    expect(denial).not.toContain('not legal in phase STOPPED')
  })

  // Was: "kanalyzer needs static analysis enabled, even in a kanalyzer-eligible phase". That is the
  // coupling this change removes — `tools.staticAnalysis` says whether *pbfuzz* uses static
  // analysis in its own pipeline, not whether the user may drive the separate kanalyzer plugin.
  it('kanalyzer is allowed whatever pbfuzz\'s own staticAnalysis switch says', () => {
    const off = view({ phase: 'INIT', settings: settings({ tools: { staticAnalysis: 'off' } }) })
    expect(decide(off, exec('kanalyzer_analyze'))).toBeUndefined()
    expect(decide(off, exec('kanalyzer_prepare'))).toBeUndefined()
    const on = view({ phase: 'INIT', settings: settings({ tools: { staticAnalysis: 'kanalyzer' } }) })
    expect(decide(on, exec('kanalyzer_prepare'))).toBeUndefined()
    // pbfuzz's own static-analysis tool is still governed by that switch, in a phase that permits it.
    const planOff = view({ phase: 'PLAN', settings: settings({ tools: { staticAnalysis: 'off' } }) })
    const denial = decide(planOff, exec('pbfuzz_callgraph'))
    expect(denial).toContain('[pbfuzz:phase-gate/disabled]')
    expect(denial).toContain('tools.staticAnalysis')
  })

  it('the "use one of ..." suggestion always names kanalyzer_*, since it is never gated', () => {
    for (const staticAnalysis of ['off', 'kanalyzer'] as const) {
      const v = view({ phase: 'PLAN', settings: settings({ tools: { staticAnalysis } }) })
      expect(decide(v, exec('pbfuzz_fuzz'))).toContain('kanalyzer_*')
    }
  })

  it('before confirmation, with hideToolsWithoutCampaign on, the suggestion is exactly the no-campaign tool set', () => {
    const v = view({ phase: 'INIT', confirmed: false, settings: settings({ guards: { hideToolsWithoutCampaign: true } }) })
    const denial = decide(v, exec('pbfuzz_fuzz'))
    expect(denial).toContain('use one of pbfuzz_campaign, pbfuzz_probe;')
  })
})

describe('decide — backing-item check (branch 8)', () => {
  it('a tool whose backing setting is off is denied, naming the setting', () => {
    const v = view({ phase: 'REFLECT', settings: settings({ tools: { deviationDetection: false } }) })
    const denial = decide(v, exec('pbfuzz_deviation'))
    expect(denial).toContain('[pbfuzz:phase-gate/disabled]')
    expect(denial).toContain('tools.deviationDetection')
  })
})

describe('decide — guard-error fail-closed wrapper', () => {
  it('never throws, and denies with a signed [pbfuzz:guard-error] instead, when something inside decide() blows up', () => {
    const poisoned: GuardView = view()
    Object.defineProperty(poisoned, 'settings', {
      get() {
        throw new Error('simulated internal failure')
      },
    })
    let result: string | undefined
    expect(() => { result = decide(poisoned, exec('bash', { bashCommand: 'echo hi' })) }).not.toThrow()
    expect(result).toContain('[pbfuzz:guard-error]')
    expect(result).toContain('DENIED (bash)')
    expect(result).toContain('simulated internal failure')
  })
})

describe('decide — totality / fuzz: never throws on malformed input, always returns undefined or a string', () => {
  // A small, deterministic PRNG so the 200+ iterations below are reproducible in CI without
  // depending on Math.random(); this is a robustness test, not a property-based search for a
  // specific bug, so determinism matters more than true randomness here.
  function mulberry32(seed: number): () => number {
    let a = seed
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const rand = mulberry32(20260917)
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!

  const weirdStrings: readonly unknown[] = [
    '', 'pbfuzz_fuzz', 'kanalyzer_query', 'write', 'edit', 'bash', 'terminal_open',
    '../../../etc/passwd', '/repo/.pbfuzz/c1/state/../../../etc/passwd',
    'a'.repeat(5000), '𝕡𝕓𝕗𝕦𝕫𝕫_𝕗𝕦𝕫𝕫', '日本語のツール名', ' ',
    null, undefined, 0, 42, true, false, {}, [], () => {},
  ]
  const weirdPhases: readonly unknown[] = ['INIT', 'PLAN', 'EXECUTE', 'REFLECT', 'STOPPED', 'HACKING', '', null, undefined, 7]
  const weirdSettings: readonly unknown[] = [
    settings(), {}, null, undefined, { guards: {} }, { guards: null }, { tools: 'nope' },
    { guards: { bashGuard: 'yes' }, tools: {}, budget: {} },
  ]

  function randomView(): GuardView | undefined {
    if (rand() < 0.15) return undefined
    return {
      phase: pick(weirdPhases) as PbfuzzPhase,
      confirmed: pick([true, false, undefined, 1, 'yes'] as const) as unknown as boolean,
      stateDir: pick(['/repo/.pbfuzz/c1/state', '', pick(weirdStrings) as string, STATE_DIR]) as string,
      settings: pick(weirdSettings) as GuardView['settings'],
      providerPresent: pick([true, false, undefined]) as unknown as boolean,
      terminalToolNames: pick([['terminal_open'], [], undefined, null, 'not-an-array']) as unknown as readonly string[],
    }
  }

  function randomExec(): GuardExec {
    return {
      name: pick(weirdStrings) as string,
      resolvedPath: pick([...weirdStrings, `${STATE_DIR}/state.json`, `${STATE_DIR}/../escaped.json`]) as string | undefined,
      bashCommand: pick([...weirdStrings, 'rm -rf .pbfuzz', 'cat file']) as string | undefined,
    }
  }

  it('decide() survives 250 randomized/malformed (view, exec) pairs', () => {
    for (let i = 0; i < 250; i++) {
      const v = randomView()
      const e = randomExec()
      let result: string | undefined
      expect(() => { result = decide(v, e) }, `iteration ${i}: view=${JSON.stringify(v)} exec=${JSON.stringify(e)}`).not.toThrow()
      expect(result === undefined || typeof result === 'string', `iteration ${i}`).toBe(true)
    }
  })
})
