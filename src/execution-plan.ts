/** Task-item execution decisions and host capability checks, independent of model prose. */
import type { Context } from '@deepseek-ai/cordis'
import type { ObjectJsonSchema, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { TaskItem, TaskState } from './engine.ts'
import { requiredReviewPaths, type DeliveryChange } from './delivery-changes.ts'

export type ExecutionMode = 'direct' | 'spawn' | 'fork'
export interface ExecutionPlan {
  requested: 'auto' | ExecutionMode
  mode: ExecutionMode
  reason: string
  boundary: 'local' | 'independent' | 'coupled'
  context: 'brief' | 'history'
  files: string[]
  changes?: DeliveryChange[]
  acceptance: string[]
  depends_on: string[]
  review: 'main' | 'independent'
  review_reason: string
  capabilities: { spawn: boolean; fork: boolean; reviewer: boolean }
  at: string
}
export interface IndependentReview {
  status: 'starting' | 'running' | 'completed' | 'failed'
  at: string
  parent_session: string
  run_id?: string
  finished_at?: string
  error?: string
  output?: string
  scope_hash: string
  plan_key: string
  dispatch_at: string
  verification_at: string
  spec?: 'pass' | 'fail'
  quality?: 'pass' | 'fail'
  notes?: string[]
  read_files?: string[]
  read_coverage?: { file: string; lines: number }[]
  context_hash?: string
}
/** In-process re-entry guard shared by all agent-scoped registrations; host FS CAS remains authoritative across processes. */
const taskMutations = new Set<string>()
export function acquireTaskMutation(key: string): () => void {
  if (taskMutations.has(key)) throw new Error('a child dispatch is still active or a task mutation is in progress; wait and reload status before retrying')
  taskMutations.add(key)
  return () => { taskMutations.delete(key) }
}
/** All registered task deliverables need an item owner before adaptive implementation starts. */
export function executionCoverageBlockers(state: TaskState): string[] {
  if (!state.delegation_version) return []
  const owned = new Set(state.items.flatMap(item => item.execution_plan?.files ?? []))
  const missing = state.files.filter(file => !owned.has(file))
  return missing.length ? [`task files have no implementation-plan owner: ${missing.join(', ')}; plan all items before dispatch`] : []
}
export function hasFullReadCoverage(review: IndependentReview | undefined, files: string[]): boolean {
  return files.every(file => review?.read_coverage?.some(entry => entry.file === file && Number.isSafeInteger(entry.lines) && entry.lines >= 0))
}
/** Narrow structural API: DSH is supplied by the host, never installed as a second runtime. */
export interface TaskSubagents {
  getProvider?(name: string): { capabilities: { depthLimit?: boolean; toolFilter?: boolean; outputSchema?: boolean }; inheritsParentContext?: boolean } | undefined
  start?(provider: string, request: { label: string; parent: NonNullable<ToolRunContext['agent']>;
    prompt: { type: 'text'; text: string }[]; signal: AbortSignal; maxDepth: number; toolFilter?: { allow: string[] }; outputSchema?: ObjectJsonSchema }): Promise<{
      id: string; localAgent?: { session: { snapshotEvents(): readonly { type: string; data: unknown }[] } };
      result: Promise<{ stopReason: string; output: { type: string; text?: string }[]; structured?: unknown; diagnostic?: string }>; dispose(): Promise<void>
    }>
}
/** Native capture schema; semantic checks still reject empty evidence after host validation. */
export const REVIEW_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    spec: { type: 'string', enum: ['pass', 'fail'] },
    quality: { type: 'string', enum: ['pass', 'fail'] },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['spec', 'quality', 'notes'],
  additionalProperties: false,
}
export function taskSubagents(ctx: Context): TaskSubagents | undefined {
  return ctx.get('subagents') as TaskSubagents | undefined
}
export function executionCapabilities(ctx: Context, liveParent: boolean): ExecutionPlan['capabilities'] {
  const runtime = taskSubagents(ctx)
  if (!liveParent || !runtime?.start || !runtime.getProvider) return { spawn: false, fork: false, reviewer: false }
  const spawn = runtime.getProvider('spawn')
  const fork = runtime.getProvider('fork')
  // Do not label an inheriting provider as an independent context/reviewer.
  return { spawn: !!spawn && spawn.inheritsParentContext === false && spawn.capabilities.depthLimit === true,
    fork: !!fork && fork.inheritsParentContext === true && fork.capabilities.depthLimit === true,
    reviewer: !!spawn && spawn.inheritsParentContext === false && spawn.capabilities.depthLimit === true && spawn.capabilities.toolFilter === true }
}
/** Exact serialized decision identity, kept separate from file content hashes. */
export function executionPlanKey(plan: ExecutionPlan): string {
  return JSON.stringify(plan)
}
export function reviewStrategy(state: Pick<TaskState, 'execution_policy' | 'complexity' | 'risk_level'>, mode: ExecutionMode, capabilities: ExecutionPlan['capabilities']): Pick<ExecutionPlan, 'review' | 'review_reason'> {
  const independent = state.execution_policy !== 'main_only'
    && (mode !== 'direct' || ['high', 'ultra'].includes(state.complexity ?? '') || state.risk_level === 'high_risk')
  return independent && capabilities.reviewer ? { review: 'independent', review_reason: '委派实现或高复杂度/高风险项，使用独立只读审核' }
    : { review: 'main', review_reason: independent ? '宿主缺少独立只读审核能力，主会话核对并保留真实验证门禁' : '局部或紧密耦合工作，由主会话审核' }
}
export function makeExecutionPlan(state: TaskState, item: TaskItem, input: {
  execution?: string; execution_reason?: string; task_boundary?: string; context_need?: string;
  files?: string[]; acceptance?: string[]; depends_on?: string[];
}, capabilities: ExecutionPlan['capabilities']): ExecutionPlan {
  if (!input.execution_reason?.trim()) throw new Error('plan_execution requires execution_reason with concrete task facts')
  if (!['local', 'independent', 'coupled'].includes(input.task_boundary ?? '')) throw new Error('plan_execution requires task_boundary: local|independent|coupled')
  const files = [...new Set(input.files ?? [])]
  if (!files.length) throw new Error(`plan_execution requires files for the complete implementation + test unit; example: ${JSON.stringify({ operation: 'plan_execution', item_id: item.id, task_boundary: 'local', files: state.files, acceptance: ['concrete behavior and its regression test'], execution_reason: 'bounded local implementation and verification' })}`)
  if (files.some(file => !state.files.includes(file))) throw new Error('plan_execution files must be registered in task scope; update scope before planning')
  const acceptance = (input.acceptance ?? []).map(value => value.trim()).filter(Boolean)
  if (!acceptance.length) throw new Error('plan_execution requires concrete acceptance conditions')
  const depends_on = [...new Set(input.depends_on ?? [])]
  const index = state.items.findIndex(entry => entry.id === item.id)
  if (depends_on.some(id => state.items.findIndex(entry => entry.id === id) < 0 || state.items.findIndex(entry => entry.id === id) >= index))
    throw new Error('dependencies must refer to earlier registered implementation items')
  const requested = input.execution ?? 'auto'
  if (!['auto', 'direct', 'spawn', 'fork'].includes(requested)) throw new Error('invalid execution mode')
  if (input.context_need !== undefined && !['brief', 'history'].includes(input.context_need)) throw new Error('context_need must be brief|history')
  const context = input.context_need === 'history' ? 'history' : 'brief'
  const desired = requested === 'auto'
    ? state.execution_policy === 'main_only' || input.task_boundary !== 'independent' ? 'direct' : context === 'history' ? 'fork' : 'spawn'
    : requested as ExecutionMode
  if (state.execution_policy === 'main_only' && desired !== 'direct') throw new Error('task execution_policy is main_only; child implementation is disabled')
  let mode = desired
  let reason = input.execution_reason.trim()
  if (mode !== 'direct' && !capabilities[mode]) {
    if (requested !== 'auto') throw new Error(`requested ${mode} provider is unavailable; no child was started`)
    reason += `；宿主 ${mode} 不可用，明确回退为主会话执行`
    mode = 'direct'
  }
  return { requested: requested as ExecutionPlan['requested'], mode, reason,
    boundary: input.task_boundary as ExecutionPlan['boundary'], context, files, acceptance, depends_on,
    ...reviewStrategy(state, mode, capabilities),
    capabilities, at: new Date().toISOString() }
}
export function executionItemBlockers(state: TaskState, item: TaskItem): string[] {
  if (!state.delegation_version) return []
  const plan = item.execution_plan
  if (!plan) return [`item ${item.id}: call plan_execution before dispatch (record boundary, files, acceptance and reason)`]
  const blockers: string[] = []
  if (!item.dispatch) blockers.push(`item ${item.id}: implementation has not been dispatched`)
  if (item.dispatch?.status && item.dispatch.status !== 'completed') blockers.push(`item ${item.id}: implementation child is not completed`)
  if (item.review?.spec.outcome !== 'pass' || (state.flow?.config.review_depth !== 'single' && item.review.quality?.outcome !== 'pass'))
    blockers.push(`item ${item.id}: item review is missing or failed before done`)
  if (plan.review === 'independent') {
    const review = item.independent_review
    if (review?.status !== 'completed' || !review.run_id || review.spec !== 'pass' || review.quality !== 'pass'
      || review.plan_key !== executionPlanKey(plan) || review.dispatch_at !== item.dispatch?.at
      || item.review?.independent_run_id !== review.run_id || !hasFullReadCoverage(review, requiredReviewPaths(plan)))
      blockers.push(`item ${item.id}: independent review is missing, failed or not accepted; run review_dispatch then review_item`)
  }
  return blockers
}
/** Compare successful, model-visible numbered read lines with current source; windows can overlap, but truncated or stale text cannot prove coverage. */
export function fullReadCoverage(events: readonly { type: string; data: unknown }[], files: { file: string; content: string }[], key: (path: string) => string): { file: string; lines: number }[] {
  const pending = new Map<string, string>()
  const sources = files.map(source => {
    const lines = source.content.split('\n').map(line => line.replace(/\r$/u, ''))
    if (!source.content || source.content.endsWith('\n')) lines.pop()
    return { ...source, key: key(source.file), lines, seen: new Set<number>(), emptyRead: false }
  })
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data as { name?: string; callId?: string; arguments?: string }
      if (data.name !== 'read' || !data.callId) continue
      try { const args = JSON.parse(data.arguments ?? '{}') as { file_path?: unknown }; if (typeof args.file_path === 'string') pending.set(data.callId, key(args.file_path)) }
      catch { /* Invalid reads do not establish coverage. */ }
    } else if (event.type === 'tool/result') {
      const data = event.data as { error?: unknown; message?: { toolCallId?: string; isError?: boolean; content?: { type: string; text?: string }[] } }
      const path = pending.get(data.message?.toolCallId ?? '')
      if (!path || data.error || data.message?.isError) continue
      const source = sources.find(source => source.key === path)
      if (!source) continue
      for (const block of data.message?.content ?? []) {
        if (block.type !== 'text') continue
        const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(block.text ?? '')?.[1]
        if (body === undefined) continue
        if (!source.lines.length && body === '(End of file - total 0 lines)') source.emptyRead = true
        for (const line of body.split('\n')) {
          const match = /^(\d+): ([\s\S]*)$/u.exec(line)
          const number = Number(match?.[1])
          if (match && number >= 1 && number <= source.lines.length && match[2] === source.lines[number - 1]) source.seen.add(number)
        }
      }
    }
  }
  return sources.filter(source => source.lines.length ? source.seen.size === source.lines.length : source.emptyRead)
    .map(source => ({ file: source.file, lines: source.lines.length }))
}
/** Successful read tool calls in the fresh reviewer's own host session. */
export function successfulReadPaths(events: readonly { type: string; data: unknown }[]): string[] {
  const calls = new Map<string, string>()
  const read = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      const data = event.data as { name?: string; callId?: string; arguments?: string }
      if (data.name !== 'read' || !data.callId) continue
      try {
        const args = JSON.parse(data.arguments ?? '{}') as { file_path?: unknown }
        if (typeof args.file_path === 'string') calls.set(data.callId, args.file_path)
      } catch { /* Malformed reads are not evidence. */ }
    } else if (event.type === 'tool/result') {
      const data = event.data as { error?: unknown; message?: { toolCallId?: string; isError?: boolean } }
      const path = calls.get(data.message?.toolCallId ?? '')
      if (path && data.message?.toolCallId && !data.error && !data.message.isError) read.add(path)
    }
  }
  return [...read]
}
export function parseIndependentReview(output: string): { spec: 'pass' | 'fail'; quality: 'pass' | 'fail'; notes: string[] } {
  return validateIndependentReview(JSON.parse(output.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')))
}
/** Validate either the native host capture or the legacy text transport, never assistant prose. */
export function validateIndependentReview(input: unknown): { spec: 'pass' | 'fail'; quality: 'pass' | 'fail'; notes: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('reviewer must return an object with spec, quality and notes')
  const value = input as Record<string, unknown>
  if (!['pass', 'fail'].includes(String(value.spec)) || !['pass', 'fail'].includes(String(value.quality))
    || !Array.isArray(value.notes) || !value.notes.length || value.notes.some(note => typeof note !== 'string' || !note.trim()))
    throw new Error('reviewer must return JSON {spec:pass|fail,quality:pass|fail,notes:[file:line evidence]}')
  return { spec: value.spec as 'pass' | 'fail', quality: value.quality as 'pass' | 'fail', notes: value.notes as string[] }
}
