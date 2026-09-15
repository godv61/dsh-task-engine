/**
 * Browser-addressable Remote owner for the engineering workflow config. The
 * `task-engine` namespace lets the browser settings page read and write one
 * workspace's `.dsh/eng.json`, list the skill/rule catalogs (bundled + project +
 * user), and create project/user skills and rules. The host validates every
 * config write with the same engine that gates `dev_task` — an invalid config
 * is never persisted.
 *
 * @module dsh-task-engine/controller
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { authorizedWorkspace } from './workspace-access.ts'
import { prepareImport, commitImport } from './resource-import.ts'
import type { ResourceImportRequest, ResourcePreview } from './resource-types.ts'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: pulls the `Context.fs` augmentation into this module.
import type {} from '@deepseek-ai/dsh-fs'
import { validateWorkflow, type StageBinding, type TaskState, type WorkflowConfig } from './engine.ts'
import type { CustomFlow } from './custom-flow.ts'
import { hashText } from './snapshot.ts'
import { resolveFlow } from './workflows.ts'

/** Merged workflow plus its validation state, returned by both config methods. */
export interface EngConfigView {
  custom_flow?: CustomFlow
  revision?: string
  /** Whether `config` passes validation; `false` means `problems` names the defects. */
  ok: boolean
  /** Where the config came from: a preset default, a sound project file, or an invalid one. */
  source: 'default' | 'project' | 'invalid'
  /** Selected workflow id (empty when the file lacks a `flow` field). */
  flow: string
  /** The resolved workflow (preset plus the project's stage-binding override). */
  config: WorkflowConfig
  /** Human-readable defects; empty means valid. */
  problems: string[]
}

/** A `write` request: the workspace directory and the flow selection to persist. */
export interface EngWriteRequest {
  custom_flow?: CustomFlow
  expected_revision?: string
  /** Absolute workspace directory; `.dsh/eng.json` is written under it. */
  path: string
  /** Preset workflow id. */
  flow: string
  /** Optional whole `stage_bindings` map replacing the preset default. */
  stage_bindings?: Record<string, StageBinding>
}

/** One skill in the mountable catalog. */
export interface SkillCatalogEntry {
  name: string
  description: string
  source: string
}

/** One rule in the mountable catalog. */
export interface RuleCatalogEntry {
  name: string
  source: string
}

/** `listSkills` result: every model-invocable skill, bundled + project + user. */
export interface SkillCatalog {
  skills: SkillCatalogEntry[]
}

/** `listRules` result: every rule, bundled + project + user. */
export interface RuleCatalog {
  rules: RuleCatalogEntry[]
}

/** Create a project- or user-level skill. */
export interface WriteSkillRequest {
  name: string
  description: string
  whenToUse?: string
  content: string
  /** `project` writes under the workspace's `.dsh/skills`; `user` under `$DSH_HOME/skills`. */
  level: 'project' | 'user'
  /** Absolute workspace directory (required when level is `project`). */
  path?: string
}

/** Install an existing directory-bundle skill (SKILL.md + assets) into a level root. */
export interface InstallSkillRequest {
  /** Absolute source directory containing `SKILL.md` (plus optional references/scripts/assets). */
  sourceDir: string
  /** `project` installs under the workspace's `.dsh/skills`; `user` under `$DSH_HOME/skills`. */
  level: 'project' | 'user'
  /** Absolute workspace directory (required when level is `project`). */
  path?: string
}

/** One child directory entry shown by the install directory picker. */
export interface ListDirsEntry {
  name: string
  /** True when this directory carries a SKILL.md of its own. */
  hasSkill: boolean
}

/** `listDirs` request: the absolute path to list (empty = the host home directory). */
export interface ListDirsRequest {
  path: string
}

/** `listDirs` result: the subdirectories of one absolute path for the install picker. */
export interface ListDirsView {
  ok: boolean
  /** The absolute directory that was listed (normalized input). */
  path: string
  entries: ListDirsEntry[]
  /** Filesystem roots offered as jump targets (Windows drive letters, `/` on POSIX). */
  roots: string[]
  /** True when the listed directory itself carries a SKILL.md (installable as-is). */
  currentHasSkill: boolean
  error?: string
}

/** Create a project- or user-level rule. */
export interface WriteRuleRequest {
  name: string
  content: string
  /** `project` writes under the workspace's `.dsh/rules`; `user` under `$DSH_HOME/rules`. */
  level: 'project' | 'user'
  /** Absolute workspace directory (required when level is `project`). */
  path?: string
}

/** Result of creating one skill or rule. */
export interface WriteResourceResult {
  ok: boolean
  name: string
  /** Absolute path the file was written to. */
  path: string
  /** Human-readable error when `ok` is false. */
  error?: string
}

/** Read a project-, user-, or bundled-level skill for inline viewing/editing. */
export interface ReadSkillRequest {
  name: string
  /** `project` reads under the workspace's `.dsh/skills`; `user` under `$DSH_HOME/skills`; `bundled` the shipped catalog. */
  level: 'project' | 'user' | 'bundled'
  /** Absolute workspace directory (required when level is `project`). */
  path?: string
}

/** Full editable content of one skill: frontmatter fields plus the body. */
export interface ReadSkillResult {
  ok: boolean
  name: string
  description: string
  whenToUse: string
  /** Raw body below the frontmatter (the part the model reads). */
  content: string
  error?: string
}

/** Read a project-, user-, or bundled-level rule for inline viewing/editing. */
export interface ReadRuleRequest {
  name: string
  /** `project` reads under the workspace's `.dsh/rules`; `user` under `$DSH_HOME/rules`; `bundled` the shipped catalog. */
  level: 'project' | 'user' | 'bundled'
  /** Absolute workspace directory (required when level is `project`). */
  path?: string
}

/** Delete a project- or user-level skill. Bundled skills cannot be deleted. */
export interface DeleteSkillRequest {
  name: string
  /** `project` deletes under the workspace's `.dsh/skills`; `user` under `$DSH_HOME/skills`. */
  level: 'project' | 'user'
  /** Absolute workspace directory (required when level is `project`). */
  path?: string
}

/** Delete a project- or user-level rule. Bundled rules cannot be deleted. */
export interface DeleteRuleRequest {
  name: string
  /** `project` deletes under the workspace's `.dsh/rules`; `user` under `$DSH_HOME/rules`. */
  level: 'project' | 'user'
  /** Absolute workspace directory (required when level is `project`). */
  path?: string
}

/** Full editable content of one rule: the raw markdown body. */
export interface ReadRuleResult {
  ok: boolean
  name: string
  content: string
  error?: string
}

/** One implementation item's audit trail, projected for the task ledger view. */
export interface TaskLedgerItem {
  id: string
  title: string
  status: string
  /** Subagent dispatch audit; absent until the item has been dispatched. */
  dispatch?: { description: string; at: string }
  /** Two-stage review audit; absent until the item has been reviewed. */
  review?: {
    spec: { outcome: 'pass' | 'fail'; notes?: string[] }
    quality: { outcome: 'pass' | 'fail'; notes?: string[] }
  }
}

/** One task's ledger projection: identity, stage, and the per-item audit trail. */
export interface TaskLedgerEntry {
  flow_id?: string
  flow_version?: number
  risk_level?: string
  updated_at?: string
  verification_passed?: boolean
  review_outcome?: string
  task_id: string
  title: string
  stage: string
  branch: string
  items: TaskLedgerItem[]
}

/** `readTasks` result: every task record under the workspace's `.dsh/`. */
export interface TaskLedgerView {
  tasks: TaskLedgerEntry[]
}

/** `readInit` result: the workspace's root `AGENTS.md`, or absent. */
export interface InitView {
  /** Whether an AGENTS.md exists at the workspace root. */
  exists: boolean
  /** Full body when `exists`, otherwise empty string. */
  content: string
  /** Physical line count (0 when absent). */
  lines: number
  /** Absolute AGENTS.md location when it was resolved outside the workspace root (e.g. a single child project). */
  path?: string
}

/** Write the workspace's root `AGENTS.md` (init apply). */
export interface InitWriteRequest {
  /** Absolute workspace directory; `AGENTS.md` is written at its root. */
  path: string
  /** Full AGENTS.md body. */
  content: string
  /** Must be true to replace an existing AGENTS.md; the workbench sets it only after a user confirmation. */
  overwrite?: boolean
}

/** `generateInit` request: scan the workspace and prompt the model for a draft. */
export interface InitGenerateRequest {
  /** Absolute workspace directory to scan. */
  path: string
}

/** `generateInit` result: a model-drafted AGENTS.md body (not yet written). */
export interface InitDraft {
  ok: boolean
  content: string
  lines: number
  error?: string
}

/** `writeInit` result: write succeeded, or failed with the offending line count. */
export interface InitWriteResult {
  ok: boolean
  lines: number
  error?: string
}

/** The one file this controller reads and writes, relative to a workspace directory. */
const ENGFILE = '.dsh/eng.json'

/** The project description file read/written at the workspace root by `init`. */
const INITFILE = 'AGENTS.md'
/** Hard line cap the init draft must satisfy before it can be written. */
const INIT_MAX_LINES = 200
/** Hard timeout for the model-draft call; the UI reports elapsed time toward it. */
const INIT_GENERATE_TIMEOUT_MS = 150000
/** System prompt for drafting a project AGENTS.md from a scanned snapshot. */
const INIT_SYSTEM_PROMPT =
  '你是一名工程交付助理。根据下面提供的项目快照，为该项目写一份项目级 AGENTS.md（Markdown）。'
  + '要求：用中文，只写骨架，不超过 200 行：项目是什么 → 怎么跑/构建 → 目录结构 → 开发约定 → 红线与坑。'
  + '不要客套的开头和结尾，不要复述项目快照里无关的细节，直接输出 Markdown 正文。'
  + '整个回答就是 AGENTS.md 的内容，不要用代码块包裹，不要附加任何说明。'
/** Files worth quoting into the scan snapshot (each truncated). */
const SCAN_KEY_FILES = ['README.md', 'package.json', 'tsconfig.json', 'tsconfig.client.json', 'pnpm-workspace.yaml', 'pyproject.toml', 'Cargo.toml', 'go.mod', '.dsh/eng.json']

/** Bundled skill directory, scanned as a fallback list when no skill registry exists. */
const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))
/** Bundled rule directory. */
const BUNDLED_RULES_DIR = fileURLToPath(new URL('../rules/', import.meta.url))

/** Resolve the harness home directory. */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Normalize a resource name into a safe kebab-case identifier. */
function sanitizeName(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^0-9a-z-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned
}

/** The standard preset's config; the built-in id always resolves. */
function standardConfig(): WorkflowConfig {
  const standard = resolveFlow('standard')
  if (!standard.ok) throw new Error('built-in "standard" preset is missing')
  return standard.config
}

/** Whether a bundled (core) skill already owns a name. */
function bundledSkillExists(name: string): boolean {
  return existsSync(join(BUNDLED_SKILLS_DIR, name, 'SKILL.md'))
}

/** Whether a bundled (core) rule already owns a name. */
function bundledRuleExists(name: string): boolean {
  return existsSync(join(BUNDLED_RULES_DIR, `${name}.md`))
}

/** Frontmatter-wrapped SKILL.md body. */
function renderSkillFile(name: string, description: string, whenToUse: string | undefined, content: string): string {
  const head = [`name: ${name}`, `description: ${description}`]
  if (whenToUse !== undefined && whenToUse.trim() !== '') head.push(`whenToUse: ${whenToUse.trim()}`)
  return `---\n${head.join('\n')}\n---\n\n${content.trimEnd()}\n`
}

/** Dirs hidden from the install directory picker (plain dependency/ignore caches). */
const SKILL_DIR_FILTER = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv'])

/** Filesystem roots the picker offers as jump targets (drive letters on Windows, `/` elsewhere). */
function filesystemRoots(): string[] {
  if (process.platform !== 'win32') return ['/']
  const roots: string[] = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (existsSync(`${letter}:\\`)) roots.push(`${letter}:\\`)
  }
  return roots
}
/** Scan a markdown directory, returning `{ name }` per `.md` file. */
function scanRuleDir(dir: string, source: string): RuleCatalogEntry[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter(name => name.endsWith('.md'))
    .map(name => ({ name: name.slice(0, -'.md'.length), source }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Parse the `name`+`description` frontmatter of one SKILL.md without invoking the registry. */
function parseSkillFrontmatter(raw: string): { name: string; description: string } | undefined {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) return undefined
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  if (!meta.name || !meta.description) return undefined
  return { name: meta.name, description: meta.description }
}

/** Full parse of one SKILL.md: frontmatter fields plus the body below it. */
function parseSkillFile(raw: string): { name: string; description: string; whenToUse: string; content: string } | undefined {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) return undefined
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  if (!meta.name || !meta.description) return undefined
  return {
    name: meta.name,
    description: meta.description,
    whenToUse: meta.whenToUse ?? '',
    content: raw.slice(m[0].length).trimEnd(),
  }
}

/** List skill frontmatter from one skills directory (directory-bundle SKILL.md entries). */
function listSkillsFromDir(dir: string, source: string): SkillCatalogEntry[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const result: SkillCatalogEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const raw = readFileSync(join(dir, entry.name, 'SKILL.md'), 'utf8')
      const parsed = parseSkillFrontmatter(raw)
      if (parsed !== undefined) result.push({ name: parsed.name, description: parsed.description, source })
    } catch {
      /* skip unreadable entry */
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Host owner of the `task-engine` Remote namespace. Discovered by the Typert
 * Gateway through source-mode reflection (the `typertRemote` binding on the
 * Cordis service), so mounting this class is the whole registration.
 */
export default class TaskEngineController extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'taskEngineController', { namespace: 'task-engine' })
  }

  private async authorizedPath(path: string): Promise<string> {
    return authorizedWorkspace(this.ctx as unknown as { get(name: string): unknown }, path, checkedPath)
  }

  /** Absolute installation roots for a selected workspace. */
  @Remote
  async resourceRoots(request: { kind: 'skill' | 'rule'; path: string }): Promise<{ project: string; user: string }> {
    if (!request.path.trim()) throw new Error('请选择工作区')
    const workspace = await this.authorizedPath(request.path)
    return { project: join(workspace, '.dsh', request.kind + 's'), user: join(dshHome(), request.kind + 's') }
  }

  /** Inspect uploaded bytes or a host directory without writing. */
  @Remote
  async previewResource(request: ResourceImportRequest): Promise<ResourcePreview> {
    return this.resourceImport(request, false)
  }

  /** Install exactly the reviewed bytes and target, without overwriting. */
  @Remote
  async importResource(request: ResourceImportRequest): Promise<ResourcePreview> {
    return this.resourceImport(request, true)
  }

  private async resourceImport(request: ResourceImportRequest, commit: boolean): Promise<ResourcePreview> {
    try {
      const roots = await this.resourceRoots(request)
      const base = roots[request.level]
      const bundled = request.kind === 'skill' ? bundledSkillExists : bundledRuleExists
      return commit ? commitImport(request, base, bundled) : prepareImport(request, base, bundled).preview
    } catch (error) {
      return { ok: false, name: '', description: '', content: '', target: '', files: 0, bytes: 0, hash: '', conflict: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Resolve one workspace's effective workflow: a preset flow plus the project's
   * stage-binding override.
   * @param path - absolute workspace directory path.
   * @returns the preset, project, or invalid selection plus its validation problems.
   */
  @Remote
  async read(path: string): Promise<EngConfigView> {
    path = await this.authorizedPath(path)
    const fs = this.fs()
    const raw = await readEngText(fs, path)
    if (raw === undefined) {
      return { ok: true, source: 'default', flow: 'standard', config: standardConfig(), problems: [], revision: hashText('') }
    }
    let parsed: { flow?: string; stage_bindings?: Record<string, StageBinding>; custom_flow?: unknown }
    try {
      parsed = JSON.parse(raw) as { flow?: string; stage_bindings?: Record<string, StageBinding>; custom_flow?: unknown }
    } catch (error) {
      return {
        ok: false,
        source: 'invalid',
        flow: 'standard',
        config: standardConfig(),
        problems: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
      }
    }
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.flow !== 'string' || parsed.flow.trim() === '') {
      return {
        ok: false,
        source: 'invalid',
        flow: '',
        config: standardConfig(),
        problems: ['eng.json exists but is missing a "flow" field — set it to standard|agile|minimal, or delete the file'],
      }
    }
    const resolved = resolveFlow(
      parsed.flow,
      parsed,
    )
    if (!resolved.ok) {
      return {
        ok: false,
        source: 'invalid',
        flow: resolved.flow,
        config: standardConfig(),
        problems: resolved.problems ?? [`unknown flow "${resolved.flow}" (known: ${resolved.knownFlows.join(', ')})`],
      }
    }
    const problems = validateWorkflow(resolved.config)
    return {
      ok: problems.length === 0,
      source: problems.length === 0 ? 'project' : 'invalid',
      flow: resolved.preset.id,
      config: resolved.config,
      revision: hashText(raw),
      ...(resolved.preset.id.startsWith('custom:') ? { custom_flow: { schema: 1 as const, id: resolved.preset.id, label: resolved.preset.label, version: resolved.preset.version, config: resolved.config } } : {}),
      problems,
    }
  }

  /**
   * Validate and persist one workspace's flow selection.
   * @param request - workspace directory, preset flow id, and binding override.
   * @returns the saved selection, or the resolved config with `ok: false` and
   * `problems` filled when validation fails (nothing is written then).
   */
  @Remote
  async write(request: EngWriteRequest): Promise<EngConfigView> {
    request.path = await this.authorizedPath(request.path)
    const resolved = resolveFlow(
      request.flow,
      request,
    )
    if (!resolved.ok) {
      return {
        ok: false,
        source: 'invalid',
        flow: resolved.flow,
        config: standardConfig(),
        problems: resolved.problems ?? [`unknown flow "${resolved.flow}" (known: ${resolved.knownFlows.join(', ')})`],
      }
    }
    const problems = validateWorkflow(resolved.config)
    if (problems.length > 0) {
      return { ok: false, source: 'invalid', flow: request.flow, config: resolved.config, problems }
    }
    if (request.flow.startsWith('custom:')) {
      const [skills, rules] = await Promise.all([this.listSkills(request.path), this.listRules(request.path)])
      for (const [stage, binding] of Object.entries(resolved.config.stage_bindings ?? {})) {
        for (const name of binding.skills ?? []) if (!skills.skills.some(s => s.name === name)) problems.push(`${stage}：技能 ${name} 不存在，请先安装或移除绑定`)
        for (const name of binding.rules ?? []) if (!rules.rules.some(r => r.name === name)) problems.push(`${stage}：规则 ${name} 不存在，请先安装或移除绑定`)
      }
      if (problems.length) return { ok: false, source: 'invalid', flow: request.flow, config: resolved.config, problems }
    }
    const fs = this.fs()
    const observed = await fs.lstat(ENGFILE, { cwd: request.path })
    const raw = await readEngText(fs, request.path)
    if (request.expected_revision !== undefined && request.expected_revision !== hashText(raw ?? '')) {
      return { ok: false, source: 'invalid', flow: request.flow, config: resolved.config, problems: ['项目配置已被修改，请重新读取后再保存'] }
    }
    let previous: Record<string, unknown> = {}
    if (raw !== undefined) {
      try { previous = JSON.parse(raw) as Record<string, unknown> } catch {
        return { ok: false, source: 'invalid', flow: request.flow, config: resolved.config, problems: ['原配置不是有效 JSON，请先修复文件，避免丢失项目设置'] }
      }
      if (previous === null || typeof previous !== 'object' || Array.isArray(previous)) return { ok: false, source: 'invalid', flow: request.flow, config: resolved.config, problems: ['原配置必须是 JSON 对象'] }
    }
    const payload: Record<string, unknown> = { ...previous, flow: request.flow }
    delete payload.custom_flow
    delete payload.stage_bindings
    if (request.flow.startsWith('custom:')) {
      const prior = previous.custom_flow as CustomFlow | undefined
      const version = prior?.id === request.flow && Number.isSafeInteger(prior.version)
        ? prior.version + (JSON.stringify(prior.config) === JSON.stringify(resolved.config) && prior.label === resolved.preset.label ? 0 : 1) : 1
      payload.custom_flow = { schema: 1, id: request.flow, label: resolved.preset.label, version, config: resolved.config }
    } else if (request.stage_bindings !== undefined) payload.stage_bindings = request.stage_bindings
    const target = await fs.resolve(ENGFILE, { cwd: request.path })
    await fs.writeText(target, JSON.stringify(payload, null, 2), observed === undefined
      ? { kind: 'createIfAbsent' }
      : { kind: 'replaceIfVersion', version: observed.version }, undefined, {
      mode: 'workspace-write',
      workspaceRoot: request.path,
    })
    return { ok: true, source: 'project', flow: request.flow, config: resolved.config, problems: [], revision: hashText(JSON.stringify(payload, null, 2)), ...(payload.custom_flow ? { custom_flow: payload.custom_flow as CustomFlow } : {}) }
  }

  /**
   * List every skill available for stage binding by scanning the same three
   * layers as {@link listRules}: bundled, project (`.dsh/skills`), and user
   * (`$DSH_HOME/skills`). Reading the directories directly keeps the catalog
   * aligned with where {@link writeSkill} writes, independently of the host
   * skill registry's scan roots.
   * @param path - absolute workspace directory for the project level.
   * @returns the mountable skill catalog.
   */
  @Remote
  async listSkills(path: string): Promise<SkillCatalog> {
    path = await this.authorizedPath(path)
    const project = path === '' ? [] : listSkillsFromDir(join(path, '.dsh/skills'), 'project')
    const user = listSkillsFromDir(join(dshHome(), 'skills'), 'user')
    const bundled = listSkillsFromDir(BUNDLED_SKILLS_DIR, 'bundled')
    // Bundled (core) entries win over user and project entries of the same name,
    // so a project cannot shadow a shipped skill; local additions use distinct names.
    const merged = new Map<string, SkillCatalogEntry>()
    for (const entry of [...project, ...user, ...bundled]) merged.set(entry.name, entry)
    const skills = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
    return { skills }
  }

  /**
   * List every rule available for stage binding: bundled, project (`.dsh/rules`),
   * and user (`$DSH_HOME/rules`).
   * @param path - absolute workspace directory for the project level.
   * @returns the mountable rule catalog.
   */
  @Remote
  async listRules(path: string): Promise<RuleCatalog> {
    path = await this.authorizedPath(path)
    const project = path === '' ? [] : scanRuleDir(join(path, '.dsh/rules'), 'project')
    const user = scanRuleDir(join(dshHome(), 'rules'), 'user')
    const bundled = scanRuleDir(BUNDLED_RULES_DIR, 'bundled')
    // Bundled (core) rules win over user and project rules of the same name, so a
    // project cannot shadow a shipped rule like `security-redlines`; local additions
    // use distinct names.
    const merged = new Map<string, string>()
    for (const entry of [...project, ...user, ...bundled]) merged.set(entry.name, entry.source)
    const rules = [...merged.entries()]
      .map(([name, source]) => ({ name, source }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { rules }
  }

  /**
   * Read every task record under one workspace's `.dsh/` into a ledger view:
   * task identity and stage plus each item's subagent dispatch and two-stage
   * review audit. This is the read-only mirror of what the `dev_task` tool
   * writes; it never mutates the records.
   * @param path - absolute workspace directory path.
   * @returns the ledger entries, empty when no task records exist.
   */
  @Remote
  async readTasks(path: string): Promise<TaskLedgerView> {
    path = await this.authorizedPath(path)
    const fs = this.fs()
    const tasks: TaskLedgerEntry[] = []
    try {
      const dshDir = await fs.resolve('.dsh', { cwd: path })
      const entries = await fs.listDir(dshDir)
      for (const entry of entries) {
        if (!entry.name.startsWith('task-') || !entry.name.endsWith('.json')) continue
        const raw = await fs.readText(await fs.resolve(`.dsh/${entry.name}`, { cwd: path }))
        if (raw === undefined) continue
        let state: TaskState
        try {
          state = JSON.parse(raw) as TaskState
        } catch {
          throw new Error('任务记录无法解析：' + entry.name)
        }
        if (!state || ['id', 'title', 'stage', 'branch'].some(key => typeof (state as unknown as Record<string, unknown>)[key] !== 'string') || (state.items !== undefined && !Array.isArray(state.items))) throw new Error('任务记录格式无效：' + entry.name)
        tasks.push({
          ...(state.risk_level ? { risk_level: state.risk_level } : {}),
          ...(state.updated_at ? { updated_at: state.updated_at } : {}),
          verification_passed: state.verification?.passed ?? false,
          review_outcome: state.review?.outcome ?? 'pending',
          ...(state.flow ? { flow_id: state.flow.flow, flow_version: state.flow.version } : {}),
          task_id: state.id,
          title: state.title,
          stage: state.stage,
          branch: state.branch,
          items: (state.items ?? []).map(item => ({
            id: item.id,
            title: item.title,
            status: item.status,
            ...(item.dispatch === undefined ? {} : { dispatch: item.dispatch }),
            ...(item.review === undefined ? {} : { review: item.review }),
          })),
        })
      }
    } catch (error) {
      // Only an absent directory is an empty ledger; denied access and corruption remain visible.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    return { tasks }
  }

  /**
   * Read the workspace's root `AGENTS.md` for the project-initialization tab.
   * @param path - absolute workspace directory.
   * @returns existence, body, and line count.
   */
  @Remote
  async readInit(path: string): Promise<InitView> {
    path = await this.authorizedPath(path)
    const { root } = locateInitRoot(path)
    const raw = await readTextAt(this.fs(), root, INITFILE)
    if (raw === undefined) return { exists: false, content: '', lines: 0 }
    return {
      exists: true,
      content: raw,
      lines: lineCount(raw),
      ...(root === path ? {} : { path: join(root, INITFILE) }),
    }
  }

  /**
   * Write the workspace's root `AGENTS.md` (init apply).
   * @param request - workspace directory and full body.
   * @returns `ok: false` with `lines` over the cap when the body is too long.
   */
  @Remote
  async writeInit(request: InitWriteRequest): Promise<InitWriteResult> {
    request.path = await this.authorizedPath(request.path)
    const lines = lineCount(request.content)
    if (lines > INIT_MAX_LINES) {
      return { ok: false, lines, error: `AGENTS.md 为 ${lines} 行，超过上限 ${INIT_MAX_LINES} 行；请精简到项目骨架后重试。` }
    }
    const { root } = locateInitRoot(request.path)
    const fs = this.fs()
    const existing = await readTextAt(fs, root, INITFILE)
    // Aligns workbench writes with `dev_task init apply`: an existing governance
    // file is protected unless the caller explicitly opts in to overwrite (the
    // workbench sets `overwrite: true` only after a user confirmation).
    if (existing !== undefined && request.overwrite !== true) {
      return {
        ok: false,
        lines,
        error: 'AGENTS.md 已存在且受保护；若确要覆盖，请在该工作台确认覆盖后重试（overwrite: true）。',
      }
    }
    const target = await fs.resolve(INITFILE, { cwd: root })
    await fs.writeText(target, request.content, undefined, undefined, {
      mode: 'workspace-write',
      workspaceRoot: request.path,
    })
    return { ok: true, lines }
  }

  /**
   * Scan the workspace and prompt the default model for an AGENTS.md draft. The
   * result is a preview only — nothing is written until {@link writeInit}.
   * @param request - absolute workspace directory.
   * @returns the drafted body, or `ok: false` with an error when generation fails.
   */
  @Remote
  async generateInit(request: InitGenerateRequest): Promise<InitDraft> {
    request.path = await this.authorizedPath(request.path)
    const { root } = locateInitRoot(request.path)
    const snapshot = scanProject(root)
    const llm = this.ctx.get('llm')
    if (llm === undefined) {
      return { ok: false, content: '', lines: 0, error: 'task-engine: llm service is absent from the host composition' }
    }
    const defaultModel = this.ctx.get('agentDefaultModel')
    if (defaultModel === undefined) {
      return { ok: false, content: '', lines: 0, error: 'task-engine: agent 默认模型未配置，请先在「模型」页选择一个模型' }
    }
    const selection = defaultModel.currentSelection()
    const options: GenerateOptions = {
      provider: selection.provider,
      model: selection.model,
      system: INIT_SYSTEM_PROMPT,
      messages: [createUserMessage({
        content: [{ type: 'text', text: `请为项目 ${root} 生成 AGENTS.md。\n\n${snapshot}` }],
        source: { kind: 'user' },
      })],
      temperature: 0.2,
      signal: AbortSignal.timeout(INIT_GENERATE_TIMEOUT_MS),
    }
    let text = ''
    try {
      const stream = llm.stream(options)
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          throw new Error(chunk.reason.failure.message)
        }
      }
    } catch (error) {
      if (options.signal?.aborted === true) {
        return { ok: false, content: '', lines: 0, error: `生成超时（超过 ${Math.round(INIT_GENERATE_TIMEOUT_MS / 1000)} 秒），请稍后重试。` }
      }
      return { ok: false, content: '', lines: 0, error: error instanceof Error ? error.message : String(error) }
    }
    const content = stripMarkdownFence(text)
    const lines = lineCount(content)
    return { ok: content.trim() !== '', content, lines }
  }

  /**
   * Create a project- or user-level skill by writing its SKILL.md.
   * @param request - name, description, whenToUse, body, and target level.
   * @returns the written resource path, or `ok: false` with an error.
   */
  @Remote
  async writeSkill(request: WriteSkillRequest): Promise<WriteResourceResult> {
    if (request.path !== undefined) request.path = await this.authorizedPath(request.path)
    const name = sanitizeName(request.name)
    if (name === '' || request.description.trim() === '') {
      return { ok: false, name, path: '', error: 'skill name and description must not be empty' }
    }
    if (bundledSkillExists(name)) {
      return { ok: false, name, path: '', error: `"${name}" is a bundled skill and cannot be overridden; choose a distinct name` }
    }
    const base = request.level === 'project'
      ? join(request.path ?? '', '.dsh/skills')
      : join(dshHome(), 'skills')
    const file = join(base, name, 'SKILL.md')
    return writeResourceFile(file, renderSkillFile(name, request.description, request.whenToUse, request.content), name)
  }

  /**
   * Install an existing directory-bundle skill (SKILL.md plus its references,
   * scripts, and assets) into the project or user skill root. The source is
   * validated as a skill before anything is copied; the target refuses to
   * shadow a bundled skill or overwrite an existing install.
   * @param request - source directory, target level, and workspace for `project`.
   * @returns the installed path, or `ok: false` with an error.
   */
  @Remote
  async installSkill(request: InstallSkillRequest): Promise<WriteResourceResult> {
    const input: ResourceImportRequest = { kind: 'skill', level: request.level, path: request.path ?? process.cwd(), files: [], sourceDir: request.sourceDir }
    const preview = await this.previewResource(input)
    if (!preview.ok) return { ok: false, name: preview.name, path: preview.target, error: preview.error ?? '安装校验失败' }
    const result = await this.importResource({ ...input, expectedHash: preview.hash })
    return result.ok ? { ok: true, name: result.name, path: result.target } : { ok: false, name: result.name, path: result.target, error: result.error ?? '安装失败' }
  }

  /**
   * List the direct subdirectories of an absolute path for the install
   * directory picker. Each child is flagged when it carries its own SKILL.md,
   * so the dialog can tell a skill root apart from a plain container or folder.
   * @param request - absolute directory to list (empty = the host home directory).
   * @returns subdirectory names, each with its hasSkill flag.
   */
  @Remote
  async listDirs(request: ListDirsRequest): Promise<ListDirsView> {
    const raw = request.path.trim()
    const dir = raw === '' ? homedir() : raw
    const roots = filesystemRoots()
    if (!isAbsolute(dir)) {
      return { ok: false, path: dir, entries: [], roots, currentHasSkill: false, error: '路径必须是绝对路径' }
    }
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      return { ok: false, path: dir, entries: [], roots, currentHasSkill: false, error: error instanceof Error ? error.message : String(error) }
    }
    const list = entries
      .filter(entry => entry.isDirectory() && !SKILL_DIR_FILTER.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => ({ name: entry.name, hasSkill: existsSync(join(dir, entry.name, 'SKILL.md')) }))
    return { ok: true, path: dir, entries: list, roots, currentHasSkill: existsSync(join(dir, 'SKILL.md')) }
  }

  /**
   * Create a project- or user-level rule by writing its markdown file.
   * @param request - name, body, and target level.
   * @returns the written resource path, or `ok: false` with an error.
   */
  @Remote
  async writeRule(request: WriteRuleRequest): Promise<WriteResourceResult> {
    if (request.path !== undefined) request.path = await this.authorizedPath(request.path)
    const name = sanitizeName(request.name)
    if (name === '' || request.content.trim() === '') {
      return { ok: false, name, path: '', error: 'rule name and content must not be empty' }
    }
    if (bundledRuleExists(name)) {
      return { ok: false, name, path: '', error: `"${name}" is a bundled rule and cannot be overridden; choose a distinct name` }
    }
    const base = request.level === 'project'
      ? join(request.path ?? '', '.dsh/rules')
      : join(dshHome(), 'rules')
    const file = join(base, `${name}.md`)
    return writeResourceFile(file, request.content.trimEnd() + '\n', name)
  }

  /**
   * Read a project-, user-, or bundled-level skill's full content for inline
   * viewing/editing. Bundled reads expose the shipped catalog read-only.
   * @param request - name and target level.
   * @returns the parsed frontmatter plus body, or `ok: false` with an error.
   */
  @Remote
  async readSkill(request: ReadSkillRequest): Promise<ReadSkillResult> {
    if (request.path !== undefined) request.path = await this.authorizedPath(request.path)
    const name = sanitizeName(request.name)
    const base = request.level === 'bundled'
      ? BUNDLED_SKILLS_DIR
      : request.level === 'project'
        ? join(request.path ?? '', '.dsh/skills')
        : join(dshHome(), 'skills')
    const raw = readResourceFile(join(base, name, 'SKILL.md'))
    if (raw === undefined) {
      return { ok: false, name, description: '', whenToUse: '', content: '', error: `skill not found: ${name}` }
    }
    const parsed = parseSkillFile(raw)
    if (parsed === undefined) {
      return { ok: false, name, description: '', whenToUse: '', content: '', error: `skill frontmatter unreadable: ${name}` }
    }
    return { ok: true, name: parsed.name, description: parsed.description, whenToUse: parsed.whenToUse, content: parsed.content }
  }

  /**
   * Read a project-, user-, or bundled-level rule's raw body for inline
   * viewing/editing. Bundled reads expose the shipped catalog read-only.
   * @param request - name and target level.
   * @returns the raw markdown body, or `ok: false` with an error.
   */
  @Remote
  async readRule(request: ReadRuleRequest): Promise<ReadRuleResult> {
    if (request.path !== undefined) request.path = await this.authorizedPath(request.path)
    const name = sanitizeName(request.name)
    const base = request.level === 'bundled'
      ? BUNDLED_RULES_DIR
      : request.level === 'project'
        ? join(request.path ?? '', '.dsh/rules')
        : join(dshHome(), 'rules')
    const raw = readResourceFile(join(base, `${name}.md`))
    if (raw === undefined) {
      return { ok: false, name, content: '', error: `rule not found: ${name}` }
    }
    return { ok: true, name, content: raw.trimEnd() }
  }

  /**
   * Delete a project- or user-level skill. Bundled skills are immutable and
   * this method refuses them; project/user deletions remove the SKILL.md and
   * its directory.
   * @param request - name and target level.
   * @returns the deleted resource path, or `ok: false` with an error.
   */
  @Remote
  async deleteSkill(request: DeleteSkillRequest): Promise<WriteResourceResult> {
    if (request.path !== undefined) request.path = await this.authorizedPath(request.path)
    const name = sanitizeName(request.name)
    if (name === '') return { ok: false, name, path: '', error: 'skill name must not be empty' }
    const base = request.level === 'project'
      ? join(request.path ?? '', '.dsh/skills')
      : join(dshHome(), 'skills')
    return deleteResourceDir(join(base, name), name)
  }

  /**
   * Delete a project- or user-level rule. Bundled rules are immutable and this
   * method refuses them.
   * @param request - name and target level.
   * @returns the deleted resource path, or `ok: false` with an error.
   */
  @Remote
  async deleteRule(request: DeleteRuleRequest): Promise<WriteResourceResult> {
    if (request.path !== undefined) request.path = await this.authorizedPath(request.path)
    const name = sanitizeName(request.name)
    if (name === '') return { ok: false, name, path: '', error: 'rule name must not be empty' }
    const base = request.level === 'project'
      ? join(request.path ?? '', '.dsh/rules')
      : join(dshHome(), 'rules')
    return deleteResourceFile(join(base, `${name}.md`), name)
  }

  /** Resolve the sandboxed fs service, failing loudly when the host lacks one. */
  private fs(): NonNullable<Context['fs']> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) {
      throw new RemoteError('gateway/internal', 'task-engine: fs service is absent from the host composition', {})
    }
    return fs
  }
}

/** Write a resource file, creating parent directories; never throws to the wire. */
function writeResourceFile(file: string, content: string, name: string): WriteResourceResult {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')
    return { ok: true, name, path: file }
  } catch (error) {
    return { ok: false, name, path: file, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Read a resource file's text, or `undefined` when absent/unreadable. */
function readResourceFile(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Delete one resource file; never throws to the wire. */
function deleteResourceFile(file: string, name: string): WriteResourceResult {
  try {
    rmSync(file, { force: true })
    return { ok: true, name, path: file }
  } catch (error) {
    return { ok: false, name, path: file, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Delete one skill directory (its SKILL.md plus the empty dir); never throws to the wire. */
function deleteResourceDir(dir: string, name: string): WriteResourceResult {
  try {
    rmSync(dir, { recursive: true, force: true })
    return { ok: true, name, path: dir }
  } catch (error) {
    return { ok: false, name, path: dir, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Read `.dsh/eng.json` under a workspace directory, or `undefined` when absent/unreadable. */
async function readEngText(fs: NonNullable<Context['fs']>, path: string): Promise<string | undefined> {
  try {
    const target = await fs.resolve(ENGFILE, { cwd: path })
    return await fs.readText(target)
  } catch {
    return undefined
  }
}

/**
 * Host-side allow-list of workspaces the Remote may touch. Empty means the
 * registry is not integrated (only {@link checkedPath} guards); once a host
 * integration registers real session workspaces, unregistered paths fail
 * closed. The final file boundary always stays with the filesystem sandbox.
 */
class WorkspaceRegistry {
  private readonly allowed = new Set<string>()

  register(path: string): void {
    this.allowed.add(normalizeKey(path))
  }

  assertAllowed(path: string): void {
    if (!strictWorkspaces && this.allowed.size === 0) return // legacy fallback — not integrated yet
    if (!this.allowed.has(normalizeKey(path))) {
      throw new RemoteError('gateway/internal', `task-engine: workspace not registered on this host: ${path}`, {})
    }
  }
}

function normalizeKey(path: string): string {
  const key = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
  return process.platform === 'win32' ? key.toLowerCase() : key
}

const workspaceRegistry = new WorkspaceRegistry()

/** When true, an empty registry no longer falls back to checkedPath — Remote calls fail closed until a host registers workspaces. */
let strictWorkspaces = false

/** Host integration point: authorize one workspace for Remote access (call per mounted session workspace). */
export function registerWorkspace(path: string): void {
  workspaceRegistry.register(path)
}

/** Host integration point: production hosts should call this — unregistered workspaces are then rejected instead of falling back to the legacy check. */
export function enableStrictWorkspaces(): void {
  strictWorkspaces = true
}

/**
 * Reject a client-supplied workspace path that is not absolute or points at a
 * system/home-wide root, then require the path on the host's workspace
 * allow-list when one is registered. The real containment stays with the
 * host's filesystem sandbox (writes carry a per-call `workspace-write`
 * policy); this check fails closed on the obvious mis-targets a stray client
 * call could name.
 */
/** Exported for tests and host integrations: the Remote path guard itself. */
export function checkedPath(raw: string): string {
  if (raw.trim() === '') { if (strictWorkspaces) throw new Error('workspace path must be absolute'); return raw } // empty means the host default, preserved for compatibility
  if (!isAbsolute(raw)) {
    throw new RemoteError('gateway/internal', `task-engine: workspace path must be absolute: ${raw}`, {})
  }
  const normalized = raw.replace(/[\\/]+$/u, '')
  const lower = normalized.replace(/\\/gu, '/').toLowerCase()
  const forbidden = ['c:/windows', 'c:/program files', 'c:/program files (x86)', 'c:/users']
  for (const prefix of forbidden) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) {
      throw new RemoteError('gateway/internal', `task-engine: path is not an allowed workspace: ${raw}`, {})
    }
  }
  workspaceRegistry.assertAllowed(normalized)
  return normalized
}

/** Directories the scan tree never descends into. */
const SCAN_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'target', '__pycache__', '.venv', 'venv', '.next', 'out', '.dsh'])
/** Maximum entries listed per directory in the scan tree; the rest collapse to a count line. */
const SCAN_MAX_ENTRIES = 40
/** Maximum directory depth the scan tree renders. */
const SCAN_MAX_DEPTH = 3

/** Render a compact directory tree (depth-bounded, skip-listed) for the model. */
function renderScanTree(root: string): string {
  const lines: string[] = [root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? root]
  function walk(dir: string, depth: number, prefix: string): void {
    if (depth > SCAN_MAX_DEPTH) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries = entries
      .filter(e => !SCAN_SKIP.has(e.name))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    const shown = entries.slice(0, SCAN_MAX_ENTRIES)
    for (const entry of shown) {
      const isDir = entry.isDirectory()
      lines.push(`${prefix}${isDir ? '▸ ' : ''}${entry.name}${isDir ? '/' : ''}`)
      if (isDir) walk(join(dir, entry.name), depth + 1, `${prefix}  `)
    }
    const hidden = entries.length - shown.length
    if (hidden > 0) lines.push(`${prefix}… (+${hidden} 项)`)
  }
  walk(root, 1, '  ')
  return lines.join('\n')
}

/** Build the project snapshot fed to the model: a bounded tree plus key file bodies. */
function scanProject(path: string): string {
  const parts: string[] = [`目录结构：\n\`\`\`\n${renderScanTree(path)}\n\`\`\``]
  for (const rel of SCAN_KEY_FILES) {
    const raw = readResourceFile(join(path, rel))
    if (raw === undefined || raw.trim() === '') continue
    parts.push(`文件 ${rel}：\n\`\`\`\n${raw.slice(0, 3000)}\n\`\`\``)
  }
  return parts.join('\n\n')
}

/** Strip a surrounding ```markdown fence if the model wrapped the draft anyway. */
function stripMarkdownFence(text: string): string {
  const trimmed = text.trim()
  const m = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/)
  if (m) return m[1]!.trimEnd()
  return trimmed
}

/** Count physical lines after CRLF normalization; an empty string counts as one. */
function lineCount(text: string): number {
  return text.replace(/\r\n/g, '\n').split('\n').length
}

/** Read one workspace-relative file through the sandboxed fs, or `undefined`. */
async function readTextAt(fs: NonNullable<Context['fs']>, path: string, rel: string): Promise<string | undefined> {
  try {
    const target = await fs.resolve(rel, { cwd: path })
    return await fs.readText(target)
  } catch {
    return undefined
  }
}

/**
 * Locate the effective `AGENTS.md` for a workspace directory. Order:
 * workspace root → exactly one direct child project → ancestor chain. When
 * several direct children own the file the location is ambiguous, so nothing is
 * guessed (`undefined`), keeping the write target at the workspace root.
 * @param path - absolute workspace directory.
 * @returns the absolute AGENTS.md path, or `undefined` when none is discoverable.
 */
function locateInitFile(path: string): string | undefined {
  const rootFile = join(path, INITFILE)
  if (existsSync(rootFile)) return rootFile
  const children: string[] = []
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const child = join(path, entry.name, INITFILE)
      if (existsSync(child)) children.push(child)
    }
  } catch {
    return undefined
  }
  if (children.length === 1) return children[0]
  if (children.length > 1) return undefined
  let current = dirname(path)
  for (;;) {
    const up = join(current, INITFILE)
    if (existsSync(up)) return up
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/** Resolve the project root that owns AGENTS.md for a workspace, or the workspace itself. */
function locateInitRoot(path: string): { root: string; found: boolean } {
  const file = locateInitFile(path)
  if (file !== undefined) return { root: dirname(file), found: true }
  return { root: path, found: false }
}
