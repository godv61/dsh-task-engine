/** Managed activation compatibility and detached child read evidence. */
import type { Context } from '@deepseek-ai/cordis'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentActivation, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { validReviewPolicy, type ReviewPolicyProof } from './reviewer-spec.ts'
import type {} from './reviewer-policy.ts'

export type TaskActivation = Pick<SubagentActivation, 'childId' | 'messageId' | 'result' | 'dispose'> & { readonly name?: string }
/** Canonical task options; 0.2.2-rc.2 flattened the activation's former request. */
export type TaskActivationSpec = Omit<SubagentStartRequest, 'label' | 'signal'> & {
  readonly provider: string
  readonly label: string
  readonly childId?: SessionId
  readonly signal: AbortSignal
  readonly delivery: 'parent' | 'caller'
}
type LegacyActivationSpec = Pick<TaskActivationSpec, 'provider' | 'label' | 'childId' | 'signal' | 'delivery'> & {
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal'>
}
/** Select once before dispatch; never retry another shape after a possible child start.
 * namesOf is the public named-tree API introduced with the flattened rc.2 contract.
 * The explicit seam supports both published signatures without binding to internals.
 */
export function startTaskActivation(runtime: Pick<SubagentRuntime, 'startActivation'>, spec: TaskActivationSpec): Promise<TaskActivation> {
  const start = runtime.startActivation as (spec: TaskActivationSpec | LegacyActivationSpec) => Promise<TaskActivation>
  if (typeof (runtime as { namesOf?: unknown }).namesOf === 'function') return start.call(runtime, spec)
  const { provider, label, childId, signal, delivery, ...request } = spec
  return start.call(runtime, { provider, label, ...(childId !== undefined ? { childId } : {}), signal, delivery, request })
}
/** The startup signal no longer cancels a published child; this owner explicitly disposes that exact activation. */
export function ownActivation(activation: TaskActivation, signal: AbortSignal): TaskActivation {
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => disposal ??= Promise.resolve().then(() => activation.dispose())
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => { void dispose().then(() => reject(new Error('parent cancelled child activation')), reject) }
  })
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return { childId: activation.childId, ...(activation.name !== undefined ? { name: activation.name } : {}), ...activation.messageId ? { messageId: activation.messageId } : {}, dispose,
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
