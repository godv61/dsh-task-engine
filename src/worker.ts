import type { Context } from '@deepseek-ai/cordis'
import { installPresetExecutor } from './tool-executor-compat.ts'
import { admitTeamWorkerStep, teamWorkerToolProblem, teamWorkerTools } from './team-delivery.ts'

export const name = 'task-engine-worker'
export const inject = ['tools']

export async function apply(ctx: Context): Promise<void> {
  await installPresetExecutor(ctx)
  ctx.tools.restrict({ allow: ctx.tools.schemas().map(tool => tool.name).filter(name => teamWorkerTools.has(name)) })
  ctx.on('agent/pre-step', async ({ agent, turn, step, messages }, next) =>
    await admitTeamWorkerStep(agent, turn, step, messages) ? next() : { kind: 'reject', reason: 'team work admission is missing or stale' })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const presentation = await next()
    return { ...presentation, sections: presentation.sections.map(section => section.name === 'team:policy'
      ? { ...section, text: 'Your Lead coordinates the Team board and continuations. Follow the admitted work brief and report your implementation to the Lead.' }
      : section) }
  })
  ctx.tools.guard(exec => teamWorkerToolProblem(exec.agent, exec.name, exec.arguments))
}
