/** Durable draft jobs. Browser disconnects do not own the model request; completed drafts survive restart. */
import { randomUUID } from 'node:crypto'
import type { ProjectInitStepResult } from './controller.ts'

export interface InitJobView {
  job_id: string
  status: 'running' | 'completed' | 'failed'
  updated_at: string
  result?: ProjectInitStepResult
  error?: string
  owner?: string
}
interface JobFs {
  resolve(path: string, options: { cwd: string }): Promise<unknown>
  readText(target: unknown): Promise<string | undefined>
  lstat(path: string, options: { cwd: string }): Promise<{ version: unknown } | undefined>
  writeText(target: unknown, text: string, expected: unknown, signal: undefined, policy: unknown): Promise<unknown>
}
const active = new Map<string, Promise<void>>()
const owner = randomUUID()

export async function initJob(fs: JobFs, root: string, id: string, start?: () => Promise<ProjectInitStepResult>): Promise<InitJobView> {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('invalid initialization job id')
  const relative = `.dsh/init-jobs/${id}.json`
  const target = await fs.resolve(relative, { cwd: root })
  const key = `${root}\0${id}`
  const info = await fs.lstat(relative, { cwd: root })
  const raw = await fs.readText(target).catch(error => {
    if (['ENOENT', 'FS_NOT_FOUND'].includes((error as { code?: string }).code ?? '')) return undefined
    throw error
  })
  let view = raw === undefined ? undefined : JSON.parse(raw) as InitJobView
  if (view && (view.job_id !== id || !['running', 'completed', 'failed'].includes(view.status))) throw new Error('initialization job record is invalid')
  if (view?.status === 'completed') return view
  if (view?.status === 'running') {
    if (active.has(key) || Date.now() - Date.parse(view.updated_at) < 330_000) return view
    // Another process may own an unexpired lease. Only an expired lease can be reclaimed.
    view = { ...view, status: 'failed', error: '生成进程已中断或超时；可从当前步骤重试', updated_at: new Date().toISOString() }
  }
  if (!start) {
    if (!view) throw new Error('initialization job does not exist')
    return view
  }
  const running: InitJobView = { job_id: id, status: 'running', updated_at: new Date().toISOString(), owner }
  await fs.writeText(target, JSON.stringify(running), info ? { kind: 'replaceIfVersion', version: info.version } : { kind: 'createIfAbsent' },
    undefined, { mode: 'workspace-write', workspaceRoot: root })
  // Keep the worker alive independently of the RPC. Catch every background failure.
  const task = Promise.resolve().then(async () => {
    let result: InitJobView
    try { result = { ...running, status: 'completed', result: await start(), updated_at: new Date().toISOString() } }
    catch (error) { result = { ...running, status: 'failed', error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() } }
    const latest = await fs.lstat(relative, { cwd: root })
    const current = JSON.parse((await fs.readText(target)) ?? '{}') as InitJobView
    if (current.owner !== owner || current.status !== 'running' || !latest) return
    await fs.writeText(target, JSON.stringify(result), { kind: 'replaceIfVersion', version: latest.version }, undefined,
      { mode: 'workspace-write', workspaceRoot: root })
  }).catch(() => { /* A failed durable write leaves an expiring running lease; the client can recover it. */ })
    .finally(() => { active.delete(key) })
  active.set(key, task)
  return running
}
