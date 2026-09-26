/**
 * Shared client helpers for the task-engine workbench: the workspace view shape
 * and small pure mappings used by the flow, skill, and rule tabs.
 *
 * @module dsh-task-engine/shared
 */

/** Browser view of one workspace, narrowed to the fields these pages need. */
export interface WorkspaceItem {
  path: string
  title: string
}

/** Map a skill/rule source tag to a short Chinese label. */
export function sourceLabel(source: string): string {
  switch (source) {
    case 'bundled': return '内置'
    case 'project': case 'project-dsh': case 'project-agents': return '项目'
    case 'codex-project': return '项目 · Codex'
    case 'user': case 'user-dsh': case 'user-agents': return '用户'
    case 'custom': return '自定义'
    default: return source
  }
}

/** One-line error message from any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '未知错误'
}
