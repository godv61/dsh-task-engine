/** Check workspace ownership against a mounted Harness registry when available. */
export interface WorkspaceHost {
  get(name: string): unknown
}
type Registry = { resolveByPath(path: string): Promise<{ path: string } | undefined> }

/** Resolve the host's canonical workspace; legacy hosts retain their explicit guard. */
export async function authorizedWorkspace(host: WorkspaceHost, path: string, fallback: (path: string) => string): Promise<string> {
  const registry = host.get('workspaceRegistry') as Registry | undefined
  if (!registry || typeof registry.resolveByPath !== 'function') return fallback(path)
  if (!path.trim()) throw new Error('请选择已在 Harness 注册的工作区')
  const workspace = await registry.resolveByPath(path)
  if (!workspace) throw new Error('此目录未在 Harness 注册为工作区，请先添加工作区')
  return workspace.path
}
