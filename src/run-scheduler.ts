/** Host-independent bounded dependency scheduler; workers own their exact DSH activation handles. */
export async function runDependencyBatch<T extends { id: string; depends_on?: string[] }>(
  jobs: T[], concurrency: number, signal: AbortSignal,
  worker: (job: T) => Promise<boolean>, blocked: (job: T, reason: string) => Promise<void>,
  stopStarting: () => string | undefined = () => undefined,
): Promise<void> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('concurrency must be an integer from 1 to 4')
  const pending = new Map(jobs.map(job => [job.id, job]))
  if (pending.size !== jobs.length) throw new Error('duplicate job identities')
  const visiting = new Set<string>(), visited = new Set<string>()
  const validate = (id: string): void => {
    if (visiting.has(id)) throw new Error('job dependencies contain a cycle')
    if (visited.has(id)) return
    const job = pending.get(id)
    if (!job) throw new Error(`unknown job dependency: ${id}`)
    visiting.add(id)
    for (const dependency of job.depends_on ?? []) validate(dependency)
    visiting.delete(id); visited.add(id)
  }
  for (const job of jobs) validate(job.id)
  const running = new Map<string, Promise<void>>()
  const outcomes = new Map<string, boolean>()
  while (pending.size || running.size) {
    for (const [id, job] of pending) {
      const dependencies = job.depends_on ?? []
      const stop = stopStarting()
      if (signal.aborted || stop || dependencies.some(id => outcomes.get(id) === false)) {
        pending.delete(id); outcomes.set(id, false)
        await blocked(job, signal.aborted ? 'parent cancelled before start' : stop ?? 'dependency did not complete with evidence')
      } else if (running.size < concurrency && dependencies.every(id => outcomes.get(id) === true)) {
        pending.delete(id)
        const promise = Promise.resolve().then(() => worker(job)).then(ok => { outcomes.set(id, ok) }, async error => {
          outcomes.set(id, false); await blocked(job, String(error))
        }).finally(() => { running.delete(id) })
        running.set(id, promise)
      }
    }
    if (running.size) await Promise.race(running.values())
    else if (pending.size && ![...pending.values()].some(job => (job.depends_on ?? []).every(id => outcomes.has(id)))) throw new Error('no runnable question; invalid dependencies')
  }
}
