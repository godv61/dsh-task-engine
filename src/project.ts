/**
 * Project adaptation knowledge shared by the tool plane, the workbench, and
 * the commit hook: language detection, root discovery, default verification
 * commands, governance-file names, and the risk policy.
 *
 * Everything here is a pure function over a narrow {@link FileProbe}, so it
 * unit-tests without a harness and the commit hook can reuse the same tables.
 *
 * @module dsh-task-engine/project
 */

import { dirname } from 'node:path'

/**
 * Read one file relative to a directory. `undefined` means missing or unreadable;
 * every caller implements this against its own filesystem (sandboxed `Fs` in the
 * tool plane, `node:fs` in the commit hook).
 */
export interface FileProbe {
  read(dir: string, relPath: string): Promise<string | undefined>
  /** Basenames of a directory's children; implementations without listing return `[]`. */
  list?(dir: string, relPath: string): Promise<string[]>
}

export type ProjectType = 'node' | 'java' | 'python' | 'go' | 'rust' | 'unknown'

/** Marker files that identify a language stack, checked in declaration order. */
const TYPE_MARKERS: Record<Exclude<ProjectType, 'unknown'>, readonly string[]> = {
  node: ['package.json'],
  java: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
  python: ['pyproject.toml', 'requirements.txt', 'setup.py'],
  go: ['go.mod'],
  rust: ['Cargo.toml'],
}

/** Default verification command per language; a project can override via `.dsh/eng.json`. */
export const DEFAULT_VERIFY_COMMANDS: Record<Exclude<ProjectType, 'unknown'>, string> = {
  node: 'npm test',
  java: 'mvn -q test',
  python: 'python -m pytest',
  go: 'go test ./...',
  rust: 'cargo test',
}

/**
 * Governance files that steer AI behavior in this workspace. `init` must not
 * overwrite any of them without an explicit, approved overwrite — they are
 * siblings of `AGENTS.md`, not alternatives it may ignore.
 */
export const GOVERNANCE_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md', '.cursorrules']

/** Directory names inside a project that hold project-level skills / rules. */
export const PROJECT_SKILL_DIR = '.dsh/skills'
export const PROJECT_RULE_DIR = '.dsh/rules'

/**
 * Risk policy: paths whose change is sensitive, and git operations that are
 * inherently risky regardless of path. The commit hook surfaces these; a task
 * touching them should be verified with a real command receipt.
 */
export interface RiskPolicy {
  /** Exact relative paths or directory prefixes whose change is sensitive. */
  sensitive_paths: readonly string[]
  /** Git `--name-status` operation letters treated as risky (delete / type change). */
  risky_operations: readonly string[]
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  sensitive_paths: ['.git', '.dsh', '.env', '.credentials.yaml', 'credentials', 'secrets'],
  risky_operations: ['D', 'T'],
}

/** All marker files across languages, for root discovery. */
const ALL_MARKERS: readonly string[] = Object.values(TYPE_MARKERS).flat()

/** Git repository markers: a real `.git` directory or a worktree's `.git` file. */
const GIT_MARKERS: readonly string[] = ['.git/HEAD', '.git']

/** How many directory levels to climb while hunting for a project root. */
const MAX_ROOT_CLIMB = 8

/** All languages detected in `dir` by marker files, in marker declaration order. */
export async function detectLanguages(probe: FileProbe, dir: string): Promise<ProjectType[]> {
  const found: ProjectType[] = []
  for (const type of Object.keys(TYPE_MARKERS) as (Exclude<ProjectType, 'unknown'>)[]) {
    for (const marker of TYPE_MARKERS[type]) {
      if (await probe.read(dir, marker) !== undefined) {
        found.push(type)
        break
      }
    }
  }
  return found
}

/** The single dominant language of `dir`; a mixed tree reports `unknown`. */
export async function detectType(probe: FileProbe, dir: string): Promise<ProjectType> {
  const languages = await detectLanguages(probe, dir)
  return languages.length === 1 ? languages[0]! : 'unknown'
}

/** Default verification command for a language; `unknown` has none. */
export function defaultVerifyCommand(type: ProjectType): string | undefined {
  return type === 'unknown' ? undefined : DEFAULT_VERIFY_COMMANDS[type]
}

/**
 * Discover the project root from `startDir` by climbing toward the filesystem
 * root: the first directory containing a git repository, a `.dsh/eng.json`
 * marker, or any language marker file wins. Falls back to `startDir` when
 * nothing is found, so a plain directory still behaves as its own project.
 */
export async function detectRoot(probe: FileProbe, startDir: string): Promise<string> {
  let current = startDir
  for (let level = 0; level <= MAX_ROOT_CLIMB; level++) {
    if (await probe.read(current, '.dsh/eng.json') !== undefined) return current
    for (const marker of GIT_MARKERS) {
      if (await probe.read(current, marker) !== undefined) return current
    }
    for (const marker of ALL_MARKERS) {
      if (await probe.read(current, marker) !== undefined) return current
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return startDir
}

/**
 * Governance files actually present in `dir`; `init` uses this to refuse silent
 * overwrites of anything steering other agents (AGENTS.md, CLAUDE.md, …).
 */
export async function presentGovernanceFiles(probe: FileProbe, dir: string): Promise<string[]> {
  const present: string[] = []
  for (const file of GOVERNANCE_FILES) {
    if (await probe.read(dir, file) !== undefined) present.push(file)
  }
  return present
}

/** Project-level rule names from `.dsh/rules/*.md` (stem names, sorted). */
export async function listProjectRules(probe: FileProbe, dir: string): Promise<string[]> {
  const entries = await probe.list?.(dir, PROJECT_RULE_DIR) ?? []
  return entries
    .filter(name => name.endsWith('.md'))
    .map(name => name.slice(0, -'.md'.length))
    .sort()
}

/** Project-level skill names from `.dsh/skills/<name>/SKILL.md` (sorted). */
export async function listProjectSkills(probe: FileProbe, dir: string): Promise<string[]> {
  const entries = await probe.list?.(dir, PROJECT_SKILL_DIR) ?? []
  const names: string[] = []
  for (const entry of entries) {
    if (await probe.read(dir, `${PROJECT_SKILL_DIR}/${entry}/SKILL.md`) !== undefined) names.push(entry)
  }
  return names.sort()
}