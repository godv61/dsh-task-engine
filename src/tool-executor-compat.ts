/** Public executor APIs differ across the supported Harness releases. */
import type { Context } from '@deepseek-ai/cordis'

type LegacyTools = { presentAs(mode: 'native'): () => void }
type ModernTools = { setExecutor?: (executor: unknown) => () => void }

/** Mount at preset scope, never at Agent scope: 0.2.2 executor disposal leaves
 * an unavailable selection, so a temporary Agent override cannot restore PTC.
 * Switching presets instead restores the host's inherited executor naturally.
 */
export async function installPresetExecutor(ctx: Context): Promise<void> {
  if (typeof (ctx.tools as unknown as Partial<LegacyTools>).presentAs === 'function') return
  const tools = ctx.tools as unknown as ModernTools
  if (typeof tools.setExecutor !== 'function') throw new Error('Unsupported Harness tool executor API')
  const { NativeToolExecutor } = await import('@deepseek-ai/dsh-tool-executor-native')
  tools.setExecutor(new NativeToolExecutor(ctx))
}

/** Legacy hosts need a temporary presentation override in addition to restrict.
 * New hosts use the mandatory native executor installed by the preset above.
 */
export function presentNativeTools(ctx: Context): () => void {
  const legacy = ctx.tools as unknown as Partial<LegacyTools>
  if (typeof legacy.presentAs === 'function') return legacy.presentAs('native')
  if (typeof (ctx.tools as unknown as ModernTools).setExecutor !== 'function') throw new Error('Unsupported Harness tool executor API')
  return () => {}
}
