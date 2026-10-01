/**
 * The kanalyzer-dependent fiber, against the real `@deepseek-ai/cordis` runtime: the analysis
 * provider is registered while `ctx.kanalyzer` exists and goes away with it, and the bundled skill
 * registers independently of that (it used to be a joint `pbfuzz-kanalyzer` skill registered from
 * inside the kanalyzer fiber; there is one merged skill now, owned by no fiber but `skills`).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as pbfuzz from '../src/index.ts'
import { settings } from './fixtures.ts'

const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })
const settle = async (n = 10): Promise<void> => { for (let i = 0; i < n; i++) await tick() }

interface FakeSkills {
  registered: Set<string>
  register(def: { name: string }): () => void
}

function fakeSkills(): FakeSkills {
  const registered = new Set<string>()
  return {
    registered,
    register(def) {
      registered.add(def.name)
      return () => { registered.delete(def.name) }
    },
  }
}

/** Every dependency `index.ts`'s top-level `inject` map names, all optional ones present too:
 * a live DSH web composition mounts all four, and pbfuzz's own fiber never activates without
 * 'tools' (`required: true`) — the other three are `required: false` for *pbfuzz's own* purposes,
 * but this harness still supplies trivial stand-ins so the fiber under test reaches ACTIVE. */
function provideHostServices(root: Context): void {
  root.provide('tools', { register: () => () => {}, schemas: () => [], guard: () => () => {} } as never)
  root.provide('sessionProjections', { register: () => () => {} } as never)
  root.provide('userQuestions', { ask: async () => ({}) } as never)
  root.provide('jobs', { run: async () => ({}), onJobDone: () => () => {} } as never)
}

describe('the kanalyzer-dependent fiber (index.ts, ctx.inject([\'kanalyzer\'], …))', () => {
  it('registers the analysis provider with kanalyzer and drops it when kanalyzer unloads', async () => {
    const root = new Context()
    provideHostServices(root)
    const skills = fakeSkills()
    root.provide('skills', skills as never)
    await root.plugin(pbfuzz as never, settings() as never)
    await settle()

    // The one bundled skill does not depend on kanalyzer at all.
    expect([...skills.registered]).toEqual(['pbfuzz'])

    const disposeKanalyzer = root.provide('kanalyzer', { doctor: async () => ({ ok: true }) } as never)
    await settle()
    expect([...skills.registered]).toEqual(['pbfuzz'])

    disposeKanalyzer()
    await settle()
    expect([...skills.registered]).toEqual(['pbfuzz'])
  })

  it('loads cleanly whichever order kanalyzer and skills arrive in', async () => {
    const root = new Context()
    provideHostServices(root)
    await root.plugin(pbfuzz as never, settings() as never)

    const disposeKanalyzer = root.provide('kanalyzer', { doctor: async () => ({ ok: true }) } as never)
    await settle()

    const skills = fakeSkills()
    const disposeSkills = root.provide('skills', skills as never)
    await settle()
    expect([...skills.registered]).toEqual(['pbfuzz'])

    disposeKanalyzer()
    await settle()
    expect([...skills.registered]).toEqual(['pbfuzz'])
    disposeSkills()
  })
})
