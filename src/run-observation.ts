/** Optional host observations must never manufacture usage or decide delivery acceptance. */
import type { RunMetrics } from './delivery-contract.ts'
export function runMetrics(events: readonly { type: string; data: unknown; seq?: number }[], started: number): RunMetrics {
  const unique = new Set<number>()
  const callIds = new Set<string>(), resultIds = new Set<string>(), messageIds = new Set<string>()
  let calls = 0, errors = 0, input = 0, cached = 0, output = 0, usageKnown = false
  for (const event of events) {
    if (event.seq !== undefined) { if (unique.has(event.seq)) continue; unique.add(event.seq) }
    const data = event.data as { turn?: number; step?: number; callId?: string; message?: { id?: string; toolCallId?: string; isError?: boolean }; stream?: { chunk?: { type: string; usage?: Record<string, number> } }[] }
    if (event.type === 'tool/call') {
      const key = `${data.turn}:${data.step}:${data.callId ?? event.seq}`
      if (!callIds.has(key)) { calls++; callIds.add(key) }
    }
    if (event.type === 'tool/result') {
      const key = `${data.turn}:${data.step}:${data.message?.toolCallId ?? event.seq}`
      if (!resultIds.has(key) && data.message?.isError) errors++
      resultIds.add(key)
    }
    if (event.type === 'assistant/message' && data.message?.id) {
      if (messageIds.has(data.message.id)) continue
      messageIds.add(data.message.id)
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') for (const part of data.stream ?? []) {
      if (part.chunk?.type !== 'usage' || !part.chunk.usage) continue
      usageKnown = true
      input += part.chunk.usage.inputTokens ?? 0
      cached += part.chunk.usage.cacheReadTokens ?? 0
      output += part.chunk.usage.outputTokens ?? 0
    }
  }
  return { elapsed_ms: Math.max(0, Date.now() - started), tool_calls: calls, errors,
    input_tokens: usageKnown ? input : null, cached_input_tokens: usageKnown ? cached : null, output_tokens: usageKnown ? output : null }
}
export function unknownMetrics(started: number): RunMetrics {
  return { elapsed_ms: Math.max(0, Date.now() - started), tool_calls: null, errors: null,
    input_tokens: null, cached_input_tokens: null, output_tokens: null }
}
export function parentMetrics(session: { snapshotEvents(): readonly unknown[] } | undefined, since: number): RunMetrics {
  try {
    const events = (session?.snapshotEvents() ?? []) as readonly { type: string; data: unknown; time?: number; seq?: number }[]
    const observed = events.filter(event => typeof event.time === 'number' && event.time >= since)
    return observed.length ? runMetrics(observed, since) : unknownMetrics(since)
  } catch { return unknownMetrics(since) }
}
