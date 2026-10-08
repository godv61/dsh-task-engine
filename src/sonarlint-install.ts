/** Install the standalone SonarLint backend on first use; connected mode fetches analyzers from SonarQube. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
const VERSION = '11.9.0.86162'
const BASE = `https://repo.maven.apache.org/maven2/org/sonarsource/sonarlint/core/sonarlint-backend-cli/${VERSION}`
const DISTRIBUTIONS: Record<string, { archive: string; sha256: string }> = {
  'win32-x64': { archive: 'windows_x64.zip', sha256: 'ff08fa813ef0507155d8e550b90425174cf778e63a473eabca53c19fe942f90b' },
  'linux-x64': { archive: 'linux_x64.tar.gz', sha256: 'e3746b02ee7f66c2d01198a472d21067aebf84c0f042b8336cd9ecddce9284ce' },
  'darwin-x64': { archive: 'macosx_x64.tar.gz', sha256: '3afe23b87f8080a20bbe3e8a783cd1ea4502023b685a37fde21d1b0b3ca7ed44' },
  'darwin-arm64': { archive: 'macosx_aarch64.tar.gz', sha256: '95faa1a243a8d5e1f5ce6a9125dacbb25de455a95b5f398beca8fe4686448dd9' },
}

export interface SonarLintEnginePaths { java: string; lib: string; plugins: string[] }

function pluginsFromEnvironment(): string[] {
  return process.env.DSH_SONARLINT_PLUGINS?.split(sep === '\\' ? ';' : ':').filter(Boolean) ?? []
}

function installedPaths(root: string): SonarLintEnginePaths {
  return { java: join(root, 'jre', 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
    lib: join(root, 'lib'), plugins: pluginsFromEnvironment() }
}

function isInstalled(root: string): boolean {
  const paths = installedPaths(root)
  return existsSync(paths.java) && existsSync(join(paths.lib, `sonarlint-backend-cli-${VERSION}.jar`))
}

function safeTemporaryPath(parent: string, candidate: string): void {
  const rel = relative(resolve(parent), resolve(candidate))
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw new Error('SonarLint temporary installation path escaped its cache directory')
  }
}

async function download(url: string, destination: string, signal?: AbortSignal): Promise<void> {
  // curl honors HTTPS_PROXY on all supported hosts; DSH_SONARLINT_PROXY is an explicit DSH-only override.
  const proxy = process.env.DSH_SONARLINT_PROXY
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await run('curl', ['--fail', '--location', '--silent', '--show-error', '--proto', '=https',
      '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '1800',
      '--retry', '3', '--retry-delay', '3', '--retry-all-errors', '--continue-at', '-',
      '--output', destination, url], { timeout: 1_850_000,
      env: proxy ? { ...process.env, HTTPS_PROXY: proxy, https_proxy: proxy } : process.env,
      signal: controller.signal })
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`无法下载 SonarLint 后台组件；检查 Maven Central 网络或 DSH_SONARLINT_PROXY 代理设置：${String(error)}`)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  let response: Response
  try { response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1_800_000)]) : AbortSignal.timeout(1_800_000) }) }
  catch (error) { throw new Error(`无法下载 SonarLint 后台组件；检查 Maven Central 网络或代理：${String(error)}`) }
  if (!response.ok || !response.body) throw new Error(`SonarLint 后台组件下载失败：HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > 500 * 1024 * 1024) throw new Error('SonarLint 后台组件下载包过大')
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destination))
}

async function sha256(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

const pending = new Map<string, Promise<SonarLintEnginePaths>>()

/** Caller may pass a cache directory for testing; normal installations live outside project repositories. */
export async function resolveSonarLintEngine(cacheBase = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sonarlint-runtime'),
  signal?: AbortSignal, archivePath?: string): Promise<SonarLintEnginePaths> {
  const explicitJava = process.env.DSH_SONARLINT_JAVA
  const explicitLib = process.env.DSH_SONARLINT_LIB
  const plugins = pluginsFromEnvironment()
  if (explicitJava || explicitLib) {
    if (!explicitJava || !explicitLib || !existsSync(explicitJava) || !existsSync(explicitLib)
      || plugins.some(path => !existsSync(path))) {
      throw new Error('SonarLint 自定义路径不完整；请同时设置有效的 DSH_SONARLINT_JAVA 和 DSH_SONARLINT_LIB')
    }
    return { java: explicitJava, lib: explicitLib, plugins }
  }
  if (plugins.some(path => !existsSync(path))) throw new Error('DSH_SONARLINT_PLUGINS 中有不存在的分析器路径')
  const platform = `${process.platform}-${process.arch}`
  const distribution = DISTRIBUTIONS[platform]
  if (!distribution) throw new Error(`当前系统 ${platform} 暂无自动安装的 SonarLint 后台组件；可设置 DSH_SONARLINT_JAVA 和 DSH_SONARLINT_LIB`)
  const root = join(cacheBase, VERSION, platform)
  if (isInstalled(root)) return installedPaths(root)
  const existing = pending.get(root)
  if (existing) return existing
  const task = (async () => {
    const parent = join(cacheBase, VERSION)
    mkdirSync(parent, { recursive: true })
    const stage = join(parent, `.install-${platform}-${randomUUID()}`)
    safeTemporaryPath(parent, stage)
    mkdirSync(stage)
    try {
      const archive = join(stage, `distribution.${distribution.archive.endsWith('.zip') ? 'zip' : 'tar.gz'}`)
      if (archivePath) {
        copyFileSync(archivePath, archive)
      } else {
        await download(`${BASE}/sonarlint-backend-cli-${VERSION}-${distribution.archive}`, archive, signal)
      }
      const hash = await sha256(archive)
      if (hash !== distribution.sha256) throw new Error('SonarLint 后台组件校验失败；下载内容与官方校验值不符')
      await run('tar', ['-xf', archive, '-C', stage], { timeout: 180_000 })
      rmSync(archive)
      if (!isInstalled(stage)) throw new Error('SonarLint 后台组件缺少 Java 或后台依赖 JAR')
      if (!isInstalled(root)) {
        try { renameSync(stage, root) }
        catch (error) { if (!isInstalled(root)) throw error }
      }
      return installedPaths(root)
    } finally {
      safeTemporaryPath(parent, stage)
      if (existsSync(stage)) rmSync(stage, { recursive: true, force: true })
    }
  })()
  pending.set(root, task)
  try { return await task } finally { pending.delete(root) }
}
