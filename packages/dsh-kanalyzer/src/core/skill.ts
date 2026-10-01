/**
 * Minimal SKILL.md frontmatter reader for the two skills this package ships.
 *
 * @module @pbfuzz/dsh-kanalyzer/core/skill
 */

/** A parsed skill file. */
export interface ParsedSkill {
  name: string
  description: string
  content: string
}

/**
 * Parse `---\nname: …\ndescription: …\n---\nbody`. Only single-line scalar fields are supported,
 * which is all the bundled skills use.
 * @param text - file contents.
 * @returns the skill, or undefined when the frontmatter lacks name/description.
 */
export function parseSkillFile(text: string): ParsedSkill | undefined {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m?.[1] || m[2] === undefined) return undefined
  const fields = new Map<string, string>()
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv?.[1] !== undefined && kv[2] !== undefined) fields.set(kv[1], kv[2].replace(/^(['"])(.*)\1$/, '$2').trim())
  }
  const name = fields.get('name')
  const description = fields.get('description')
  if (!name || !description) return undefined
  return { name, description, content: m[2].trim() }
}
