/** rc.3 managed activations and detached child read evidence. */
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { validReviewPolicy, type ReviewPolicyProof } from './reviewer-spec.ts'
import type {} from './reviewer-policy.ts'

export type TaskActivation = SubagentActivation
/** The startup signal no longer cancels a published child; this owner explicitly disposes that exact activation. */
export function ownActivation(activation: SubagentActivation, signal: AbortSignal): TaskActivation {
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => disposal ??= Promise.resolve().then(() => activation.dispose())
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => { void dispose().then(() => reject(new Error('parent cancelled child activation')), reject) }
  })
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return { childId: activation.childId, ...activation.messageId ? { messageId: activation.messageId } : {}, dispose,
    result: Promise.race([activation.result, cancelled]).finally(() => signal.removeEventListener('abort', abort)) }
}
/** Query the fresh child log after settlement, retaining the immutable cut after its observation lease is released. */
export async function reviewerEvents(ctx: Context, childId: string, signal: AbortSignal): Promise<readonly { type: string; data: unknown }[]> {
  const query = ctx.get('sessionQuery')
  if (!query) throw new Error('reviewer sessionQuery is unavailable; no read coverage can be proven')
  const observation = await query.observeSession(SessionId(childId), { signal, projectionMode: 'none' })
  try {
    if (observation.header.id !== childId) throw new Error('reviewer observation belongs to another child')
    return [...observation.events]
  } finally { observation[Symbol.dispose]() }
}
/** A successful model verdict is insufficient without the guard's own effective-tool receipt. */
export function reviewerProof(ctx: Context, childId: string, structured: boolean): ReviewPolicyProof {
  const proof = ctx.get('taskEngineReviewPolicy')?.proof(childId)
  if (!validReviewPolicy(proof, childId, structured)) throw new Error('readonly reviewer policy is missing or invalid; no independent verdict is accepted')
  return proof!
}
