/**
 * Runtime registration of the skills bundled under `skills/`.
 *
 * There is one: `pbfuzz`. It used to be five (`pbfuzz`, `pbfuzz-pier`, `pbfuzz-kanalyzer`,
 * `pbfuzz-derive-target`, `pbfuzz-debugging`), 47 KB in total, of which a normal campaign loaded
 * three — restating the same failure-recovery rule in each, retelling incidents the model cannot
 * act on, and contradicting the command's own bootstrap about when to probe. The merged skill is
 * about a fifth of that and is injected directly by `/pbfuzz`, so onboarding needs no `skill`
 * round trip either.
 *
 * @module @pbfuzz/dsh-pbfuzz/skills
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillInvocationPolicy, SkillRegistration, SkillResourceBase } from '@deepseek-ai/dsh-skill'

/** A parsed SKILL.md. */
export interface ParsedSkill {
  name: string
  description: string
  content: string
  path: string
  /**
   * Extra routing guidance from the `whenToUse` (or `when-to-use`) frontmatter field, when
   * present. The real `@deepseek-ai/dsh-skill-filesystem` provider's own frontmatter parser
   * accepts only the camelCase spelling (verified against its installed source), so that is the
   * one this parser prefers when a skill declares both; `when-to-use` is accepted too since a
   * hand-written bundled SKILL.md is easy to get wrong either way and there is no user-facing
   * document to keep byte-for-byte compatible with an external tool here.
   */
  whenToUse?: string
  /**
   * Resolved from the `disable-model-invocation`/`user-invocable` frontmatter fields — the real
   * filesystem provider's own kebab-case keys (its camelCase spellings, e.g. `modelInvocable`, are
   * REJECTED legacy aliases, verified against its installed source, so this parser does not accept
   * them either). Absent entirely when the frontmatter declares neither field, matching
   * `ctx.skills.register()`'s own "omission permits both model and user surfaces" default — there
   * is nothing to override.
   */
  invocation?: SkillInvocationPolicy
  /**
   * The directory this skill's SKILL.md was loaded from, set by {@link loadSkills} (which is the
   * one function that knows it); absent when {@link parseSkill} is called directly on bare text.
   * Passed through to `ctx.skills.register()` so a skill's relative file references (e.g.
   * the `pbfuzz` skill's `canaries/README.md`) resolve for the model the same way the real
   * filesystem provider already resolves them for a project/user skill.
   */
  resourceBase?: SkillResourceBase
}

/** Frontmatter booleans this bundled parser accepts: `true`/`yes`/`on`/`1`, case-insensitively —
 * everything else (including an absent or malformed value) reads as `false`. Deliberately more
 * forgiving than the real filesystem provider's `frontmatterBoolean` (which throws on a value it
 * cannot parse): these SKILL.md files ship with the package, so a malformed value is a bug to fix
 * here, not untrusted user content to reject loudly at load time. */
function frontmatterBoolean(raw: string): boolean {
  return ['true', 'yes', 'on', '1'].includes(raw.trim().toLowerCase())
}

/**
 * Resolve `disable-model-invocation`/`user-invocable` into a full invocation policy, or undefined
 * when the frontmatter declares neither key.
 * @param fields - the parsed frontmatter key/value map.
 * @returns the resolved policy, or undefined.
 */
function parseInvocation(fields: Record<string, string>): SkillInvocationPolicy | undefined {
  const hasDisable = Object.hasOwn(fields, 'disable-model-invocation')
  const hasUser = Object.hasOwn(fields, 'user-invocable')
  if (!hasDisable && !hasUser) return undefined
  return {
    modelInvocable: !hasDisable || !frontmatterBoolean(fields['disable-model-invocation']!),
    userInvocable: !hasUser || frontmatterBoolean(fields['user-invocable']!),
  }
}

/**
 * Parse `---` frontmatter (flat `key: value` lines) and body.
 * @param text - SKILL.md contents.
 * @param path - file path, for errors.
 * @returns the parsed skill, or undefined when name/description are missing.
 */
export function parseSkill(text: string, path: string): ParsedSkill | undefined {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (match === null) return undefined
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (kv !== null) fields[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '')
  }
  if (fields.name === undefined || fields.description === undefined) return undefined
  const whenToUse = fields.whenToUse ?? fields['when-to-use']
  const invocation = parseInvocation(fields)
  return {
    name: fields.name,
    description: fields.description,
    content: match[2]!.trim(),
    path,
    ...whenToUse !== undefined && whenToUse !== '' ? { whenToUse } : {},
    ...invocation !== undefined ? { invocation } : {},
  }
}

/**
 * Read every skill bundle under `skillsDir`.
 * @param skillsDir - the package's `skills/` directory.
 * @returns parsed skills (unparsable ones skipped).
 */
export function loadSkills(skillsDir: string): ParsedSkill[] {
  if (!existsSync(skillsDir)) return []
  const out: ParsedSkill[] = []
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(skillsDir, entry.name)
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) continue
    const skill = parseSkill(readFileSync(file, 'utf8'), file)
    if (skill !== undefined) out.push({ ...skill, resourceBase: { kind: 'directory', path: dir } })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Register skills on `ctx.skills`.
 * @param skills - the registry.
 * @param list - skills to register.
 * @returns each registration's disposer, in `list` order, for callers that need to unregister
 *   deterministically (rather than relying on the registry to auto-track the calling fiber).
 */
export function registerSkills(skills: { register(s: SkillRegistration): () => void }, list: ParsedSkill[]): (() => void)[] {
  return list.map(s => skills.register({
    name: s.name,
    description: s.description,
    content: s.content,
    path: s.path,
    source: 'bundled',
    ...s.whenToUse !== undefined ? { whenToUse: s.whenToUse } : {},
    ...s.invocation !== undefined ? { invocation: s.invocation } : {},
    ...s.resourceBase !== undefined ? { resourceBase: s.resourceBase } : {},
  }))
}
