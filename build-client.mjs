/**
 * Bundle the browser half into the closure factory the DSH client module loader
 * expects: `window.__ModuleLoader__.load({ id, factory: (require) => { ... } })`.
 * Only the baseline platform modules are external; `zod` and the shared host
 * `engine` module are inlined, so `lib/client.js` is self-contained apart from
 * React/Cordis/store/ui-slots/ui-primitives (provided by the shell at runtime).
 */

import { writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

const id = '@godv61/dsh-task-engine'

/** Declared surface for TypeScript consumers of `./client` (the bundle itself is a side-effectful loader registration). */
const CLIENT_DTS = `/** dsh-task-engine browser half — declared surface for TypeScript consumers of "./client". */
import type { Context } from '@deepseek-ai/cordis'

export const inject: string[]

export function apply(ctx: Context): Promise<() => Promise<void>>
`

const BASELINE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  // JSX compiles to the `react/jsx-runtime` automatic runtime, which is already
  // in BASELINE so it stays external. tsconfig.client.json matches (`react-jsx`).
  jsx: 'automatic',
  loader: { '.ts': 'tsx' },
  external: BASELINE,
  sourcemap: true,
  // Line mappings only. Inlining `sourcesContent` would publish the whole
  // `src/client` tree inside the shipped bundle's source map, defeating both
  // the `files` whitelist and the "tarball excludes src sources" check.
  sourcesContent: false,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;\n`,
  },
  footer: {
    js: '\nreturn module.exports; } });',
  },
})

await writeFile('lib/client.d.ts', CLIENT_DTS)