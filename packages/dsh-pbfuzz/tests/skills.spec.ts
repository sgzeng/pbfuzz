import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSkills, parseSkill, registerSkills, type ParsedSkill } from '../src/skills.ts'

describe('parseSkill: whenToUse / invocation frontmatter', () => {
  it('has no whenToUse/invocation when the frontmatter declares neither', () => {
    expect(parseSkill('---\nname: x\ndescription: y\n---\nbody', 'p')).toEqual({ name: 'x', description: 'y', content: 'body', path: 'p' })
  })

  it.each([
    ['whenToUse', 'camelCase, the real filesystem provider\'s own spelling'],
    ['when-to-use', 'the hyphenated spelling'],
  ])('parses %s (%s)', (key) => {
    const skill = parseSkill(`---\nname: x\ndescription: y\n${key}: use this when Z\n---\nbody`, 'p')
    expect(skill?.whenToUse).toBe('use this when Z')
    expect(skill?.invocation).toBeUndefined()
  })

  it('resolves disable-model-invocation / user-invocable into a full policy', () => {
    expect(parseSkill('---\nname: x\ndescription: y\ndisable-model-invocation: true\n---\nb', 'p')?.invocation)
      .toEqual({ modelInvocable: false, userInvocable: true })
    expect(parseSkill('---\nname: x\ndescription: y\nuser-invocable: false\n---\nb', 'p')?.invocation)
      .toEqual({ modelInvocable: true, userInvocable: false })
    expect(parseSkill('---\nname: x\ndescription: y\ndisable-model-invocation: yes\nuser-invocable: no\n---\nb', 'p')?.invocation)
      .toEqual({ modelInvocable: false, userInvocable: false })
  })
})

describe('loadSkills: resourceBase', () => {
  it('sets resourceBase to the skill\'s own directory, not the parent skills/ root', () => {
    const root = mkdtempSync(join(tmpdir(), 'pbfuzz-skills-'))
    const dir = join(root, 'my-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: my-skill\ndescription: d\n---\nbody')
    const [skill] = loadSkills(root)
    expect(skill?.resourceBase).toEqual({ kind: 'directory', path: dir })
  })
})

describe('registerSkills', () => {
  it('passes whenToUse/invocation/resourceBase through only when present', () => {
    const registered: unknown[] = []
    const registry = { register: (s: unknown) => { registered.push(s); return () => {} } }
    const bare: ParsedSkill = { name: 'a', description: 'd', content: 'c', path: '/a/SKILL.md' }
    const full: ParsedSkill = {
      name: 'b',
      description: 'd2',
      content: 'c2',
      path: '/b/SKILL.md',
      whenToUse: 'when B',
      invocation: { modelInvocable: false, userInvocable: true },
      resourceBase: { kind: 'directory', path: '/b' },
    }
    registerSkills(registry, [bare, full])
    expect(registered[0]).toEqual({ name: 'a', description: 'd', content: 'c', path: '/a/SKILL.md', source: 'bundled' })
    expect(registered[1]).toEqual({
      name: 'b',
      description: 'd2',
      content: 'c2',
      path: '/b/SKILL.md',
      source: 'bundled',
      whenToUse: 'when B',
      invocation: { modelInvocable: false, userInvocable: true },
      resourceBase: { kind: 'directory', path: '/b' },
    })
  })
})
