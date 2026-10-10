/** Evidence-led repository inventory for project Skill/Rule initialization. */
import type { FileProbe } from './project.ts'
import { META_STAGES, type MetaSkill } from './adaptive.ts'

export interface InitResource {
  kind: 'skill' | 'rule'
  name: string
  description?: string
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
      if (!Array.isArray(resource.meta_skills) || resource.meta_skills.length === 0 ||
        !resource.meta_skills.every(meta => typeof meta === 'string' && meta in META_STAGES)) throw new Error(`Skill ${resource.name} needs valid meta_skills`)
      if (resource.rules !== undefined && (!Array.isArray(resource.rules) || !resource.rules.every(rule => typeof rule === 'string' && RESOURCE_NAME.test(rule)))) {
        throw new Error(`Skill ${resource.name} has invalid rule names`)
      }
    }
  }
  return resources
}

export interface ProjectInventory {
  project_name: string
  root_entries: string[]
  modules: { path: string; entries: string[] }[]
  manifests: { path: string; facts: string[] }[]
  suggestions: { name: string; kind: 'skill' | 'rule'; meta_skills: string[]; why: string }[]
  caution: string
}

export interface ProjectInitStep {
  name: string
  kind: 'skill' | 'rule'
  meta_skills: string[]
  why: string
  required: boolean
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

/** Reject a feature-only map that omits independently discovered project modules. */
export function projectMapCoverageGaps(content: string, inventory: ProjectInventory): string[] {
  const normalized = content.replace(/\\/gu, '/').toLowerCase()
  return projectMapCoveragePaths(inventory).filter(path => !normalized.includes(path.toLowerCase()))
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

/** Read only conventional manifests and first-level structure; source code stays for model review. */
export async function scanProject(probe: FileProbe, root: string): Promise<ProjectInventory> {
  const project_name = slug(root)
  const root_entries = (await probe.list?.(root, '.') ?? [])
    .filter(entry => !['.git', 'node_modules', 'target', 'dist', 'build', '.dsh'].includes(entry)).sort().slice(0, 100)
  const modules: ProjectInventory['modules'] = []
  for (const name of root_entries.filter(entry => !entry.startsWith('.')).slice(0, 60)) {
    const entries = await probe.list?.(root, name) ?? []
    if (entries.length > 0) modules.push({ path: name, entries: entries.sort().slice(0, 50) })
  }
  const manifestPaths = [...MANIFESTS,
    ...modules.filter(module => module.entries.some(entry => MANIFESTS.includes(entry)))
      .flatMap(module => MANIFESTS.filter(name => module.entries.includes(name)).map(name => `${module.path}/${name}`))]
  const manifests: ProjectInventory['manifests'] = []
  let hasJava = false
  let hasFrontend = false
  for (const path of manifestPaths) {
    const raw = await probe.read(root, path)
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
  return { project_name, root_entries, modules, manifests, suggestions,
    caution: 'This inventory identifies evidence, not coding rules. The project-map and optional business-capabilities Skill are reusable repository-wide context even when init_project is called during a feature task; keep that task\'s design and call-chain findings in task artifacts. Separate confirmed code facts, plausible inference and product questions. Review representative source, tests and existing governance files before proposing Rule content; legacy violations are not standards.' }
}
