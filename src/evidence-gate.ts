/** Filesystem-dependent receipt checks shared by dev_task and the installed hook. */
import { verificationHeldStages, type TaskState, type WorkflowConfig } from './engine.ts'
import { groupEvidenceBlockers, verificationKey } from './verification-state.ts'

export function verificationEvidenceBlockers(state: TaskState, workflow: WorkflowConfig, currentScopeHash: string, groupHashes?: Record<string, string>): string[] {
  const needsVerification = verificationHeldStages(workflow).has(state.stage)
    || workflow.transitions.some(edge => edge.from === state.stage && (edge.requires ?? []).includes('verified'))
  if (!needsVerification) return []
  if (state.verification_version) return groupEvidenceBlockers(state, groupHashes)
  if (!state.verification.passed) return []
  const receipt = state.verification.receipt
  if (!receipt) return ['verification has no command receipt; rerun verify on the current files']
  if (receipt.scope_changed_during_run) return ['task files changed while verification ran; rerun tests']
  if (!receipt.scope_hash || receipt.scope_hash !== currentScopeHash) {
    return ['verification is stale after file/scope changes; rerun verify on the current files']
  }
  return []
}

/** A verdict belongs to the content and verification actually reviewed. */
export function reviewEvidenceBlockers(state: TaskState, currentScopeHash: string): string[] {
  if (state.review.outcome !== 'pass') return []
  if (state.review.scope_hash !== currentScopeHash
    || (state.verification_version ? state.review.verification_key !== verificationKey(state)
      : state.review.verification_at !== state.verification.receipt?.finished_at)) {
    return ['review is stale or has no content receipt; rerun review on the current verified files']
  }
  return []
}
