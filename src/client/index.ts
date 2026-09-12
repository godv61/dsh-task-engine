/**
 * Browser half of dsh-task-engine: a full-screen "工程流程" workbench plus a
 * sidebar trigger. It mounts the `task-engine` Remote namespace, then registers
 * two slot entries that share one visibility store — the `sidebar.footer.action`
 * trigger opens it, and the `shell.overlay` panel renders it over the whole
 * app frame. The workbench hosts three tabs: the flow editor, the skill
 * manager, and the rule manager.
 *
 * @module dsh-task-engine/client
 */

import TYPERT_REMOTE from './remote.ts'
import type { TaskEngineRemote } from './TaskEngineSection.tsx'
import { Workbench } from './Workbench.tsx'
import { TriggerButton } from './TriggerButton.tsx'
import { createVisibilityStore } from './visibility.ts'

export const inject = ['remote', 'slots']

/** Narrowed browser context: only the services this half reads. */
interface ClientCtx {
  remote: {
    $mount(contribution: unknown): Promise<() => Promise<void>>
  }
  slots: {
    inject(name: string, focus: () => unknown): unknown
    register(entry: unknown, component: unknown): unknown
  }
  get(name: string): unknown
}

/**
 * Mount the `task-engine` Remote namespace, then register the trigger and the
 * overlay with one shared store.
 * @param ctx - the browser plugin context.
 * @returns disposer that unmounts the Remote contribution; the slot
 *   registrations leave with this plugin's own fiber.
 */
export async function apply(ctx: ClientCtx): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)

  // The namespace is a `remote.task-engine` service in the global store, not a
  // context-proxy property: this plugin both mounts and consumes it, so declaring
  // it in `inject` would deadlock (the fiber waits on a service its own apply
  // provides). `ctx.get` reads the global store without that enforcement.
  const taskEngine = ctx.get('remote.task-engine') as TaskEngineRemote | undefined
  if (taskEngine === undefined) {
    await disposeRemote()
    throw new Error('task-engine: remote.task-engine namespace failed to mount')
  }

  // One store handle connects the trigger and the overlay; the framework caches
  // a single instance per handle × root scope, so a trigger click and the
  // panel's close button read/write the same `open` fact.
  const visibility = createVisibilityStore()

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'task-engine',
    order: 100,
    store: visibility,
    inject: () => ({ remote: taskEngine }),
  }, Workbench))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'task-engine',
    order: 100,
    store: visibility,
  }, TriggerButton))

  return async () => {
    await disposeRemote()
  }
}