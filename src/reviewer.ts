/** Agent-scoped reviewer: hide inherited tools and deny every non-review execution, including nested calls. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { REVIEW_PRESET, REVIEW_TOOLS } from './reviewer-spec.ts'
import type {} from './reviewer-policy.ts'
import { installPresetExecutor, presentNativeTools } from './tool-executor-compat.ts'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

export const name = 'task-engine-reviewer'
export const inject = ['tools', 'systemPrompt', 'taskEngineReviewPolicy']
/** Install restrictions on the Agent, where preset tools are inherited and result capture is local. */
function installGuard(ctx: Context, agent: Agent): void {
  presentNativeTools(ctx)
  const available = new Set(ctx.tools.schemas(agent).map(tool => tool.name))
  ctx.tools.restrict({ allow: ['read', 'glob', 'grep'].filter(name => available.has(name)) })
  ctx.tools.guard(exec => (REVIEW_TOOLS as readonly string[]).includes(exec.name) ? undefined : 'Task reviewer is read-only; only read, glob, grep and structured_output are permitted')
}
/** Presets are shared compositions; each bound Agent owns its restrictions and their cleanup. */
export async function apply(ctx: Context): Promise<void> {
  await installPresetExecutor(ctx)
  // The host routes these listeners to this preset's Agents. Do not inspect
  // private scope Symbols from another installed/source module instance.
  const prepared = new Map<Agent, Scope>()
  const prepare = (agent: Agent): void => {
    if (!prepared.has(agent)) {
      const scope = createScope(agent.ctx, agent)
      try { installGuard(scope.ctx, agent); prepared.set(agent, scope) }
      catch (error) { void scope.dispose(); throw error }
    }
  }
  ctx.on('agent-preset/selected', id => {
    for (const [agent, scope] of prepared) if (agent.id === id) {
      prepared.delete(agent)
      ctx.taskEngineReviewPolicy.forget(id)
      void scope.dispose().catch(error => ctx.logger.warn(`Reviewer cleanup: ${String(error)}`))
    }
  })
  // Agent disposal owns the scope's effects. Keep the bounded final policy
  // receipt so the parent can validate an already completed child.
  ctx.on('agent/disposed', ({ agent }) => { prepared.delete(agent) })
  ctx.effect(() => async () => {
    for (const agent of prepared.keys()) ctx.taskEngineReviewPolicy.forget(agent.id)
    await Promise.all([...prepared.values()].map(scope => scope.dispose())); prepared.clear()
  })
  ctx.on('agent/created', async ({ agent }) => { await prepare(agent) })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const agent = context.agent ?? context.scope as Agent | undefined
    if (agent?.ctx) await prepare(agent)
    const assembly = await next()
    // A listener installed during this assembly is absent from its middleware
    // snapshot. Record here so the first assembly also proves the actual view.
    if (agent?.ctx) ctx.taskEngineReviewPolicy.record({ version: 1, preset: REVIEW_PRESET,
      child_id: agent.id, tools: ctx.tools.schemas(agent).map(tool => tool.name) })
    return assembly
  })
}
