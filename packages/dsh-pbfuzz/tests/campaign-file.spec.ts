/**
 * What actually lands in `pbfuzz.campaign.yaml`, for the campaign session ea916c42 drafted
 * (readelf.cpp:96). That file was 40 lines; about a third restated something else: a header
 * comment, `env.build_script` next to an identical `build.cmd`, a `run_script` nothing ever ran,
 * `entry.binary` (never read), `canary_on_trigger` on a target with its own markers, a
 * `build.dir` equal to the repo, and an `output.dir` naming the very directory the file sits in.
 */
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { draftCampaign } from '../src/core/campaign.ts'
import { PBFUZZ_TOOLS } from '../src/core/phases.ts'
import { PbfuzzHost, type AgentLike } from '../src/host.ts'
import { settings } from './fixtures.ts'

describe('the campaign file', () => {
  it('holds only target facts, and loads back complete', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pbfuzz-file-')))
    const agent: AgentLike = { id: 'a', session: { header: { cwd: repo } }, ctx: { tools: { restrict: () => () => {} } } }
    const host = new PbfuzzHost(() => settings(), { info() {}, warn() {} }, () => new Set<string>(PBFUZZ_TOOLS))
    // The live run's answers, less what the schema no longer has (`env`, `entry.binary`) and the
    // bitcode the agent built only because it was told that would "skip the rebuild".
    const { campaign, validation } = draftCampaign({
      id: 'readelf-l96',
      target: { repo, language: 'cpp' },
      bug: { targets: [{ location: 'readelf.cpp:96', condition: 'header.e_ident[EI_CLASS] == ELFCLASS64 && header.e_ident[EI_DATA] == ELFDATA2MSB' }] },
      entry: { kind: 'executable', run_cmd: './readelf @@', input_channel: 'file', cwd: repo },
      oracle: { mode: 'preexisting', reached_pattern: 'bug location reached', triggered_pattern: 'bug location triggered' },
      build: { cmd: `${repo}/build.sh`, dir: repo },
    }, settings({ tools: { staticAnalysis: 'kanalyzer', corpusAnalysis: false, deviationDetection: false } }), false)
    expect(validation.ok, JSON.stringify(validation.issues)).toBe(true)

    const saved = host.save(agent, campaign)
    const text = readFileSync(saved.path, 'utf8')
    for (const gone of ['#', 'env:', 'binary', 'run_script', 'canary_on_trigger', 'output:', 'analysis:', `dir: ${repo}\n`]) {
      expect(text, `${gone} should not be in:\n${text}`).not.toContain(gone)
    }
    expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(25)

    // Nothing was lost: the loader restores output.dir from where the file is.
    const loaded = host.load(agent, saved.path, false)
    expect(loaded.campaign.output.dir).toBe(saved.layout.dir)
    expect(loaded.layout.stateDir).toBe(saved.layout.stateDir)
  })
})
