/** Browser-safe, version-bound business confirmation. Tool permissions are unrelated. */
import type { TaskState, WorkflowConfig } from './engine.ts'

export interface RequirementPolicy { version: 1; stage: string; artifact: string }
export interface ClarificationQuestion {
  id: string
  question: string
  options?: { label: string; description?: string }[]
}
export interface Clarification extends ClarificationQuestion {
  request_id: string
  answer?: { selected: string[]; custom?: string; at: string }
}
export interface RequirementDocument {
  version: number
  path: string
  /** Canonical artifact fields and actual human answers represented by this document. */
  source: string
  content: string
  hash: string
  status: 'awaiting_confirmation' | 'confirmed' | 'changes_requested' | 'draft'
  question_id?: string
  feedback?: string
  confirmation?: { hash: string; version: number; at: string; session_id: string }
}
export interface RequirementsState { clarifications: Clarification[]; document?: RequirementDocument }
export interface RequirementsView {
  status: 'clarifying' | 'draft' | 'awaiting_confirmation' | 'confirmed' | 'changes_requested' | 'stale'
  pending_questions: number
  path?: string
  version?: number
  hash?: string
  confirmed_at?: string
  feedback?: string
  content?: string
}
export const REQUIREMENT_FIELDS = {
  goal: '业务目标与当前问题', scope: '本期范围', non_goals: '明确不做', rules: '业务流程与规则',
  exceptions: '边界与异常处理', acceptance: '验收条件', dependencies: '外部依赖与已接受的假设',
} as const

/** Historical records remain readable; execution never falls back to an older gate. */
export function taskExecutionProblem(state: TaskState): string | undefined {
  if (state.completed || state.delivery?.intent === 'analysis') return undefined
  return state.flow?.config.requirement_review?.version === 1 ? undefined
    : '此任务缺少新版需求确认结构，仅可查看；请使用新的 task_id 重新创建任务，整理需求总结并由用户确认后继续。不会迁移旧回执或改动已有代码。'
}

export function requirementSource(state: TaskState, policy: RequirementPolicy): string {
  const fields = state.artifacts[policy.artifact] ?? {}
  return JSON.stringify({ task: state.id, title: state.title,
    fields: Object.keys(fields).sort().map(key => [key, fields[key]]),
    clarifications: (state.requirements?.clarifications ?? []).map(({ id, question, answer }) => ({ id, question, answer })) })
}
export function requirementConfirmed(state: TaskState, config: WorkflowConfig): boolean {
  if (!config.requirement_review) return false
  const doc = state.requirements?.document, confirmation = doc?.confirmation
  return !!doc && doc.status === 'confirmed' && !!confirmation
    && doc.source === requirementSource(state, config.requirement_review)
    && confirmation.hash === doc.hash && confirmation.version === doc.version
    && !(state.requirements?.clarifications ?? []).some(question => !question.answer)
}
export function invalidateRequirement(state: TaskState): void {
  state.requirement_confirmed = false
  const doc = state.requirements?.document
  if (doc) { doc.status = 'draft'; delete doc.confirmation; delete doc.question_id }
}
export function requirementsView(state: TaskState, stale = false, detail = false): RequirementsView | undefined {
  const policy = state.flow?.config.requirement_review
  if (!policy) return undefined
  const pending = state.requirements?.clarifications.filter(question => !question.answer).length ?? 0
  const doc = state.requirements?.document
  return { status: stale ? 'stale' : pending ? 'clarifying' : !doc ? 'draft'
    : doc.source !== requirementSource(state, policy) ? 'draft' : doc.status,
    pending_questions: pending, ...(doc ? { path: doc.path, version: doc.version, hash: doc.hash,
      ...(doc.confirmation ? { confirmed_at: doc.confirmation.at } : {}),
      ...(doc.feedback ? { feedback: doc.feedback } : {}), ...(detail ? { content: doc.content } : {}) } : {}) }
}
