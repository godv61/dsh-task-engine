/**
 * Bundle the commit-msg hook into a self-contained CommonJS executable that runs
 * under any repo `type` (the installed `.git/hooks/package.json` pins CommonJS).
 * The pure gate logic imported from `src/engine.ts` + `src/workflows.ts` is
 * inlined, so the hook and the engine share one source of truth — no hand mirror.
 */

import { build } from 'esbuild'

await build({
  entryPoints: ['src/hook.ts'],
  outfile: 'hooks/commit-msg',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  loader: { '.ts': 'ts' },
  // node:fs / node:path / node:child_process stay external (node builtins)
  banner: { js: '#!/usr/bin/env node\n' },
})