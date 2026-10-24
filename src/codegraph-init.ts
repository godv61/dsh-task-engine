/** Optional CodeGraph CLI evidence for project initialization. */
import { exec as execShell, execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { assertRealPath } from './resource-import.ts'

const exec = promisify(execFile)
const shell = promisify(execShell)

export interface CodeGraphState {
  installed: boolean
  indexed: boolean
  summary: string
}

async function run(root: string, program: 'codegraph' | 'npm', args: string[], timeout = 30_000, maxCharacters = 12_000): Promise<string> {
  // Arguments below are fixed by the plugin; the project path is passed only as cwd.
  // execFile escapes quotes again when forwarding a command string to cmd.exe.
  // That makes npm receive a literal quoted package name on Windows.
  const options = { cwd: root, timeout, maxBuffer: 512_000, windowsHide: true }
  const { stdout } = process.platform === 'win32'
    ? await shell([program, ...args.map(arg => /^[\w@./-]+$/u.test(arg) ? arg : `"${arg}"`)].join(' '), options)
    : await exec(program, args, options)
  return stdout.trim().slice(0, maxCharacters)
}

/** Passive hint only: detecting a database is not a successful CLI/index health check. */
export function codeGraphInitHint(root: string): string {
  return existsSync(join(root, '.codegraph', 'codegraph.db'))
    ? '检测到 .codegraph/codegraph.db；先用 init_query_codegraph 的 status 核验索引，再按需查询 files 或 context。不要直接读取 SQLite 文件。'
    : '本项目未检测到 .codegraph/codegraph.db；可用 init_query_codegraph 的 status 核验。无可用索引时直接查阅源码，不自动安装或建索引。'
}

/** Fixed read-only CLI operations; model input is never accepted as a command line. */
export async function queryInitCodeGraph(root: string, mode: 'status' | 'files' | 'context', query?: string): Promise<unknown> {
  if (!['status', 'files', 'context'].includes(mode)) throw new Error('CodeGraph 只允许 status、files、context 查询')
  assertRealPath(join(root, '.codegraph', 'codegraph.db'))
  if (mode === 'status') return codeGraphStatus(root)
  if (!existsSync(join(root, '.codegraph', 'codegraph.db'))) throw new Error('项目索引不存在，请使用目录和源码继续查阅')
  if (mode === 'context' && (!query?.trim() || !/^[\p{L}\p{N}_./ -]{1,160}$/u.test(query) || query.trim().startsWith('-'))) {
    throw new Error('图谱查询仅接受1至160个文字、数字、空格与路径字符，不接受命令、选项或 shell 字符')
  }
  const args = mode === 'files' ? ['files', '--format', 'tree', '--max-depth', '4', '--no-metadata']
    : ['context', '--no-code', '--max-nodes', '12', query!.trim()]
  const output = await run(root, 'codegraph', args, 20_000, 12_001)
  return { mode, ...(query ? { query } : {}), output: output.slice(0, 12_000), truncated: output.length > 12_000,
    caution: '图谱可能过期、漏项或低置信匹配，仅作定位；请用文件读取工具核对源码。截断时应缩小 context 查询，不能把省略部分视为不存在。' }
}

export async function codeGraphStatus(root: string): Promise<CodeGraphState> {
  let version: string
  try { version = await run(root, 'codegraph', ['--version'], 15_000) }
  catch { return { installed: false, indexed: false, summary: '未检测到 CodeGraph CLI；可选择安装后再建立项目索引。' } }
  if (!existsSync(join(root, '.codegraph'))) return { installed: true, indexed: false,
    summary: `CodeGraph ${version} 已安装，当前项目尚未建立索引。` }
  try { return { installed: true, indexed: true, summary: (await run(root, 'codegraph', ['status'])).slice(0, 4000) } }
  catch (error) { return { installed: true, indexed: false,
    summary: `项目索引不可用：${error instanceof Error ? error.message : String(error)}` } }
}

export async function prepareCodeGraph(root: string, install: boolean): Promise<CodeGraphState> {
  let state = await codeGraphStatus(root)
  if (!state.installed && install) {
    await run(root, 'npm', ['install', '-g', '@colbymchenry/codegraph@latest'], 240_000)
    state = await codeGraphStatus(root)
  }
  if (!state.installed) throw new Error('CodeGraph 未安装。请先点击“安装 CodeGraph”，或按官方文档安装 CLI。')
  if (state.indexed) await run(root, 'codegraph', ['sync'], 240_000)
  else if (existsSync(join(root, '.codegraph'))) await run(root, 'codegraph', ['index'], 240_000)
  else await run(root, 'codegraph', ['init', '--yes'], 240_000)
  const updated = await codeGraphStatus(root)
  if (!updated.indexed) throw new Error(`CodeGraph 索引未就绪：${updated.summary}`)
  return updated
}

export async function codeGraphEvidence(root: string, modules: string[] = []): Promise<string | undefined> {
  if (!existsSync(join(root, '.codegraph'))) return undefined
  try {
    // Evidence is optional. Bound its total latency so opening the initialization
    // plan cannot wait for several sequential graph searches in a large index.
    const tree = await run(root, 'codegraph', ['files', '--format', 'tree', '--max-depth', '3', '--no-metadata'], 20_000)
    const selected = modules.filter(name => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name)).slice(0, 3)
    const contexts = await Promise.all(selected.map(async module => {
      try {
        const context = await run(root, 'codegraph', ['context', '--no-code', '--max-nodes', '6',
          `${module} entry points controllers services components`], 12_000)
        // Natural-language graph search may return an unrelated symbol with a matching name.
        // Keep only high-confidence results whose source path belongs to this module.
        const symbols = context.includes('Low-confidence match') ? [] : context.split('\n')
          .filter(line => line.startsWith('- ') && line.includes(`${module}/`))
          .slice(0, 6)
        return `### ${module}\n${symbols.length ? symbols.join('\n') : '未找到可靠的模块符号匹配；请以目录结构和源码为准。'}`
      } catch { return `### ${module}\n图谱查询不可用；请直接核对源码。` }
    }))
    return `CodeGraph 索引文件结构：\n${tree.slice(0, 4000)}\n模块代表性符号（只作导航线索，不据此断言业务含义）：\n${contexts.join('\n\n').slice(0, 7000)}`
  } catch { return 'CodeGraph 索引存在，但图谱查询失败；请使用目录、构建清单和源码证据继续初始化。' }
}
