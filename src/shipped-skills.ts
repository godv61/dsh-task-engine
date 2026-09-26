/**
 * The bundled eng-delivery orchestration skill, registered into the calling
 * scope's layer of the host skill registry on the AGENT plane.
 *
 * @module dsh-task-engine/shipped-skills
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/** Narrowed view of the host skill registry's register method. */
interface SkillRegistry {
  register(skill: { name: string; description: string; whenToUse?: string; content: string; source: string }): () => void
}

/**
 * Register the bundled `skills/` catalog (each directory's `SKILL.md` with
 * `name`/`description`/`whenToUse` frontmatter). No-op when the skill registry
 * is absent.
 * @param ctx - the scoped context whose `skills` resolves to the host registry.
 */
export function registerShippedSkills(ctx: Context): void {
  const skills = ctx.get('skills') as SkillRegistry | undefined
  if (skills === undefined) return
  const skillsRoot = fileURLToPath(new URL('../skills/', import.meta.url))
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const raw = readFileSync(fileURLToPath(new URL(`../skills/${entry.name}/SKILL.md`, import.meta.url)), 'utf8')
      .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!m) continue
    const head = m[1]!
    const body = m[2]!
    const meta: Record<string, string> = {}
    for (const line of head.split('\n')) {
      const i = line.indexOf(':')
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    if (!meta.name || !meta.description) continue
    skills.register({
      name: meta.name,
      description: meta.description,
      ...(meta.whenToUse !== undefined ? { whenToUse: meta.whenToUse } : {}),
      content: body,
      source: 'custom',
    })
  }
}
