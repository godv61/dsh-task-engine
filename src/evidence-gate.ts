/** Filesystem-dependent receipt checks shared by dev_task and the installed hook. */
import { verificationHeldStages, type TaskState, type WorkflowConfig } from './engine.ts'

export function verificationEvidenceBlockers(state: TaskState, workflow: WorkflowConfig, currentScopeHash: string): string[] {
  const needsVerification = verificationHeldStages(workflow).has(state.stage)
    || workflow.transitions.some(edge => edge.from === state.stage && (edge.requires ?? []).includes('verified'))
  if (!needsVerification || !state.verification.passed) return []
  const receipt = state.verification.receipt
  if (!receipt) return ['verification has no command receipt; rerun verify on the current files']
  if (receipt.scope_changed_during_run) return ['task files changed while verification ran; rerun tests']
  if (!receipt.scope_hash || receipt.scope_hash !== currentScopeHash) {
    return ['verification is stale after file/scope changes; rerun verify on the current files']
  }
  return []
}
