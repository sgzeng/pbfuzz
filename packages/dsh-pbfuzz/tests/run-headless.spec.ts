/**
 * `runHeadless` (campaign-flow.ts): the shared body of `/pbfuzz run <path>` and the
 * `pbfuzz_campaign` tool's `run` action — the headless entry point (C8), since headless mode has
 * no slash-command dispatch to reach `/pbfuzz run` with, so the model must be able to call the
 * exact same logic as a tool.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runHeadless, type FlowContext } from '../src/campaign-flow.ts'
import { campaignToYaml } from '../src/core/campaign-yaml.ts'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { engineEnv } from '../src/engine-bridge.ts'
import { PbfuzzHost, type AgentLike } from '../src/host.ts'
import { settings } from './fixtures.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const repo = resolve(pkgRoot, '..', '..')
const venvPython = join(repo, 'engine', '.venv', 'bin', 'python')
const python = process.env.PBFUZZ_PYTHON ?? (existsSync(venvPython) ? venvPython : undefined)

function agentIn(cwd: string): AgentLike {
  return { id: `agent:${cwd}`, session: { header: { cwd } }, ctx: { tools: { restrict: () => () => {} } } }
}

function flowFor(root: string, agent: AgentLike, py = python ?? 'python3'): FlowContext {
  const host = new PbfuzzHost(() => settings({ execution: { pythonPath: py } }), { info() {}, warn() {} }, () => new Set(PBFUZZ_TOOLS), engineEnv(pkgRoot))
  return { host, agent, asker: undefined, signal: new AbortController().signal }
}

describe('runHeadless', () => {
  it('an unconfirmed campaign is refused with an actionable diagnosis, before touching the engine', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-run-')))
    const path = join(root, 'pbfuzz.campaign.yaml')
    writeFileSync(path, campaignToYaml({
      version: 1,
      id: 'unconfirmed',
      confirmed: false,
      target: { repo: root, language: 'python' },
      bug: { targets: [{ location: 'target.py:1' }] },
      entry: { kind: 'executable', run_cmd: 'python3 target.py @@', input_channel: 'file' },
      oracle: { mode: 'preexisting', reached_pattern: 'R', triggered_pattern: 'T' },
      tracer: 'off',
      output: { dir: join(root, 'out') },
    } as never))

    const outcome = await runHeadless(flowFor(root, agentIn(root)), path)
    expect(outcome.ok).toBe(false)
    expect(outcome.diagnosis).toContain('confirmed is not true')
    expect(outcome.campaignId).toBeUndefined()
  })

  it('a path naming nothing fails with a plain diagnosis, not a thrown error', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-run-')))
    const outcome = await runHeadless(flowFor(root, agentIn(root)), join(root, 'nope.yaml'))
    expect(outcome.ok).toBe(false)
    expect(outcome.diagnosis).toContain('pbfuzz:')
  })

  describe.skipIf(python === undefined)('a confirmed, self-check-passing campaign (real engine)', () => {
    it('starts PIER: ok, the campaign id, and a next_instruction naming the auto-advanced PLAN phase / pbfuzz_plan', async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-run-')))
      const campDir = join(root, '.pbfuzz', 'headless-ok')
      mkdirSync(join(campDir, 'state'), { recursive: true })
      writeFileSync(join(root, 'target.py'), "import sys\nsys.stderr.write('PBFUZZ_REACHED: t1\\n')\n")
      const path = join(campDir, 'pbfuzz.campaign.yaml')
      writeFileSync(path, campaignToYaml({
        version: 1,
        id: 'headless-ok',
        confirmed: true,
        target: { repo: root, language: 'python' },
        bug: { targets: [{ location: 'target.py:2' }] },
        entry: { kind: 'executable', run_cmd: `${python} ${join(root, 'target.py')} @@`, input_channel: 'file' },
        oracle: { mode: 'preexisting', reached_pattern: 'PBFUZZ_REACHED:\\s*(\\S+)', triggered_pattern: 'PBFUZZ_TRIGGERED:\\s*(\\S+)' },
        tracer: 'off',
        output: { dir: campDir },
      } as never))

      const outcome = await runHeadless(flowFor(root, agentIn(root)), path)
      expect(outcome.ok, outcome.diagnosis).toBe(true)
      expect(outcome.campaignId).toBe('headless-ok')
      // selfcheck() auto-advances INIT->PLAN on a pass (the model never hand-writes state.json
      // for this hop any more), so nextInstruction names the tool that owns PLAN's own transition.
      expect(outcome.nextInstruction).toContain('PLAN')
      expect(outcome.nextInstruction).toContain('pbfuzz_plan')
      expect(outcome.nextInstruction).toContain('headless')
    }, 30_000)
  })
})
