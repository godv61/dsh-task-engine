/** Browser-safe mount policy and metadata. A loading choice is local to one stage. */
import type { SkillBinding, SkillLoading } from './engine.ts'

export type MetaSkillMount = string | { name: string; loading: SkillLoading }
export function mountName(mount: MetaSkillMount): string { return typeof mount === 'string' ? mount : mount.name }
export function mountLoading(mount: MetaSkillMount): SkillLoading { return typeof mount === 'string' ? 'required' : mount.loading }
export function validMetaMount(value: unknown): value is MetaSkillMount {
  if (typeof value === 'string') return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const mount = value as Partial<Exclude<MetaSkillMount, string>>
  return typeof mount.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(mount.name)
    && (mount.loading === 'required' || mount.loading === 'on-demand')
}
export function appendMount(mounts: MetaSkillMount[], mount: MetaSkillMount): MetaSkillMount[] {
  return mounts.some(entry => mountName(entry) === mountName(mount)) ? mounts : [...mounts, mount]
}
/** Initialization adds advisory project knowledge; never rewrite an existing mount's policy. */
export function appendInitMount(mounts: MetaSkillMount[], name: string, coreName: string): MetaSkillMount[] {
  return appendMount(mounts, { name, loading: name === coreName ? 'required' : 'on-demand' })
}
export function requiredSkill(entry: Pick<SkillBinding, 'loading'>): boolean { return entry.loading !== 'on-demand' }

/** Same simple frontmatter fields accepted by the resource editor and host registry. */
export function skillMetadata(raw: string): { description: string; whenToUse: string } {
  const head = raw.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n').match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1] ?? ''
  const field = (name: string) => head.split('\n').find(line => line.startsWith(name + ':'))?.slice(name.length + 1).trim() ?? ''
  return { description: field('description'), whenToUse: field('whenToUse') }
}
