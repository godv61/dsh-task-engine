/** Browser-safe reviewer policy identity shared by task gates and host receipts. */
export const REVIEW_PRESET = 'task-engine-review'
/** Stable legacy preset ID now represents shared read-only evidence capability, not a forced second review. */
export const READONLY_PRESET = REVIEW_PRESET
export const REVIEW_TOOLS = ['read', 'glob', 'grep', 'structured_output'] as const
export interface ReviewPolicyProof { version: 1; preset: string; child_id: string; tools: string[] }
export function validReviewPolicy(proof: ReviewPolicyProof | undefined, childId?: string, structured = false): boolean {
  return !!proof && proof.version === 1 && proof.preset === REVIEW_PRESET && !!childId && proof.child_id === childId
    && Array.isArray(proof.tools) && proof.tools.includes('read') && (!structured || proof.tools.includes('structured_output'))
    && proof.tools.every(tool => (REVIEW_TOOLS as readonly string[]).includes(tool))
}
