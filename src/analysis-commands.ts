/** Analysis use cases own source capture, read-only run transactions and acceptance. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { isAbsolute, relative, resolve, win32 } from 'node:path'
import { realpathSync } from 'node:fs'
import type { TaskState } from './engine.ts'
import type { OpArgs } from './dev-task.ts'
import type { SkillSession } from './skill-audit.ts'
import { acquireTaskMutation, taskSubagents } from './execution-plan.ts'
import { deliveryView, isAnalysis, sourceEvidence } from './delivery-contract.ts'
import { investigate } from './investigation-runtime.ts'
import { readText, loadTask, writeTask } from './task-store.ts'
import { isSensitivePath } from './project.ts'
import { assertInsideRoot } from './path-guard.ts'
import { parentMetrics } from './run-observation.ts'
import { hashText } from './snapshot.ts'

export interface AnalysisCommandContext {
  ctx: Context
  exec: ToolRunContext
  fs: Context['fs']
  state: TaskState
  cwd: string | undefined
  session: SkillSession | undefined
  mutationPath: string
  writeMode(): Promise<'workspace-write' | 'danger-full-access'>
}
export async function executeAnalysisCommand(a: OpArgs, env: AnalysisCommandContext): Promise<string> {
  const { ctx, exec, fs, state, cwd, session, mutationPath, writeMode } = env
  if (!['delegate', 'recover_analysis', 'submit_analysis', 'complete'].includes(a.operation)) throw new Error('analysis is read-only: use delegate for questions or submit_analysis for the conclusion; implementation needs a separate task')
  if (a.operation === 'delegate') {
    if (!a.delegation_benefit || !a.execution_reason?.trim()) throw new Error('delegate requires delegation_benefit and execution_reason demonstrating why a child is useful; otherwise investigate directly')
    const mode = await writeMode()
    // Serialize only state transactions. Never hold this lock across an LLM activation.
    let updates = Promise.resolve()
    const update = (change: (fresh: TaskState) => void): Promise<void> => {
      const next = updates.then(async () => {
        const unlock = acquireTaskMutation(mutationPath)
        try {
          const fresh = await loadTask(fs, state.id, cwd)
          if (fresh.completed || !isAnalysis(fresh)) throw new Error('analysis task is no longer active')
          change(fresh)
          await writeTask(fs, fresh, cwd, mode)
        } finally { unlock() }
      })
      updates = next.catch(() => {})
      return next
    }
    await investigate(ctx, exec, { read: () => loadTask(fs, state.id, cwd), update }, a.questions ?? [], a.concurrency ?? 2)
    return JSON.stringify({ delivery: deliveryView(await loadTask(fs, state.id, cwd)), instruction: 'Inspect returned reports, verify key claims and report findings to the user. Returned is not accepted. Preserve successful reports if other questions failed.' })
  }
  if (a.operation === 'recover_analysis') {
    if (!session?.id) throw new Error('recovery requires the original parent session')
    const active = state.delivery!.runs.filter(run => ['queued', 'starting', 'running'].includes(run.status))
    const runtime = taskSubagents(ctx)
    if (!runtime?.listDescendants) throw new Error('host cannot establish child liveness; recovery is blocked')
    const descendants = await runtime.listDescendants(session.id as never, exec.signal)
    for (const run of active) {
      if (run.parent_session !== session.id) throw new Error('recovery requires the original parent session')
      const childId = run.run_id ?? run.id
      const index = descendants.findIndex(child => child.id === childId)
      if (index < 0 && run.status !== 'queued') throw new Error('child identity is absent from host catalog; recovery cannot prove it stopped')
      const depth = index < 0 ? Infinity : descendants[index]!.depth
      const end = index < 0 ? -1 : descendants.findIndex((child, i) => i > index && child.depth <= depth)
      const tail = index < 0 ? [] : descendants.slice(index, end < 0 ? undefined : end)
      if (tail.some(child => child.kind !== 'child' || child.activity !== 'inactive')) throw new Error('child or descendant is still active; stop it through host controls before recovery')
    }
    for (const run of active) { run.status = 'failed'; run.finished_at = new Date().toISOString(); run.error = 'Interrupted run recovered after host liveness check. Existing reports remain available; retry only unreturned questions.' }
    await writeTask(fs, state, cwd, await writeMode())
    return JSON.stringify(deliveryView(state))
  }
  if (state.delivery!.runs.some(run => ['queued', 'starting', 'running'].includes(run.status))) throw new Error('investigation children are active; wait or recover before accepting')
  if (a.operation === 'submit_analysis') {
    if (!a.conclusion?.trim() || !a.proposal?.trim() || !a.source_evidence?.length || !Array.isArray(a.limitations)) throw new Error('submit_analysis requires conclusion, proposal, limitations (possibly empty) and exact source_evidence')
    const evidence = []
    for (const claim of a.source_evidence) {
      if (isAbsolute(claim.file) || win32.isAbsolute(claim.file)) throw new Error('evidence paths must be project-relative')
      assertInsideRoot(state.root!, state.root!, claim.file)
      const canonical = relative(state.root!, resolve(state.root!, claim.file)).replace(/\\/gu, '/')
      if (/^\.dsh\//u.test(canonical) || isSensitivePath(canonical)) throw new Error('task metadata and credentials are not source evidence')
      const info = await fs.lstat(claim.file, { cwd: state.root! })
      if (info?.type !== 'file') throw new Error(`evidence must be a regular source file: ${claim.file}`)
      assertInsideRoot(realpathSync.native(state.root!), realpathSync.native(state.root!), realpathSync.native(resolve(state.root!, claim.file)))
      const source = await readText(fs, claim.file, state.root)
      if (source === undefined) throw new Error(`cannot read source evidence: ${claim.file}`)
      const snapshot = sourceEvidence(claim, source, hashText(source))
      evidence.push({ ...snapshot, range_hash: hashText(snapshot.quote) })
    }
    // Acceptance is one transaction, not record + review + done + advance + complete.
    state.delivery!.result = { conclusion: a.conclusion.trim(), proposal: a.proposal.trim(), limitations: a.limitations, evidence, accepted_at: new Date().toISOString() }
    const since = Date.parse(state.delivery!.requested_at ?? state.delivery!.created_at)
    state.delivery!.metrics = parentMetrics(session, since)
    state.artifacts.analysis = { conclusion: a.conclusion, proposal: a.proposal, limitations: a.limitations.join('\n') || 'No additional limitations reported.' }
    state.stage = '完成'
    state.completed = { at: new Date().toISOString() }
    await writeTask(fs, state, cwd, await writeMode())
    return JSON.stringify({ accepted: true, task: state.id, archived: true,
      evidence: evidence.map(({ file, start_line, end_line, content_hash }) => ({ file, start_line, end_line, content_hash })),
      instruction: 'Deliver the conclusion and proposal to the user. Source matching proves provenance, not semantic correctness. Exact source snapshots are saved in the task record; no need to repeat source reads. No business code was implemented or tested by this operation.' })
  }
  throw new Error('analysis needs submit_analysis; do not bypass source acceptance with complete')
}
