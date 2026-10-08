/** Optional SonarQube audit for an existing CI scan or a local scanner run. */
export interface SonarPolicy {
  enabled: true
  host_url: string
  project_key: string
  mode: 'branch' | 'pull-request'
  /** Name of an environment variable containing a SonarQube user token. */
  token_env: string
  /** CI is the backwards-compatible default. Local runs the configured scanner before inspection. */
  source?: 'ci' | 'local' | 'ide-local'
  reference_branch?: string
  scan_command?: string
  /** Project-relative directories or files analyzed by the configured CI scan (ide-local only). */
  include_paths?: string[]
}

export interface SonarFinding {
  key: string
  rule: string
  message: string
  severity: string
  file: string
  line?: number
}

/** One human-approved exception for a single finding in one unchanged local audit. */
export interface SonarDisposition {
  issue_key: string
  kind: 'false_positive'
  reason: string
  evidence: string[]
  approved_at: string
}

export interface SonarAudit {
  ce_task_id: string
  analysis_id: string
  gate: string
  /** Unfiltered server Quality Gate, retained while this audit gates only new-code conditions. */
  server_gate?: string
  checked_at: string
  scope_hash: string
  commit_hash?: string
  findings: SonarFinding[]
  blocking: SonarFinding[]
  /** Local-only decisions; never rewrite the analyzer's original gate or server Quality Gate. */
  dispositions?: SonarDisposition[]
  /** Changed code files for which the local analyzer could not run. */
  uncovered_files?: string[]
  /** Branch or merge request used for new-code findings. */
  target: string
  /** Project-relative Markdown report written for this audit run. */
  report_path?: string
  /** Changed task files actually analyzed by the local engine. */
  scanned_files?: string[]
  /** Active project rules by language and whether an analyzer was synchronized locally. */
  profile_coverage?: { language: string; active_rules: number; analyzer: string }[]
}

/** Limit local analysis to the project-relative source roots used by the project's scanner. */
export function validAuditIncludePaths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every(path =>
    typeof path === 'string' && path.length > 0 && path.length <= 240
    && /^[A-Za-z0-9._/-]+$/u.test(path)
    && path.split('/').every((part: string) => part !== '' && part !== '.' && part !== '..'))
}

export function isIncludedAuditPath(path: string, includePaths: string[] | undefined): boolean {
  if (!includePaths?.length) return true
  const normalized = path.replace(/\\/gu, '/')
  return includePaths.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`))
}

type Json = Record<string, unknown>

/** A project file must not turn a credential-bearing scanner invocation into an arbitrary shell command. */
export function validLocalScanCommand(command: string): boolean {
  const value = command.trim()
  if (!value || /[^A-Za-z0-9_ .:\\/='",-]/u.test(value) || /\r|\n|sonar\.(?:token|login|password)|SONAR_TOKEN/iu.test(value)) return false
  const executable = value.split(/\s+/u)[0]!
  return /(?:^|[\\/])(?:mvn|mvn\.cmd|mvnw|mvnw\.cmd|sonar-scanner|sonar-scanner\.bat|sonar-scanner\.cmd)$/iu.test(executable)
}

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SonarQube returned an invalid object')
  return value as Json
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`SonarQube response lacks ${field}`)
  return value
}

async function api(policy: SonarPolicy, token: string, path: string, params: Record<string, string>, fetcher: typeof fetch): Promise<Json> {
  const url = new URL(`${policy.host_url.replace(/\/$/u, '')}/api/${path}`)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`SonarQube ${path} returned HTTP ${response.status}`)
  return object(await response.json())
}

/** Refuse a branch upload before invoking the scanner when the server cannot store it safely. */
export async function assertLocalSonarReady(policy: SonarPolicy, token: string, fetcher: typeof fetch = fetch): Promise<void> {
  const navigation = await api(policy, token, 'navigation/global', {}, fetcher)
  const edition = typeof navigation.edition === 'string' ? navigation.edition.toLowerCase() : ''
  if (edition === 'community') {
    throw new Error('SonarQube Community Build supports only the main analysis branch; local task-branch scanning needs Developer Edition or higher. The shared main analysis was not changed.')
  }
  if (!['developer', 'enterprise', 'datacenter', 'data_center'].includes(edition)) {
    throw new Error('cannot confirm SonarQube branch-analysis edition; refusing to upload a local scan to the shared project')
  }
  const branches = await api(policy, token, 'project_branches/list', { project: policy.project_key }, fetcher)
  if (!Array.isArray(branches.branches) || !branches.branches.some(entry => object(entry).name === policy.reference_branch)) {
    throw new Error(`SonarQube reference branch ${policy.reference_branch ?? '(missing)'} has no analysis in this project`)
  }
}

/** Both SonarQube severity schemes: Standard and Multi-Quality Rule. */
export function isBlockingFinding(finding: SonarFinding): boolean {
  return ['MAJOR', 'CRITICAL', 'BLOCKER', 'MEDIUM', 'HIGH'].includes(finding.severity.toUpperCase())
}

export function unresolvedBlockingFindings(audit: SonarAudit): SonarFinding[] {
  const approved = new Set((audit.dispositions ?? []).filter(entry => entry.kind === 'false_positive')
    .map(entry => entry.issue_key))
  return audit.blocking.filter(finding => !approved.has(finding.key))
}

export function localReviewGate(audit: SonarAudit): 'OK' | 'ERROR' {
  return unresolvedBlockingFindings(audit).length === 0 && !(audit.uncovered_files?.length) ? 'OK' : 'ERROR'
}

/** Resolve an exact CI Compute Engine task to its analysis and Quality Gate. */
export async function inspectSonar(policy: SonarPolicy, token: string, ceTaskId: string, target: string,
  scopeHash: string, fetcher: typeof fetch = fetch, newCodeOnly = false): Promise<SonarAudit> {
  if (!token) throw new Error(`SonarQube token environment variable ${policy.token_env} is not set`)
  if (!/^[\w-]{8,120}$/u.test(ceTaskId)) throw new Error('invalid SonarQube ce_task_id')
  if (!target.trim()) throw new Error('SonarQube audit needs a branch or pull request')
  const ce = object((await api(policy, token, 'ce/task', { id: ceTaskId }, fetcher)).task)
  const status = string(ce.status, 'task.status')
  if (status !== 'SUCCESS') throw new Error(`SonarQube Compute Engine task is ${status}; wait for its analysis to finish successfully`)
  const analysisId = string(ce.analysisId, 'task.analysisId')
  const componentKey = ce.componentKey
  if (typeof componentKey === 'string' && componentKey !== policy.project_key) {
    throw new Error(`SonarQube analysis belongs to ${componentKey}, expected ${policy.project_key}`)
  }
  const taskTarget = policy.mode === 'branch' ? ce.branch : ce.pullRequest
  if (typeof taskTarget === 'string' && taskTarget !== target) {
    throw new Error(`SonarQube analysis belongs to ${taskTarget}, expected ${target}`)
  }
  const gateStatus = object((await api(policy, token, 'qualitygates/project_status', { analysisId }, fetcher)).projectStatus)
  const serverGate = string(gateStatus.status, 'projectStatus.status')
  if (newCodeOnly && serverGate !== 'OK' && serverGate !== 'ERROR') {
    throw new Error(`SonarQube Quality Gate is ${serverGate}; local audit cannot claim a pass`)
  }
  let gate = serverGate
  if (newCodeOnly) {
    if (!Array.isArray(gateStatus.conditions)) {
      if (serverGate !== 'OK') throw new Error('SonarQube did not return Quality Gate conditions; cannot separate new-code failures from old-code failures')
    } else {
      const newConditions = gateStatus.conditions.map(object).filter(condition =>
        typeof condition.metricKey === 'string' && condition.metricKey.startsWith('new_'))
      gate = newConditions.some(condition => condition.status !== 'OK') ? 'ERROR' : 'OK'
    }
  }
  const findings: SonarFinding[] = []
  const selector: Record<string, string> = policy.mode === 'branch' ? { branch: target } : { pullRequest: target }
  for (let page = 1; page <= 20; page++) {
    const result = await api(policy, token, 'issues/search', {
      componentKeys: policy.project_key, ...selector, inNewCodePeriod: 'true', resolved: 'false', p: String(page), ps: '500',
    }, fetcher)
    const issues = result.issues
    if (!Array.isArray(issues)) throw new Error('SonarQube issues/search response lacks issues')
    for (const raw of issues) {
      const issue = object(raw)
      const impacts = Array.isArray(issue.impacts) ? issue.impacts : []
      const impactSeverities = impacts.flatMap(impact => {
        const severity = object(impact).severity
        return typeof severity === 'string' ? [severity] : []
      })
      const severity = impactSeverities.find(level => ['BLOCKER', 'HIGH', 'MEDIUM'].includes(level))
        ?? (typeof issue.severity === 'string' ? issue.severity : impactSeverities[0] ?? 'UNKNOWN')
      const key = string(issue.key, 'issue.key')
      findings.push({ key, rule: string(issue.rule, 'issue.rule'), message: string(issue.message, 'issue.message'),
        severity, file: typeof issue.component === 'string' ? issue.component : '',
        ...(typeof issue.line === 'number' ? { line: issue.line } : {}) })
    }
    const paging = object(result.paging ?? {})
    const total = typeof paging.total === 'number' ? paging.total : findings.length
    if (findings.length >= total || issues.length < 500) break
    if (page === 20) throw new Error('SonarQube new-code findings exceed 10,000; audit cannot claim completeness')
  }
  return { ce_task_id: ceTaskId, analysis_id: analysisId, gate,
    ...(newCodeOnly ? { server_gate: serverGate } : {}), checked_at: new Date().toISOString(),
    scope_hash: scopeHash, findings, blocking: findings.filter(isBlockingFinding), target }
}
