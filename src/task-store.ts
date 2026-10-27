/** Host filesystem task store. All writers use the same sandbox policy, revision and atomic version intent. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { TaskState } from './engine.ts'
import { hashConfig } from './snapshot.ts'
type Fs = Context['fs']
export const taskPath = (id: string): string => `.dsh/task-${id.replace(/[^0-9a-zA-Z_-]/g, '-')}.json`
interface WritePolicy {
  mode: 'workspace-write' | 'danger-full-access'
  workspaceRoot: string
}

export type WriteFs = {
  resolve(relPath: string, opts?: { cwd?: string }): Promise<unknown>
  writeText(target: unknown, content: string, expected?: unknown, signal?: unknown, sandboxPolicy?: WritePolicy): Promise<unknown>
  lstat(path: string, opts?: { cwd?: string }, signal?: unknown): Promise<{ version: unknown } | undefined>
}

export async function readText(fs: Fs, relPath: string, cwd?: string): Promise<string | undefined> {
  try {
    const target = await fs.resolve(relPath, cwd !== undefined ? { cwd } : undefined)
    return await (fs as unknown as { readText(target: unknown): Promise<string> }).readText(target)
  } catch {
    return undefined
  }
}


export async function writeText(
  fs: Fs,
  relPath: string,
  content: string,
  cwd?: string,
  mode: 'workspace-write' | 'danger-full-access' = 'workspace-write',
  expected?: unknown,
): Promise<void> {
  const target = await fs.resolve(relPath, cwd !== undefined ? { cwd } : undefined)
  const policy: WritePolicy = { mode, workspaceRoot: cwd !== undefined ? cwd : process.cwd() }
  await (fs as unknown as WriteFs).writeText(target, content, expected, undefined, policy)
}


export async function loadTask(fs: Fs, id: string, cwd?: string): Promise<TaskState> {
  const raw = await readText(fs, taskPath(id), cwd)
  if (raw === undefined) throw new Error(`no task "${id}" under ${taskPath(id)}`)
  const state = JSON.parse(raw) as TaskState
  if (state.id !== id) throw new Error(`task id collision: ${taskPath(id)} contains "${state.id}" rather than "${id}"`)
  // Tasks recorded before these features lack the fields; treat them as empty
  // so every engine gate reads complete state instead of crashing on absence.
  state.artifacts = state.artifacts ?? {}
  state.files = state.files ?? []
  state.items = state.items ?? []
  state.commits = state.commits ?? []
  state.verification = state.verification ?? { passed: false, evidence: [] }
  state.review = state.review ?? { outcome: 'pending' }
  if (!state.completed && state.review.outcome === 'pass' && !state.review.scope_hash) state.review = { outcome: 'pending' }
  state.revision = state.revision ?? 0 // pre-0.23 records carry no revision; CAS treats them as 0
  if (state.flow?.hash !== undefined && hashConfig(state.flow.config) !== state.flow.hash) {
    throw new Error(
      `task "${id}" snapshot hash mismatch — the frozen workflow config was edited after creation. ` +
      'Restore the original record or recreate the task; the gate refuses to run on a tampered snapshot.',
    )
  }
  return state
}


export async function writeTask(fs: Fs, state: TaskState, cwd: string | undefined, mode: 'workspace-write' | 'danger-full-access'): Promise<void> {
  const path = taskPath(state.id)
  // Friendly fast-fail first: the logical revision must still be the one loaded.
  const info = await (fs as unknown as WriteFs).lstat(path, cwd !== undefined ? { cwd } : undefined)
  const onDiskRaw = await readText(fs, path, cwd)
  if (onDiskRaw === undefined) {
    state.revision = state.revision ?? 1 // first write of a fresh record keeps the factory revision
  } else {
    const onDisk = JSON.parse(onDiskRaw) as TaskState
    if ((onDisk.revision ?? 0) !== (state.revision ?? 0)) {
      throw new Error(
        `task "${state.id}" changed concurrently (record revision ${onDisk.revision ?? 0} vs the loaded revision ${state.revision ?? 0}) — reload status and retry this operation`,
      )
    }
    state.revision = (state.revision ?? 0) + 1
  }
  // Atomic guard: the write carries the file's current version as a
  // replace-if-version intent, so a concurrent write between our read and our
  // write fails with FS_STALE_VERSION instead of silently overwriting.
  const intent = info === undefined
    ? { kind: 'createIfAbsent' }
    : { kind: 'replaceIfVersion', version: info.version }
  try {
    state.updated_at = new Date().toISOString()
    await writeText(fs, path, JSON.stringify(state, null, 2), cwd, mode, intent)
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    if (code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED') {
      throw new Error(
        `task "${state.id}" changed concurrently (file version moved) — reload status and retry this operation`,
      )
    }
    throw error
  }
}
