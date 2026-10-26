/** Agent-scoped reviewer: hide inherited tools and deny every non-review execution, including nested calls. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { REVIEW_PRESET, REVIEW_TOOLS } from './reviewer-spec.ts'
import type {} from './reviewer-policy.ts'

export const name = 'task-engine-reviewer'
export const inject = ['tools', 'systemPrompt', 'taskEngineReviewPolicy']
/** Install restrictions on the Agent, where preset tools are inherited and result capture is local. */
function installGuard(ctx: Context, agent: Agent): void {
  ctx.tools.presentAs('native')
  ctx.tools.restrict({ allow: ['read'] })
  ctx.tools.guard(exec => (REVIEW_TOOLS as readonly string[]).includes(exec.name) ? undefined : 'Task reviewer is read-only; only read and structured_output are permitted')
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (context.scope !== agent && context.agent !== agent) return assembly
    const tools = ctx.tools.schemas(agent).map(tool => tool.name)
    ctx.taskEngineReviewPolicy.record({ version: 1, preset: REVIEW_PRESET, child_id: agent.id, tools })
    return assembly
  })
}
/** Presets are shared compositions; each bound Agent owns its restrictions and their cleanup. */
export function apply(ctx: Context): void {
  // The host routes these listeners to this preset's Agents. Do not inspect
  // private scope Symbols from another installed/source module instance.
  const prepared = new WeakMap<Agent, Promise<unknown>>()
  const prepare = (agent: Agent): Promise<unknown> => {
    let pending = prepared.get(agent)
    if (!pending) {
      pending = Promise.resolve(agent.ctx.plugin({ name: 'task-engine-reviewer-guard', inject,
        apply: (agentCtx: Context) => installGuard(agentCtx, agent) }))
      prepared.set(agent, pending)
    }
    return pending
  }
  ctx.on('agent/created', async ({ agent }) => { await prepare(agent) })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent ?? context.scope as Agent | undefined
    if (agent?.ctx) await prepare(agent)
    return next()
  })
}
