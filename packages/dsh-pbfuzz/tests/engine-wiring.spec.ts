import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { campaignToYaml, parseCampaignYaml } from '../src/core/campaign-yaml.ts'
import {
  corpusAnalyzeParams,
  debuggerPaths,
  fuzzRunParams,
  generatorValidateParams,
  paramsExtractParams,
} from '../src/core/engine-params.ts'
import { EngineRpcError } from '../src/core/rpc.ts'
import { engineEnv } from '../src/engine-bridge.ts'
import { engineToolError, type QuestionAsker } from '../src/recovery.ts'
import { reachingTestcases } from '../src/tools.ts'
import { settings } from './fixtures.ts'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const repo = resolve(pkgRoot, '..', '..')

/** `FuzzRunParams` is `additionalProperties: false` in contracts/engine-rpc.schema.json. */
const FUZZ_RUN_KEYS = ['campaignPath', 'debuggerPaths', 'generatorPath', 'pierRound', 'planPath', 'runtime']

describe('campaign yaml is safe for the YAML 1.1 readers (engine + guards use PyYAML)', () => {
  it('quotes 1.1 booleans such as `off`, adds no directive, and round-trips', () => {
    const doc = { version: 1, id: 'x', tracer: 'off', target: { repo: '/r', language: 'c' }, note: 'yes' }
    const text = campaignToYaml(doc as never)
    expect(text).toMatch(/^tracer: "off"$/m)
    expect(text).toMatch(/^note: "yes"$/m)
    expect(text).not.toContain('%YAML')
    expect(parseCampaignYaml(text)).toEqual(doc)
  })
})

describe('engine parameter shapes', () => {
  it('fuzz.run forwards every fuzzing.* knob, the generator limits and debuggerPaths', () => {
    const s = settings({ execution: { gdbPath: '/opt/gdb', pythonPath: '/venv/bin/python', generatorMemLimitMB: 256, generatorCpuLimitSec: 7 } })
    const p = fuzzRunParams({ campaignPath: '/c.yaml', planPath: '/p.json', generatorPath: '/g.py', pierRound: 2, settings: s, overrides: { maxIters: 9 } })
    expect(Object.keys(p).sort()).toEqual(FUZZ_RUN_KEYS)
    expect(p.runtime).toEqual({
      maxIters: 9,
      execTimeoutSec: s.fuzzing.execTimeoutSec,
      fuzzTimeoutSec: s.fuzzing.fuzzTimeoutSec,
      generatorTimeoutSec: s.fuzzing.generatorTimeoutSec,
      enableDebuggerForAll: s.fuzzing.enableDebuggerForAll,
      stage1MinConcreteParams: s.fuzzing.stage1MinConcreteParams,
      generatorMemLimitMB: 256,
      generatorCpuLimitSec: 7,
    })
    expect(p.debuggerPaths).toEqual({ gdbPath: '/opt/gdb', pythonPath: '/venv/bin/python' })
    expect(p.pierRound).toBe(2)
  })

  it('omits empty debugger paths (the engine falls back to PATH)', () => {
    expect(debuggerPaths(settings({ execution: { gdbPath: '', pythonPath: 'python3' } }))).toEqual({ pythonPath: 'python3' })
  })

  it('sends exactly the engine/README.md shapes for the methods the contract leaves open', () => {
    expect(generatorValidateParams('/g.py', { parameter_space: {} })).toEqual({ generatorPath: '/g.py', plan: { parameter_space: {} } })
    expect(corpusAnalyzeParams('/c.yaml')).toEqual({ campaignPath: '/c.yaml' })
    expect(corpusAnalyzeParams('/c.yaml', '/seeds')).toEqual({ campaignPath: '/c.yaml', seedsDir: '/seeds' })
    expect(paramsExtractParams('/x.py', { seedsDir: '/seeds' })).toEqual({ extractorPath: '/x.py', seedsDir: '/seeds' })
    expect(paramsExtractParams('/x.py', { inputs: ['/a'] })).toEqual({ extractorPath: '/x.py', inputs: ['/a'] })
  })

  it('finds the reaching testcases the engine saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pbfuzz-tc-'))
    for (const name of ['round0_s1_stage2_iter3', 'round0_s1_stage1_iter1_reached', 'round0_s1_stage2_iter2_triggered']) writeFileSync(join(dir, name), 'x')
    mkdirSync(join(dir, 'sub_reached'))
    expect(reachingTestcases(dir)).toEqual([join(dir, 'round0_s1_stage1_iter1_reached'), join(dir, 'round0_s1_stage2_iter2_triggered')])
    expect(reachingTestcases(join(dir, 'missing'))).toEqual([])
  })
})

describe('engine sidecar environment', () => {
  it('puts the in-repo engine on PYTHONPATH, keeping an existing one', () => {
    expect(engineEnv(pkgRoot, {})).toEqual({ PYTHONPATH: join(repo, 'engine') })
    expect(engineEnv(pkgRoot, { PYTHONPATH: '/x' }).PYTHONPATH).toBe(`${join(repo, 'engine')}:/x`)
    expect(engineEnv('/nonexistent/pkg', {})).toEqual({})
  })

  it('uses the engine shipped inside an installed npm package (no source checkout around it)', () => {
    const root = mkdtempSync(join(tmpdir(), 'pbfuzz-installed-'))
    const installed = join(root, 'node_modules', '@pbfuzz', 'dsh-pbfuzz')
    mkdirSync(join(installed, 'engine', 'pbfuzz_engine'), { recursive: true })
    writeFileSync(join(installed, 'engine', 'pbfuzz_engine', 'rpc.py'), '')
    expect(engineEnv(installed, {})).toEqual({ PYTHONPATH: join(installed, 'engine') })
  })

  it('lets $PBFUZZ_ENGINE_DIR win over both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pbfuzz-enginedir-'))
    mkdirSync(join(dir, 'pbfuzz_engine'), { recursive: true })
    writeFileSync(join(dir, 'pbfuzz_engine', 'rpc.py'), '')
    expect(engineEnv(pkgRoot, { PBFUZZ_ENGINE_DIR: dir })).toEqual({ PYTHONPATH: dir })
  })
})

describe('engine errors reach the user as remedies, not a bare message', () => {
  const error = new EngineRpcError({
    code: -32002,
    message: 'generator failed before any input ran',
    data: {
      diagnosis: 'generate() raised KeyError: n',
      remedies: [
        { id: 'fix_generator', label: 'Fix the generator', effect: 'retry' },
        { id: 'shrink_space', label: 'Drop the n parameter', detail: 'edit fuzz_plan.json', effect: 'edit_campaign' },
      ],
    },
  })

  it('interactive: offers the engine remedies through ask_user_question and reports the choice', async () => {
    const asked: unknown[] = []
    const asker: QuestionAsker = {
      ask: async (request) => {
        asked.push(request)
        return { answers: [{ id: request.questions[0]!.id, selected: ['Drop the n parameter'] }] }
      },
    }
    const out = await engineToolError('pbfuzz fuzz.run', error, asker, { headless: false })
    const question = (asked[0] as { questions: { options: { label: string }[]; detail: string }[] }).questions[0]!
    expect(question.options.map(o => o.label)).toEqual(['Fix the generator', 'Drop the n parameter'])
    expect(question.detail).toContain('generate() raised KeyError: n')
    expect(out.message).toContain('The user chose: Drop the n parameter (edit fuzz_plan.json) [effect: edit_campaign]')
  })

  it('headless: no prompt, no exit code, and the message still lists the options', async () => {
    const before = process.exitCode
    const out = await engineToolError('pbfuzz trace.run', error, undefined, { headless: true })
    expect(process.exitCode).toBe(before)
    expect(out.message).toContain('generate() raised KeyError: n')
    expect(out.message).toContain('Fix the generator')
    expect(out.message).toContain('Drop the n parameter')
  })
})
