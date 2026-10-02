/** kanalyzer's tools and command through DSH's runtimes. The LLVM toolchain is out of scope. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootRealDsh, type RealDsh } from './harness.ts'
import { openSession } from './helpers.ts'

let dsh: RealDsh
beforeAll(async () => { dsh = await bootRealDsh() })
afterAll(async () => { await dsh?.dispose() })

describe('kanalyzer', () => {
  it('kanalyzer_doctor runs through the ToolRuntime and reports a missing toolchain as data, not a crash', async () => {
    const session = await openSession(dsh)
    const result = await session.call('kanalyzer_doctor')
    expect(result.isError).toBe(false)
    expect(result.value).toEqual(expect.objectContaining({ ok: false, status: { installed: false }, reason: expect.stringContaining('KAMain not found') }))
  })

  it('/kanalyzer doctor reaches the same check through the CommandRuntime', async () => {
    const session = await openSession(dsh)
    const result = await session.command('/kanalyzer doctor')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('KAMain not found')
  })
})
