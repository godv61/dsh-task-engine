import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { startTaskActivation } from './subagent-runtime.ts'
import type { ItemDispatch, TaskItem, TaskState } from './engine.ts'
import { loadTask, writeTask } from './task-store.ts'
import { executionPlanKey } from './execution-plan.ts'
import { requirementConfirmed, taskExecutionProblem } from './requirements.ts'
import { requirementDocumentProblem } from './requirement-commands.ts'
import { attachTeamReceipt, ownedTeamWork, releaseTeamWork, reserveTeamWork, syncTeamBoard, TEAM_WORKER_PRESET, teamsEnabled } from './team-delivery.ts'

type WriteMode = Parameters<typeof writeTask>[3]

export function activeDispatch(dispatch: { status?: string } | undefined): boolean {
  return dispatch?.status === 'starting' || dispatch?.status === 'running'
}

export async function startTeamImplementation(input: {
  ctx: Context; parent: Agent; state: TaskState; item: TaskItem; dispatch: ItemDispatch;
  cwd: string | undefined; mode: WriteMode; prompt: string; signal: AbortSignal; reuse: string | undefined
}): Promise<string> {
  const { ctx, parent, state, item, dispatch, cwd, mode, prompt, signal, reuse } = input
  const host = ctx.get('subagents') as (Context['subagents'] & {
    rootOf?: (agent: Agent) => Agent
    namesOf?: unknown
  }) | undefined
  const plan = item.execution_plan!
  if (host?.rootOf?.(parent) !== parent || state.delivery?.parent_session !== parent.id)
    throw new Error('团队派发需要登记该任务的原始 Lead 会话。')
  if (!teamsEnabled(ctx, parent) || !host?.sendMessage || typeof host.namesOf !== 'function' || !host.getProvider('spawn')?.capabilities.agentPreset)
    throw new Error('团队执行需要开启 DSH Agent Teams、原生消息及支持独立预设的 spawn 后端。')
  const child = SessionId(reuse ?? randomUUID())
  const root = state.root ?? cwd!
  const key = executionPlanKey(plan)
  const validate = async (): Promise<boolean> => {
    const current = await loadTask(ctx.fs, state.id, cwd)
    const candidate = current.items.find(entry => entry.id === item.id)
    const flow = current.flow?.config
    const target = candidate?.dispatch
    return !current.completed && !taskExecutionProblem(current) && current.stage === state.stage
      && current.root === state.root && !!flow && requirementConfirmed(current, flow)
      && !await requirementDocumentProblem(ctx.fs, current, cwd)
      && target?.run_id === child && target.at === dispatch.at && activeDispatch(target)
      && plan.files.every(file => current.files.includes(file))
      && !!candidate?.execution_plan && executionPlanKey(candidate.execution_plan) === key
  }
  const run = reserveTeamWork(parent, state.id, item.id, child, root, plan.files, validate)
  dispatch.team = {}
  dispatch.run_id = child
  dispatch.status = 'starting'
  let reserved = false
  try {
    await writeTask(ctx.fs, state, cwd, mode)
    reserved = true
    await syncTeamBoard(ctx, parent, state.id, item.id, item.title, plan.files, dispatch)
    if (dispatch.team.board_problem) throw new Error(dispatch.team.board_problem)
    const content = [{ type: 'text' as const, text: prompt }]
    let message: string | undefined
    if (reuse) {
      const previous = item.dispatch_history?.at(-1)
      dispatch.team.member = previous?.team?.member ?? child
      message = await host.sendMessage(parent, child, content, { signal })
    } else {
      const activation = await startTaskActivation(host, { provider: 'spawn', childId: child, agentPreset: TEAM_WORKER_PRESET,
        label: state.id + '/' + item.id, parent, cwd: root, prompt: content, maxDepth: 3, signal, delivery: 'parent' })
      dispatch.team.member = activation.name ?? child
      message = activation.messageId
    }
    if (!message || !run.activation) throw new Error('DSH 已接收消息，但未观察到对应原生执行；关闭本轮文件权限并使用 recover_dispatch。')
    dispatch.status = 'running'
    dispatch.team.activation_id = run.activation
    dispatch.team.message_id = message
    await syncTeamBoard(ctx, parent, state.id, item.id, item.title, plan.files, dispatch)
    await writeTask(ctx.fs, state, cwd, mode)
    attachTeamReceipt(run, dispatch, message)
  } catch (error) {
    run.admission.resolve(undefined)
    if (!reserved) { releaseTeamWork(run); throw error }
    const message = error instanceof Error ? error.message : String(error)
    if (run.activation) throw new Error('团队派发未能提交完整回执。请 wait_agent 后用 recover_dispatch：' + message)
    dispatch.status = 'failed'
    dispatch.error = message
    dispatch.finished_at = new Date().toISOString()
    item.status = 'todo'
    releaseTeamWork(run)
    await syncTeamBoard(ctx, parent, state.id, item.id, item.title, plan.files, dispatch)
    await writeTask(ctx.fs, state, cwd, mode)
    throw new Error('团队派发失败：' + message)
  }
  return JSON.stringify({ item_id: item.id, dispatch,
    next_action: '可 dispatch 文件独立的实施项。用原生 wait_agent 等候，再用 dev_task team_collect 收取；测试回执和验收由 Lead 完成。' })
}

export async function manageTeamImplementation(input: {
  ctx: Context; parent: Agent | undefined; state: TaskState; item: TaskItem; cwd: string | undefined; mode: WriteMode;
  operation: 'team_collect' | 'team_cancel'; signal: AbortSignal
}): Promise<string> {
  const { ctx, parent, state, item, cwd, mode, operation, signal } = input
  const dispatch = item.dispatch
  if (!dispatch?.team || !dispatch.run_id || !parent || dispatch.parent_session !== parent.id)
    throw new Error('此操作需要该实施轮次的原始 Lead 会话和团队执行记录。')
  const run = ownedTeamWork(parent, state.id, item.id, dispatch.run_id)
  if (operation === 'team_cancel') {
    if (!activeDispatch(dispatch) || run?.outcome) throw new Error('该轮已结束；用 team_collect 收取状态。')
    if (!run) throw new Error('当前进程缺少该轮执行证明；请从宿主停止该成员并运行 recover_dispatch。')
    if (!run.cancelled) {
      const host = ctx.get('subagents')
      if (!host?.interrupt) throw new Error('DSH 中断服务不可用，请从宿主停止该成员。')
      host.interrupt(run.child, { kind: 'ancestor', agent: parent })
      run.cancelled = true
    }
    dispatch.team.cancelled = true
    await writeTask(ctx.fs, state, cwd, mode)
    return JSON.stringify({ item_id: item.id, cancel_requested: true, next_action: '等候成员停止后用 team_collect 收取；停止期间仍保留文件范围。' })
  }
  if (activeDispatch(dispatch)) {
    if (!run) throw new Error('当前进程缺少该轮执行证明；用 recover_dispatch 核实宿主活动并恢复为可重试状态。')
    if (!run.outcome) return JSON.stringify({ item_id: item.id, dispatch, next_action: '执行尚未结束，请用原生 wait_agent 等候。' })
    const valid = await run.validate().catch(() => false)
    const accepted = !!dispatch.team.message_id && !!run.authorizedTurn && !!dispatch.team.activation_id
      && dispatch.team.activation_id === run.outcome.runId && !run.cancelled && !run.unexpectedInput && valid
    dispatch.status = accepted && run.outcome.stopReason === 'completed' ? 'completed' : 'failed'
    dispatch.finished_at = new Date().toISOString()
    dispatch.output = run.outcome.lastAssistantMessage?.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').slice(0, 24_000) ?? ''
    if (dispatch.status === 'failed') {
      item.status = 'todo'
      dispatch.error = run.cancelled ? '团队执行已取消。' : !accepted ? '本轮授权、消息或需求版本未能核实。' : run.outcome.stopReason
    }
  }
  signal.throwIfAborted()
  await syncTeamBoard(ctx, parent, state.id, item.id, item.title, item.execution_plan?.files ?? [], dispatch)
  await writeTask(ctx.fs, state, cwd, mode)
  if (run) releaseTeamWork(run)
  return JSON.stringify({ item_id: item.id, dispatch,
    next_action: dispatch.status === 'completed' ? 'Lead 检查交付，执行 verify 和计划要求的审核，再用 accept_item。' : '确认遗留工作树改动后，用 team_resume 复用成员或 dispatch 新派发。' })
}
