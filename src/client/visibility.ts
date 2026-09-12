/**
 * Shared viewing state for the task-engine workbench: whether the full-screen
 * panel is open. One handle is created in `apply` and passed to both the
 * sidebar trigger and the `shell.overlay` workbench, so a click on the trigger
 * opens the panel and the panel's close button closes it again.
 *
 * @module dsh-task-engine/visibility
 */

import { defineStore, type EngineStoreHandle, type Baked } from '@deepseek-ai/dsh-client-store'

/** The single fact the two slots share. */
export interface VisibilityState {
  open: boolean
}

/** Baked actions: the engine drops the draft parameter before calling these. */
export type VisibilityActions = Baked<{
  open: (state: VisibilityState) => void
  close: (state: VisibilityState) => void
}>

export function createVisibilityStore(): EngineStoreHandle<VisibilityState, VisibilityActions> {
  return defineStore<VisibilityState, {
    open: (state: VisibilityState) => void
    close: (state: VisibilityState) => void
  }>({
    init: (): VisibilityState => ({ open: false }),
    actions: {
      open: (d: VisibilityState) => { d.open = true },
      close: (d: VisibilityState) => { d.open = false },
    },
  })
}