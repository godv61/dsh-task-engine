/**
 * Ambient types for the `react-dom` baseline external. The DSH shell seeds
 * `react-dom` at runtime (the client bundle does not copy it), so this
 * declaration is type-check-only and covers the single entry this plugin uses:
 * `createPortal` for the skill/rule modal. It never reaches `lib/client.js`
 * because esbuild does not bundle `.d.ts`.
 *
 * @module dsh-task-engine/react-dom (ambient)
 */

declare module 'react-dom' {
  import type { ReactNode } from 'react'
  export function createPortal(children: ReactNode, container: Element): ReactNode
}