/** Read the rules enabled for one SonarQube project's effective Quality Profiles. */
export interface SonarProjectProfile {
  key: string
  name: string
  language: string
  active_rules: number
  analyzed: boolean
}

export interface SonarProjectRule {
  key: string
  name: string
  language: string
  severity: string
}

export interface SonarProjectRuleView {
  profiles: SonarProjectProfile[]
  analyzed_languages: string[]
  selected_language: string
  rules: SonarProjectRule[]
  rule_total: number
}

type Fetcher = typeof fetch

function apiUrl(host: string, path: string): URL {
  return new URL(`${host.replace(/\/$/u, '')}${path}`)
}

async function readJson(url: URL, token: string, fetcher: Fetcher): Promise<any> {
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`SonarQube 规则查询失败（HTTP ${response.status}）`)
  return response.json()
}

/** The last server analysis supplies the project's actual languages; a new project may have none yet. */
export function parseAnalyzedLanguages(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return [...new Set(value.split(';').flatMap(part => {
    const match = /^([a-z][a-z0-9_-]*)=\d+$/iu.exec(part.trim())
    return match ? [match[1]!.toUpperCase()] : []
  }))]
}

export async function projectAnalyzedLanguages(host: string, project: string, token: string,
  fetcher: Fetcher = fetch): Promise<string[]> {
  const url = apiUrl(host, '/api/measures/component')
  url.searchParams.set('component', project)
  url.searchParams.set('metricKeys', 'ncloc_language_distribution')
  try {
    const data = await readJson(url, token, fetcher)
    return parseAnalyzedLanguages(data?.component?.measures?.find((measure: any) =>
      measure.metric === 'ncloc_language_distribution')?.value)
  } catch {
    // Projects without an analysis or metric permission can still inspect their configured profiles.
    return []
  }
}

/** Only project-effective profiles are queried; rules are fetched for the selected profile on demand. */
export async function listSonarProjectRules(host: string, project: string, token: string,
  language?: string, fetcher: Fetcher = fetch): Promise<SonarProjectRuleView> {
  const url = apiUrl(host, '/api/qualityprofiles/search')
  url.searchParams.set('project', project)
  const [data, analyzed_languages] = await Promise.all([
    readJson(url, token, fetcher), projectAnalyzedLanguages(host, project, token, fetcher),
  ])
  if (!Array.isArray(data?.profiles)) throw new Error('SonarQube 未返回当前项目的 Quality Profile')
  const analyzed = new Set(analyzed_languages)
  const profiles: SonarProjectProfile[] = data.profiles.flatMap((profile: any) =>
    typeof profile.key === 'string' && typeof profile.name === 'string' && typeof profile.language === 'string'
      && Number.isFinite(Number(profile.activeRuleCount)) && Number(profile.activeRuleCount) > 0
      ? [{ key: profile.key, name: profile.name, language: profile.language.toUpperCase(),
        active_rules: Number(profile.activeRuleCount), analyzed: analyzed.has(profile.language.toUpperCase()) }]
      : []).sort((left: SonarProjectProfile, right: SonarProjectProfile) =>
    Number(right.analyzed) - Number(left.analyzed) || left.language.localeCompare(right.language))
  const selected = language ? profiles.find(profile => profile.language === language.toUpperCase())
    : profiles[0]
  if (!selected) {
    if (language) throw new Error(`当前项目没有 ${language} 的 Quality Profile`)
    return { profiles, analyzed_languages, selected_language: '', rules: [], rule_total: 0 }
  }
  const rules: SonarProjectRule[] = []
  let total = 0
  for (let page = 1; page <= 20; page++) {
    const rulesUrl = apiUrl(host, '/api/rules/search')
    rulesUrl.searchParams.set('qprofile', selected.key)
    rulesUrl.searchParams.set('activation', 'true')
    rulesUrl.searchParams.set('f', 'repo,name,severity,actives')
    rulesUrl.searchParams.set('p', String(page))
    rulesUrl.searchParams.set('ps', '500')
    const result = await readJson(rulesUrl, token, fetcher)
    if (!Array.isArray(result?.rules) || !Number.isFinite(Number(result.total))) {
      throw new Error('SonarQube 未返回当前配置的规则列表')
    }
    total = Number(result.total)
    for (const rule of result.rules) {
      if (typeof rule.key !== 'string' || typeof rule.name !== 'string') continue
      const active = result.actives?.[rule.key]?.[0]
      rules.push({ key: rule.key, name: rule.name, language: selected.language,
        severity: String(active?.severity ?? rule.severity ?? '—') })
    }
    if (rules.length >= total || result.rules.length === 0) break
  }
  if (rules.length !== total) throw new Error(`SonarQube 规则列表不完整：已读取 ${rules.length}/${total} 条`)
  return { profiles, analyzed_languages, selected_language: selected.language, rules, rule_total: total }
}
