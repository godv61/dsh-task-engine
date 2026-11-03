/** Short-lived in-memory initialization jobs; never create project or machine cache files. */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { ProjectInitStepResult } from './controller.ts'
import { INIT_JOB_TIMEOUT_MS, withInitTimeout } from './init-timeout.ts'

export interface InitJobView {
  job_id: string
  status: 'running' | 'completed' | 'failed'
  updated_at: string
  result?: ProjectInitStepResult
  error?: string
  owner?: string
}
interface LegacyJobFs {
  resolve(path: string, options: { cwd: string }): Promise<unknown>
  readText(target: unknown): Promise<string | undefined>
}
interface Job {
  view: InitJobView
  deadline?: number
  expiry?: ReturnType<typeof setTimeout>
}

export const INIT_JOB_RETENTION_MS = 30 * 60_000
export const INIT_JOB_MAX_ENTRIES = 100
const jobs = new Map<string, Job>()

function remove(key: string): void {
  clearTimeout(jobs.get(key)?.expiry)
  jobs.delete(key)
}

function settle(key: string, job: Job, view: InitJobView): void {
  if (jobs.get(key) !== job) return
  clearTimeout(job.expiry)
  job.view = view
  job.expiry = setTimeout(() => { if (jobs.get(key) === job) remove(key) }, INIT_JOB_RETENTION_MS)
  job.expiry.unref?.()
}

function makeRoom(): void {
  // Evict finished jobs first; running work remains discoverable until its deadline.
  for (const [key, job] of jobs) {
    if (jobs.size < INIT_JOB_MAX_ENTRIES) return
    if (job.view.status !== 'running') remove(key)
  }
  if (jobs.size >= INIT_JOB_MAX_ENTRIES) throw new Error('初始化后台作业数量已达上限，请等待正在运行的步骤结束后重试')
}

/** Read old records only; never create, update or delete files here. */
async function legacyJob(fs: LegacyJobFs, root: string, id: string): Promise<InitJobView | undefined> {
  try {
    const raw = await fs.readText(await fs.resolve(`.dsh/init-jobs/${id}.json`, { cwd: root }))
    if (raw === undefined) return undefined
    const view = JSON.parse(raw) as InitJobView
    if (!view || view.job_id !== id || !['running', 'completed', 'failed'].includes(view.status)) throw new Error('initialization job record is invalid')
    return view
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'FS_NOT_FOUND', 'FS_NOT_DIRECTORY'].includes((error as { code?: string }).code ?? '')) return undefined
    throw error
  }
}

export async function initJob(fs: LegacyJobFs, root: string, id: string, start?: () => Promise<ProjectInitStepResult>,
  timeoutMs = INIT_JOB_TIMEOUT_MS): Promise<InitJobView> {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('invalid initialization job id')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('invalid initialization job deadline')
  const canonical = resolve(root)
  const key = `${process.platform === 'win32' ? canonical.toLowerCase() : canonical}\0${id}`
  let job = jobs.get(key)
  if (!job) {
    const legacy = await legacyJob(fs, root, id)
    // Another request may have started the same job during the legacy read.
    job = jobs.get(key)
    if (!job && legacy) {
      // An old host may still own its old file; poll it until it completes or its lease expires.
      if (legacy.status === 'running' && Date.now() - Date.parse(legacy.updated_at) < 330_000) return legacy
      makeRoom()
      job = { view: legacy.status === 'running' ? { ...legacy, status: 'failed',
        error: '旧版生成作业已中断或超时，可重试当前步骤', updated_at: new Date().toISOString() } : legacy }
      jobs.set(key, job)
      settle(key, job, job.view)
    }
  }
  if (job?.view.status === 'running') {
    if (Date.now() < job.deadline!) return job.view
    settle(key, job, { ...job.view, status: 'failed', error: '生成进程已中断或超时；可从当前步骤重试', updated_at: new Date().toISOString() })
  }
  if (job?.view.status === 'completed') return job.view
  if (!start) {
    if (!job) throw new Error('初始化作业已过期或 DSH 已重启；已保存的浏览器草案仍可使用，未完成步骤可重新生成')
    return job.view
  }
  if (job) remove(key)
  makeRoom()
  const running: InitJobView = { job_id: id, status: 'running', updated_at: new Date().toISOString(), owner: randomUUID() }
  const worker: Job = { view: running, deadline: Date.now() + timeoutMs }
  jobs.set(key, worker)
  // The server owns the request independently of the browser. Old attempts cannot overwrite newer work.
  void withInitTimeout(() => start(), timeoutMs,
    `本步生成作业超过${Math.round(timeoutMs / 1000)}秒上限，已结束等待；已有草案保留，可重试当前步骤`).then(
    result => {
      if (worker.view.status === 'running') settle(key, worker, { ...running, status: 'completed', result, updated_at: new Date().toISOString() })
    },
    error => {
      if (worker.view.status === 'running') settle(key, worker, { ...running, status: 'failed',
        error: error instanceof Error ? error.message : String(error), updated_at: new Date().toISOString() })
    })
  return running
}
