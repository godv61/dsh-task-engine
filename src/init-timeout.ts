/** A shared generation deadline includes reads, reasoning, composition and any retry. */
export const DEFAULT_INIT_TIMEOUT_MINUTES = 10
export function initTimeBudget(minutes = DEFAULT_INIT_TIMEOUT_MINUTES): { generationMs: number; jobMs: number; pollMs: number } {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) throw new Error('单项初始化时间预算须为1至30分钟的整数')
  const generationMs = minutes * 60_000
  return { generationMs, jobMs: generationMs + 30_000, pollMs: generationMs + 60_000 }
}
export const INIT_ATTEMPT_TIMEOUT_MS = initTimeBudget().generationMs
export const INIT_JOB_TIMEOUT_MS = initTimeBudget().jobMs
export const INIT_POLL_TIMEOUT_MS = initTimeBudget().pollMs

/** Bound the await even if a provider ignores AbortSignal. Late results are discarded. */
export async function withInitTimeout<T>(work: (signal: AbortSignal) => Promise<T>, milliseconds: number,
  message: string): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message)
      controller.abort(error)
      reject(error)
    }, milliseconds)
  })
  try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), expired]) }
  finally { clearTimeout(timer) }
}
