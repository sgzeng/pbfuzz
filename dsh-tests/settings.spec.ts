/**
 * Settings are the plugin's own Loader entry in DSH >= 0.2 (`.volatile()` fields, edited through
 * `settings.update`). The 0.2 migration broke exactly here while 414 mocked tests stayed green.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootRealDsh, type RealDsh } from './harness.ts'
import { openSession, plain, waitUntil } from './helpers.ts'

let dsh: RealDsh
beforeAll(async () => { dsh = await bootRealDsh() })
afterAll(async () => { await dsh?.dispose() })

const section = async (ns: string): Promise<any> => plain((await dsh.ctx.get('settings').describe()).find((entry: any) => entry.ns === ns))

describe('settings', () => {
  it('each plugin has a live section, and the generated page stays off for pbfuzz and kanalyzer (their own cards replace it)', async () => {
    for (const ns of ['pbfuzz', 'kanalyzer']) {
      expect(await section(ns), ns).toEqual(expect.objectContaining({ applies: 'live', autoGenerate: false }))
    }
  })

  it('an edit is written to the profile patch and reaches the running plugin', async () => {
    const settings = dsh.ctx.get('settings')
    await settings.update('pbfuzz', { budget: { maxPierRounds: 2 } })
    await settings.update('pbfuzz', { budget: { campaignWallTimeMin: 45 } })

    const patch = readFileSync(join(dsh.profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/maxPierRounds: 2/)
    expect(patch, 'an edit is a merge patch: the earlier one is still there').toMatch(/campaignWallTimeMin: 45/)

    // The plugin re-resolves on `loader/volatile-update`; the campaign dashboard shows the limit it uses.
    const session = await openSession(dsh)
    expect((await session.command(`/pbfuzz run ${session.workspace.campaignPath}`)).kind).toBe('success')
    const plan = await session.call('pbfuzz_campaign', { action: 'status' })
    expect(plan.meta?.pbfuzzDashboard?.maxPierRounds ?? plan.value?.pbfuzzDashboard?.maxPierRounds).toBe(2)
  })

  it('the environment self-check result is merged into settings.status and leaves other fields alone', async () => {
    const session = await openSession(dsh)
    expect(await session.command('/pbfuzz selfcheck')).toEqual({ kind: 'success', text: 'pbfuzz environment self-check pass' })

    // The plugin persists the result without awaiting it, so wait for the write to land.
    await waitUntil('the self-check cache to be written', async () => (await section('pbfuzz')).value.status.envSelfcheck.overall === 'pass')
    const { value } = await section('pbfuzz')
    expect(value.status.envSelfcheck).toEqual(expect.objectContaining({ overall: 'pass', items: [expect.objectContaining({ name: 'engine', status: 'pass' })] }))
    expect(value.budget.maxPierRounds, 'the edit from the previous test survives').toBe(2)
  })
})
