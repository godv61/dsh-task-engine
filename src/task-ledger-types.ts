/** Shared browser-safe contract for the task workbench. */
import type { DeliveryView } from './delivery-contract.ts'
import type { VerificationGroupView } from './verification-state.ts'
import type { TaskLedgerContent } from './task-ledger-content.ts'

/** One implementation item's audit trail, projected for the task ledger view. */
export interface TaskLedgerItem {
  id: string
  title: string
  status: string
  execution_plan?: import('./execution-plan.ts').ExecutionPlan
  independent_review?: import('./execution-plan.ts').IndependentReview
  /** Subagent dispatch audit; absent until the item has been dispatched. */
  dispatch?: {
    description: string
    at: string
    provider?: string
    execution?: string
    run_id?: string
    status?: string
    output?: string
    error?: string
    finished_at?: string
    metrics?: import('./delivery-contract.ts').RunMetrics
  }
  dispatch_history?: NonNullable<TaskLedgerItem['dispatch']>[]
  /** Two-stage review audit; absent until the item has been reviewed. */
  review?: {
    independent_run_id?: string
    spec: { outcome: 'pass' | 'fail'; notes?: string[] }
    quality: { outcome: 'pass' | 'fail'; notes?: string[] }
  }
}

/** One task's ledger projection: identity, stage, and the per-item audit trail. */
export interface TaskLedgerEntry {
  content?: TaskLedgerContent
  requirements?: import('./requirements.ts').RequirementsView
  complexity?: string
  delivery?: DeliveryView
  evidence_status?: 'valid' | 'stale' | 'failed' | 'blocked' | 'missing' | 'historical' | 'unknown'
  evidence_problems?: string[]
  verification_groups?: VerificationGroupView[]
  review_status?: 'valid' | 'stale' | 'missing' | 'blocked' | 'historical'
  risk_level?: string
  updated_at?: string
  lifecycle: 'active' | 'ready_to_close' | 'archived'
  completed_at?: string
  related_task?: { id: string; kind: string }
  items_done: number
  next_action: string
  verification_passed?: boolean
  review_outcome?: string
  sonar?: {
    source: string
    audit?: {
      gate: string
      review_gate?: string
      checked_at: string
      target: string
      findings: { key: string; rule: string; message: string; severity: string; file: string; line?: number }[]
      blocking_count: number
      unresolved_count?: number
      uncovered_files: string[]
      dispositions?: { issue_key: string; kind: string; reason: string; evidence: string[]; approved_at: string }[]
      report_path?: string
      scanned_files?: string[]
      profile_coverage?: { language: string; active_rules: number; analyzer: string }[]
    }
  }
  task_id: string
  title: string
  stage: string
  branch: string
  items: TaskLedgerItem[]
}

/** `readTasks` result: every task record under the workspace's `.dsh/`. */
export interface TaskLedgerView {
  tasks: TaskLedgerEntry[]
  errors?: { file: string; message: string }[]
  next_cursor?: string
  total_count?: number
}
