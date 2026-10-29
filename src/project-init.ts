/** Evidence-led repository inventory for project Skill/Rule initialization. */
import type { FileProbe } from './project.ts'
import { META_STAGES, type MetaSkill } from './adaptive.ts'

export interface InitResource {
  kind: 'skill' | 'rule'
  name: string
  description?: string
  /** Short task/scope condition for on-demand selection; absent in older drafts. */
  whenToUse?: string
  content: string
  meta_skills?: MetaSkill[]
  rules?: string[]
}

const RESOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** One validator for model-facing and workbench project initialization. */
export function validateInitResources(resources: InitResource[] | undefined): InitResource[] {
  if (!Array.isArray(resources) || resources.length > 24) {
    throw new Error('init_project requires 0–24 Skill/Rule resources')
  }
  const names = new Set<string>()
  for (const resource of resources) {
    if (!resource || !['skill', 'rule'].includes(resource.kind) || !RESOURCE_NAME.test(resource.name)
      || typeof resource.content !== 'string' || !resource.content.trim() || resource.content.length > 16_000) {
      throw new Error('each init_project resource needs kind, kebab-case name, and nonempty content under 16,000 characters')
    }
    const key = `${resource.kind}:${resource.name}`
    if (names.has(key)) throw new Error(`duplicate init_project resource ${key}`)
    names.add(key)
    if (resource.kind === 'skill') {
      if (typeof resource.description !== 'string' || !resource.description.trim()) throw new Error(`Skill ${resource.name} needs a description`)
      if (resource.whenToUse !== undefined && typeof resource.whenToUse !== 'string') throw new Error(`Skill ${resource.name} whenToUse must be a string`)
      if (!Array.isArray(resource.meta_skills) || resource.meta_skills.length === 0 ||
        !resource.meta_skills.every(meta => typeof meta === 'string' && meta in META_STAGES)) throw new Error(`Skill ${resource.name} needs valid meta_skills`)
      if (resource.rules !== undefined && (!Array.isArray(resource.rules) || !resource.rules.every(rule => typeof rule === 'string' && RESOURCE_NAME.test(rule)))) {
        throw new Error(`Skill ${resource.name} has invalid rule names`)
      }
    }
  }
  return resources
}

/** Identical reviewed bytes for both initialization writers and conflict checking. */
export function renderInitSkill(resource: InitResource): string {
  const line = (value: string) => value.replace(/[\r\n]+/gu, ' ').trim()
  const head = [`name: ${resource.name}`, `description: ${line(resource.description ?? '')}`]
  if (resource.whenToUse?.trim()) head.push(`whenToUse: ${line(resource.whenToUse)}`)
  return `---\n${head.join('\n')}\n---\n\n${resource.content.trimEnd()}\n`
}

export interface ProjectInventory {
  project_name: string
  root_entries: string[]
  modules: { path: string; entries: string[] }[]
  manifests: { path: string; facts: string[] }[]
  suggestions: { name: string; kind: 'skill' | 'rule'; meta_skills: string[]; why: string }[]
  caution: string
  discovery?: { status: 'complete' | 'partial' | 'unavailable'; directories: number; entries: number;
    warnings: string[]; exclusions: string[]; limits: { directories: number; depth: number; entries: number } }
}

export interface ProjectInitStep {
  name: string
  kind: 'skill' | 'rule'
  meta_skills: string[]
  why: string
  required: boolean
}

/** Exact file ranges returned to the initialization model, without source bodies. */
export interface InitReadRecord {
  path: string
  start_line: number
  end_line: number
  sha256: string
}

export interface InitGraphQueryRecord {
  mode: 'status' | 'files' | 'context'
  query?: string
  ok: boolean
}

/** A stable order keeps each model response small and makes failed steps resumable. */
export function projectInitSteps(inventory: ProjectInventory, existing: ReadonlySet<string>): ProjectInitStep[] {
  const project = inventory.project_name
  const ordered = [
    `${project}-project-map`, `${project}-tech-stack`, `${project}-business-capabilities`,
    `${project}-code-backend`, `${project}-code-frontend`,
  ]
  const order = new Map(ordered.map((name, index) => [name, index]))
  return inventory.suggestions.filter(item => !existing.has(item.name))
    .sort((a, b) => (order.get(a.name) ?? ordered.length) - (order.get(b.name) ?? ordered.length))
    .map(item => ({ ...item, required: false }))
}

/** Recognize older or user-created stage-specific Skills so initialization can keep their bindings. */
export function projectMetaSkillTargets(projectName: string): { meta: MetaSkill; name: string }[] {
  return (Object.keys(META_STAGES) as MetaSkill[]).map(meta => ({ meta, name: `${projectName}-${meta}` }))
}

/** Paths a repository-wide project map must account for before it is installed. */
export function projectMapCoveragePaths(inventory: ProjectInventory): string[] {
  const paths = new Set<string>()
  for (const manifest of inventory.manifests) {
    const parent = manifest.path.split('/').slice(0, -1).join('/')
    paths.add(parent || manifest.path)
  }
  for (const module of inventory.modules) {
    if (module.entries.some(entry => entry === 'src' || entry === 'pom.xml' || entry === 'package.json'
      || entry === 'build.gradle' || entry === 'build.gradle.kts')) paths.add(module.path)
  }
  return [...paths].sort()
}

/** Known path omissions are actionable; an unfinished discovery is a scope warning, not a missing path. */
export function projectMapCoverageGaps(content: string, inventory: ProjectInventory): string[] {
  const normalized = content.replace(/\\/gu, '/').toLowerCase()
  const gaps = projectMapCoveragePaths(inventory).filter(path => !normalized.includes(path.toLowerCase()))
  if (!projectMapCoveragePaths(inventory).length) gaps.push('[no module or manifest evidence discovered; repository coverage is unproven]')
  return gaps
}

/** Keep the discovery boundary visible in generated maps without claiming source/business completeness. */
export function projectMapScopeNote(inventory: ProjectInventory): string {
  const discovery = inventory.discovery
  if (!discovery || discovery.status === 'complete') return ''
  return `> 发现范围：目录发现尚未完成（已列出 ${discovery.directories} 个目录、${discovery.entries} 个条目）。本地图依据已发现路径与实际查阅文件整理；未发现或未查阅的部分仍待核对，不代表不存在。后续需求可继续通过源码及可用的 CodeGraph 索引定位。\n\n`
}

const MANIFESTS = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'package.json', 'go.mod', 'pyproject.toml', 'Cargo.toml']

function slug(root: string): string {
  const parts = root.replace(/[\\/]+$/u, '').split(/[\\/]/u)
  const name = parts[parts.length - 1] ?? 'project'
  return name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'project'
}

function xmlVersion(raw: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([^<]+)</${tag}>`, 'u').exec(raw)?.[1]?.trim()
}

/** Bounded repository discovery. Completion refers to this explicit search scope, not business completeness. */
export async function scanProject(probe: FileProbe, root: string,
  limits = { directories: 1024, depth: 16, entries: 20_000 }): Promise<ProjectInventory> {
  const project_name = slug(root)
  const exclusions = ['hidden directories', 'symlinks (typed listings)', 'node_modules', 'target', 'dist', 'build', 'coverage', 'vendor', '__pycache__']
  const skip = (name: string): boolean => name.startsWith('.') || exclusions.includes(name)
  const discovery: NonNullable<ProjectInventory['discovery']> = { status: probe.list ? 'complete' : 'unavailable',
    directories: 0, entries: 0, warnings: [], exclusions, limits }
  const warn = (message: string): void => { discovery.status = 'partial'; if (!discovery.warnings.includes(message)) discovery.warnings.push(message) }
  if (!probe.list) discovery.warnings.push('directory listing is unavailable')
  const listing = new Map<string, string[]>()
  const queue = [{ path: '.', depth: 0 }]
  const visited = new Set<string>()
  while (probe.list && queue.length) {
    if (discovery.directories >= limits.directories || discovery.entries >= limits.entries) { warn('directory or entry discovery budget reached'); break }
    const current = queue.shift()!
    if (visited.has(current.path)) continue
    visited.add(current.path)
    try {
      const names = [...new Set(await probe.list(root, current.path))].filter(name => name && name !== '.' && name !== '..' && !/[\\/]/u.test(name)).sort()
      discovery.directories++
      discovery.entries += names.length
      const kept = names.slice(0, Math.max(0, limits.entries - (discovery.entries - names.length)))
      if (kept.length < names.length) warn(`entry budget reached at ${current.path}`)
      listing.set(current.path, kept)
      const typed = await probe.directories?.(root, current.path)
      const children = kept.filter(name => !skip(name) && (typed === undefined || typed.includes(name)))
      if (current.depth >= limits.depth) {
        if (children.length) warn(`depth limit reached at ${current.path}`)
      } else for (const name of children) queue.push({ path: current.path === '.' ? name : `${current.path}/${name}`, depth: current.depth + 1 })
    } catch (error) { warn(`cannot list ${current.path}: ${String(error)}`) }
  }
  const root_entries = (listing.get('.') ?? []).filter(entry => !skip(entry))
  const modules: ProjectInventory['modules'] = []
  for (const [path, entries] of listing) {
    if (path !== '.' && entries.length && (!path.includes('/') || entries.some(name => MANIFESTS.includes(name)))) modules.push({ path, entries })
  }
  const manifestPaths = probe.list ? [...listing].flatMap(([path, entries]) => MANIFESTS.filter(name => entries.includes(name))
    .map(name => path === '.' ? name : `${path}/${name}`)).sort() : MANIFESTS
  const manifests: ProjectInventory['manifests'] = []
  let hasJava = false
  let hasFrontend = false
  for (const path of manifestPaths) {
    let raw: string | undefined
    try { raw = await probe.read(root, path) } catch (error) { warn(`cannot read manifest ${path}: ${String(error)}`); continue }
    if (raw === undefined && probe.list) warn(`listed manifest is unreadable: ${path}`)
    if (raw === undefined) continue
    const facts: string[] = []
    if (/pom\.xml$/u.test(path)) {
      hasJava = true
      for (const tag of ['java.version', 'maven.compiler.source', 'spring-boot.version']) {
        const version = xmlVersion(raw, tag)
        if (version) facts.push(`${tag}=${version}`)
      }
      const parent = /<parent>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<version>([^<]+)<\/version>[\s\S]*?<\/parent>/u.exec(raw)
      if (parent) facts.push(`parent=${parent[1]}@${parent[2]}`)
    } else if (/build\.gradle(?:\.kts)?$/u.test(path)) {
      hasJava = true
      for (const match of raw.matchAll(/(?:JavaVersion\.VERSION_|sourceCompatibility\s*=\s*['"]?)([\w.]+)/gu)) facts.push(`java=${match[1]}`)
    } else if (/package\.json$/u.test(path)) {
      try {
        const value = JSON.parse(raw) as { name?: string; engines?: { node?: string }; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
        if (value.name) facts.push(`package=${value.name}`)
        if (value.engines?.node) facts.push(`node=${value.engines.node}`)
        const deps = { ...value.dependencies, ...value.devDependencies }
        for (const key of ['vue', 'react', 'vite', 'typescript', 'angular', 'next']) {
          if (deps[key]) { facts.push(`${key}=${deps[key]}`); hasFrontend = true }
        }
      } catch { facts.push('package.json JSON could not be parsed') }
    } else if (/go\.mod$/u.test(path)) {
      const version = /^go\s+(.+)$/mu.exec(raw)?.[1]
      if (version) facts.push(`go=${version}`)
    } else if (/pyproject\.toml$/u.test(path)) {
      const version = /requires-python\s*=\s*["']([^"']+)/u.exec(raw)?.[1]
      if (version) facts.push(`python=${version}`)
    } else if (/Cargo\.toml$/u.test(path)) {
      const version = /^rust-version\s*=\s*["']([^"']+)/mu.exec(raw)?.[1]
      if (version) facts.push(`rust=${version}`)
    }
    manifests.push({ path, facts })
  }
  const suggestions: ProjectInventory['suggestions'] = [
    { name: `${project_name}-project-map`, kind: 'skill', meta_skills: ['requirements-analysis', 'architecture-design', 'task-orchestration', 'code-development'], why: '可选的项目知识：覆盖整个仓库的模块职责、依赖与通用入口；不能写成当前需求的总结。' },
    { name: `${project_name}-tech-stack`, kind: 'skill', meta_skills: ['architecture-design', 'code-development', 'test-validation'], why: '按构建清单记录可证实的技术版本、构建与测试约束；证据不足可不生成。' },
    { name: `${project_name}-business-capabilities`, kind: 'skill', meta_skills: ['requirements-analysis', 'architecture-design'], why: '可选业务能力图；仅在页面、接口、测试或文档足以证明业务功能时生成，并标注证据路径。' },
  ]
  if (hasJava) {
    suggestions.push({ name: `${project_name}-code-backend`, kind: 'skill', meta_skills: ['code-development'], why: '检测到 Java 构建清单；只有代表性源码证明项目特有的目录、接口或实现约定时才生成，不重复通用开发方法。' })
  }
  if (hasFrontend) {
    suggestions.push({ name: `${project_name}-code-frontend`, kind: 'skill', meta_skills: ['code-development'], why: '检测到前端依赖；只有组件、路由或构建脚本证明项目特有实现方式时才生成，不重复通用开发方法。' })
  }
  return { project_name, root_entries, modules, manifests, suggestions, discovery,
    caution: 'This inventory identifies evidence, not coding rules. The project-map and optional business-capabilities Skill are reusable repository-wide context even when init_project is called during a feature task; keep that task\'s design and call-chain findings in task artifacts. Separate confirmed code facts, plausible inference and product questions. Review representative source, tests and existing governance files before proposing Rule content; legacy violations are not standards.' }
}
