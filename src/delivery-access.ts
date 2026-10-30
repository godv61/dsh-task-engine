/** Per-agent intent guard. Analysis cannot gain write/terminal/delegation capabilities through nested tool calls. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TaskState } from './engine.ts'
import type { DeliveryIntent } from './delivery-contract.ts'
import { requirementConfirmed, taskExecutionProblem } from './requirements.ts'
import { requirementDocumentProblem } from './requirement-commands.ts'
import { loadTask } from './task-store.ts'

type AccessMode = DeliveryIntent | 'pending' | 'requirements' | 'history'
const modes = new WeakMap<object, AccessMode>()
const requirementChecks = new WeakMap<object, () => Promise<string | undefined>>()
const presentationUndo = new WeakMap<object, () => void>()
const readTools = new Set(['read', 'glob', 'grep', 'skill', 'working_directory', 'ask_user_question', 'dev_task', 'structured_output', 'list_agents'])
const entryTools = new Set(['dev_task', 'working_directory', 'skill', 'ask_user_question'])
export function untrackedDelegationProblem(name: string): string | undefined {
  return /^(?:subagent(?:_|$)|send_message$|workflow(?:_|$)|ralph(?:_|$))/u.test(name)
    ? 'Engineering delegation must be tracked. No child was started by this call. For read-only work create intent=analysis, then use dev_task delegate with questions, delegation_benefit and execution_reason; for implementation use plan_execution/dispatch. Do not retry a native subagent alias.' : undefined
}
export function bindDeliveryIntent(agent: object | undefined, intent: AccessMode | undefined): void {
  if (!agent) return
  const context = (agent as Agent).ctx
  if (modes.get(agent) !== intent) { presentationUndo.get(agent)?.(); presentationUndo.delete(agent) }
  if ((intent === 'analysis' || intent === 'pending' || intent === 'requirements' || intent === 'history') && !presentationUndo.has(agent) && context?.tools) {
    const restorePresentation = context.tools.presentAs('native')
    const available = new Set(context.tools.schemas(agent as Agent).map(tool => tool.name))
    const restoreTools = context.tools.restrict({ allow: [...(intent === 'pending' ? entryTools : readTools)].filter(name => available.has(name)) })
    presentationUndo.set(agent, () => { restoreTools(); restorePresentation() })
  }
  else if (intent !== 'analysis' && intent !== 'pending' && intent !== 'requirements' && intent !== 'history') { presentationUndo.get(agent)?.(); presentationUndo.delete(agent) }
  if (intent) modes.set(agent, intent)
  else modes.delete(agent)
}
export async function bindTaskDelivery(ctx: Context, agent: Agent | undefined, state: TaskState): Promise<void> {
  if (!agent) return
  const policy = state.flow?.config.requirement_review
  if ((!policy && !taskExecutionProblem(state)) || state.completed) { requirementChecks.delete(agent); bindDeliveryIntent(agent, state.completed ? 'history' : state.delivery?.intent); return }
  const check = async () => {
    const current = await loadTask(ctx.fs, state.id, agent.session.header.cwd)
    if (current.completed) { requirementChecks.delete(agent); bindDeliveryIntent(agent, 'history'); return undefined }
    const problem = taskExecutionProblem(current) ?? (!requirementConfirmed(current, current.flow!.config) ? '需求尚未由用户确认；先澄清并确认当前需求总结，再修改代码或执行命令'
      : await requirementDocumentProblem(ctx.fs, current, agent.session.header.cwd)
    )
    bindDeliveryIntent(agent, problem ? 'requirements' : current.delivery?.intent)
    return problem
  }
  requirementChecks.set(agent, check)
  await check()
}
export function analysisAccessProblem(agent: object | undefined, name: string, args?: unknown): string | undefined {
  if (agent && modes.get(agent) === 'pending' && !entryTools.has(name)) return 'Before repository tools, select the user deliverable through dev_task: status/create intent=analysis for diagnosis/proposal, or intent=implementation for requested code changes. Ordinary questions can be answered directly. No tool was executed.'
  const operation = (args as { operation?: string } | undefined)?.operation
  if (agent && modes.get(agent) === 'history' && (!readTools.has(name) || name === 'dev_task'
    && !['status', 'config', 'assess', 'create'].includes(operation ?? '')))
    return '此任务为历史记录，仅可查看；继续工作请创建新任务。'
  if (agent && modes.get(agent) === 'requirements' && (!readTools.has(name) || name === 'dev_task'
    && !['status', 'assess', 'config', 'create', 'load_skill', 'record', 'scope', 'revise', 'advance', 'clarify_requirement', 'prepare_requirement', 'confirm_requirement'].includes(operation ?? '')))
    return '需求尚未由用户确认；可以查阅、澄清和整理需求，不能修改业务文件、执行命令或启动实施'
  if (agent && modes.get(agent) === 'requirements' && name === 'dev_task' && operation === 'create'
    && !['analysis', 'implementation'].includes((args as { intent?: string }).intent ?? '')) return '当前处于需求确认阶段，新任务必须明确 intent=analysis|implementation，不能退回旧调用绕过确认'
  const metadataSafe = name !== 'dev_task' || ['status', 'config', 'assess', 'create', 'delegate', 'submit_analysis', 'recover_analysis', 'complete'].includes(operation ?? '')
  return agent && modes.get(agent) === 'analysis' && (!readTools.has(name) || !metadataSafe)
    ? 'This task is analysis-only. Use read/glob/grep and submit source evidence. Implementation or command side effects require a separately authorized implementation task.' : undefined
}
export function installDeliveryAccess(ctx: Context, restore: (agent: Agent) => Promise<TaskState | undefined>): void {
  const aliases = ctx.tools.schemas?.().filter(tool => untrackedDelegationProblem(tool.name)).map(tool => tool.name) ?? []
  if (aliases.length) ctx.tools.restrict?.({ deny: aliases })
  ctx.tools.guard?.(exec => untrackedDelegationProblem(exec.name) ?? analysisAccessProblem(exec.agent, exec.name, exec.arguments))
  if (!ctx.on) return
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent) {
      const problem = await requirementChecks.get(exec.agent)?.()
      if (problem && !readTools.has(exec.name)) return { kind: 'deny', reason: problem }
    }
    return next()
  })
  const restored = new WeakSet<object>()
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent ?? context.scope as Agent | undefined
    if (agent?.session && !restored.has(agent)) {
      const state = await restore(agent)
      if (state) await bindTaskDelivery(ctx, agent, state)
      else bindDeliveryIntent(agent, 'pending')
      restored.add(agent)
    } else if (agent) await requirementChecks.get(agent)?.()
    return next()
  })
}
