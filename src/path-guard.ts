import { isAbsolute, relative, resolve, win32 } from 'node:path'

/**
 * Reject a workspace-relative write whose resolved target escapes the project
 * root. `cwd` is the session workspace (always inside `root`, since `root` is
 * discovered from it upward); this guards the reverse case: a mis-resolved root
 * or a `..`-carrying target must never write outside the project.
 */
export function assertInsideRoot(root: string, cwd: string, relPath: string): void {
  if (!isAbsolute(relPath) && win32.isAbsolute(relPath)) {
    throw new Error(`write target ${relPath} escapes the project root ${root}`)
  }
  const target = resolve(cwd, relPath)
  const rootDir = resolve(root)
  const inside = relative(rootDir, target)
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`write target ${target} escapes the project root ${rootDir}`)
  }
}
