/**
 * Agent half of dsh-task-engine: registers the model-facing `dev_task` tool and
 * the shipped engineering skills onto the calling (preset) scope. Name this row
 * from a preset's `agent.cordis.yml` to activate the delivery flow for that
 * preset's sessions; presets that never name it see neither the tool nor the
 * skills.
 *
 * @module dsh-task-engine/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerDevTask } from './dev-task.ts'
import { registerShippedSkills } from './shipped-skills.ts'

export const name = 'task-engine-agent'
export const inject = ['tools', 'fs']

export function apply(ctx: Context): void {
  registerDevTask(ctx)
  registerShippedSkills(ctx)
}