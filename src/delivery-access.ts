/** Per-agent intent guard. Analysis cannot gain write/terminal/delegation capabilities through nested tool calls. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TaskState } from './engine.ts'
import type { DeliveryIntent } from './delivery-contract.ts'

type AccessMode = DeliveryIntent | 'pending'
const modes = new WeakMap<object, AccessMode>()
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
  if ((intent === 'analysis' || intent === 'pending') && !presentationUndo.has(agent) && context?.tools) {
    const restorePresentation = context.tools.presentAs('native')
    const available = new Set(context.tools.schemas(agent as Agent).map(tool => tool.name))
    const restoreTools = context.tools.restrict({ allow: [...(intent === 'pending' ? entryTools : readTools)].filter(name => available.has(name)) })
    presentationUndo.set(agent, () => { restoreTools(); restorePresentation() })
  }
  else if (intent !== 'analysis' && intent !== 'pending') { presentationUndo.get(agent)?.(); presentationUndo.delete(agent) }
  if (intent) modes.set(agent, intent)
  else modes.delete(agent)
}
export function analysisAccessProblem(agent: object | undefined, name: string, args?: unknown): string | undefined {
  if (agent && modes.get(agent) === 'pending' && !entryTools.has(name)) return 'Before repository tools, select the user deliverable through dev_task: status/create intent=analysis for diagnosis/proposal, or intent=implementation for requested code changes. Ordinary questions can be answered directly. No tool was executed.'
  const operation = (args as { operation?: string } | undefined)?.operation
  const metadataSafe = name !== 'dev_task' || ['status', 'config', 'assess', 'create', 'delegate', 'submit_analysis', 'recover_analysis', 'complete'].includes(operation ?? '')
  return agent && modes.get(agent) === 'analysis' && (!readTools.has(name) || !metadataSafe)
    ? 'This task is analysis-only. Use read/glob/grep and submit source evidence. Implementation or command side effects require a separately authorized implementation task.' : undefined
}
export function installDeliveryAccess(ctx: Context, restore: (agent: Agent) => Promise<TaskState | undefined>): void {
  const aliases = ctx.tools.schemas?.().filter(tool => untrackedDelegationProblem(tool.name)).map(tool => tool.name) ?? []
  if (aliases.length) ctx.tools.restrict?.({ deny: aliases })
  ctx.tools.guard?.(exec => untrackedDelegationProblem(exec.name) ?? analysisAccessProblem(exec.agent, exec.name, exec.arguments))
  if (!ctx.on) return
  const restored = new WeakSet<object>()
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent ?? context.scope as Agent | undefined
    if (agent?.session && !restored.has(agent)) {
      const state = await restore(agent)
      bindDeliveryIntent(agent, state ? state.delivery?.intent : 'pending')
      restored.add(agent)
    }
    return next()
  })
}
