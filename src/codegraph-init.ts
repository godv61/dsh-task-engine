/** Optional CodeGraph CLI evidence for project initialization. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface CodeGraphState {
  installed: boolean
  indexed: boolean
  summary: string
}

async function run(root: string, program: 'codegraph' | 'npm', args: string[], timeout = 30_000): Promise<string> {
  // Arguments below are fixed by the plugin; the project path is passed only as cwd.
  const command = process.platform === 'win32' ? 'cmd.exe' : program
  const parameters = process.platform === 'win32'
    ? ['/d', '/s', '/c', [program, ...args.map(arg => /^[\w.-]+$/u.test(arg) ? arg : `"${arg}"`)].join(' ')]
    : args
  const { stdout } = await exec(command, parameters, { cwd: root, timeout, maxBuffer: 512_000, windowsHide: true })
  return stdout.trim().slice(0, 12_000)
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
  const state = await codeGraphStatus(root)
  if (!state.indexed) return undefined
  try {
    const tree = await run(root, 'codegraph', ['files', '--format', 'tree', '--max-depth', '3', '--no-metadata'], 45_000)
    const contexts: string[] = []
    for (const module of modules.filter(name => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name)).slice(0, 5)) {
      try {
        const context = await run(root, 'codegraph', ['context', '--no-code', '--max-nodes', '6',
          `${module} entry points controllers services components`], 30_000)
        // Natural-language graph search may return an unrelated symbol with a matching name.
        // Keep only high-confidence results whose source path belongs to this module.
        const symbols = context.includes('Low-confidence match') ? [] : context.split('\n')
          .filter(line => line.startsWith('- ') && line.includes(`${module}/`))
          .slice(0, 6)
        contexts.push(`### ${module}\n${symbols.length ? symbols.join('\n') : '未找到可靠的模块符号匹配；请以目录结构和源码为准。'}`)
      } catch { contexts.push(`### ${module}\n图谱查询不可用；请直接核对源码。`) }
    }
    return `CodeGraph 状态：${state.summary.slice(0, 1200)}\n索引文件结构：\n${tree.slice(0, 4000)}\n模块代表性符号（只作导航线索，不据此断言业务含义）：\n${contexts.join('\n\n').slice(0, 7000)}`
  } catch { return `CodeGraph 索引存在，但图谱查询失败；不能据此推断模块关系。状态：${state.summary.slice(0, 1200)}` }
}
