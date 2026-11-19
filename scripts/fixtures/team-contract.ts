// Compiled against the installed public rc.5 declarations by verify:preset.
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-team'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivationSpec, SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'

export async function checkTeamContract(ctx: Context, agent: Agent, spec: SubagentActivationSpec & { childId: SessionId }) {
  const board = ctx.agentTeams
  if (!board.isEnabled(agent) || ctx.subagents.rootOf(agent) !== agent) throw new Error('Team Lead required')
  const task = await board.createTask(agent, { subject: 'Scoped delivery', description: 'Engineering item', writeScopes: ['example.txt'] })
  const activation = await ctx.subagents.startActivation({ ...spec, agentPreset: 'task-engine-worker' })
  const view = await board.updateTask(agent, { taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: activation.childId })
  const continuation = await ctx.subagents.sendMessage(agent, activation.childId, spec.prompt, { signal: spec.signal })
  ctx.subagents.interrupt(activation.childId, { kind: 'ancestor', agent })
  ctx.on('subagent/end', (event: SubagentRunEndInfo) => {
    if (event.parentSessionId === agent.id && event.stopReason === 'completed') board.getTask(agent, view.id)
  })
  return { continuation, activationMessage: activation.messageId, name: activation.name, tasks: board.listTasks(agent) }
}
