// Normalize only the test driver's public invocation API, never plugin behavior.
export async function executeTool(ctx, input) {
  if (typeof ctx.tools.setExecutor !== 'function') return ctx.tools.execute(input)
  const { name, arguments: args, callId, ...context } = input
  const batch = await ctx.tools.execute({ ...context,
    calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }] })
  if (batch.results.length !== 1 || batch.results[0].callId !== callId) throw new Error('Unexpected Harness tool batch result')
  return batch.results[0].result
}

export async function installTestExecutor(ctx) {
  if (typeof ctx.tools.setExecutor === 'function') {
    const { NativeToolExecutor } = await import('@deepseek-ai/dsh-tool-executor-native')
    ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  }
}
