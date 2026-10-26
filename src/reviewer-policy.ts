/** Host-owned receipts for the read-only reviewer preset; unavailable proof blocks acceptance. */
import { Service, type Context } from '@deepseek-ai/cordis'

import { REVIEW_PRESET, validReviewPolicy, type ReviewPolicyProof } from './reviewer-spec.ts'
export interface ReviewPolicyService {
  readonly preset: string
  record(proof: ReviewPolicyProof): void
  proof(childId: string): ReviewPolicyProof | undefined
}
declare module '@deepseek-ai/cordis' { interface Context { taskEngineReviewPolicy: ReviewPolicyService } }

/** Receipts are produced by the child guard, never by a model response. */
export default class ReviewerPolicy extends Service implements ReviewPolicyService {
  readonly preset = REVIEW_PRESET
  private readonly proofs = new Map<string, ReviewPolicyProof>()
  constructor(ctx: Context) { super(ctx, 'taskEngineReviewPolicy') }
  record(proof: ReviewPolicyProof): void {
    if (!validReviewPolicy(proof, proof.child_id)) throw new Error('invalid reviewer tool policy')
    this.proofs.set(proof.child_id, { ...proof, tools: [...proof.tools] })
    if (this.proofs.size > 200) this.proofs.delete(this.proofs.keys().next().value!)
  }
  proof(childId: string): ReviewPolicyProof | undefined {
    const proof = this.proofs.get(childId)
    return proof ? { ...proof, tools: [...proof.tools] } : undefined
  }
}
