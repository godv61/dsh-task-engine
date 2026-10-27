/** Read-only runs use DSH lifecycle ownership and a short, versioned task-store transaction. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskState } from './engine.ts'
import { executionCapabilities, taskSubagents } from './execution-plan.ts'
import { ownActivation, reviewerEvents, reviewerProof } from './subagent-runtime.ts'
import { READONLY_PRESET } from './reviewer-spec.ts'
import { parseInvestigationReport, validateInvestigationReport, validateQuestions, type InvestigationQuestion, type InvestigationRun, type RunMetrics } from './delivery-contract.ts'
export { runMetrics } from './run-observation.ts'
import { runMetrics, unknownMetrics } from './run-observation.ts'
import { runDependencyBatch } from './run-scheduler.ts'

export interface InvestigationStore {
  update(change: (state: TaskState) => void): Promise<void>
  read(): Promise<TaskState>
}
const REPORT_SCHEMA: ObjectJsonSchema = { type: 'object', additionalProperties: false, properties: {
  status: { type: 'string', enum: ['complete', 'partial', 'blocked'] }, summary: { type: 'string' },
  evidence: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    file: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' }, quote: { type: 'string' },
  }, required: ['file', 'start_line', 'end_line', 'quote'] } }, limitations: { type: 'array', items: { type: 'string' } },
}, required: ['status', 'summary', 'evidence', 'limitations'] }
export async function investigate(ctx: Context, exec: ToolRunContext, store: InvestigationStore,
  questions: InvestigationQuestion[], concurrency = 2): Promise<void> {
  validateQuestions(questions)
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('concurrency must be 1–4')
  if (!exec.agent || !executionCapabilities(ctx, true).reviewer) throw new Error('read-only spawn preset and observable host runs are required; investigate in the main session instead')
  const initial = await store.read()
  if (initial.execution_policy === 'main_only') throw new Error('main_only: investigate in the main session')
  const parentId = exec.agent.session.id
  const attempts = questions.map(question => ({ id: randomUUID(), question, parent_session: parentId,
    status: 'queued', at: new Date().toISOString() } satisfies InvestigationRun))
  await store.update(state => {
    if (state.delivery?.intent !== 'analysis' || state.completed) throw new Error('delegate requires an active analysis task')
    const runs = state.delivery.runs
    if (runs.some(run => ['queued', 'starting', 'running'].includes(run.status))) throw new Error('an investigation batch is active; wait or recover it')
    if (questions.some(q => runs.some(run => run.question.id === q.id && run.status === 'returned'))) throw new Error('question already returned; reuse its report or create a distinct question, do not redispatch completed work')
    // Bound terminal history, retaining recent reports and all active identities.
    state.delivery.runs = [...runs.slice(-80), ...attempts]
  })
  const update = (id: string, change: (run: InvestigationRun) => void) => store.update(state => {
    const run = state.delivery?.runs.find(run => run.id === id)
    if (!run) throw new Error('investigation identity disappeared; inspect task status')
    change(run)
  })
  const runtime = taskSubagents(ctx)!
  const structured = runtime.getProvider('spawn')!.capabilities.outputSchema === true
  let stopReason: string | undefined
  await runDependencyBatch(questions, concurrency, exec.signal, async question => {
    const attempt = attempts.find(run => run.question.id === question.id)!
    const started = Date.now()
    let run: ReturnType<typeof ownActivation> | undefined
    try {
      await update(attempt.id, entry => { entry.status = 'starting'; entry.started_at = new Date().toISOString() })
      const current = await store.read()
      const dependencies = current.delivery!.runs.filter(r => question.depends_on?.includes(r.question.id) && r.status === 'returned').map(r => ({ question: r.question.question, report: r.report }))
      run = ownActivation(await runtime.startActivation({ provider: 'spawn', label: `${current.id}/analysis/${question.id}`, childId: SessionId(attempt.id),
        delivery: 'caller', signal: exec.signal, request: { parent: exec.agent!, cwd: current.root!, agentPreset: READONLY_PRESET, maxDepth: 1,
          ...(structured ? { outputSchema: REPORT_SCHEMA } : {}),
          prompt: [{ type: 'text', text: `You are a read-only investigator, not an implementer or workflow controller. Answer exactly this question. Do not edit, run commands, delegate or change task records. Use glob/grep to discover paths; do not repeatedly guess missing filenames. Read only relevant source windows; follow project constraints. Return useful partial findings when context is missing.\nTask goal: ${current.title}\nUser-requested delivery: ${current.delivery!.reason}\nQuestion: ${JSON.stringify(question)}\nDependency reports (unverified): ${JSON.stringify(dependencies)}\nFinish with structured_output if offered; otherwise return ONLY JSON {"status":"complete"|"partial"|"blocked","summary":"findings and reasoning","evidence":[{"file":"repo-relative path","start_line":1,"end_line":2,"quote":"exact source text in this window"}],"limitations":["unknowns"]}. A run finishing does not imply parent acceptance. Cite evidence, not confidence scores. Report the central finding first and avoid pasting complete files.` }] } }), exec.signal)
      await update(attempt.id, entry => { entry.status = 'running'; entry.run_id = run!.childId })
      const result = await run.result
      if (result.stopReason !== 'completed') throw new Error(result.diagnostic ?? result.stopReason)
      reviewerProof(ctx, run.childId, structured)
      const report = structured ? validateInvestigationReport(result.structured)
        : parseInvestigationReport(result.output.filter(b => b.type === 'text').map(b => b.text).join('\n'))
      await update(attempt.id, entry => { entry.report = report })
      let metrics: RunMetrics
      try { metrics = runMetrics(await reviewerEvents(ctx, run.childId, exec.signal), started) }
      catch { metrics = unknownMetrics(started) }
      await run.dispose()
      run = undefined
      await update(attempt.id, entry => { entry.report = report; entry.metrics = metrics; entry.status = 'returned'; entry.finished_at = new Date().toISOString() })
      return report.status === 'complete'
    } catch (error) {
      if (/\bAUTH\b|AccessDenied|\b40[13]\b/u.test(String(error))) stopReason = 'model authorization failed; preserve completed reports and check the configured provider before resuming'
      let metrics = unknownMetrics(started)
      if (run) try { metrics = runMetrics(await reviewerEvents(ctx, run.childId, exec.signal), started) } catch {}
      await update(attempt.id, entry => { entry.status = 'failed'; entry.error = String(error); entry.metrics = metrics; entry.finished_at = new Date().toISOString() })
      return false
    } finally {
      if (run) {
        try { await run.dispose() }
        catch (error) {
          stopReason = 'child cleanup is unproven; recover before starting more work'
          await update(attempt.id, entry => { entry.status = 'running'; entry.error = `cleanup unproven: ${String(error)}` })
        }
      }
    }
  }, async (question, reason) => {
    await update(attempts.find(run => run.question.id === question.id)!.id, entry => {
      entry.status = 'failed'; entry.error = reason; entry.finished_at = new Date().toISOString()
    })
  }, () => stopReason)
}
