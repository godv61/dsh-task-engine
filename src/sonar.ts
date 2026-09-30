/** Optional SonarQube audit, queried only after an existing CI scan has run. */
export interface SonarPolicy {
  enabled: true
  host_url: string
  project_key: string
  mode: 'branch' | 'pull-request'
  /** Name of an environment variable containing a SonarQube user token. */
  token_env: string
}

export interface SonarFinding {
  key: string
  rule: string
  message: string
  severity: string
  file: string
  line?: number
}

export interface SonarAudit {
  ce_task_id: string
  analysis_id: string
  gate: string
  checked_at: string
  scope_hash: string
  commit_hash?: string
  findings: SonarFinding[]
  blocking: SonarFinding[]
  /** Branch or merge request used for new-code findings. */
  target: string
}

type Json = Record<string, unknown>

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

/** Both SonarQube severity schemes: Standard and Multi-Quality Rule. */
export function isBlockingFinding(finding: SonarFinding): boolean {
  return ['MAJOR', 'CRITICAL', 'BLOCKER', 'MEDIUM', 'HIGH'].includes(finding.severity.toUpperCase())
}

/** Resolve an exact CI Compute Engine task to its analysis and Quality Gate. */
export async function inspectSonar(policy: SonarPolicy, token: string, ceTaskId: string, target: string,
  scopeHash: string, fetcher: typeof fetch = fetch): Promise<SonarAudit> {
  if (!token) throw new Error(`SonarQube token environment variable ${policy.token_env} is not set`)
  if (!/^[\w-]{8,120}$/u.test(ceTaskId)) throw new Error('invalid SonarQube ce_task_id')
  if (!target.trim()) throw new Error('SonarQube audit needs a branch or pull request')
  const ce = object((await api(policy, token, 'ce/task', { id: ceTaskId }, fetcher)).task)
  const status = string(ce.status, 'task.status')
  if (status !== 'SUCCESS') throw new Error(`SonarQube Compute Engine task is ${status}; wait for its CI analysis to finish successfully`)
  const analysisId = string(ce.analysisId, 'task.analysisId')
  const componentKey = ce.componentKey
  if (typeof componentKey === 'string' && componentKey !== policy.project_key) {
    throw new Error(`SonarQube analysis belongs to ${componentKey}, expected ${policy.project_key}`)
  }
  const taskTarget = policy.mode === 'branch' ? ce.branch : ce.pullRequest
  if (typeof taskTarget === 'string' && taskTarget !== target) {
    throw new Error(`SonarQube analysis belongs to ${taskTarget}, expected ${target}`)
  }
  const gate = string(object((await api(policy, token, 'qualitygates/project_status', { analysisId }, fetcher)).projectStatus).status,
    'projectStatus.status')
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
  return { ce_task_id: ceTaskId, analysis_id: analysisId, gate, checked_at: new Date().toISOString(),
    scope_hash: scopeHash, findings, blocking: findings.filter(isBlockingFinding), target }
}
