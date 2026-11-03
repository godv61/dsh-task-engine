/** Explicit recovery actions must be legal from the current workflow stage. */
import type { TaskState, WorkflowConfig } from './engine.ts'

export function implementationRecovery(state: TaskState, workflow: WorkflowConfig, itemIds?: string[]) {
  const target = workflow.stages.find(stage => stage === '代码开发' || stage === '开发')
  if (!target || workflow.stages.indexOf(state.stage) < workflow.stages.indexOf(target)) return undefined
  const affected = itemIds?.length ? [...new Set(itemIds)] : state.items.filter(item => item.execution_plan).map(item => item.id)
  return { operation: 'revise', task_id: state.id, revision_kind: 'defect',
    revision_reason: 'Repair findings and refresh the affected implementation reviews', target_stage: target,
    ...(affected.length ? { affected_items: affected } : {}) }
}

export function reviewRecoveryMessage(state: TaskState, workflow: WorkflowConfig, reason: string, itemIds?: string[]): string {
  const recovery = implementationRecovery(state, workflow, itemIds)
  return reason + (recovery ? `\nRecovery: call dev_task ${JSON.stringify(recovery)} before editing or re-accepting items. `
    + 'Then load missing bound Skills, fix the findings, verify only missing/changed checks, and accept_item (new contract) or review_item/items (legacy). Unchanged passing checks remain reusable.' : '')
}
