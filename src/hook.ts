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

import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  checkFileScope,
  commitCheckpoint,
  validateCommitMessage,
  type FlowSnapshot,
  type TaskState,
  type WorkflowConfig,
} from './engine.ts'
import { hashBytes, hashConfig, hashText } from './snapshot.ts'
import { DEFAULT_RISK_POLICY, isSensitivePath } from './project.ts'
import { sonarCommitBlockers } from './sonar.ts'
import { reviewEvidenceBlockers, verificationEvidenceBlockers } from './evidence-gate.ts'
import { groupInputs } from './verification-state.ts'
import { requirementConfirmed, taskExecutionProblem } from './requirements.ts'
import { lastLocalRuleUpdate, localRulesFingerprint } from './sonarlint-local.ts'

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
 * Normalize records for inspection; support checks run before executing gates.
 */
function normalizeTask(task: Record<string, unknown>): TaskState {
  return {
    schema: 1,
    id: String(task.id ?? ''),
    title: String(task.title ?? ''),
    branch: String(task.branch ?? ''),
    work_size: (task.work_size as TaskState['work_size']) ?? 'standard',
    risk_level: (task.risk_level as TaskState['risk_level']) ?? 'standard',
    ...(task.delivery ? { delivery: task.delivery as NonNullable<TaskState['delivery']> } : {}),
    ...(task.complexity !== undefined ? { complexity: task.complexity as NonNullable<TaskState['complexity']> } : {}),
    ...(task.sonar_policy !== undefined ? { sonar_policy: task.sonar_policy as NonNullable<TaskState['sonar_policy']> } : {}),
    ...(task.sonar_audit !== undefined ? { sonar_audit: task.sonar_audit as NonNullable<TaskState['sonar_audit']> } : {}),
    stage: String(task.stage ?? ''),
    requirement_confirmed: task.requirement_confirmed === true,
    ...(task.requirements ? { requirements: task.requirements as NonNullable<TaskState['requirements']> } : {}),
    solution_confirmed: task.solution_confirmed === true,
    items: Array.isArray(task.items) ? (task.items as TaskState['items']) : [],
    verification: (task.verification as TaskState['verification']) ?? { passed: false, evidence: [] },
    review: (task.review as TaskState['review']) ?? { outcome: 'pending' },
    artifacts: (task.artifacts as TaskState['artifacts']) ?? {},
    files: Array.isArray(task.files) ? (task.files as string[]) : [],
    commits: Array.isArray(task.commits) ? (task.commits as TaskState['commits']) : [],
    ...(task.completed !== undefined ? { completed: task.completed as NonNullable<TaskState['completed']> } : {}),
    ...(task.execution_version === 1 ? { execution_version: 1 as const } : {}),
    ...(task.delegation_version === 1 ? { delegation_version: 1 as const } : {}),
    ...(task.verification_version === 1 ? { verification_version: 1 as const,
      verification_groups: (task.verification_groups as TaskState['verification_groups']) ?? {},
      verification_runs: (task.verification_runs as TaskState['verification_runs']) ?? [] } : {}),
    ...(typeof task.root === 'string' ? { root: task.root } : {}),
    ...(task.flow !== undefined ? { flow: task.flow as FlowSnapshot } : {}),
  }
}

/** Hook installation records only workspace paths inside this Git worktree. */
function taskRoots(repoRoot: string): string[] {
  const roots = new Set([repoRoot])
  const configPath = path.join(__dirname, 'dsh-task-roots.json')
  const config = readJson(configPath)
  if (fs.existsSync(configPath) && config === undefined) refuse('提交钩子的工作区配置无法读取或解析')
  if (config?.roots !== undefined && !Array.isArray(config.roots)) refuse('提交钩子的工作区配置无效')
  for (const value of (config?.roots ?? []) as unknown[]) {
    if (typeof value !== 'string' || path.isAbsolute(value)) refuse('提交钩子的工作区配置含非法路径')
    const root = path.resolve(repoRoot, value)
    const inside = path.relative(repoRoot, root)
    if (inside.startsWith('..') || path.isAbsolute(inside)) refuse('提交钩子的工作区配置越界')
    roots.add(root)
  }
  return [...roots]
}

function loadTasks(): { file: string; task: TaskState }[] {
  const out: { file: string; task: TaskState }[] = []
  const repoRoot = fs.realpathSync.native(process.cwd())
  for (const root of taskRoots(repoRoot)) {
    const dir = path.join(root, '.dsh')
    if (!fs.existsSync(dir)) continue
    const names = fs.readdirSync(dir).filter(name => name.startsWith('task-') && name.endsWith('.json'))
    for (const name of names) {
      const json = readJson(path.join(dir, name))
      if (json === undefined || json.id === undefined) continue
      const task = normalizeTask(json)
      // Git reports long Windows paths while old task roots may use an 8.3 alias.
      const projectRoot = fs.realpathSync.native(task.root === undefined ? root : path.resolve(task.root))
      const insideRepo = path.relative(repoRoot, projectRoot)
      const workspaceInsideProject = path.relative(projectRoot, root)
      if (insideRepo.startsWith('..') || path.isAbsolute(insideRepo)
        || workspaceInsideProject.startsWith('..') || path.isAbsolute(workspaceInsideProject)) {
        refuse(`任务 ${task.id} 的项目根目录与钩子登记的工作区不一致`)
      }
      out.push({ file: path.join(dir, name), task: { ...task, root: projectRoot } })
    }
  }
  return out
}

function currentBranch(): string {
  try {
    return execSync('git symbolic-ref --quiet --short HEAD', { encoding: 'utf8' }).trim()
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
    refuse('无法读取 Git 暂存区，不能确认实际提交内容')
  }
}

/** A commit must contain the same bytes and file type currently covered by the receipt. */
function assertIndexMatchesWorktree(repoRoot: string, file: string): void {
  const staged = execFileSync('git', ['ls-files', '--stage', '-z', '--', file], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0').filter(Boolean)
  const exact = staged.filter(line => line.endsWith(`\t${file}`))
  const target = path.resolve(repoRoot, file)
  if (exact.length === 0) {
    if (fs.existsSync(target)) refuse(`暂存区已删除但工作区仍有文件：${file}；重新暂存并验证`)
    return
  }
  if (exact.length !== 1) refuse(`暂存区存在未解决冲突：${file}`)
  const match = /^(100644|100755|120000) ([0-9a-f]+) 0\t/u.exec(exact[0]!)
  if (!match) refuse(`暂存文件类型不受支持：${file}`)
  let info: fs.Stats
  try { info = fs.lstatSync(target) }
  catch { refuse(`暂存区与工作区不一致：${file}；重新暂存并验证`) }
  if (!info.isFile() || match[1] === '120000') refuse(`任务提交不支持符号链接：${file}`)
  if (process.platform !== 'win32' && ((match[1] === '100755') !== ((info.mode & 0o111) !== 0))) {
    refuse(`暂存区文件权限与已验证工作区不一致：${file}`)
  }
  const worktreeOid = execFileSync('git', ['hash-object', `--path=${file}`, '--', file], { cwd: repoRoot, encoding: 'utf8' }).trim()
  if (worktreeOid !== match[2]) refuse(`暂存区内容与已验证工作区不一致：${file}；重新暂存并验证`)
}

/** Read-only historical/analysis records cannot compete with an executable task. */
function pickTask(tasks: { file: string; task: TaskState }[], branch: string): TaskState | undefined {
  const candidates = tasks.filter(({ task }) => task.branch === branch && task.stage !== '完成' && task.completed === undefined
    && !taskExecutionProblem(task) && task.delivery?.intent !== 'analysis')
  if (candidates.length > 1) {
    refuse(`当前分支有多个未完成任务（${candidates.map(({ task }) => task.id).join('、')}）；请在提交消息开头写明【任务ID】`)
  }
  return candidates[0]?.task
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
  return /^\.dsh\/(task-[^/]+\.json|eng\.json|meta\.json)$/.test(file)
}

function scopeHash(state: TaskState, root: string, includeGovernance = false): string {
  const entries = [...new Set(state.files)].filter(file => includeGovernance || !isEngineMeta(file)).sort().map(file => {
    const target = path.resolve(root, file)
    const inside = path.relative(root, target)
    if (inside.startsWith('..') || path.isAbsolute(inside)) refuse(`任务范围路径越界: ${file}`)
    try {
      const info = fs.lstatSync(target)
      if (!info.isFile()) refuse(`任务范围含非普通文件: ${file}`)
      const executable = process.platform === 'win32' ? false : (info.mode & 0o111) !== 0
      return [file, hashBytes(fs.readFileSync(target)), executable]
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [file, null, null]
      refuse(`无法读取任务文件 ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  return hashText(JSON.stringify(entries))
}

/** Staged paths that hit the risk policy's sensitive paths (engine files exempt). */
function riskyPaths(entries: { status: string; path: string }[]): string[] {
  return entries
    .filter(entry => !isEngineMeta(entry.path))
    .filter(entry => isSensitivePath(entry.path))
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

// --- the gate ---
if (!messageFile) {
  process.exit(0)
}

const message = readCommitMessage(messageFile)
const cwd = fs.realpathSync.native(process.cwd())
const tasks = loadTasks()

// Locate the task by id from the summary first; only then read its frozen config.
const taskId = extractTaskId(message)
let state: TaskState | undefined
if (taskId !== undefined) {
  const found = tasks.filter(({ task }) => task.id === taskId)
  if (found.length === 0) {
    refuse(`提交消息里的任务 id "${taskId}" 找不到对应的任务记录（.dsh/task-<id>.json）`)
  }
  if (found.length > 1) refuse(`任务 id "${taskId}" 在多个工作区重复；请先消除歧义`)
  state = found[0]!.task
} else {
  state = pickTask(tasks, currentBranch())
}
if (!state) {
  refuse('当前分支没有可提交的 dev_task 任务——请先建立任务，或在提交消息开头写明【任务ID】')
}
if (state.completed !== undefined) refuse('此任务已归档，仅可查看；请新建任务后提交')
const branch = currentBranch()
if (!branch || branch === 'HEAD' || state.branch !== branch) {
  refuse(`任务 ${state.id} 记录的分支是 ${state.branch}，当前 Git 分支是 ${branch || '未知'}；请切回任务分支`)
}

if (state.flow?.hash !== undefined && hashConfig(state.flow.config) !== state.flow.hash) {
  refuse(`任务 ${state.id} 的流程快照 hash 不匹配——task 记录在创建后被改动过，修复或重建任务后再提交`)
}

const executionProblem = taskExecutionProblem(state)
if (executionProblem) refuse(executionProblem)

// Execution requires a current task snapshot.
let config: WorkflowConfig
if (state.flow !== undefined && state.flow.config !== undefined) {
  config = state.flow.config
} else {
  refuse('此任务缺少流程快照，请重新创建任务后提交')
}

const verdict = validateCommitMessage(message, config)
if (!verdict.ok) {
  refuse(verdict.errors?.[0] ?? 'commit summary does not match the configured pattern')
}

if (config.requirement_review) {
  if (!requirementConfirmed(state, config)) refuse('当前需求版本尚未由用户确认')
  const doc = state.requirements!.document!, workspace = state.root ?? cwd
  const documentPath = path.resolve(workspace, doc.path)
  const outside = (file: string) => { const rel = path.relative(fs.realpathSync(workspace), file); return rel.startsWith('..') || path.isAbsolute(rel) }
  try {
    if (outside(fs.realpathSync(documentPath)) || hashText(fs.readFileSync(documentPath, 'utf8')) !== doc.hash) refuse('需求文档已变化；请修订并重新确认')
  } catch { refuse('需求文档无法核对；请修订并重新确认') }
}
const checkpoint = commitCheckpoint(state, config)
if (!checkpoint.allowed) {
  refuse((checkpoint.reason ?? 'commit checkpoint rejected') + '（当前阶段: ' + state.stage + '）')
}
const groupHashes = state.verification_version ? Object.fromEntries(Object.values(state.verification_groups ?? {}).map(group =>
  [group.id, scopeHash({ ...state, files: groupInputs(state, group) }, state.root ?? cwd, true)])) : undefined
const evidence = verificationEvidenceBlockers(state, config, scopeHash(state, state.root ?? cwd), groupHashes)
evidence.push(...reviewEvidenceBlockers(state, scopeHash(state, state.root ?? cwd)))
if (evidence.length) refuse(evidence.join('; '))

// Adaptive tasks commit at the Test checkpoint; a local Sonar scan does not
// require pushing that commit. The audit gates Code Review and Completion.
if (state.sonar_policy?.enabled && ['代码审核', '完成'].includes(state.stage)) {
  const lastCommit = state.commits.findLast(entry => entry.hash !== undefined)?.hash
  const blockers = sonarCommitBlockers(state.sonar_policy, state.sonar_audit, scopeHash(state, state.root ?? cwd), lastCommit)
  if (state.sonar_policy.source === 'ide-local' && state.sonar_audit) {
    const updated = lastLocalRuleUpdate(state.sonar_policy, state.root ?? cwd)
    const rulesHash = localRulesFingerprint(state.sonar_policy, state.root ?? cwd)
    if ((updated && updated !== state.sonar_audit.rules_updated_at) || (rulesHash && rulesHash !== state.sonar_audit.rules_hash))
      blockers.push('project rule configuration changed; rerun sonar_check and review')
  }
  if (blockers.length) refuse(blockers.join('; '))
}

const workspace = state.root ?? cwd
const entries = stagedEntries().map(entry => {
  const absolute = path.resolve(cwd, entry.path)
  const relativePath = path.relative(workspace, absolute).replaceAll('\\', '/')
  return { ...entry, path: relativePath }
})
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
for (const entry of entries) {
  if (!isEngineMeta(entry.path)) assertIndexMatchesWorktree(cwd, path.relative(cwd, path.resolve(workspace, entry.path)).replaceAll('\\', '/'))
}

const sensitive = riskyPaths(entries)
const riskyChanges = entries.filter(entry => DEFAULT_RISK_POLICY.risky_operations.includes(entry.status[0] ?? ''))
  .map(entry => `${entry.status}\t${entry.path}`)
if ((sensitive.length > 0 || riskyChanges.length > 0) && !riskVerified(state)) {
  refuse(
    '提交触及敏感路径或高风险操作: ' + [...sensitive, ...riskyChanges].join(', ') +
    ' — 这类变更要求任务声明为 high_risk，且验证必须是真实命令回执（exit 0）',
  )
}

process.exit(0)
