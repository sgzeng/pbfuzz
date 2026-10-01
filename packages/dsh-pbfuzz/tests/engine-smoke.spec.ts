/**
 * End-to-end smoke: the TS engine bridge spawns the REAL `python -m pbfuzz_engine.rpc` and runs a
 * tiny fuzz session against a toy Python target. The first proof that plugin and engine connect.
 *
 * This used to also drive the REAL `state_guard` hook (the old Claude-Code-hooks bridge) to judge
 * REFLECT→SUCCESS against the metrics.json the engine wrote; that hook binary is retired along
 * with the whole hooks bridge (`packages/dsh-pbfuzz/hooks/` is deleted) under this rewrite's P3
 * design change — phase gating is now `core/guard-policy.ts`'s native `ctx.tools.guard()` (its own
 * test file), and REFLECT→SUCCESS's "needs engine evidence" check now lives in the tool that owns
 * that transition, not in a guard. Neither has a port here; this file stays scoped to the engine
 * bridge itself.
 *
 * Interpreter: $PBFUZZ_PYTHON, else engine/.venv/bin/python (`pip install -e 'engine[dev]'`).
 * Skipped cleanly when neither exists.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { campaignToYaml } from '../src/core/campaign-yaml.ts'
import { fuzzRunParams, selfcheckEngineParams } from '../src/core/engine-params.ts'
import { CONTRACTS_VERSION } from '../src/core/selfcheck.ts'
import { EngineBridge, engineEnv } from '../src/engine-bridge.ts'
import { settings } from './fixtures.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const repo = resolve(pkgRoot, '..', '..')
const venvPython = join(repo, 'engine', '.venv', 'bin', 'python')
const python = process.env.PBFUZZ_PYTHON ?? (existsSync(venvPython) ? venvPython : undefined)

const TARGET = `import sys
data = open(sys.argv[1], 'rb').read()
if b'R' in data:
    sys.stderr.write('PBFUZZ_REACHED: t1\\n')
if b'T' in data:
    sys.stderr.write('PBFUZZ_TRIGGERED: t1\\n')
`
const GENERATOR = `def generate(**params):
    return {0: b'x', 1: b'R'}.get(int(params.get('n', 0)), b'RT')
`

describe.skipIf(python === undefined)('engine smoke: bridge → real engine', () => {
  let root = ''
  let campDir = ''
  let campaignPath = ''
  let bridge: EngineBridge
  const logs: string[] = []
  const reflect = { campaign_id: 'smoke', phase: 'REFLECT', status: 'round 2 analysed', current_task: 't', next_action: 'n', pier_round: 2 }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-smoke-')))
    campDir = join(root, '.pbfuzz', 'smoke')
    mkdirSync(join(campDir, 'state'), { recursive: true })
    writeFileSync(join(root, 'target.py'), TARGET)
    campaignPath = join(campDir, 'pbfuzz.campaign.yaml')
    // The host's own writer, so the engine reads exactly what PbfuzzHost.save() writes
    // (this test is what caught `tracer: off` being loaded as boolean False by PyYAML).
    writeFileSync(campaignPath, campaignToYaml({
      version: 1,
      id: 'smoke',
      confirmed: true,
      target: { repo: root, language: 'python' },
      bug: { targets: [{ location: 'target.py:5' }] },
      entry: { kind: 'executable', run_cmd: `${python!} ${join(root, 'target.py')} @@`, input_channel: 'file' },
      oracle: { mode: 'preexisting', reached_pattern: 'PBFUZZ_REACHED:\\s*(\\S+)', triggered_pattern: 'PBFUZZ_TRIGGERED:\\s*(\\S+)' },
      tracer: 'off',
      output: { dir: campDir },
    } as never))
    writeFileSync(join(campDir, 'state', 'fuzz_plan.json'), JSON.stringify({
      parameter_space: { n: { type: 'int_range', min: 0, max: 3 } },
      next_batch_plan: [
        { plan_description: 'miss', n: 0 },
        { plan_description: 'reach only', n: 1 },
        { plan_description: 'reach and trigger', n: 2 },
      ],
    }))
    writeFileSync(join(campDir, 'generator.py'), GENERATOR)
    // The active pointer PbfuzzHost.bind() writes; state.json is what a real REFLECT round leaves.
    writeFileSync(join(root, '.pbfuzz', 'active'), `${campDir}\n`)
    writeFileSync(join(campDir, 'state', 'state.json'), JSON.stringify(reflect))
    bridge = new EngineBridge({ pythonPath: python!, env: engineEnv(pkgRoot), log: line => { logs.push(line) } })
  })

  afterAll(() => {
    void bridge?.stop()
    if (root !== '') rmSync(root, { recursive: true, force: true })
  })

  it('ping reports the contracts version the plugin speaks', async () => {
    const ping = await bridge.call('ping') as { contractsVersion: string; capabilities: string[] }
    expect(ping.contractsVersion).toBe(CONTRACTS_VERSION)
    expect(ping.capabilities).toContain('fuzz.run')
  }, 30_000)

  it('selfcheck.engine passes', async () => {
    const item = await bridge.call('selfcheck.engine', selfcheckEngineParams(CONTRACTS_VERSION)) as { name: string; status: string; evidence: string[] }
    expect(item.name).toBe('engine')
    expect(item.status, item.evidence.join('\n')).toBe('pass')
  }, 30_000)

  it('fuzz.run with the plugin\'s own params triggers, and the engine writes metrics.json', async () => {
    const params = fuzzRunParams({
      campaignPath,
      planPath: join(campDir, 'state', 'fuzz_plan.json'),
      generatorPath: join(campDir, 'generator.py'),
      pierRound: 2,
      settings: settings({ execution: { pythonPath: python! } }),
      overrides: { maxIters: 20, fuzzTimeoutSec: 60 },
    })
    const result = await bridge.call('fuzz.run', params as unknown as Record<string, unknown>) as {
      summary: { totalIterations: number; reachedCount: number; triggeredCount: number; stoppedBy: string }
      firstTriggeringInput?: string
    }
    expect(result.summary, logs.join('\n')).toMatchObject({ stoppedBy: 'trigger', triggeredCount: 1, reachedCount: 2, totalIterations: 3 })
    expect(result.firstTriggeringInput).toBeDefined()
    expect(readFileSync(result.firstTriggeringInput!, 'utf8')).toBe('RT')

    const metrics = JSON.parse(readFileSync(join(campDir, 'state', 'metrics.json'), 'utf8')) as Record<string, unknown>
    expect(metrics).toMatchObject({ pier_round: 2, triggered_count: 1, total_iterations: 3, total_reached_count: 2 })
  }, 90_000)

  it('stop() actually waits for the sidecar to quiesce, so a later call respawns cleanly', async () => {
    await bridge.stop() // resolves only once the real child has exited (or the grace period elapsed)
    const ping = await bridge.call('ping') as { contractsVersion: string }
    expect(ping.contractsVersion).toBe(CONTRACTS_VERSION)
  }, 30_000)
})
