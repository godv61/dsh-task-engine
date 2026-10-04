/** Local SonarQube for IDE engine. It reads server rules and source files; it never runs a scanner or uploads an analysis. */
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { SonarAudit, SonarFinding, SonarPolicy } from './sonar.ts'
import { isBlockingFinding, isIncludedAuditPath } from './sonar.ts'

const run = promisify(execFile)
const SUPPORTED_FILE = /\.(?:java|js|jsx|ts|tsx|vue|css|scss|html|jsp|xml|json|ya?ml|sql|properties|py|go|kt|kts|cs|c|cc|cpp|h|hpp|php|rb|sh|scala|groovy)$/iu
function isAuditSource(path: string): boolean {
  const parts = path.replaceAll('\\', '/').split('/')
  if (parts.some(part => ['.dsh', '.git', 'node_modules', 'target', 'dist', 'build'].includes(part))) return false
  return SUPPORTED_FILE.test(path)
}
function localLanguage(path: string): string | undefined {
  if (/\.java$/iu.test(path)) return 'JAVA'
  if (/\.(?:js|jsx|vue)$/iu.test(path)) return 'JS'
  if (/\.(?:ts|tsx)$/iu.test(path)) return 'TS'
  if (/\.(?:css|scss)$/iu.test(path)) return 'CSS'
  if (/\.html?$/iu.test(path)) return 'HTML'
  if (/\.xml$/iu.test(path)) return 'XML'
  return undefined
}

/** Languages which the server can assign to changed files that this local engine cannot analyze. */
function serverLanguages(path: string): string[] {
  const extension = /\.([^.\\/]+)$/u.exec(path)?.[1]?.toLowerCase()
  const languages: Record<string, string[]> = {
    sql: ['sql', 'plsql', 'tsql'], json: ['json'], yaml: ['yaml'], yml: ['yaml'],
    properties: ['properties'], py: ['py'], go: ['go'], kt: ['kotlin'], kts: ['kotlin'],
    cs: ['cs'], c: ['c'], cc: ['cpp'], cpp: ['cpp'], h: ['c', 'cpp'], hpp: ['cpp'],
    php: ['php'], rb: ['ruby'], sh: ['shell'], scala: ['scala'], groovy: ['groovy'],
  }
  return extension ? (languages[extension] ?? []) : []
}

export function uncoveredLocalFiles(paths: string[], profiles: { language?: string; activeRuleCount?: number }[]): string[] {
  const active = new Set(profiles.filter(profile => Number(profile.activeRuleCount) > 0)
    .map(profile => profile.language?.toLowerCase()).filter((language): language is string => !!language))
  return paths.filter(path => serverLanguages(path).some(language => active.has(language)))
}

/** A declared task scope must include every changed file selected for this project's local audit. */
export function missingLocalAuditScope(paths: string[], taskPaths: string[]): string[] {
  const declared = new Set(taskPaths.map(path => path.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase()))
  return paths.filter(path => !declared.has(path.replaceAll('\\', '/').replace(/^\.\//u, '').toLowerCase()))
}

interface ChangedFile { path: string; lines: Set<number>; newFile: boolean }

/** Compare the current working tree with a reference; an untracked file is wholly new. */
export async function changedLines(root: string, reference: string, taskPaths?: string[]): Promise<ChangedFile[]> {
  if (!/^[A-Za-z0-9._/-]+$/u.test(reference) || reference.startsWith('-')) throw new Error('invalid Sonar reference branch')
  const [diff, untracked] = await Promise.all([
    run('git', ['-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-color', '--unified=0', reference, '--'],
      { cwd: root, maxBuffer: 20 * 1024 * 1024 }),
    run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 5 * 1024 * 1024 }),
  ])
  const files = new Map<string, ChangedFile>()
  let current: string | undefined
  let newFile = false
  for (const line of diff.stdout.split(/\r?\n/u)) {
    if (line.startsWith('--- /dev/null')) newFile = true
    else if (line.startsWith('--- a/')) newFile = false
    else if (line.startsWith('+++ b/')) {
      current = line.slice(6).trim()
      if (current && isAuditSource(current)) files.set(current,
        files.get(current) ?? { path: current, lines: new Set(), newFile })
      else current = undefined
    } else if (line.startsWith('+++ /dev/null')) current = undefined
    else if (current && line.startsWith('@@ ')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line)
      if (!hunk) throw new Error(`cannot parse Git diff hunk for ${current}`)
      const first = Number(hunk[1]); const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      for (let n = first; n < first + count; n++) files.get(current)!.lines.add(n)
    }
  }
  for (const path of untracked.stdout.split('\0').filter(Boolean)) {
    if (!isAuditSource(path)) continue
    const absolute = resolve(root, path)
    if (relative(resolve(root), absolute).startsWith('..')) throw new Error('untracked path escaped the project root')
    const lines = readFileSync(absolute, 'utf8').split(/\r?\n/u).length
    files.set(path, { path, lines: new Set(Array.from({ length: lines }, (_, index) => index + 1)), newFile: true })
  }
  const scoped = taskPaths === undefined ? undefined : new Set(taskPaths.map(path => path.replaceAll('\\', '/')
    .replace(/^\.\//u, '').toLowerCase()))
  return [...files.values()].filter(file => file.lines.size
    && (scoped === undefined || scoped.has(file.path.replaceAll('\\', '/').toLowerCase())))
}

interface EnginePaths { java: string; lib: string; plugins: string[] }

/** The engine can be installed independently; environment paths point to its Java runtime and SonarLint JARs. */
function enginePaths(): EnginePaths {
  const java = process.env.DSH_SONARLINT_JAVA
  const lib = process.env.DSH_SONARLINT_LIB
  const plugins = process.env.DSH_SONARLINT_PLUGINS?.split(sep === '\\' ? ';' : ':').filter(Boolean) ?? []
  if (!java || !lib || !plugins.length || !existsSync(java) || !existsSync(lib) || plugins.some(path => !existsSync(path))) {
    throw new Error('本地 Sonar 审核需要 DSH_SONARLINT_JAVA、DSH_SONARLINT_LIB 和 DSH_SONARLINT_PLUGINS；请先安装 SonarLint 后台组件并配置路径')
  }
  return { java, lib, plugins }
}

interface RpcPending { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** Analyze only changed supported files with the project's synchronized Quality Profile. */
export async function inspectLocalRules(policy: SonarPolicy, token: string, root: string,
  scopeHash: string, signal?: AbortSignal, taskPaths?: string[]): Promise<SonarAudit> {
  if (!token) throw new Error('本地规则审核需要当前项目 SonarQube Token')
  if (!policy.reference_branch) throw new Error('本地规则审核需要新代码参考分支')
  const changes = (await changedLines(root, policy.reference_branch))
    .filter(file => isIncludedAuditPath(file.path, policy.include_paths))
  if (taskPaths !== undefined) {
    const missing = missingLocalAuditScope(changes.map(file => file.path), taskPaths)
    if (missing.length) throw new Error(`本地规则审核范围漏登 ${missing.length} 个新增代码文件；先用 dev_task scope 补齐后重试：${missing.join(', ')}`)
  }
  const unsupported = changes.filter(file => !localLanguage(file.path))
  const profilesUrl = new URL(`${policy.host_url.replace(/\/$/u, '')}/api/qualityprofiles/search`)
  profilesUrl.searchParams.set('project', policy.project_key)
  const profilesResponse = await fetch(profilesUrl, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
  if (!profilesResponse.ok) throw new Error(`SonarQube 项目规则配置查询失败（HTTP ${profilesResponse.status}）`)
  const profileData = await profilesResponse.json() as { profiles?: { language?: string; activeRuleCount?: number }[] }
  if (!Array.isArray(profileData.profiles)) throw new Error('SonarQube 未返回项目规则配置')
  const uncovered = uncoveredLocalFiles(unsupported.map(file => file.path), profileData.profiles)
  const branchUrl = new URL(`${policy.host_url.replace(/\/$/u, '')}/api/project_branches/list`)
  branchUrl.searchParams.set('project', policy.project_key)
  const branchResponse = await fetch(branchUrl, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
  if (!branchResponse.ok) throw new Error(`SonarQube 项目分支查询失败（HTTP ${branchResponse.status}）`)
  const branchData = await branchResponse.json() as { branches?: { name?: string; isMain?: boolean }[] }
  const serverMain = branchData.branches?.find(branch => branch.isMain === true)?.name
  if (!serverMain) throw new Error('SonarQube 未返回项目主分支，无法同步本地规则')
  const paths = enginePaths()
  const supported = changes.filter(change => localLanguage(change.path))
  const files = supported.map(change => {
    const absolute = resolve(root, change.path)
    if (relative(resolve(root), absolute).startsWith('..')) throw new Error('changed path escaped the project root')
    return { uri: pathToFileURL(absolute).href, ideRelativePath: change.path.replaceAll('\\', '/'),
      configScopeId: 'project', isTest: /(^|[\\/])test[\\/]/iu.test(change.path), charset: 'UTF-8',
      fsPath: absolute, content: readFileSync(absolute, 'utf8'), detectedLanguage: localLanguage(change.path), isUserDefined: true }
  })
  const fileLines = new Map(supported.map((change, index) => [files[index]!.uri, change.lines]))
  const newFiles = new Set(files.filter((_, index) => supported[index]?.newFile).map(file => file.uri))
  const cacheKey = `${resolve(root).toLowerCase()}\0${policy.host_url}\0${policy.project_key}`
  const stateDir = join(homedir(), '.dsh', 'sonarlint-cache', createHash('sha256').update(cacheKey).digest('hex').slice(0, 24))
  mkdirSync(stateDir, { recursive: true })
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-sonarlint-'))
  const child = spawn(paths.java, ['-cp', join(paths.lib, '*'),
    'org.sonarsource.sonarlint.core.backend.cli.SonarLintServerCli'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = Buffer.alloc(0)
  let id = 1
  let settled = false
  const pending = new Map<number, RpcPending>()
  const messages: string[] = []
  let ready: () => void = () => {}
  const readiness = new Promise<void>(resolveReady => { ready = resolveReady })
  let rejectExit: (error: Error) => void = () => {}
  const exited = new Promise<never>((_, reject) => { rejectExit = reject })
  void exited.catch(() => {})
  const write = (message: unknown) => {
    const payload = Buffer.from(JSON.stringify(message))
    child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`)
    child.stdin.write(payload)
  }
  const request = (method: string, params: unknown, timeout = 120_000): Promise<any> => {
    const current = id++
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { pending.delete(current); reject(new Error(`${method} timed out`)) }, timeout)
      pending.set(current, { resolve: accept, reject, timer })
      write({ jsonrpc: '2.0', id: current, method, params })
    })
  }
  const notify = (method: string, params: unknown) => write({ jsonrpc: '2.0', method, params })
  child.stderr.on('data', chunk => {
    const line = String(chunk).replaceAll(token, '[redacted]').slice(0, 500)
    if (messages.length < 8) messages.push(line)
  })
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const split = buffer.indexOf('\r\n\r\n')
      if (split < 0) break
      const length = Number(/Content-Length:\s*(\d+)/iu.exec(buffer.subarray(0, split).toString())?.[1])
      if (!Number.isFinite(length) || buffer.length < split + 4 + length) break
      const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString()) as {
        id?: number; method?: string; params?: any; result?: any; error?: { message?: string }
      }
      buffer = buffer.subarray(split + 4 + length)
      if (message.id !== undefined && message.method === undefined) {
        const task = pending.get(message.id); pending.delete(message.id)
        if (task) {
          clearTimeout(task.timer)
          if (message.error) task.reject(new Error(message.error.message ?? 'SonarLint RPC failed'))
          else task.resolve(message.result)
        }
      } else {
        if (message.method === 'didChangeAnalysisReadiness' && message.params?.areReadyForAnalysis === true) ready()
        if (message.method === 'log' && ['ERROR', 'WARN'].includes(message.params?.level) && messages.length < 8) {
          messages.push(String(message.params?.message ?? '').replaceAll(token, '[redacted]').slice(0, 500))
        }
        if (message.id !== undefined) {
          const result = message.method === 'getBaseDir' ? { baseDir: root }
            : message.method === 'getInferredAnalysisProperties' ? { properties: {} }
              : message.method === 'getFileExclusions' ? { fileExclusionPatterns: [] }
                : message.method === 'listFiles' ? { files }
                  : message.method === 'getCredentials' ? { credentials: { token } }
                    : message.method === 'selectProxies' ? { proxies: [] }
                      : message.method === 'checkServerTrusted' ? { trusted: false }
                        : message.method === 'matchSonarProjectBranch' ? { branchName: serverMain } : null
          write({ jsonrpc: '2.0', id: message.id, result })
        }
      }
    }
  })
  const failChild = (error: Error) => {
    if (!settled) {
      rejectExit(error)
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error) }
    }
  }
  child.on('error', error => failChild(new Error(`SonarLint could not start: ${error.message}`)))
  child.stdin.on('error', error => failChild(new Error(`SonarLint input failed: ${error.message}`)))
  child.on('exit', code => failChild(new Error(`SonarLint exited ${code}: ${messages.join('; ')}`)))
  const onAbort = () => child.kill()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await request('initialize', {
      clientConstantInfo: { name: 'DSH', userAgent: 'dsh-task-engine' },
      telemetryConstantAttributes: { productKey: 'dsh', productName: 'DSH', productVersion: '0', ideVersion: '0', additionalAttributes: {} },
      httpConfiguration: { sslConfiguration: {} }, backendCapabilities: ['FULL_SYNCHRONIZATION'],
      storageRoot: stateDir, workDir, embeddedPluginPaths: paths.plugins, connectedModeEmbeddedPluginPathsByKey: {},
      enabledLanguagesInStandaloneMode: ['JAVA'], extraEnabledLanguagesInConnectedMode: ['JS', 'TS', 'CSS', 'HTML', 'XML'], disabledPluginKeysForAnalysis: [],
      sonarQubeConnections: [{ connectionId: 'project', serverUrl: policy.host_url, disableNotifications: true }], sonarCloudConnections: [],
      standaloneRuleConfigByKey: {}, isFocusOnNewCode: false, automaticAnalysisEnabled: false,
      languageSpecificRequirements: { omnisharpDownloadEnabled: false }, logLevel: 'WARN',
    }, 30_000)
    notify('configuration/didAddConfigurationScopes', { addedScopes: [{ id: 'project', bindable: true, name: 'Project',
      binding: { connectionId: 'project', sonarProjectKey: policy.project_key, bindingSuggestionDisabled: true } }] })
    let readyTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([readiness, exited, new Promise((_, reject) => {
        readyTimer = setTimeout(() => reject(new Error(`SonarLint 项目规则同步超时：${messages.join('; ')}`)), 120_000)
      })])
    } finally { if (readyTimer) clearTimeout(readyTimer) }
    if (files.length) {
      notify('file/didUpdateFileSystem', { addedFiles: files, changedFiles: [], removedFiles: [] })
      const status = await request('file/getFilesStatus', { fileUrisByConfigScopeId: { project: files.map(file => file.uri) } })
      const excluded = files.filter(file => status.fileStatuses?.[file.uri]?.excluded)
      if (excluded.length) throw new Error(`SonarLint 排除了新增代码：${excluded.map(file => file.ideRelativePath).join(', ')}`)
    }
    const response = files.length ? await request('analysis/analyzeFilesAndTrack', {
      configurationScopeId: 'project', analysisId: randomUUID(), filesToAnalyze: files.map(file => file.uri),
      extraProperties: {}, shouldFetchServerIssues: false,
    }) : { rawIssues: [], failedAnalysisFiles: [] }
    if (response.failedAnalysisFiles?.length) throw new Error(`SonarLint 无法分析：${response.failedAnalysisFiles.join(', ')}`)
    const rawFindings: SonarFinding[] = (response.rawIssues ?? []).flatMap((issue: any) => {
      const uri = issue.fileUri ?? issue.uri ?? files[0]?.uri
      const line = issue.textRange?.startLine ?? issue.primaryLocation?.textRange?.startLine
      if (typeof uri !== 'string' || (typeof line !== 'number' && !newFiles.has(uri))
        || (typeof line === 'number' && !fileLines.get(uri)?.has(line))) return []
      const path = files.find(file => file.uri === uri)?.ideRelativePath ?? uri
      const identity = `${path}\0${line ?? 'file'}\0${issue.ruleKey}\0${issue.primaryMessage}`
      return [{ key: `local-${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`,
        rule: String(issue.ruleKey ?? ''), message: String(issue.primaryMessage ?? ''),
        severity: String(issue.severity ?? 'UNKNOWN'), file: path,
        ...(typeof line === 'number' ? { line } : {}) }]
    })
    const findings = [...new Map(rawFindings.map(finding => [finding.key, finding])).values()]
    const blocking = findings.filter(isBlockingFinding)
    return { ce_task_id: 'local', analysis_id: randomUUID(), gate: blocking.length || uncovered.length ? 'ERROR' : 'OK',
      checked_at: new Date().toISOString(), scope_hash: scopeHash, findings, blocking,
      ...(uncovered.length ? { uncovered_files: uncovered } : {}),
      target: policy.reference_branch, scanned_files: supported.map(file => file.path) }
  } finally {
    settled = true
    signal?.removeEventListener('abort', onAbort)
    child.stdin.end()
    setTimeout(() => child.kill(), 2000).unref()
    const resolvedWorkDir = resolve(workDir)
    const relativeWorkDir = relative(resolve(tmpdir()), resolvedWorkDir)
    if (relativeWorkDir && relativeWorkDir !== '..' && !relativeWorkDir.startsWith(`..${sep}`)
      && !relativeWorkDir.startsWith(sep) && relativeWorkDir.startsWith('dsh-sonarlint-')) {
      rmSync(resolvedWorkDir, { recursive: true, force: true })
    }
  }
}
