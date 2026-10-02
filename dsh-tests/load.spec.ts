/**
 * Do pbfuzz and kanalyzer load into the newest DSH and register everything they declare? Every
 * assertion here goes through a REAL DSH service (ToolRuntime, CommandRuntime, SkillRegistry,
 * SettingsProvider); the packages' own unit tests can only check our side of these calls.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PBFUZZ_TOOLS } from '../packages/dsh-pbfuzz/src/core/phases.ts'
import { bootRealDsh, FIBER_ACTIVE, type RealDsh } from './harness.ts'
import { openSession } from './helpers.ts'

let dsh: RealDsh
beforeAll(async () => { dsh = await bootRealDsh() })
afterAll(async () => { await dsh?.dispose() })

describe('pbfuzz and kanalyzer in DSH', () => {
  it('boots a fully started tree with both plugins mounted', () => {
    expect(dsh.ctx.fiber.state, `DSH ${dsh.version}`).toBe(FIBER_ACTIVE)
    expect(dsh.ctx.get('kanalyzer'), 'the service kanalyzer publishes').toBeDefined()
  })

  it('registers every tool, each with an object parameter schema DSH accepts', () => {
    const schemas: { name: string; parameters: { type: string } }[] = dsh.ctx.get('tools').schemas()
    const byName = new Map(schemas.map(schema => [schema.name, schema]))
    for (const name of [...PBFUZZ_TOOLS, 'kanalyzer_doctor', 'kanalyzer_prepare', 'kanalyzer_analyze', 'kanalyzer_query']) {
      expect(byName.get(name)?.parameters.type, name).toBe('object')
    }
  })

  it('registers the /pbfuzz and /kanalyzer commands and their skills', async () => {
    const commands: { name: string }[] = dsh.ctx.get('commands').list()
    expect(commands.map(command => command.name)).toEqual(expect.arrayContaining(['pbfuzz', 'kanalyzer']))
    const skills: { name: string }[] = await dsh.ctx.get('skills').list()
    expect(skills.map(skill => skill.name)).toEqual(expect.arrayContaining(['pbfuzz', 'kanalyzer']))
  })

  it("pbfuzz finds kanalyzer's service and registers it as an analysis provider", async () => {
    const session = await openSession(dsh)
    session.llm.enqueue({ text: 'ok' }, { text: 'ok' }, { text: 'ok' }, { text: 'ok' }) // the run starts a turn
    expect((await session.command(`/pbfuzz run ${session.workspace.campaignPath}`)).kind).toBe('success')
    const status = JSON.parse((await session.command('/pbfuzz status')).text)
    expect(status).toEqual(expect.objectContaining({ providers: ['kanalyzer'] }))
  })
})
