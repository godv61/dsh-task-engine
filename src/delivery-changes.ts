/** Explicit destructive delivery intent. Baselines are captured by the engine, never supplied by the model. */
export interface DeliveryChangeInput { path: string; kind: 'delete' | 'rename'; to?: string }
export interface DeliveryChange extends DeliveryChangeInput {
  baseline: { commit: string; blob: string; git: { path: string; sha256: string }; before?: { path: string; sha256: string } }
}
export function validateDeliveryChanges(changes: DeliveryChangeInput[], files: string[]): void {
  if (changes.length > 24) throw new Error('at most 24 planned deletions/renames per implementation item')
  const owned = new Set<string>()
  for (const change of changes) {
    if (!change || !['delete', 'rename'].includes(change.kind) || !files.includes(change.path) || owned.has(change.path)
      || (change.kind === 'delete' && change.to !== undefined)
      || (change.kind === 'rename' && (!change.to || change.to === change.path || !files.includes(change.to))))
      throw new Error('planned deletion/rename must have unique old paths and both rename paths in plan files')
    owned.add(change.path)
  }
  if (changes.some(change => change.to && owned.has(change.to))) throw new Error('rename destination cannot also be a planned deletion')
  const targets = changes.flatMap(change => change.to ? [change.to] : [])
  if (new Set(targets).size !== targets.length) throw new Error('rename destinations must be unique')
}
/** Review old content through immutable snapshots and surviving/new content at their actual paths. */
export function requiredReviewPaths(plan: { files: string[]; changes?: DeliveryChange[] }): string[] {
  const removed = new Set(plan.changes?.map(change => change.path))
  return [...new Set([...plan.files.filter(file => !removed.has(file)),
    ...(plan.changes ?? []).flatMap(change => [change.baseline.git.path, ...(change.baseline.before ? [change.baseline.before.path] : [])])])]
}
