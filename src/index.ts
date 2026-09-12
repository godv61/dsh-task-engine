/**
 * Host half of dsh-task-engine: mounts the `task-engine` Remote namespace that
 * the browser workbench reads/writes, plus the browser half (declared via
 * `dsh.client`), and seeds a pickable "工程化开发引擎" preset so activation is
 * a single preset switch. The model-facing `dev_task` tool and the shipped
 * engineering skills live on the AGENT plane (`./agent`), registered only in a
 * preset that names it.
 *
 * @module dsh-task-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import TaskEngineController from './controller.ts'
import { seedEngPreset } from './seed-preset.ts'

export const name = 'task-engine'

export function apply(ctx: Context): void {
  ctx.plugin(TaskEngineController)
  seedEngPreset()
}