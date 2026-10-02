import { describe, expect, it } from 'vitest'
import { EngineBridge, scrubEnv } from '../src/engine-bridge.ts'

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
