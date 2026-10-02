import { describe, expect, it } from 'vitest'
import { EngineBridge, resolvePythonPath, scrubEnv } from '../src/engine-bridge.ts'

describe('scrubEnv: no credential reaches the model-code sidecar', () => {
  it('drops names containing KEY/SECRET/TOKEN/PASSWORD, case-insensitively', () => {
    const env = {
      OPENAI_API_KEY: 'sk-x',
      apiKey: 'y',
      DATABASE_PASSWORD: 'z',
      GITHUB_TOKEN: 'gh',
      AWS_SECRET_ACCESS_KEY: 's',
      PATH: '/usr/bin',
      PYTHONPATH: '/engine',
      LANG: 'en_US.UTF-8',
    }
    expect(scrubEnv(env)).toEqual({ PATH: '/usr/bin', PYTHONPATH: '/engine', LANG: 'en_US.UTF-8' })
  })
})

describe('EngineBridge.stop()', () => {
  it('is a no-op that resolves immediately when nothing was ever spawned, and stays so when repeated', async () => {
    const bridge = new EngineBridge({ pythonPath: '/does/not/matter' })
    await expect(bridge.stop()).resolves.toBeUndefined()
    await expect(bridge.stop()).resolves.toBeUndefined()
  })
})

describe('resolvePythonPath: the default interpreter must be a Python >= 3.11', () => {
  it('keeps a configured interpreter as is, without probing', () => {
    const probe = (): boolean => { throw new Error('must not probe') }
    expect(resolvePythonPath('/opt/py/bin/python', probe)).toBe('/opt/py/bin/python')
    expect(resolvePythonPath('python3.12', probe)).toBe('python3.12')
  })

  it('uses python3 when it is new enough', () => {
    expect(resolvePythonPath('python3', () => true)).toBe('python3')
  })

  it('falls back to the newest versioned interpreter when python3 is too old (Ubuntu 22.04)', () => {
    const suitable = new Set(['python3.12', 'python3.11'])
    expect(resolvePythonPath('python3', c => suitable.has(c))).toBe('python3.12')
  })

  it('stays python3 when nothing qualifies, so the engine reports its own diagnosis', () => {
    expect(resolvePythonPath('python3', () => false)).toBe('python3')
  })
})
