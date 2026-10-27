/** Versioned delivery contracts. A run ending and a deliverable being accepted are different facts. */
import type { TaskState, WorkflowConfig } from './engine.ts'

export type DeliveryIntent = 'analysis' | 'implementation'
export type DelegationBenefit = 'parallel' | 'context_isolation' | 'independent_check'
export interface SourceClaim { file: string; start_line: number; end_line: number; quote: string }
export type SourceLocation = Omit<SourceClaim, 'quote'> & { quote?: string }
export interface SourceEvidence extends SourceClaim { content_hash: string; range_hash?: string; highlight?: string }
export interface InvestigationQuestion { id: string; question: string; references?: string[]; depends_on?: string[] }
export interface InvestigationReport {
  status: 'complete' | 'partial' | 'blocked'
  summary: string
  evidence: SourceClaim[]
  limitations: string[]
}
export interface RunMetrics {
  elapsed_ms: number
  tool_calls: number | null
  errors: number | null
  input_tokens: number | null
  cached_input_tokens: number | null
  output_tokens: number | null
}
export interface InvestigationRun {
  id: string
  question: InvestigationQuestion
  parent_session: string
  status: 'queued' | 'starting' | 'running' | 'returned' | 'failed'
  at: string
  started_at?: string
  run_id?: string
  finished_at?: string
  error?: string
  report?: InvestigationReport
  metrics?: RunMetrics
}
export interface DeliveryContract {
  version: 1
  intent: DeliveryIntent
  reason: string
  created_at: string
  requested_at?: string
  parent_session?: string
  runs: InvestigationRun[]
  metrics?: RunMetrics
  references?: string[]
  result?: { conclusion: string; proposal: string; limitations: string[]; evidence: SourceEvidence[]; accepted_at: string }
}
export interface InvestigationView extends InvestigationRun {
  acceptance?: 'pending_parent' | 'used_in_delivery' | 'not_used'
}
export interface DeliveryView extends DeliveryContract {
  runs: InvestigationView[]
  next_actions: string[]
  instruction: string
}
export function deliveryContract(intent: string, reason: string): DeliveryContract {
  if (intent !== 'analysis' && intent !== 'implementation') throw new Error('intent must be analysis|implementation')
  if (!reason?.trim()) throw new Error('intent_reason is required: state what the user asked to receive')
  return { version: 1, intent, reason: reason.trim(), created_at: new Date().toISOString(), runs: [] }
}
export function isAnalysis(state: Pick<TaskState, 'delivery'>): boolean { return state.delivery?.intent === 'analysis' }
export function analysisWorkflow(): WorkflowConfig {
  return { stages: ['调查分析', '完成'], start_stage: '调查分析',
    transitions: [{ from: '调查分析', to: '完成', requires: ['artifacts_present'] }],
    artifacts: [{ stage: '调查分析', id: 'analysis', name: '原因与方案', fields: ['conclusion', 'proposal', 'limitations'] }],
    commit: { policy: 'manual', message_pattern: '', message_hint: '', checkpoints: [], file_scope: true },
    high_risk_requires_verification: false, review_depth: 'single' }
}
/** References are discovery hints, never write ownership. Reject ambiguous/cyclic batches before starting anything. */
export function validateQuestions(questions: InvestigationQuestion[]): void {
  if (!Array.isArray(questions) || !questions.length) throw new Error('delegate requires questions')
  const ids = new Set<string>()
  for (const q of questions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(q.id) || ids.has(q.id) || !q.question?.trim()) throw new Error('questions require unique IDs and a concrete question')
    ids.add(q.id)
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('question dependencies contain a cycle')
    if (visited.has(id)) return
    const q = questions.find(q => q.id === id)!
    visiting.add(id)
    for (const dependency of q.depends_on ?? []) {
      if (!ids.has(dependency)) throw new Error(`unknown question dependency: ${dependency}`)
      visit(dependency)
    }
    visiting.delete(id); visited.add(id)
  }
  for (const id of ids) visit(id)
}
/** The caller reads through the host FS and checks real paths before providing source text. */
export function sourceEvidence(claim: SourceLocation, source: string, contentHash: string): SourceEvidence {
  if (!claim.file || !Number.isSafeInteger(claim.start_line) || !Number.isSafeInteger(claim.end_line)
    || claim.start_line < 1 || claim.end_line < claim.start_line || claim.end_line - claim.start_line >= 200) throw new Error('source evidence requires a file and a valid 1-based range of at most 200 lines')
  const lines = source.replace(/\r\n/gu, '\n').split('\n')
  const window = lines.slice(claim.start_line - 1, claim.end_line).join('\n')
  const highlight = claim.quote?.replace(/\r\n/gu, '\n')
  if (claim.end_line > lines.length || !window.trim() || (highlight !== undefined && (!highlight.trim() || !window.includes(highlight)))) throw new Error(`evidence does not match current source: ${claim.file}:${claim.start_line}; omit quote to capture this exact source range, or correct the range/quote`)
  return { ...claim, quote: window, content_hash: contentHash, ...(highlight === undefined ? {} : { highlight }) }
}
export function parseInvestigationReport(text: string): InvestigationReport {
  return validateInvestigationReport(JSON.parse(text))
}
/** Native schema capture is separate from assistant text, which may contain only commentary. */
export function validateInvestigationReport(input: unknown): InvestigationReport {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid investigation report')
  const value = input as InvestigationReport
  if (!['complete', 'partial', 'blocked'].includes(value.status) || typeof value.summary !== 'string' || !value.summary.trim() || !Array.isArray(value.evidence)
    || !Array.isArray(value.limitations) || value.limitations.some(v => typeof v !== 'string')) throw new Error('invalid investigation report')
  if (value.status === 'complete' && !value.evidence.length) throw new Error('a complete investigation requires source evidence')
  for (const claim of value.evidence) if (!claim || typeof claim.file !== 'string' || !claim.file.trim()
    || !Number.isSafeInteger(claim.start_line) || !Number.isSafeInteger(claim.end_line) || claim.start_line < 1 || claim.end_line < claim.start_line
    || typeof claim.quote !== 'string' || !claim.quote.trim()) throw new Error('investigation evidence is malformed')
  return value
}
export function analysisBlockers(state: TaskState): string[] {
  if (!isAnalysis(state)) return []
  const contract = state.delivery!
  return [
    ...contract.runs.some(r => ['queued', 'starting', 'running'].includes(r.status)) ? ['investigation children are active; wait or recover before accepting'] : [],
    ...!contract.result ? ['submit a conclusion, proposal, limitations and exact source evidence'] : [],
  ]
}
export function deliveryView(state: TaskState): DeliveryView | undefined {
  if (!state.delivery) return undefined
  const { runs, result, ...contract } = state.delivery
  return { ...contract, ...(result ? { result } : {}), runs: runs.map((run): InvestigationView => ({ ...run, ...run.status !== 'returned' ? {} : { acceptance: !result ? 'pending_parent'
    : run.report?.evidence.some(claim => result.evidence.some(used => used.file === claim.file
      && used.start_line <= claim.end_line && claim.start_line <= used.end_line
      && used.quote.replace(/\r\n/gu, '\n').includes(claim.quote.replace(/\r\n/gu, '\n')))) ? 'used_in_delivery' : 'not_used' } })),
    next_actions: state.completed ? [] : isAnalysis(state) ? ['submit_analysis', 'delegate', 'recover_analysis', 'status'] : ['plan', 'accept_item', 'status'],
    instruction: isAnalysis(state) ? 'Investigate directly by default. Delegate only for a concrete benefit. Report confirmed findings early. Submit exact evidence and known limitations; no implementation/test/Sonar gate is required.' : 'Use existing project stages and evidence gates. Plan complete implementation/test units; delegation is optional.' }
}
