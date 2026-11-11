/** Per-agent intent guard. Analysis cannot gain write/terminal/delegation capabilities through nested tool calls. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as hostScope from '@deepseek-ai/dsh-scope'
import type { TaskState } from './engine.ts'
import type { DeliveryIntent } from './delivery-contract.ts'
import { requirementConfirmed, taskExecutionProblem } from './requirements.ts'
import { requirementDocumentProblem } from './requirement-commands.ts'
import { loadTask } from './task-store.ts'
import { commandName, commandWords } from './command-words.ts'
import { resolve } from 'node:path'
import { presentNativeTools } from './tool-executor-compat.ts'
import { executionCapabilities } from './execution-plan.ts'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

type AccessMode = DeliveryIntent | 'pending' | 'requirements' | 'history'
const modes = new WeakMap<object, AccessMode>()
const requirementChecks = new WeakMap<object, () => Promise<string | undefined>>()
const presentationUndo = new WeakMap<object, () => void>()
const unrestrictedTools = new WeakMap<object, ReadonlySet<string>>()
const plannedCommands = new WeakMap<object, { task: string; root?: string; groups: { id: string; words: string[] }[] }>()
const readTools = new Set(['read', 'glob', 'grep', 'skill', 'working_directory', 'ask_user_question', 'dev_task', 'structured_output', 'list_agents'])
const entryTools = new Set(['dev_task', 'working_directory', 'skill', 'ask_user_question'])
const commandTools = ['pwsh', 'powershell', 'bash', 'sh', 'shell', 'terminal', 'exec_command']
export function untrackedDelegationProblem(name: string): string | undefined {
  return /^(?:spawn_teammate$|subagent(?:_|$)|send_message$|interrupt_agent$|workflow(?:_|$)|ralph(?:_|$))/u.test(name)
    ? 'Engineering delegation must be tracked. No delegation action was executed. Use dev_task delegate only for an active intent=analysis task with questions, delegation_benefit and execution_reason; for implementation use plan_execution/dispatch in development. Start a linked follow-up for new work after archival.' : undefined
}
export function bindDeliveryIntent(agent: object | undefined, intent: AccessMode | undefined): void {
  if (!agent) return
  if (intent !== 'implementation') plannedCommands.delete(agent)
  const context = (agent as Agent).ctx
  if (modes.get(agent) !== intent) { presentationUndo.get(agent)?.(); presentationUndo.delete(agent) }
  if (!intent) unrestrictedTools.delete(agent)
  else if (!presentationUndo.has(agent) && typeof context?.tools?.schemas === 'function') {
    // Read the preset inventory before applying our own intent restriction.
    unrestrictedTools.set(agent, new Set(context.tools.schemas(agent as Agent).map(tool => tool.name)))
  }
  if ((intent === 'analysis' || intent === 'pending' || intent === 'requirements' || intent === 'history') && !presentationUndo.has(agent) && context?.tools) {
    const restorePresentation = presentNativeTools(context)
    const available = new Set(context.tools.schemas(agent as Agent).map(tool => tool.name))
    const parentOf = (hostScope as { scopeParentOf?: (scope: object) => object | undefined }).scopeParentOf
    // The host only masks inherited registrations. Agent-local Teams tools are
    // checked at execution, even if their schemas remain visible in that scope.
    const inherited = new Set(context.tools.schemas(parentOf?.(agent)).map(tool => tool.name))
    const restoreTools = context.tools.restrict({ allow: [...(intent === 'pending' ? entryTools : readTools)]
      .filter(name => available.has(name) && inherited.has(name)) })
    presentationUndo.set(agent, () => { restoreTools(); restorePresentation() })
  }
  else if (intent !== 'analysis' && intent !== 'pending' && intent !== 'requirements' && intent !== 'history') { presentationUndo.get(agent)?.(); presentationUndo.delete(agent) }
  if (intent) modes.set(agent, intent)
  else modes.delete(agent)
}

/** Validate the Lead's own tools separately from the host's managed providers. */
export function executionPathProblem(ctx: Context, agent: Agent | undefined, intent: DeliveryIntent,
  options: { mainOnly?: boolean; needsCommit?: boolean } = {}): string | undefined {
  if (!agent) return undefined
  const available = unrestrictedTools.get(agent)
    ?? (typeof ctx.tools.schemas === 'function' ? new Set(ctx.tools.schemas(agent).map(tool => tool.name)) : undefined)
  if (!available) return undefined
  const terminal = commandTools.some(name => available.has(name))
  const canRead = available.has('read') || available.has('grep')
  const direct = intent === 'analysis' ? canRead : terminal || canRead && (available.has('edit') || available.has('write'))
  const managed = options.mainOnly || direct ? false : (() => {
    const capabilities = executionCapabilities(ctx, true)
    return intent === 'analysis' ? capabilities.reviewer : capabilities.spawn || capabilities.fork
  })()
  if (!direct && !managed) return intent === 'analysis'
    ? '当前会话缺少源码读取工具和受控只读取证路径；请切换到可读源码的工程化开发引擎预设。'
    : '当前会话缺少直接实施工具和受控实施派发路径；请切换到具备工作区执行能力的工程化开发引擎预设。'
  if (intent === 'implementation' && options.needsCommit && !terminal) {
    return '当前会话缺少主会话终端，无法完成本流程要求的 Git 提交；请切换到具备终端的工程化开发引擎预设。'
  }
}
function bindPlannedCommands(agent: object, state: TaskState): void {
  if (state.delivery?.intent !== 'implementation' || state.completed) { plannedCommands.delete(agent); return }
  plannedCommands.set(agent, { task: state.id, ...(state.root !== undefined ? { root: state.root } : {}), groups: Object.values(state.verification_groups ?? {}).flatMap(group => {
    const words = commandWords(group.command)
    return words?.length ? [{ id: group.id, words: [commandName(words[0]), ...words.slice(1)] }] : []
  }) })
}

/** Route an already planned exact test invocation through its receipt owner.
 * Other terminal diagnostics and unplanned exploratory commands remain available.
 */
export function nativeVerificationProblem(agent: object | undefined, name: string, args?: unknown): string | undefined {
  if (!agent || modes.get(agent) !== 'implementation' || !commandTools.includes(name)) return undefined
  const input = args as { command?: unknown; script?: unknown; workdir?: unknown; cwd?: unknown } | undefined
  const command = input?.command ?? input?.script
  if (typeof command !== 'string') return undefined
  const binding = plannedCommands.get(agent), words = commandWords(command)
  if (!binding || !words?.length) return undefined
  const directory = input?.workdir ?? input?.cwd
  const canonical = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
  if (binding.root && typeof directory === 'string' && canonical(resolve(binding.root, directory)) !== canonical(resolve(binding.root))) return undefined
  const normalized = [commandName(words[0]), ...words.slice(1)]
  const group = binding.groups.find(entry => entry.words.length === normalized.length && entry.words.every((word, index) => word === normalized[index]))
  return group ? `This exact test command is registered as ${group.id}. No command was executed. Use dev_task ${JSON.stringify({ operation: 'verify', task_id: binding.task, verification_group: group.id })}; verify executes the real test itself and captures its receipt, timeout and environment recovery. Do not run the same planned suite in a native terminal first.` : undefined
}
export async function bindTaskDelivery(ctx: Context, agent: Agent | undefined, state: TaskState): Promise<void> {
  if (!agent) return
  const policy = state.flow?.config.requirement_review
  if ((!policy && !taskExecutionProblem(state)) || state.completed) { requirementChecks.delete(agent); bindDeliveryIntent(agent, state.completed ? 'history' : state.delivery?.intent); bindPlannedCommands(agent, state); return }
  const check = async () => {
    const current = await loadTask(ctx.fs, state.id, agent.session.header.cwd)
    if (current.completed) { requirementChecks.delete(agent); bindDeliveryIntent(agent, 'history'); return undefined }
    const problem = taskExecutionProblem(current) ?? (!requirementConfirmed(current, current.flow!.config) ? '需求尚未由用户确认；先澄清并确认当前需求总结，再修改代码或执行命令'
      : await requirementDocumentProblem(ctx.fs, current, agent.session.header.cwd)
    )
    bindDeliveryIntent(agent, problem ? 'requirements' : current.delivery?.intent)
    bindPlannedCommands(agent, current)
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
    && !['status', 'assess', 'config', 'create', 'load_skill', 'record', 'scope', 'revise', 'advance', 'clarify_requirement', 'prepare_requirement', 'confirm_requirement', 'write_requirement_material', 'retire_requirement_material'].includes(operation ?? '')))
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
  ctx.tools.guard?.(exec => untrackedDelegationProblem(exec.name) ?? analysisAccessProblem(exec.agent, exec.name, exec.arguments)
    ?? nativeVerificationProblem(exec.agent, exec.name, exec.arguments))
  if (!ctx.on) return
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent) {
      const problem = await requirementChecks.get(exec.agent)?.()
      if (problem && !readTools.has(exec.name)) return { kind: 'deny', reason: problem }
      const planned = nativeVerificationProblem(exec.agent, exec.name, exec.arguments)
      if (planned) return { kind: 'deny', reason: planned }
    }
    return next()
  })
  const restored = new WeakSet<object>()
  const agents = new Map<string, Agent>()
  const clear = (agent: Agent) => {
    bindDeliveryIntent(agent, undefined)
    requirementChecks.delete(agent)
    restored.delete(agent)
    agents.delete(agent.id)
  }
  ctx.on('agent-preset/selected', id => { const agent = agents.get(id); if (agent) clear(agent) })
  ctx.on('agent/disposed', ({ agent }) => { clear(agent) })
  ctx.effect(() => () => { for (const agent of agents.values()) clear(agent) })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent ?? context.scope as Agent | undefined
    if (agent?.session) agents.set(agent.id, agent)
    if (agent?.session && !restored.has(agent)) {
      const state = await restore(agent)
      if (state) await bindTaskDelivery(ctx, agent, state)
      else bindDeliveryIntent(agent, 'pending')
      restored.add(agent)
    } else if (agent) await requirementChecks.get(agent)?.()
    return next()
  })
}
