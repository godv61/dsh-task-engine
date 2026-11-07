/** Concrete file inputs shared by declaration, fingerprinting and recovery. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import { relative, resolve, sep } from 'node:path'
import { assertInsideRoot } from './path-guard.ts'
import { isSensitivePath } from './project.ts'
import { isTaskLedgerPath } from './task-paths.ts'

type Fs = Context['fs']
export type FileUse = 'delivery' | 'verification' | 'fingerprint'

export class TaskFileError extends Error {
  readonly code = 'INVALID_FILE_SCOPE'
  constructor(readonly path: string, owner: string, reason: string) {
    super('INVALID_FILE_SCOPE: ' + owner + ': ' + path + ': ' + reason
      + '; declare concrete regular files, not directories; correct scope or plan_verification before retrying')
    this.name = 'TaskFileError'
  }
}

/** Missing files are legitimate planned additions; an existing link or directory is not. */
export async function validateTaskFiles(fs: Fs, paths: readonly string[], root: string, owner: string, use: FileUse): Promise<string[]> {
  const checkedParents = new Set<string>()
  for (const path of new Set(paths)) {
    try {
      if (typeof path !== 'string' || !path.trim()) throw new Error('file path must be a non-empty string')
      assertInsideRoot(root, root, path)
      const local = relative(resolve(root), resolve(root, path)).replace(/\\/gu, '/')
      const canonical = process.platform === 'win32' ? local.toLowerCase() : local
      if (/[*?]/u.test(local)) throw new Error('wildcards are not concrete file paths')
      if (use !== 'fingerprint' && isTaskLedgerPath(canonical)) throw new Error('a changing task ledger cannot be a delivery or test input')
      if (use === 'delivery' && isSensitivePath(canonical)) throw new Error('sensitive delivery path: ' + path)
      // Inspect ancestors through the same host FS: a lexical in-root path can
      // still cross a linked parent, including when the final file is missing.
      const parts = local.split('/').filter(Boolean)
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join(sep)
        if (checkedParents.has(parent)) continue
        const info = await fs.lstat(parent, { cwd: root })
        if (info?.type !== undefined && info.type !== 'directory') throw new Error('parent is not an ordinary directory: ' + parent)
        checkedParents.add(parent)
      }
      const info = await fs.lstat(path, { cwd: root })
      if (info?.type !== undefined && info.type !== 'file') throw new Error('non-regular file (' + info.type + ')')
    } catch (error) {
      if (['ENOENT', 'FS_NOT_FOUND'].includes((error as { code?: string }).code ?? '')) continue
      throw new TaskFileError(String(path), owner, error instanceof Error ? error.message : String(error))
    }
  }
  return [...new Set(paths)]
}
