/** Task-level four-grade flows and meta-skill bindings. */
import { createElement, useCallback, useEffect, useState, type CSSProperties } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { META_STAGES, type MetaSkill } from '../adaptive.ts'
import type { ResourceRef, SkillProfile } from '../engine.ts'
import { styles } from './styles.ts'
import { describeError } from './shared.ts'
import type { AdaptiveConfigView, AdaptiveProjectConfig, ReadSkillResult, RuleCatalogEntry, SkillCatalogEntry, TaskEngineRemote } from './TaskEngineSection.tsx'
import { SkillRuleDialog } from './SkillRuleDialog.tsx'

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
    .sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source))[0]?.source ?? '缺失'
}

export function AdaptivePanel({ workspace, remote, onOpenInit }: { workspace: string; remote: TaskEngineRemote;
  onOpenInit: () => void }): ReturnType<typeof createElement> {
  const [view, setView] = useState<AdaptiveConfigView | null>(null)
  const [draft, setDraft] = useState<AdaptiveProjectConfig>({})
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([])
  const [rules, setRules] = useState<RuleCatalogEntry[]>([])
  const [selected, setSelected] = useState<{ skill: ResourceRef; profile: SkillProfile; hash: string;
    template?: ReadSkillResult; templateSource?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState('')
  const [sonarToken, setSonarToken] = useState('')
  const [tokenInfo, setTokenInfo] = useState<{ configured: boolean; source?: string; writable: boolean } | null>(null)
  const [tokenBusy, setTokenBusy] = useState(false)
  const refresh = useCallback(() => {
    setLoading(true)
    setMessage('')
    setSonarToken('')
    setTokenInfo(null)
    void remote.describeSonarToken(workspace).then(result => {
      if (result.ok) setTokenInfo(result.value)
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

  const candidates = [...new Set(skills.map(skill => skill.name))].filter(name =>
    name !== 'eng-delivery' && !(name in META_STAGES)).sort()
  const sonar = draft.sonar ?? {}
  return createElement('div', { style: { ...styles.section, display: 'flex', flexDirection: 'column', gap: 16 } },
    createElement('div', { style: row },
      createElement(Button, { variant: 'outline', size: 'sm', onClick: onOpenInit }, '初始化项目 Skill / Rule'),
      createElement('span', { style: label }, '扫描项目后先预览，确认后写入。')),
    createElement('div', { style: card },
      createElement('strong', null, '按需求选择流程'),
      createElement('span', { style: label }, '每个任务由大模型分析后选择复杂度，任务创建时冻结阶段和生效技能；不同会话可走不同流程。风险等级独立判断。'),
      createElement('div', { style: grid }, ...(view?.grades ?? []).map(grade =>
        createElement('div', { key: grade.id, style: { ...card, gap: 5 } },
          createElement('strong', null, `${grade.label} · ${grade.id}`),
          createElement('span', { style: label }, grade.guidance),
          createElement('span', { style: { fontSize: 12 } }, grade.stages.join(' → ')),
        ))),
    ),
    createElement('div', { style: card },
      createElement('strong', null, '元技能与项目技能'),
      createElement('span', { style: label }, '每个元技能始终加载同名核心 Skill；同名项目 Skill 覆盖用户与内置版本。附加技能按名称挂载，实际来源在任务创建时解析。Rule 保存在对应 Skill 的 profile.json。'),
      ...Object.entries(META_STAGES).map(([id, stage]) => {
        const meta = id as MetaSkill
        const selected = draft.meta_bindings?.[meta] ?? []
        return createElement('div', { key: id, style: { ...card, gap: 6 } },
          createElement('strong', null, stage),
          createElement('span', { style: label }, `核心：${id} · 生效来源：${effectiveSource(skills, id)}`),
          createElement(Button, { variant: 'outline', size: 'sm', onClick: () => openRules(id) }, '配置核心 Skill 的 Rule'),
          createElement('div', { style: row }, ...selected.map(name => createElement('button', {
            key: name, type: 'button', title: '移除挂载', style: { ...input, minWidth: 0, cursor: 'pointer' },
            onClick: () => removeSkill(meta, name),
          }, `${name} · ${effectiveSource(skills, name)} ×`)),
          ...selected.map(name => createElement(Button, { key: `rules-${name}`, variant: 'outline', size: 'sm',
            onClick: () => openRules(name) }, `配置 ${name} 的 Rule`))),
          createElement('select', { style: input, 'aria-label': `给${stage}挂载项目技能`, value: '',
            onChange: (event: { target: HTMLSelectElement }) => addSkill(meta, event.target.value) },
          createElement('option', { value: '' }, '挂载附加技能…'),
          ...candidates.filter(name => !selected.includes(name)).map(name =>
            createElement('option', { key: name, value: name }, `${name} · ${effectiveSource(skills, name)}`))),
        )
      }),
    ),
    createElement('div', { style: card },
      createElement('div', { style: row }, createElement('strong', null, 'SonarQube 审核'),
        createElement('label', { style: row }, createElement('input', { type: 'checkbox', checked: sonar.enabled === true,
          onChange: (event: { target: HTMLInputElement }) => updateSonar({ enabled: event.target.checked }) }),
        '启用（仅代码审核阶段）')),
      createElement('span', { style: label }, '测试通过后，代码审核元技能会检查提交前的新增代码。首次审核自动准备本地分析组件，并从 SonarQube 同步当前项目的规则。Token 按项目保存在本机 DSH 凭据存储。'),
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
          '无需安装 IDEA、Maven 或 SonarScanner。首次审核会下载官方本地分析后台；语言分析器由后台从 SonarQube 同步。部分服务端规则无法在本地执行，本地通过不等于服务端质量门禁通过。'),
        createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
          createElement('span', { style: label }, `当前项目 Token：${tokenInfo === null ? '状态不可用' : tokenInfo.configured ? '已配置' : '未配置'}`),
          createElement('input', { type: 'password', autoComplete: 'new-password', style: input,
            value: sonarToken, placeholder: '输入用户令牌（保存后不回显）',
            onChange: (event: { target: HTMLInputElement }) => setSonarToken(event.target.value) }),
          createElement('div', { style: row },
            createElement(Button, { variant: 'outline', size: 'sm', disabled: tokenBusy || !sonarToken.trim() || tokenInfo?.writable === false,
              onClick: saveToken }, tokenBusy ? '处理中…' : '保存 Token'),
            tokenInfo?.configured ? createElement(Button, { variant: 'outline', size: 'sm',
              disabled: tokenBusy || tokenInfo.writable === false, onClick: clearToken }, '移除 Token') : null),
        ),
      ) : null,
    ),
    createElement('div', { style: row },
      createElement(Button, { variant: 'outline', size: 'sm', disabled: loading || saving, onClick: refresh }, '刷新'),
      createElement(Button, { variant: 'primary', size: 'sm', disabled: loading || saving || !dirty, onClick: save },
        saving ? '保存中…' : '保存自适应配置'),
      createElement('span', { style: label }, '项目 Skill / Rule 初始化入口位于“项目初始化”页。'),
    ),
    message ? createElement('p', { role: 'status', style: styles.status }, message) : null,
    view?.problems.length ? createElement('p', { role: 'alert', style: styles.status }, view.problems.join('；')) : null,
    selected ? createElement(SkillRuleDialog, { key: `${selected.skill.source}:${selected.skill.name}`, skill: selected.skill,
      profile: selected.profile, rules,
      description: selected.template
        ? `当前来自 ${selected.templateSource}。保存时会先复制为同名项目 Skill，再写入项目 Rule；新任务优先使用项目版本。`
        : '项目 Skill 的规则档案保存在其 profile.json，影响之后创建的自适应任务。',
      saveLabel: selected.template ? '创建项目 Skill 并保存规则' : '保存配置',
      onSave: saveRules, onClose: () => setSelected(null) }) : null,
  )
}
