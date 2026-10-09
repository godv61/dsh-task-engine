/** Read fresh Gradle JUnit XML evidence when successful builds omit test counts. */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

type Report = { signature: string; tests: number; failed: number; skipped: number }
export type GradleReportSnapshot = Map<string, Report>

const SKIP = new Set(['.git', '.dsh', 'node_modules', '.gradle', 'build', 'target', 'dist', 'out'])

function inside(root: string, candidate: string): boolean {
  const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  return key(candidate) === key(root) || key(candidate).startsWith(key(root.endsWith(sep) ? root : root + sep))
}

function safeDirectory(root: string, path: string): boolean {
  try {
    return lstatSync(path).isDirectory() && inside(root, realpathSync.native(path))
  } catch { return false }
}

function numberAttribute(tag: string, name: string): number | undefined {
  const match = new RegExp(`(?:^|\\s)${name}="(\\d+)"`, 'u').exec(tag)
  return match ? Number(match[1]) : undefined
}

function readReport(root: string, path: string): Report | undefined {
  try {
    if (!lstatSync(path).isFile() || !inside(root, realpathSync.native(path))) return undefined
    const info = statSync(path)
    if (!info.isFile() || info.size > 5 * 1024 * 1024) return undefined
    const bytes = readFileSync(path)
    const tag = /<testsuite\b[^>]*>/iu.exec(bytes.toString('utf8', 0, Math.min(bytes.length, 16384)))?.[0]
    if (!tag) return undefined
    const tests = numberAttribute(tag, 'tests')
    const failures = numberAttribute(tag, 'failures')
    const errors = numberAttribute(tag, 'errors') ?? 0
    const skipped = numberAttribute(tag, 'skipped') ?? 0
    if (tests === undefined || failures === undefined || skipped > tests) return undefined
    return { signature: `${info.mtimeMs}:${createHash('sha256').update(bytes).digest('hex')}`,
      tests, failed: failures + errors, skipped }
  } catch { return undefined }
}

/** Bounded root + two-module-level scan; links outside the project are ignored. */
export function snapshotGradleReports(projectRoot: string): GradleReportSnapshot {
  const reports: GradleReportSnapshot = new Map()
  let root: string
  try { root = realpathSync.native(resolve(projectRoot)) }
  catch { return reports }
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited++ < 200 && reports.size < 1000) {
    const { dir, depth } = queue.shift()!
    const resultDir = join(dir, 'build', 'test-results', 'test')
    if (safeDirectory(root, resultDir)) {
      let names: string[] = []
      try { names = readdirSync(resultDir).filter(name => /^TEST-.+\.xml$/iu.test(name)).slice(0, 1000 - reports.size) }
      catch { /* Missing or unreadable reports cannot prove tests. */ }
      for (const name of names) {
        const file = join(resultDir, name)
        const entry = readReport(root, file)
        if (entry) reports.set(relative(root, file), entry)
      }
    }
    if (depth >= 2) continue
    let children: string[] = []
    try { children = readdirSync(dir).filter(name => !SKIP.has(name)).slice(0, 200) }
    catch { continue }
    for (const name of children) {
      const child = join(dir, name)
      if (safeDirectory(root, child)) queue.push({ dir: child, depth: depth + 1 })
    }
  }
  return reports
}

/** Count only reports changed by this validation run, never stale XML on disk. */
export function freshGradleReportSummary(before: GradleReportSnapshot, after: GradleReportSnapshot):
  { count: number; files: number } | undefined {
  const fresh = [...after].filter(([path, report]) => before.get(path)?.signature !== report.signature)
  if (fresh.length === 0) return undefined
  if (fresh.some(([, report]) => report.failed > 0)) return { count: 0, files: fresh.length }
  return { count: fresh.reduce((sum, [, report]) => sum + report.tests - report.skipped, 0), files: fresh.length }
}
