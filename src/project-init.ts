/** Evidence-led repository inventory for project Skill/Rule initialization. */
import type { FileProbe } from './project.ts'

export interface ProjectInventory {
  project_name: string
  root_entries: string[]
  modules: { path: string; entries: string[] }[]
  manifests: { path: string; facts: string[] }[]
  suggestions: { name: string; kind: 'skill' | 'rule'; meta_skills: string[]; why: string }[]
  caution: string
}

const MANIFESTS = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'package.json', 'go.mod', 'pyproject.toml', 'Cargo.toml']

function slug(root: string): string {
  const name = root.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) ?? 'project'
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
    { name: `${project_name}-project-map`, kind: 'skill', meta_skills: ['requirements-analysis', 'code-development'], why: 'Root structure and module entry points help both impact analysis and implementation.' },
    { name: `${project_name}-tech-stack`, kind: 'skill', meta_skills: ['requirements-analysis', 'code-development', 'test-validation'], why: 'Manifest versions and build constraints are reusable project facts.' },
  ]
  if (hasJava) suggestions.push({ name: `${project_name}-code-backend`, kind: 'skill', meta_skills: ['code-development'], why: 'Java build manifest found; inspect representative backend code before writing conventions.' })
  if (hasFrontend) suggestions.push({ name: `${project_name}-code-frontend`, kind: 'skill', meta_skills: ['code-development'], why: 'Frontend dependency found; inspect components and build scripts before writing conventions.' })
  return { project_name, root_entries, modules, manifests, suggestions,
    caution: 'This inventory identifies evidence, not coding rules. Review representative source, tests and existing governance files before proposing Rule content; legacy violations are not standards.' }
}
