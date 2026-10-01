/**
 * `RunOptions.onOutput` against a real subprocess (no `exec.ts` mocking here — this spec exists
 * to exercise the actual stdout/stderr 'data' handlers, not a stand-in for them).
 */
import { describe, expect, it } from 'vitest'
import { run } from '../../src/host/exec.ts'

describe('run(): onOutput', () => {
  it('delivers both stdout and stderr chunks tagged by stream, without changing the buffered result', async () => {
    const seen: Array<{ chunk: string; stream: 'stdout' | 'stderr' }> = []
    const result = await run('/bin/sh', ['-c', 'echo out; echo err >&2'], {
      onOutput: (chunk, stream) => { seen.push({ chunk, stream }) },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('out\n')
    expect(result.stderr).toBe('err\n')

    expect(seen.some(s => s.stream === 'stdout')).toBe(true)
    expect(seen.some(s => s.stream === 'stderr')).toBe(true)
    expect(seen.filter(s => s.stream === 'stdout').map(s => s.chunk).join('')).toBe('out\n')
    expect(seen.filter(s => s.stream === 'stderr').map(s => s.chunk).join('')).toBe('err\n')
  })

  it('a callback that throws is swallowed and does not abort the run', async () => {
    const result = await run('/bin/sh', ['-c', 'echo out; echo err >&2'], {
      onOutput: () => { throw new Error('boom') },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('out\n')
    expect(result.stderr).toBe('err\n')
  })

  it('omitting onOutput leaves the result exactly as before', async () => {
    const result = await run('/bin/sh', ['-c', 'echo out; echo err >&2'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('out\n')
    expect(result.stderr).toBe('err\n')
  })
})
