/**
 * Frozen-snapshot integrity: the canonical hash of a workflow config.
 *
 * Lives outside {@link ../engine} because the browser client bundles engine
 * (for `validateWorkflow`) but must never pull `node:crypto`; the tool plane
 * and the commit hook import this module directly, both on the Node platform.
 *
 * @module dsh-task-engine/snapshot
 */

import { createHash } from 'node:crypto'
import type { WorkflowConfig } from './engine.ts'

/**
 * SHA-256 of arbitrary text; the integrity primitive behind both the frozen
 * config hash and the installed-hook integrity check.
 */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * SHA-256 of a workflow config's canonical JSON, the frozen-snapshot integrity
 * stamp. The same JSON object re-serializes byte-identically, so a task record
 * whose `config` was hand-edited after creation no longer matches its `hash`.
 */
export function hashConfig(config: WorkflowConfig): string {
  return hashText(JSON.stringify(config))
}