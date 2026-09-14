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

/**
 * Host integration surface (0.22.4): authorize a session workspace for the
 * Remote, and opt into strict mode where unregistered paths are rejected
 * instead of falling back to the defensive path check. See README「host 集成 API」.
 */
export { enableStrictWorkspaces, registerWorkspace } from './controller.ts'