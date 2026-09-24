/** User-scoped Skill -> Rule ownership shared by every workspace and session. */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatResourceRef, type ResourceRef, type SkillProfile } from './engine.ts'
import type { ProjectConfig } from './workflows.ts'

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const EVIDENCE = new Set(['command', 'artifact', 'review', 'manual', 'none'])
const SOURCES = new Set(['bundled', 'project', 'user'])

function home(): string { return process.env.DSH_HOME ?? join(homedir(), '.dsh') }

export function userSkillProfilePath(name: string): string {
  if (!NAME.test(name)) throw new Error(`invalid user skill name: ${name}`)
  return join(home(), 'skills', name, 'profile.json')
}

function isRef(value: unknown): value is ResourceRef {
  if (value === null || typeof value !== 'object') return false
  const ref = value as Partial<ResourceRef>
  return typeof ref.source === 'string' && SOURCES.has(ref.source)
    && typeof ref.name === 'string' && NAME.test(ref.name)
}

function parseProfile(raw: string, name: string): SkillProfile {
  const value = JSON.parse(raw) as Partial<SkillProfile>
  if (!Array.isArray(value.rules) || !value.rules.every(isRef)
    || (value.evidence !== undefined && !EVIDENCE.has(value.evidence))) {
    throw new Error(`invalid user skill profile: ${name}`)
  }
  return { rules: value.rules, ...(value.evidence !== undefined ? { evidence: value.evidence } : {}) }
}

/** Global user profiles override old copies in each project's eng.json. */
export function withUserSkillProfiles(project: ProjectConfig): ProjectConfig {
  const root = join(home(), 'skills')
  if (!existsSync(root)) return project
  const profiles = { ...project.skill_profiles }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue
    const file = userSkillProfilePath(entry.name)
    if (!existsSync(file)) continue
    if (!existsSync(join(root, entry.name, 'SKILL.md'))) {
      throw new Error(`user skill profile has no skill: ${entry.name}`)
    }
    profiles[formatResourceRef({ source: 'user', name: entry.name })] = parseProfile(readFileSync(file, 'utf8'), entry.name)
  }
  return { ...project, skill_profiles: profiles }
}

/** Persist a user skill's method beside its body, never in a particular project. */
export function saveUserSkillProfile(name: string, profile: SkillProfile): string {
  const file = userSkillProfilePath(name)
  if (!existsSync(join(home(), 'skills', name, 'SKILL.md'))) {
    throw new Error(`user skill not found: ${name}`)
  }
  const validated = parseProfile(JSON.stringify(profile), name)
  if (validated.rules.some(rule => rule.source === 'project')) {
    throw new Error('用户级技能不能绑定项目级规则；请把规则复制到用户级，或把技能复制到项目级')
  }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(validated, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
  return file
}
