/** Validate complete resource packages before exclusive installation. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, relative, sep } from 'node:path'
import type { ResourceImportRequest, ResourcePreview } from './resource-types.ts'

export const IMPORT_LIMITS = { files: 1000, bytes: 100 * 1024 * 1024, fileBytes: 20 * 1024 * 1024, depth: 20 }
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.cache', '.DS_Store'])
type Entry = { path: string; data: Buffer }

/** Reject links in the path itself and every existing parent. */
export function assertRealPath(path: string): void {
  let cursor = resolve(path)
  for (;;) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('不允许符号链接或目录联接：' + cursor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}

function safeRelative(path: string): string {
  const parts = path.split('/')
  if (parts.length > IMPORT_LIMITS.depth || parts.some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f<>"|?*]/u.test(p) || /[. ]$/u.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(p))) {
    throw new Error('不安全的文件路径或目录超过 20 层：' + path)
  }
  return path
}

function sourceEntries(source: string): Entry[] {
  if (!isAbsolute(source)) throw new Error('源目录必须是绝对路径')
  assertRealPath(source)
  if (!lstatSync(source).isDirectory()) throw new Error('请选择文件夹')
  if (!existsSync(join(source, 'SKILL.md'))) {
    const candidates = readdirSync(source, { withFileTypes: true }).filter(e => e.isDirectory() && !SKIP.has(e.name) && existsSync(join(source, e.name, 'SKILL.md')))
    if (candidates.length !== 1) throw new Error('缺少 SKILL.md 或存在多个带 SKILL.md 的子目录，请直接选择技能根目录')
    source = join(source, candidates[0]!.name)
  }
  const entries: Entry[] = []
  let bytes = 0
  let nodes = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > IMPORT_LIMITS.depth) throw new Error('目录超过 20 层')
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(item.name)) continue
      if (++nodes > 3000) throw new Error('目录项过多')
      const path = join(dir, item.name)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) throw new Error('不允许符号链接：' + path)
      if (info.isDirectory()) { walk(path, depth + 1); continue }
      if (!info.isFile()) throw new Error('不允许特殊文件：' + path)
      if (info.size > IMPORT_LIMITS.fileBytes || bytes + info.size > IMPORT_LIMITS.bytes || entries.length >= IMPORT_LIMITS.files) throw new Error('技能超限：1000 文件 / 100 MB / 单文件 20 MB')
      assertRealPath(path)
      const data = readFileSync(path)
      bytes += data.length
      entries.push({ path: relative(source, path).replace(/\\/gu, '/'), data })
    }
  }
  walk(source, 0)
  return entries
}

function decode(request: ResourceImportRequest): Entry[] {
  if (request.sourceDir !== undefined) {
    if (request.kind !== 'skill' || request.files.length) throw new Error('目录导入只接受技能，不能同时上传文件')
    return sourceEntries(request.sourceDir)
  }
  if (!request.files.length || request.files.length > IMPORT_LIMITS.files) throw new Error('请选择 1 至 1000 个文件')
  let encoded = 0
  return request.files.map(file => {
    encoded += file.base64.length
    if (file.base64.length > Math.ceil(IMPORT_LIMITS.fileBytes / 3) * 4 || encoded > Math.ceil(IMPORT_LIMITS.bytes / 3) * 4 + 4000) throw new Error('上传超过大小限制')
    safeRelative(file.path)
    const data = Buffer.from(file.base64, 'base64')
    if (data.length > IMPORT_LIMITS.fileBytes) throw new Error('单文件超过 20 MB')
    if (data.toString('base64') !== file.base64) throw new Error('文件编码无效')
    return { path: file.path, data }
  }).filter(file => !file.path.split('/').some(part => SKIP.has(part)))
}

/** Build a preview from the exact bytes that a subsequent install will validate again. */
export function prepareImport(request: ResourceImportRequest, base: string, bundled: (name: string) => boolean): { preview: ResourcePreview; entries: Entry[] } {
  let entries = decode(request)
  let name: string
  let description = ''
  let content: string
  if (request.kind === 'skill') {
    const direct = entries.find(e => e.path === 'SKILL.md')
    const roots = entries.filter(e => e.path.endsWith('/SKILL.md'))
    if (!direct) {
      if (roots.length !== 1) throw new Error('缺少 SKILL.md 或包含多个技能，请选择一个技能文件夹')
      const prefix = roots[0]!.path.slice(0, -'SKILL.md'.length)
      entries = entries.filter(e => e.path.startsWith(prefix)).map(e => ({ ...e, path: e.path.slice(prefix.length) }))
    }
    const file = entries.find(e => e.path === 'SKILL.md')!
    if (file.data.length > 1024 * 1024) throw new Error('SKILL.md 不能超过 1 MB')
    content = new TextDecoder('utf-8', { fatal: true }).decode(file.data).replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
    const front = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1]
    const field = (key: string) => front?.match(new RegExp('^' + key + ':\\s*(.+)$', 'mu'))?.[1]?.trim().replace(/^(['"])(.*)\1$/u, '$2') ?? ''
    name = field('name'); description = field('description')
    if (!description) throw new Error('SKILL.md 需要 name 和 description')
    content = content.replace(/^---\n[\s\S]*?\n---(?:\n|$)/u, '')
  } else {
    if (entries.length !== 1 || !/\.md$/iu.test(entries[0]!.path)) throw new Error('规则请选择一个 .md 文件')
    const file = entries[0]!
    if (file.data.length > 1024 * 1024) throw new Error('规则文件不能超过 1 MB')
    name = file.path.split('/').at(-1)!.replace(/\.md$/iu, '')
    content = new TextDecoder('utf-8', { fatal: true }).decode(file.data).replace(/^\uFEFF/u, '')
    if (!content.trim()) throw new Error('规则文件不能为空')
    entries = [{ path: name + '.md', data: file.data }]
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) throw new Error('名称需使用小写字母、数字和连字符；请修改源文件后重新选择')
  if (bundled(name)) throw new Error('内置资源不可覆盖，请使用不同名称')
  const seen = new Set<string>()
  let bytes = 0
  for (const entry of entries) {
    safeRelative(entry.path)
    const key = entry.path.toLowerCase()
    if (seen.has(key)) throw new Error('存在重复或仅大小写不同的路径：' + entry.path)
    seen.add(key)
    bytes += entry.data.length
    if (entry.data.length > IMPORT_LIMITS.fileBytes) throw new Error('单文件超过 20 MB')
  }
  for (const key of seen) {
    const parts = key.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (seen.has(parts.slice(0, i).join('/'))) throw new Error('文件与目录路径冲突：' + key)
    }
  }
  if (entries.length > IMPORT_LIMITS.files || bytes > IMPORT_LIMITS.bytes) throw new Error('技能超限：1000 文件 / 100 MB')
  const target = join(base, request.kind === 'skill' ? name : name + '.md')
  assertRealPath(target)
  const conflict = existsSync(target) || (existsSync(base) && readdirSync(base).some(n => n.toLowerCase() === (request.kind === 'skill' ? name : name + '.md').toLowerCase()))
  const digest = createHash('sha256').update(JSON.stringify([request.kind, request.level, resolve(target)]))
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) digest.update(JSON.stringify([entry.path, entry.data.length])).update(entry.data)
  return { preview: { ok: true, name, description, content, target, files: entries.length, bytes, hash: digest.digest('hex'), conflict }, entries }
}

/** Install only a reviewed package; never overwrite an existing destination. */
export function commitImport(request: ResourceImportRequest, base: string, bundled: (name: string) => boolean): ResourcePreview {
  const { preview, entries } = prepareImport(request, base, bundled)
  if (!request.expectedHash || request.expectedHash !== preview.hash) throw new Error('预览后内容或目标发生变化，请重新预览')
  if (preview.conflict) throw new Error('目标已有同名资源，请先检查现有内容')
  mkdirSync(base, { recursive: true })
  assertRealPath(base)
  if (request.kind === 'rule') {
    const fd = openSync(preview.target, 'wx')
    try { writeFileSync(fd, entries[0]!.data) }
    catch (error) { closeSync(fd); unlinkSync(preview.target); throw error }
    closeSync(fd)
    return preview
  }
  mkdirSync(preview.target) // Exclusive ownership: cleanup below can only remove this call's new directory.
  try {
    for (const entry of entries) {
      const target = join(preview.target, entry.path)
      assertRealPath(target)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, entry.data, { flag: 'wx' })
    }
  } catch (error) {
    assertRealPath(preview.target)
    if (resolve(preview.target) === resolve(base) || !resolve(preview.target).startsWith(resolve(base) + sep)) throw error
    rmSync(preview.target, { recursive: true, force: true })
    throw error
  }
  return preview
}
