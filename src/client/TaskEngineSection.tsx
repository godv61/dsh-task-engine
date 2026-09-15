/** Shared Remote types and the project workflow settings entry point. */
import type { ResourceImportRequest, ResourcePreview } from '../resource-types.ts'
import type { StageBinding, WorkflowConfig } from '../engine.ts'
import type { CustomFlow } from '../custom-flow.ts'
export { FlowEditor as TaskEngineSection } from './FlowEditor.tsx'

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error?: unknown }

/** The `read`/`write` result: preset flow, resolved workflow, plus validation state. */
interface EngConfigView {
  custom_flow?: CustomFlow
  revision?: string
  ok: boolean
  source: 'default' | 'project' | 'invalid'
  flow: string
  config: WorkflowConfig
  problems: string[]
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

/** Result of creating one skill or rule. */
export interface WriteResourceResult {
  ok: boolean
  name: string
  path: string
  error?: string
}

/** Full editable content of one skill. */
export interface ReadSkillResult {
  ok: boolean
  name: string
  description: string
  whenToUse: string
  content: string
  error?: string
}

/** Full editable content of one rule. */
export interface ReadRuleResult {
  ok: boolean
  name: string
  content: string
  error?: string
}

/** One implementation item's audit trail in the task ledger view. */
export interface TaskLedgerItem {
  id: string
  title: string
  status: string
  dispatch?: { description: string; at: string }
  review?: {
    spec: { outcome: 'pass' | 'fail'; notes?: string[] }
    quality: { outcome: 'pass' | 'fail'; notes?: string[] }
  }
}

/** One task's ledger projection: identity, stage, and per-item audit trail. */
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
  exists: boolean
  content: string
  lines: number
  /** Absolute AGENTS.md location when resolved outside the workspace root. */
  path?: string
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

/** The mounted `task-engine` Remote namespace. */
export interface TaskEngineRemote {
  resourceRoots(request: { kind: 'skill' | 'rule'; path: string }): Promise<RemoteResult<{ project: string; user: string }>>
  previewResource(request: ResourceImportRequest): Promise<RemoteResult<ResourcePreview>>
  importResource(request: ResourceImportRequest): Promise<RemoteResult<ResourcePreview>>
  read(path: string): Promise<RemoteResult<EngConfigView>>
  write(request: { path: string; flow: string; custom_flow?: CustomFlow; expected_revision?: string; stage_bindings?: Record<string, StageBinding> }): Promise<RemoteResult<EngConfigView>>
  listSkills(path: string): Promise<RemoteResult<{ skills: SkillCatalogEntry[] }>>
  listRules(path: string): Promise<RemoteResult<{ rules: RuleCatalogEntry[] }>>
  writeSkill(request: { name: string; description: string; whenToUse?: string; content: string; level: 'project' | 'user'; path?: string }): Promise<RemoteResult<WriteResourceResult>>
  installSkill(request: { sourceDir: string; level: 'project' | 'user'; path?: string }): Promise<RemoteResult<WriteResourceResult>>
  listDirs(request: { path: string }): Promise<RemoteResult<{ ok: boolean; path: string; entries: { name: string; hasSkill: boolean }[]; roots: string[]; currentHasSkill: boolean; error?: string }>>
  writeRule(request: { name: string; content: string; level: 'project' | 'user'; path?: string }): Promise<RemoteResult<WriteResourceResult>>
  readSkill(request: { name: string; level: 'project' | 'user' | 'bundled'; path?: string }): Promise<RemoteResult<ReadSkillResult>>
  readRule(request: { name: string; level: 'project' | 'user' | 'bundled'; path?: string }): Promise<RemoteResult<ReadRuleResult>>
  deleteSkill(request: { name: string; level: 'project' | 'user'; path?: string }): Promise<RemoteResult<WriteResourceResult>>
  deleteRule(request: { name: string; level: 'project' | 'user'; path?: string }): Promise<RemoteResult<WriteResourceResult>>
  readTasks(path: string): Promise<RemoteResult<TaskLedgerView>>
  readInit(path: string): Promise<RemoteResult<InitView>>
  writeInit(request: { path: string; content: string; overwrite?: boolean }): Promise<RemoteResult<InitWriteResult>>
  generateInit(request: { path: string }): Promise<RemoteResult<InitDraft>>
}
