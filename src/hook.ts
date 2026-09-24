/**
 * Commit-msg hook source — the SINGLE source the installed hook is generated from.
 *
 * `build-hook.mjs` bundles this file (plus the pure {@link ../engine} and
 * {@link ../workflows} modules it imports) into a self-contained CommonJS
 * `hooks/commit-msg`. The gate logic therefore lives in exactly one place
 * (`engine.ts` + `workflows.ts`); the hook no longer hand-mirrors it. Edit this
 * file and rebuild — never edit `hooks/commit-msg` directly.
 *
 * @module dsh-task-engine/hook
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  checkFileScope,
  commitCheckpoint,
  validateCommitMessage,
  type FlowSnapshot,
  type StageBinding,
  type TaskState,
  type WorkflowConfig,
  type ArtifactDef,
  type CommitRule,
  type ReviewDepth,
} from './engine.ts'
import { resolveFlow } from './workflows.ts'
import { hashConfig } from './snapshot.ts'
import { DEFAULT_RISK_POLICY } from './project.ts'

const messageFile = process.argv[2]

function refuse(reason: string): never {
  console.error('')
  console.error('dsh-task-engine 提交门禁拒绝: ' + reason)
  console.error('请先用 dev_task 走完前置阶段（或修正提交消息），再提交。')
  console.error('')
  process.exit(1)
}

function readJson(abs: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Fill every field missing from a legacy task record so the engine's pure
 * functions (`commitCheckpoint`, `checkFileScope`) never read an absent field.
 */
function normalizeTask(task: Record<string, unknown>): TaskState {
  return {
    schema: 1,
    id: String(task.id ?? ''),
    title: String(task.title ?? ''),
    branch: String(task.branch ?? ''),
    work_size: (task.work_size as TaskState['work_size']) ?? 'standard',
    risk_level: (task.risk_level as TaskState['risk_level']) ?? 'standard',
    stage: String(task.stage ?? ''),
    requirement_confirmed: task.requirement_confirmed === true,
    solution_confirmed: task.solution_confirmed === true,
    items: Array.isArray(task.items) ? (task.items as TaskState['items']) : [],
    verification: (task.verification as TaskState['verification']) ?? { passed: false, evidence: [] },
    review: (task.review as TaskState['review']) ?? { outcome: 'pending' },
    artifacts: (task.artifacts as TaskState['artifacts']) ?? {},
    files: Array.isArray(task.files) ? (task.files as string[]) : [],
    commits: Array.isArray(task.commits) ? (task.commits as TaskState['commits']) : [],
    ...(task.flow !== undefined ? { flow: task.flow as FlowSnapshot } : {}),
  }
}

function loadTasks(): { file: string; task: TaskState }[] {
  const dir = path.join(process.cwd(), '.dsh')
  if (!fs.existsSync(dir)) return []
  const out: { file: string; task: TaskState }[] = []
  const names = fs.readdirSync(dir).filter(name => name.startsWith('task-') && name.endsWith('.json'))
  for (const name of names) {
    const json = readJson(path.join(dir, name))
    if (json !== undefined && json.id !== undefined) out.push({ file: path.join(dir, name), task: normalizeTask(json) })
  }
  return out
}

function currentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/**
 * The commit's touched paths with their git status (e.g. `M`, `A`, `D`, `T`,
 * `R100`). Read as raw bytes under `quotePath=false` so non-ASCII filenames
 * survive verbatim; `ACMRDT` includes deletions and type changes so every
 * touched path — plus a rename's old and new path — is held to the declared
 * scope. The status is surfaced on refusal for audit.
 */
function stagedEntries(): { status: string; path: string }[] {
  try {
    const raw = execSync('git -c core.quotePath=false diff --cached --name-status -z --diff-filter=ACMRDT', { encoding: 'utf8' })
    const parts = raw.split('\0')
    const entries: { status: string; path: string }[] = []
    let i = 0
    while (i < parts.length) {
      const status = parts[i]
      if (status === undefined || status === '') { i++ ; continue }
      if (status.startsWith('R') || status.startsWith('C')) {
        // rename/copy carry `<status><score>\0<oldpath>\0<newpath>`; both paths
        // are in the commit, so both are scope-checked.
        const from = parts[i + 1]
        const to = parts[i + 2]
        if (from !== undefined && from !== '') entries.push({ status, path: from })
        if (to !== undefined && to !== '') entries.push({ status, path: to })
        i += 3
      } else {
        const path = parts[i + 1]
        if (path !== undefined && path !== '') entries.push({ status, path })
        i += 2
      }
    }
    return entries
  } catch {
    return []
  }
}

function fileMtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** Fallback only for pattern-less flows: newest task on the branch, else the sole task. */
function pickTask(tasks: { file: string; task: TaskState }[], branch: string): TaskState | undefined {
  if (tasks.length === 0) return undefined
  const byBranch = tasks.find(({ task }) => task.branch === branch)
  if (byBranch) return byBranch.task
  if (tasks.length === 1) return tasks[0]!.task
  const sorted = [...tasks].sort((a, b) => fileMtime(b.file) - fileMtime(a.file))
  return sorted[0]!.task
}

function readCommitMessage(file: string): string {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => !line.startsWith('#'))
    .join('\n')
    .trim()
}

/**
 * Extract the task id from the leading `【…】` of the summary, independent of the
 * live config (the hook must locate the task before it knows that task's frozen
 * config). Pattern-less flows simply carry no `【…】` here.
 */
function extractTaskId(message: string): string | undefined {
  const match = /^【([^【】\s]+)】/.exec(message)
  return match ? match[1] : undefined
}

/** Engine-owned state files are exempt from scope and risk checks. */
function isEngineMeta(file: string): boolean {
  return /^\.dsh\/(task-[^/]+\.json|eng\.json)$/.test(file)
}

/** Staged paths that hit the risk policy's sensitive paths (engine files exempt). */
function riskyPaths(entries: { status: string; path: string }[]): string[] {
  return entries
    .filter(entry => !isEngineMeta(entry.path))
    .filter(entry => DEFAULT_RISK_POLICY.sensitive_paths.some(prefix =>
      entry.path === prefix || entry.path.startsWith(`${prefix}/`)))
    .map(entry => entry.path)
}

/** Only a high-risk task that passed a real command receipt may touch sensitive paths. */
function riskVerified(state: TaskState): boolean {
  const receipt = state.verification.receipt
  return state.risk_level === 'high_risk'
    && receipt !== undefined
    && receipt.exit_code === 0
    && !receipt.timed_out
    && !receipt.aborted
}

/** The standard preset, applied when the project has no `.dsh/eng.json` at all. */
function defaultConfig(): WorkflowConfig {
  const resolved = resolveFlow('standard')
  if (!resolved.ok) throw new Error('built-in "standard" preset is missing')
  return resolved.config
}

/**
 * Resolve the project's live workflow — used only as a FALLBACK when a legacy
 * task record carries no frozen snapshot. Mirrors `dev_task` `resolveWorkflow`:
 * no file → standard; missing/unknown `flow` → fail closed (never silent fallback).
 */
  function loadWorkflow(parsed: { flow?: string; stage_bindings?: unknown; commit?: unknown; artifacts?: unknown; review_depth?: unknown; commit_required?: unknown } | undefined): WorkflowConfig {
  if (parsed === undefined) return defaultConfig()
  const flow = parsed.flow
  if (typeof flow !== 'string' || flow.trim() === '') {
    refuse('项目 .dsh/eng.json 缺 "flow" 字段——设为 standard|agile|minimal，或删除该文件')
  }
  // The hook validates the same contract the tool does, so it reads the same whole
  // config: narrowing to stage_bindings would let the hook judge a commit against a
  // different commit rule than the one the tool authorised it under.
  const project = {
    flow,
    ...(typeof parsed.stage_bindings === 'object' && parsed.stage_bindings !== null && !Array.isArray(parsed.stage_bindings)
      ? { stage_bindings: parsed.stage_bindings as Record<string, StageBinding> }
      : {}),
    ...(typeof parsed.commit === 'object' && parsed.commit !== null && !Array.isArray(parsed.commit) ? { commit: parsed.commit as CommitRule } : {}),
    ...(Array.isArray(parsed.artifacts) ? { artifacts: parsed.artifacts as ArtifactDef[] } : {}),
    ...(typeof parsed.review_depth === 'string' ? { review_depth: parsed.review_depth as ReviewDepth } : {}),
    ...(typeof parsed.commit_required === 'boolean' ? { commit_required: parsed.commit_required } : {}),
  }
  const resolved = resolveFlow(flow, project)
  if (!resolved.ok) {
    refuse(`未知流程 "${resolved.flow}"（已知流程：${resolved.knownFlows.join('、')}）`)
  }
  return resolved.config
}

// --- gather project state (fallback config) ---
const cwd = process.cwd()
const configPath = path.join(cwd, '.dsh', 'eng.json')
let config: WorkflowConfig
if (fs.existsSync(configPath)) {
  let raw = ''
  try {
    raw = fs.readFileSync(configPath, 'utf8')
  } catch {
    raw = ''
  }
  let parsed: { flow?: string; stage_bindings?: unknown }
  try {
    parsed = JSON.parse(raw) as { flow?: string; stage_bindings?: unknown }
  } catch (error) {
    refuse('invalid JSON in .dsh/eng.json: ' + (error instanceof Error ? error.message : String(error)))
  }
  config = loadWorkflow(parsed)
} else {
  config = loadWorkflow(undefined)
}

// --- the gate ---
if (!messageFile) {
  process.exit(0)
}

const message = readCommitMessage(messageFile)
const tasks = loadTasks()

// Locate the task by id from the summary first; only then read its frozen config.
const taskId = extractTaskId(message)
let state: TaskState | undefined
if (taskId !== undefined) {
  const found = tasks.find(({ task }) => task.id === taskId)
  if (!found) {
    refuse(`提交消息里的任务 id "${taskId}" 找不到对应的任务记录（.dsh/task-<id>.json）`)
  }
  state = found.task
} else {
  state = pickTask(tasks, currentBranch())
}
if (!state) {
  refuse('没有找到 dev_task 任务记录（.dsh/task-*.json）——请先 dev_task operation=create 建立任务')
}

if (state.flow?.hash !== undefined && hashConfig(state.flow.config) !== state.flow.hash) {
  refuse(`任务 ${state.id} 的流程快照 hash 不匹配——task 记录在创建后被改动过，修复或重建任务后再提交`)
}

// Check this task against its frozen snapshot, not the live .dsh/eng.json
// (which may have drifted mid-task). Fall back to the live config only for
// legacy records that predate the snapshot field.
if (state.flow !== undefined && state.flow.config !== undefined) {
  config = state.flow.config
}

const verdict = validateCommitMessage(message, config)
if (!verdict.ok) {
  refuse(verdict.errors?.[0] ?? 'commit summary does not match the configured pattern')
}

const checkpoint = commitCheckpoint(state, config)
if (!checkpoint.allowed) {
  refuse((checkpoint.reason ?? 'commit checkpoint rejected') + '（当前阶段: ' + state.stage + '）')
}

const entries = stagedEntries()
const scope = checkFileScope(state, entries.map(entry => entry.path), config)
if (!scope.ok) {
  if (scope.noScope) {
    refuse('任务没有声明文件范围（files 为空）——先用 dev_task operation=scope 声明本任务涉及的文件')
  }
  const described = scope.outside.map(outside => {
    const entry = entries.find(candidate => candidate.path === outside)
    return entry === undefined ? outside : `${entry.status}\t${outside}`
  })
  refuse('提交了任务范围之外的文件: ' + described.join(', '))
}

const sensitive = riskyPaths(entries)
if (sensitive.length > 0 && !riskVerified(state)) {
  refuse(
    '提交触及敏感路径: ' + sensitive.join(', ') +
    ' — 这类变更要求任务声明为 high_risk，且验证必须是真实命令回执（exit 0）',
  )
}

process.exit(0)