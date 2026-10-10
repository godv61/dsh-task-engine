/** Task-level four-grade flows and meta-skill bindings. */
import { createElement, useCallback, useEffect, useState, type CSSProperties } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { META_EVIDENCE, META_STAGES, type MetaSkill } from '../adaptive.ts'
import type { ResourceRef, SkillProfile } from '../engine.ts'
import { styles } from './styles.ts'
import { describeError } from './shared.ts'
import type { AdaptiveConfigView, AdaptiveProjectConfig, ReadSkillResult, RuleCatalogEntry, SkillCatalogEntry, TaskEngineRemote } from './TaskEngineSection.tsx'
import { SkillRuleDialog } from './SkillRuleDialog.tsx'
import { SonarRuleViewer } from './SonarRuleViewer.tsx'

const card: CSSProperties = { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
  padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const label: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }
const input: CSSProperties = { background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '6px 8px', minWidth: 180 }

const SOURCE_ORDER = ['project', 'codex-project', 'user', 'bundled']
function effectiveSource(entries: SkillCatalogEntry[], name: string): string {
  return entries.filter(entry => entry.name === name)
    .sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source))[0]?.sourceLabel ?? '缺失'
}

export function AdaptivePanel({ workspace, remote, onOpenInit }: { workspace: string; remote: TaskEngineRemote;
  onOpenInit: () => void }): ReturnType<typeof createElement> {
  const [view, setView] = useState<AdaptiveConfigView | null>(null)
  const [draft, setDraft] = useState<AdaptiveProjectConfig>({})
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([])
  const [rules, setRules] = useState<RuleCatalogEntry[]>([])
  const [selected, setSelected] = useState<{ skill: ResourceRef; profile: SkillProfile; hash: string;
    template?: ReadSkillResult; templateSource?: string } | null>(null)
  const [activeMeta, setActiveMeta] = useState<MetaSkill>('requirements-analysis')
  const [metaQuery, setMetaQuery] = useState('')
  const [skillQuery, setSkillQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState('')
  const [sonarToken, setSonarToken] = useState('')
  const [tokenInfo, setTokenInfo] = useState<{ configured: boolean; source?: string; writable: boolean } | null>(null)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [analyzerOperation, setAnalyzerOperation] = useState<'prepare' | 'update' | ''>('')
  const [analyzerProfiles, setAnalyzerProfiles] = useState<{ language: string; active_rules: number; analyzer: string }[] | null>(null)
  const [analyzerOtherCount, setAnalyzerOtherCount] = useState(0)
  const [analyzerUpdatedAt, setAnalyzerUpdatedAt] = useState('')
  const [ruleViewerOpen, setRuleViewerOpen] = useState(false)
  const refresh = useCallback(() => {
    setLoading(true)
    setMessage('')
    setSonarToken('')
    setTokenInfo(null)
    setAnalyzerProfiles(null)
    setAnalyzerOtherCount(0)
    setAnalyzerUpdatedAt('')
    void remote.describeSonarToken(workspace).then(result => {
      if (result.ok) setTokenInfo(result.value)
    }, () => {})
    void remote.describeSonarRuleUpdate(workspace).then(result => {
      if (result.ok) setAnalyzerUpdatedAt(result.value.updated_at ?? '')
    }, () => {})
    void Promise.all([remote.readAdaptive(workspace), remote.listSkills(workspace), remote.listRules(workspace)]).then(([config, catalog, ruleCatalog]) => {
      setLoading(false)
      if (!config.ok) { setMessage('读取自适应配置失败：' + describeError(config.error)); return }
      if (!catalog.ok) { setMessage('读取技能目录失败：' + describeError(catalog.error)); return }
      if (!ruleCatalog.ok) { setMessage('读取规则目录失败：' + describeError(ruleCatalog.error)); return }
      setView(config.value)
      setDraft(config.value.config)
      setSkills(catalog.value.skills)
      setRules(ruleCatalog.value.rules)
      setDirty(false)
    }, error => { setLoading(false); setMessage('读取失败：' + describeError(error)) })
  }, [remote, workspace])
  useEffect(() => { refresh() }, [refresh])

  const reloadSaved = () => {
    if (dirty && !window.confirm('重新读取将丢弃本页尚未保存的 Skill 挂载和 Sonar 设置，确定继续？')) return
    refresh()
  }

  const update = (config: AdaptiveProjectConfig) => { setDraft(config); setDirty(true); setMessage('') }
  const addSkill = (meta: MetaSkill, name: string) => {
    if (!name) return
    const meta_bindings = { ...draft.meta_bindings, [meta]: [...new Set([...(draft.meta_bindings?.[meta] ?? []), name])] }
    update({ ...draft, meta_bindings })
  }
  const removeSkill = (meta: MetaSkill, name: string) => {
    const meta_bindings = { ...draft.meta_bindings, [meta]: (draft.meta_bindings?.[meta] ?? []).filter(entry => entry !== name) }
    update({ ...draft, meta_bindings })
  }
  const updateSonar = (patch: NonNullable<AdaptiveProjectConfig['sonar']>) => {
    if (patch.host_url !== undefined || patch.project_key !== undefined) setTokenInfo(null)
    update({ ...draft, sonar: { ...draft.sonar, ...patch, source: 'ide-local', mode: 'branch',
      token_env: draft.sonar?.token_env ?? 'SONAR_TOKEN', reference_branch: patch.reference_branch ?? draft.sonar?.reference_branch ?? 'HEAD',
      scan_command: undefined } })
  }
  const openRules = (name: string) => {
    setMessage('')
    const source = skills.filter(skill => skill.name === name)
      .sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source))[0]?.ref.source
    if (!source) { setMessage(`技能 ${name} 不在当前目录中，请刷新后重试。`); return }
    if (source === 'project') {
      void remote.readProjectSkillProfile({ path: workspace, name }).then(result => {
        if (!result.ok) { setMessage('读取技能规则失败：' + describeError(result.error)); return }
        setSelected({ skill: { source: 'project', name }, profile: result.value.profile, hash: result.value.hash })
      }, error => setMessage('读取技能规则失败：' + describeError(error)))
      return
    }
    void remote.readSkill({ path: workspace, name, level: source }).then(result => {
      if (!result.ok) { setMessage('读取技能失败：' + describeError(result.error)); return }
      if (!result.value.ok) { setMessage('读取技能失败：' + describeError(result.value.error)); return }
      setSelected({ skill: { source: 'project', name }, profile: { rules: [] }, hash: '',
        template: result.value, templateSource: source })
    }, error => setMessage('读取技能失败：' + describeError(error)))
  }
  const saveRules = async (profile: SkillProfile) => {
    if (!selected) return
    let hash = selected.hash
    if (selected.template) {
      const template = selected.template
      const created = await remote.writeSkill({ path: workspace, level: 'project', name: selected.skill.name,
        description: template.description, whenToUse: template.whenToUse, content: template.content, createOnly: true })
      if (!created.ok) throw new Error('创建项目技能失败：' + describeError(created.error))
      if (!created.value.ok) throw new Error('创建项目技能失败：' + describeError(created.value.error))
      const initial = await remote.readProjectSkillProfile({ path: workspace, name: selected.skill.name })
      if (!initial.ok) throw new Error('读取新项目技能失败：' + describeError(initial.error))
      hash = initial.value.hash
      setSelected({ ...selected, hash, template: undefined, templateSource: undefined })
    }
    const result = await remote.writeProjectSkillProfile({ path: workspace, name: selected.skill.name,
      profile, expected_hash: hash })
    if (!result.ok) throw new Error('保存技能规则失败：' + describeError(result.error))
    void remote.listSkills(workspace).then(catalog => { if (catalog.ok) setSkills(catalog.value.skills) }, () => {})
    setSelected(null)
    setMessage(`已保存 ${selected.skill.name} 的项目 Rule；新任务将读取此配置。`)
  }
  const save = () => {
    if (!view) return
    setSaving(true)
    const config = { ...draft, ...(draft.sonar?.enabled ? { sonar: { ...draft.sonar, source: 'ide-local' as const,
      mode: 'branch' as const, reference_branch: draft.sonar.reference_branch?.trim() || 'HEAD', scan_command: undefined } } : {}) }
    void remote.writeAdaptive({ path: workspace, config, expected_hash: view.hash }).then(result => {
      setSaving(false)
      if (!result.ok) { setMessage('保存失败：' + describeError(result.error)); return }
      setView(result.value)
      if (!result.value.ok) { setMessage('配置未保存：' + result.value.problems.join('；')); return }
      setDraft(result.value.config)
      setDirty(false)
      void remote.describeSonarToken(workspace).then(info => { if (info.ok) setTokenInfo(info.value) }, () => {})
      setMessage('已保存到 .dsh/meta.json；只影响新建任务。')
    }, error => { setSaving(false); setMessage('保存失败：' + describeError(error)) })
  }
  const saveToken = () => {
    if (!sonarToken.trim()) return
    setTokenBusy(true)
    void remote.setSonarToken({ path: workspace, token: sonarToken }).then(result => {
      setTokenBusy(false)
      if (!result.ok) { setMessage('保存 SonarQube Token 失败：' + describeError(result.error)); return }
      setSonarToken('')
      setTokenInfo(result.value)
      setMessage('当前项目的 SonarQube Token 已保存到本机 DSH 凭据存储，可立即使用。')
    }, error => { setTokenBusy(false); setMessage('保存 SonarQube Token 失败：' + describeError(error)) })
  }
  const clearToken = () => {
    setTokenBusy(true)
    void remote.unsetSonarToken(workspace).then(result => {
      setTokenBusy(false)
      if (!result.ok) { setMessage('移除 SonarQube Token 失败：' + describeError(result.error)); return }
      setSonarToken('')
      setTokenInfo(result.value)
      setMessage('已移除当前项目保存在本机的 SonarQube Token。')
    }, error => { setTokenBusy(false); setMessage('移除 SonarQube Token 失败：' + describeError(error)) })
  }
  const prepareAnalyzer = () => {
    if (dirty) { setMessage('请先保存 SonarQube 审核配置，再检查本地分析器。'); return }
    setAnalyzerOperation('prepare')
    setAnalyzerProfiles(null)
    setMessage('正在准备官方 SonarLint 本地检查组件和配套 Java，并连接当前项目的 SonarQube。首次约需下载 93 MiB；不会分析或上传项目代码。')
    void remote.prepareSonarAnalyzer(workspace).then(result => {
      setAnalyzerOperation('')
      if (!result.ok) { setMessage('本地分析器检查失败：' + describeError(result.error)); return }
      setAnalyzerProfiles(result.value.profiles)
      setAnalyzerOtherCount(result.value.other_profile_count)
      setAnalyzerUpdatedAt(result.value.updated_at ?? '')
      setMessage('已连接 SonarQube；下方优先显示本项目最近一次分析涉及的语言。')
    }, error => { setAnalyzerOperation(''); setMessage('本地分析器检查失败：' + describeError(error)) })
  }
  const updateRules = () => {
    if (dirty) { setMessage('请先保存 SonarQube 审核配置，再更新规则。'); return }
    setAnalyzerOperation('update')
    setMessage('正在从当前 SonarQube 项目重新同步规则；完成后后续审核会使用新配置。')
    void remote.updateSonarRules(workspace).then(result => {
      setAnalyzerOperation('')
      if (!result.ok) { setMessage('更新规则失败：' + describeError(result.error)); return }
      setAnalyzerProfiles(result.value.profiles)
      setAnalyzerOtherCount(result.value.other_profile_count)
      setAnalyzerUpdatedAt(result.value.updated_at ?? '')
      setMessage('当前项目的本地规则已更新；后续代码审核将使用这次同步的配置。')
    }, error => { setAnalyzerOperation(''); setMessage('更新规则失败：' + describeError(error)) })
  }

  const candidates = [...new Set(skills.map(skill => skill.name))].filter(name =>
    name !== 'eng-delivery' && !(name in META_STAGES)).sort()
  const stageQuery = metaQuery.trim().toLowerCase()
  const visibleStages = (Object.entries(META_STAGES) as [MetaSkill, string][]).filter(([id, stage]) =>
    !stageQuery || `${id} ${stage} ${(draft.meta_bindings?.[id] ?? []).join(' ')}`.toLowerCase().includes(stageQuery))
  const visibleMeta = visibleStages.find(([id]) => id === activeMeta)?.[0] ?? visibleStages[0]?.[0]
  const mounted = visibleMeta ? draft.meta_bindings?.[visibleMeta] ?? [] : []
  const candidateQuery = skillQuery.trim().toLowerCase()
  const matchingCandidates = candidates.filter(name => !mounted.includes(name) && (!candidateQuery
    || name.toLowerCase().includes(candidateQuery)
    || skills.some(skill => skill.name === name && `${skill.description} ${skill.sourceLabel}`.toLowerCase().includes(candidateQuery))))
  const sonar = draft.sonar ?? {}
  return createElement('div', { style: { ...styles.section, display: 'flex', flexDirection: 'column', gap: 16 } },
    createElement('p', { style: label },
      '在这里设置本项目各开发阶段使用的 Skill，以及可选的 SonarQube 审核。创建任务时，DSH 按需求选择低／中／高／超高流程；保存后的设置只用于新任务。'),
    createElement('div', { style: row },
      createElement(Button, { variant: 'outline', size: 'sm', onClick: onOpenInit }, '生成可选项目 Skill'),
      createElement('span', { style: label }, '扫描项目后先预览，确认后写入。')),
    createElement('details', { style: card },
      createElement('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '按需求选择流程 · 查看四档阶段'),
      createElement('span', { style: label }, '每个任务单独选择复杂度并冻结阶段和技能；不同会话可走不同流程。'),
      createElement('div', { style: grid }, ...(view?.grades ?? []).map(grade =>
        createElement('div', { key: grade.id, style: { ...card, gap: 5 } },
          createElement('strong', null, `${grade.label} · ${grade.id}`),
          createElement('span', { style: label }, grade.guidance),
          createElement('span', { style: { fontSize: 12 } }, grade.stages.join(' → ')),
        )))),
    createElement('div', { style: card },
      createElement('strong', null, '元技能与项目技能'),
      createElement('span', { style: label }, '每个元技能始终加载同名核心 Skill；同名项目 Skill 覆盖用户与内置版本。附加技能按名称挂载，实际来源在任务创建时解析。Rule 保存在对应 Skill 的 profile.json。'),
      createElement('input', { className: 'te-input', type: 'search', 'aria-label': '搜索元技能或已挂载技能',
        placeholder: '搜索阶段或已挂载的 Skill', value: metaQuery,
        onChange: (event: { target: HTMLInputElement }) => setMetaQuery(event.target.value) }),
      createElement('div', { className: 'te-meta-layout' },
        createElement('nav', { className: 'te-meta-nav', 'aria-label': '元技能阶段' },
          ...visibleStages.map(([id, stage]) => createElement('button', { key: id, type: 'button',
            'aria-current': visibleMeta === id ? 'true' : undefined,
            onClick: () => { setActiveMeta(id); setSkillQuery('') } },
          stage, createElement('small', null, `已挂载 ${(draft.meta_bindings?.[id] ?? []).length} 个 Skill`))),
          visibleStages.length === 0 ? createElement('span', { style: label }, '没有匹配的阶段。') : null),
        visibleMeta ? createElement('div', { className: 'te-meta-detail' },
          createElement('div', null,
            createElement('strong', null, META_STAGES[visibleMeta]),
            createElement('div', { style: label }, '核心 Skill 与附加 Skill 的 Rule 分别保存在各自的配置中。')),
          createElement('div', { className: 'te-meta-skill-row' },
            createElement('span', null, createElement('strong', null, visibleMeta),
              createElement('small', { style: { ...label, display: 'block' } }, `核心 · ${effectiveSource(skills, visibleMeta)}`)),
            createElement(Button, { variant: 'outline', size: 'sm', onClick: () => openRules(visibleMeta) }, '配置 Rule')),
          createElement('strong', { style: { fontSize: 13 } }, `附加 Skill · ${mounted.length}`),
          ...mounted.map(name => createElement('div', { key: name, className: 'te-meta-skill-row' },
            createElement('span', null, createElement('strong', null, name),
              createElement('small', { style: { ...label, display: 'block' } }, effectiveSource(skills, name))),
            createElement('div', { className: 'te-meta-skill-actions' },
              createElement(Button, { variant: 'outline', size: 'sm', onClick: () => openRules(name) }, '配置 Rule'),
              createElement('button', { type: 'button', className: 'te-transfer-remove',
                'aria-label': `从${META_STAGES[visibleMeta]}移除 ${name}`, onClick: () => removeSkill(visibleMeta, name) }, '×')))),
          mounted.length === 0 ? createElement('span', { style: label }, '尚未挂载附加 Skill。') : null,
          createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
            createElement('strong', { style: { fontSize: 13 } }, '挂载附加 Skill'),
            createElement('input', { className: 'te-input', type: 'search', 'aria-label': '搜索可挂载技能',
              placeholder: '搜索 Skill 名称、说明或来源', value: skillQuery,
              onChange: (event: { target: HTMLInputElement }) => setSkillQuery(event.target.value) }),
            createElement('span', { style: label }, `可选 ${matchingCandidates.length} 个${matchingCandidates.length > 12 ? '，先显示前 12 个；可继续输入缩小范围' : ''}`),
            createElement('div', { className: 'te-meta-candidates' },
              ...matchingCandidates.slice(0, 12).map(name => createElement('div', { key: name, className: 'te-meta-candidate' },
                createElement('span', null, createElement('strong', null, name),
                  createElement('small', null, effectiveSource(skills, name))),
                createElement(Button, { variant: 'outline', size: 'sm', onClick: () => addSkill(visibleMeta, name) }, '挂载'))),
              matchingCandidates.length === 0 ? createElement('span', { style: label }, '没有匹配的 Skill。') : null))) : null),
    ),
    createElement('div', { style: card },
      createElement('div', { style: row }, createElement('strong', null, 'SonarQube 审核'),
        createElement('label', { style: row }, createElement('input', { type: 'checkbox', checked: sonar.enabled === true,
          onChange: (event: { target: HTMLInputElement }) => updateSonar({ enabled: event.target.checked }) }),
        '启用（仅代码审核阶段）')),
      createElement('span', { style: label }, '测试通过后，代码审核元技能会检查提交前的新增代码。首次审核自动准备本地分析组件，并从 SonarQube 同步当前项目的规则。Token 按项目保存在本机 DSH 凭据存储。'),
      sonar.enabled === true && sonar.host_url?.startsWith('http://') ? createElement('span', { style: { ...label, color: '#b45309' } },
        '当前使用 HTTP：Token 会通过未加密的网络连接发送到此服务地址。仅在可信内网使用；Token 与此地址及项目 Key 绑定，变更后需重新保存。') : null,
      sonar.enabled === true && sonar.source && sonar.source !== 'ide-local' ? createElement('span', { style: label },
        '此项目仍是旧审核模式；保存配置后，新任务将使用提交前本地审核。已有任务按创建时的配置继续。') : null,
      sonar.enabled === true ? createElement('div', { style: grid },
        ...([['host_url', '服务地址', 'https://sonar.example'], ['project_key', '项目 Key', 'my-project']] as const).map(([key, title, placeholder]) =>
            createElement('label', { key, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              createElement('span', { style: label }, title),
              createElement('input', { style: input, value: sonar[key] ?? '', placeholder,
                onChange: (event: { target: HTMLInputElement }) => updateSonar({ [key]: event.target.value }) }),
            )),
        createElement('details', { style: { gridColumn: '1 / -1' } },
          createElement('summary', null, '高级设置：新增代码参考版本与审核范围'),
          createElement('div', { style: { ...grid, marginTop: 8 } },
            createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              createElement('span', { style: label }, 'Git 参考版本（默认 HEAD，即未提交变更）'),
              createElement('input', { style: input, value: sonar.reference_branch ?? 'HEAD', placeholder: 'HEAD',
                onChange: (event: { target: HTMLInputElement }) => updateSonar({ reference_branch: event.target.value }) })),
            createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              createElement('span', { style: label }, '审核路径（每行一个；留空为本次任务的全部代码）'),
              createElement('textarea', { style: { ...input, minHeight: 76 }, value: (sonar.include_paths ?? []).join('\n'),
                onChange: (event: { target: HTMLTextAreaElement }) => updateSonar({
                  include_paths: event.target.value.split(/\r?\n|,/u).map(path => path.trim()).filter(Boolean),
                }) })))),
        createElement('span', { style: { ...label, gridColumn: '1 / -1' } },
          'DSH 会在本机缓存中准备官方 SonarLint 后台及配套 Java，再从当前 SonarQube 项目同步可用的语言分析器和规则；无需安装 IDEA、Maven 或 SonarScanner。此处只准备检查环境，不执行代码审核。'),
        createElement('div', { style: { ...row, gridColumn: '1 / -1' } },
          createElement(Button, { variant: 'outline', size: 'sm', disabled: !!analyzerOperation || saving || dirty,
            onClick: prepareAnalyzer }, analyzerOperation === 'prepare' ? '准备与检查中…' : '准备本地 Sonar 检查'),
          createElement(Button, { variant: 'outline', size: 'sm', disabled: !!analyzerOperation || saving || dirty,
            onClick: updateRules }, analyzerOperation === 'update' ? '规则同步中…' : '重新同步本项目 Sonar 规则'),
          createElement(Button, { variant: 'outline', size: 'sm', disabled: saving || dirty,
            onClick: () => setRuleViewerOpen(true) }, '查看本项目 Sonar 规则')),
        createElement('span', { style: { ...label, gridColumn: '1 / -1' } },
          '“准备本地 Sonar 检查”首次约下载 93 MiB 到本机 DSH 缓存，已有组件则复用；检查服务连接与当前项目规则状态，不上传代码。即使不提前点击，首次代码审核也会自动准备。'),
        analyzerUpdatedAt && !dirty ? createElement('span', { style: { ...label, gridColumn: '1 / -1' } },
          `上次手动更新：${new Date(analyzerUpdatedAt).toLocaleString()}`) : null,
        analyzerProfiles ? createElement('div', { style: { ...label, gridColumn: '1 / -1' } },
          analyzerProfiles.length ? analyzerProfiles.map(profile =>
            createElement('div', { key: profile.language },
              `${profile.language}：服务端 ${profile.active_rules} 条规则；本地分析器 ${profile.analyzer}`))
            : '项目没有返回已启用规则的语言。',
          analyzerOtherCount ? createElement('div', null,
            `其它 ${analyzerOtherCount} 个语言配置已收起；可在“查看本项目 Sonar 规则”中显示。`) : null,
          createElement('div', null, '已同步表示该语言分析器可用，不代表服务端全部规则都能在本地执行。')) : null,
        createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
          createElement('span', { style: label }, `当前项目 Token：${tokenInfo === null ? '状态不可用' : tokenInfo.configured ? '已配置' : '未配置'}`),
          createElement('input', { type: 'password', autoComplete: 'new-password', style: input,
            value: sonarToken, placeholder: '输入用户令牌（保存后不回显）',
            onChange: (event: { target: HTMLInputElement }) => setSonarToken(event.target.value) }),
          createElement('div', { style: row },
            createElement(Button, { variant: 'outline', size: 'sm', disabled: dirty || tokenBusy || !sonarToken.trim() || tokenInfo?.writable === false,
              onClick: saveToken }, tokenBusy ? '处理中…' : '保存 Token'),
            tokenInfo?.configured ? createElement(Button, { variant: 'outline', size: 'sm',
              disabled: tokenBusy || tokenInfo.writable === false, onClick: clearToken }, '移除 Token') : null),
        ),
      ) : null,
    ),
    createElement('div', { className: 'te-adaptive-savebar' },
      createElement(Button, { variant: 'outline', size: 'sm', disabled: loading || saving, onClick: reloadSaved }, '重新读取已保存设置'),
      createElement(Button, { variant: 'primary', size: 'sm', disabled: loading || saving || !dirty, onClick: save },
        saving ? '保存中…' : '保存项目流程与审核设置'),
      createElement('span', { style: label }, dirty
        ? '有未保存的项目设置；保存到 .dsh/meta.json 后才会用于新任务'
        : '项目设置已保存；未修改时无需再次保存'),
      message ? createElement('span', { role: 'status', style: { ...label, flexBasis: '100%' } }, message) : null,
    ),
    view?.problems.length ? createElement('p', { role: 'alert', style: styles.status }, view.problems.join('；')) : null,
    ruleViewerOpen && sonar.enabled === true && sonar.host_url
      ? createElement(SonarRuleViewer, { workspace, host: sonar.host_url, remote, onClose: () => setRuleViewerOpen(false) }) : null,
    selected ? createElement(SkillRuleDialog, { key: `${selected.skill.source}:${selected.skill.name}`, skill: selected.skill,
      profile: selected.profile, rules,
      defaultEvidence: META_EVIDENCE[selected.skill.name as MetaSkill] ?? 'none',
      description: selected.template
        ? `当前来自 ${selected.templateSource}。保存时会先复制为同名项目 Skill，再写入项目 Rule；新任务优先使用项目版本。`
        : '项目 Skill 的规则档案保存在其 profile.json，影响之后创建的自适应任务。',
      saveLabel: selected.template ? '创建项目 Skill 并保存规则' : '保存配置',
      onSave: saveRules, onClose: () => setSelected(null) }) : null,
  )
}
