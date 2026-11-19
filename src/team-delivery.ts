import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunInfo, SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { lstatSync } from 'node:fs'
import { assertRealPath } from './resource-import.ts'
import type { ItemDispatch } from './engine.ts'

export const TEAM_WORKER_PRESET = 'task-engine-worker'

/** Runtime feature detection also covers older hosts and profiles without Teams. */
interface BoardTask {
  id: string
  revision: number
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  ownerId?: string
}
interface TeamBoard {
  isEnabled(agent: Agent): boolean
  listTasks(agent: Agent): BoardTask[]
  createTask(agent: Agent, input: { subject: string; description: string; writeScopes: string[] }): Promise<BoardTask>
  updateTask(agent: Agent, input: { taskId: string; expectedRevision: number; action: 'reassign' | 'reopen' | 'complete' | 'edit'; owner?: SessionId; writeScopes?: string[] }): Promise<BoardTask>
}

function teamBoard(ctx: Context): TeamBoard | undefined {
  const board = (ctx as unknown as { get(name: string): unknown }).get('agentTeams') as TeamBoard | undefined
  if (board && ['isEnabled', 'listTasks', 'createTask', 'updateTask'].every(key => typeof board[key as keyof TeamBoard] === 'function')) return board
}

export function teamsEnabled(ctx: Context, agent: Agent | undefined): boolean {
  try { return !!agent && teamBoard(ctx)?.isEnabled(agent) === true }
  catch (error) {
    if ((error as { code?: string }).code === 'UNAUTHORIZED') return false
    throw error
  }
}

interface TeamWork {
  parent: Agent
  task: string
  item: string
  root: string
  files: Set<string>
  admission: PromiseWithResolvers<string | undefined>
  child: SessionId
  activation?: string
  outcome?: SubagentRunEndInfo
  authorizedTurn?: number
  cancelled: boolean
  unexpectedInput: boolean
  validate: () => Promise<boolean>
}

const runs = new Map<string, TeamWork>()
const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const workerReads = new Set(['read', 'glob', 'grep'])
export const teamWorkerTools = new Set([...workerReads, 'write', 'edit'])
const parentReads = new Set([...workerReads, 'dev_task', 'skill', 'working_directory', 'wait_agent', 'list_agents',
  'team_task_list', 'team_task_get', 'ask_user_question'])
const teamOperations = new Set(['status', 'dispatch', 'team_resume', 'team_collect', 'team_cancel', 'recover_dispatch'])

export function teamParentOperationProblem(agent: Agent | undefined, task: string | undefined, operation: string): string | undefined {
  const run = [...runs.values()].find(work => work.parent === agent)
  if (!run || operation === 'status' || task === run.task && teamOperations.has(operation)) return undefined
  return '活动团队实施锁定父任务。用 team_collect 或 team_cancel 收齐本任务运行，再切换任务、修订、修改文件或执行 verify。'
}

export function teamParentToolProblem(agent: Agent | undefined, name: string): string | undefined {
  if (!parentReads.has(name) && [...runs.values()].some(run => run.parent === agent))
    return '团队成员仍有待收取的执行记录。请先 wait_agent、team_collect 或 team_cancel，再在父会话写入或运行命令。'
}

export function teamFileKey(root: string, path: string): string {
  const full = resolve(root, path)
  const local = relative(root, full)
  const parts = local.split(sep)
  if (!local || isAbsolute(local) || local === '..' || parts[0] === '..'
    || parts.some(part => ['.git', '.dsh'].includes(part.toLowerCase()) || /[:. ]$/u.test(part) || part.includes(':'))) {
    throw new Error('团队成员写入只接受项目内登记的普通交付文件路径（不含 .git 或 .dsh）。')
  }
  assertRealPath(full)
  try {
    const stat = lstatSync(full)
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('团队成员不能写入非普通文件或有硬链接的文件。')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return canonical(full)
}

export function reserveTeamWork(parent: Agent, task: string, item: string, child: SessionId, root: string, files: string[], validate: () => Promise<boolean>): TeamWork {
  const targets = new Set(files.map(path => teamFileKey(root, path)))
  if (!targets.size) throw new Error('团队实施需要明确的交付文件。')
  if (runs.has(child)) throw new Error('该成员仍有未收取的运行；请先 team_collect。')
  for (const active of runs.values()) {
    if (canonical(active.root) === canonical(root) && (active.parent !== parent || active.task !== task))
      throw new Error('此工作区已有受控团队实施；请回到原任务收取或取消。')
    for (const path of targets) {
      if ([...active.files].some(existing => path === existing || path.startsWith(existing + sep) || existing.startsWith(path + sep)))
        throw new Error('团队实施文件范围冲突；先收取已有执行，再安排重叠文件。')
    }
  }
  const run: TeamWork = { parent, task, item, child, root, files: targets, admission: Promise.withResolvers<string | undefined>(),
    cancelled: false, unexpectedInput: false, validate }
  runs.set(child, run)
  return run
}

export function releaseTeamWork(run: TeamWork): void {
  run.admission.resolve(undefined)
  if (runs.get(run.child) === run) runs.delete(run.child)
}

export function ownedTeamWork(parent: Agent, task: string, item: string, child: string): TeamWork | undefined {
  const run = runs.get(child)
  if (run && run.parent === parent && run.task === task && run.item === item) return run
}

export function attachTeamReceipt(run: TeamWork, dispatch: ItemDispatch, message: string): void {
  dispatch.team!.message_id = message
  run.admission.resolve(message)
}

// Earlier hosts published the same lifecycle events without the durable creator field.
type NamedRunInfo = SubagentRunInfo & { parentSessionId?: string }

export function installTeamLifecycle(ctx: Context): void {
  ctx.on('subagent/start', (event: SubagentRunInfo) => {
    const run = runs.get(event.id)
    if (run && event.local && run.parent.id === (event as NamedRunInfo).parentSessionId && !run.activation) run.activation = event.runId
  })
  ctx.on('subagent/end', (event: SubagentRunEndInfo) => {
    const run = runs.get(event.id)
    if (run?.activation === event.runId && run.parent.id === (event as NamedRunInfo).parentSessionId) run.outcome = event
  })
  ctx.on('agent/disposed', ({ agent }) => {
    for (const run of runs.values()) if (run.parent === agent) releaseTeamWork(run)
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const run = exec.agent && runs.get(exec.agent.id)
    if (run && (exec.name === 'edit' || exec.name === 'write') && !await run.validate().catch(() => false)) {
      run.unexpectedInput = true
      return { kind: 'deny', reason: '团队写入权限对应的需求、实施计划或账本已变更。' }
    }
    return next()
  })
  ctx.tools.guard(exec => {
    if (!exec.agent) return undefined
    if (runs.has(exec.agent.id)) return teamWorkerToolProblem(exec.agent, exec.name, exec.arguments)
    return teamParentToolProblem(exec.agent, exec.name)
  })
}

export async function admitTeamWorkerStep(agent: Agent, turn: number, step: number, messages: readonly { id: string }[]): Promise<boolean> {
  const run = runs.get(agent.id)
  if (!run) return false
  const message = await run.admission.promise
  if (!message || run.cancelled || runs.get(agent.id) !== run || !await run.validate().catch(() => false)) return false
  if (step === 1 && messages.length === 1 && messages[0]?.id === message && run.authorizedTurn === undefined) {
    run.authorizedTurn = turn
    return true
  }
  if (run.authorizedTurn === turn && step > 1 && messages.length === 0) return true
  run.unexpectedInput = true
  return false
}

export function teamWorkerToolProblem(agent: Agent | undefined, name: string, args: unknown): string | undefined {
  if (workerReads.has(name)) return undefined
  const run = agent && runs.get(agent.id)
  if (run && run.authorizedTurn !== undefined && !run.cancelled && !run.outcome && !run.unexpectedInput &&
    (name === 'write' || name === 'edit')) {
    const path = (args as { file_path?: unknown } | null)?.file_path
    if (typeof path === 'string') {
      try { if (run.files.has(teamFileKey(run.root, path))) return undefined } catch { /* Reject invalid paths with the same workspace diagnostic. */ }
    }
  }
  return '团队实施成员只能读源码和修改本轮登记的普通文件。请由父会话通过 dev_task 执行终端、验证、审核、续跑和归档。'
}

/** One stable board entry per Lead / engineering task / item, even after a lost create receipt. */
export async function syncTeamBoard(ctx: Context, parent: Agent, task: string, item: string, title: string, files: string[], dispatch: ItemDispatch): Promise<void> {
  const link = dispatch.team!
  const board = teamBoard(ctx)
  try {
    if (!board?.isEnabled(parent)) throw new Error('团队开关已关闭；重新开启后用 team_collect 同步任务板。')
    const description = JSON.stringify({ engineering_task: task, implementation_item: item })
    let entry = board.listTasks(parent).find(candidate => candidate.description === description)
    if (!entry) entry = await board.createTask(parent, { subject: title.slice(0, 120), description, writeScopes: files })
    link.board_id = entry.id
    const change = (action: Parameters<TeamBoard['updateTask']>[1]['action'], extras = {}) =>
      board.updateTask(parent, { taskId: entry!.id, expectedRevision: entry!.revision, action, ...extras })
    if (dispatch.status === 'starting') {
      if (entry.status === 'completed') entry = await change('reopen')
      entry = await change('edit', { writeScopes: files })
    } else if (dispatch.status === 'running' || dispatch.status === 'completed') {
      if (entry.status !== 'completed') {
        if (entry.status !== 'in_progress' || entry.ownerId !== dispatch.run_id) entry = await change('reassign', { owner: dispatch.run_id })
        if (dispatch.status === 'completed') await change('complete')
      }
    } else {
      if (entry.status === 'completed') entry = await change('reopen')
      if (entry.status === 'in_progress') await change('reassign')
    }
    delete link.board_problem
  } catch (error) {
    link.board_problem = error instanceof Error ? error.message : String(error)
  }
}
