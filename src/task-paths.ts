/** One portable task namespace. Shared by the tool, workbench and commit hook. */
export const TASKS_DIRECTORY = '.dsh/tasks'

export function validTaskId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(id) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(id)
  )
}

export function taskDirectory(id: string): string {
  if (!validTaskId(id))
    throw new Error(
      'task_id must be a portable 1–64 character identifier: letters, digits, hyphens or underscores; device names are forbidden',
    )
  return `${TASKS_DIRECTORY}/${id}`
}

export const taskPath = (id: string): string => `${taskDirectory(id)}/task.json`
/** Artifact references are relative to the source project; storage can belong to a child workspace. */
export function taskArtifactDirectory(id: string, namespace?: string): string {
  const suffix = taskDirectory(id),
    value = namespace ?? suffix
  if (
    (value !== suffix && !value.endsWith('/' + suffix)) ||
    value
      .split('/')
      .some(
        (part) => !part || part === '.' || part === '..' || /[\\:\x00-\x1f<>"|?*]/u.test(part) || /[. ]$/u.test(part),
      )
  )
    throw new Error('任务目录不是本工作区内的普通路径')
  return value
}
export const taskRequirementPath = (id: string, namespace?: string): string =>
  `${taskArtifactDirectory(id, namespace)}/requirement.md`
export const taskMaterialDirectory = (id: string, namespace?: string): string =>
  `${taskArtifactDirectory(id, namespace)}/materials`
export const taskReviewDirectory = (id: string, namespace?: string): string =>
  `${taskArtifactDirectory(id, namespace)}/reviews`

export function isTaskLedgerPath(value: string): boolean {
  const parts = value.replace(/\\/gu, '/').split('/')
  const tail = parts.slice(-4),
    prefix = parts.slice(0, -4)
  return (
    parts.length >= 4 &&
    prefix.every((part) => !!part && part !== '.' && part !== '..' && !/[\\:\x00-\x1f<>"|?*]/u.test(part)) &&
    tail[0] === '.dsh' &&
    tail[1] === 'tasks' &&
    validTaskId(tail[2]) &&
    tail[3] === 'task.json'
  )
}

/** No blanket exemption for documents or arbitrary files inside a task directory. */
export function isEngineMeta(value: string): boolean {
  const path = value.replace(/\\/gu, '/')
  return path === '.dsh/eng.json' || path === '.dsh/meta.json' || isTaskLedgerPath(path)
}

export function isTaskRequirementPath(id: string, path: string, namespace?: string): boolean {
  const prefix = `${taskArtifactDirectory(id, namespace)}/`
  return path.startsWith(prefix) && /^requirement(?:-[A-Za-z0-9_-]+)?\.md$/u.test(path.slice(prefix.length))
}

export function isTaskReviewPath(id: string, path: string, namespace?: string): boolean {
  const prefix = `${taskReviewDirectory(id, namespace)}/`
  return path.startsWith(prefix) && /^[A-Za-z0-9][A-Za-z0-9_.+-]*\.(?:md|json)$/u.test(path.slice(prefix.length))
}
