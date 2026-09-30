/** Task-level four-grade flows and meta-skill bindings. */
import { createElement, useCallback, useEffect, useState, type CSSProperties } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { META_STAGES, type MetaSkill } from '../adaptive.ts'
import type { ResourceRef, SkillProfile } from '../engine.ts'
import { styles } from './styles.ts'
import { describeError } from './shared.ts'
import type { AdaptiveConfigView, AdaptiveProjectConfig, RuleCatalogEntry, SkillCatalogEntry, TaskEngineRemote } from './TaskEngineSection.tsx'
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

export function AdaptivePanel({ workspace, remote }: { workspace: string; remote: TaskEngineRemote }): ReturnType<typeof createElement> {
  const [view, setView] = useState<AdaptiveConfigView | null>(null)
  const [draft, setDraft] = useState<AdaptiveProjectConfig>({})
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([])
  const [rules, setRules] = useState<RuleCatalogEntry[]>([])
  const [selected, setSelected] = useState<{ skill: ResourceRef; profile: SkillProfile; hash: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState('')
  const refresh = useCallback(() => {
    setLoading(true)
    setMessage('')
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
    update({ ...draft, sonar: { mode: 'branch', token_env: 'SONAR_TOKEN', ...draft.sonar, ...patch } })
  }
  const openRules = (name: string) => {
    if (effectiveSource(skills, name) !== 'project') {
      setMessage(`当前 ${name} 来自非项目级；请先在“技能”页创建同名项目 Skill，再编辑它的 Rule。`)
      return
    }
    void remote.readProjectSkillProfile({ path: workspace, name }).then(result => {
      if (!result.ok) { setMessage('读取技能规则失败：' + describeError(result.error)); return }
      setSelected({ skill: { source: 'project', name }, profile: result.value.profile, hash: result.value.hash })
    }, error => setMessage('读取技能规则失败：' + describeError(error)))
  }
  const saveRules = async (profile: SkillProfile) => {
    if (!selected) return
    const result = await remote.writeProjectSkillProfile({ path: workspace, name: selected.skill.name,
      profile, expected_hash: selected.hash })
    if (!result.ok) throw new Error('保存技能规则失败：' + describeError(result.error))
    setSelected(null)
    setMessage(`已保存 ${selected.skill.name} 的项目 Rule；新任务将读取此配置。`)
  }
  const save = () => {
    if (!view) return
    setSaving(true)
    void remote.writeAdaptive({ path: workspace, config: draft, expected_hash: view.hash }).then(result => {
      setSaving(false)
      if (!result.ok) { setMessage('保存失败：' + describeError(result.error)); return }
      setView(result.value)
      if (!result.value.ok) { setMessage('配置未保存：' + result.value.problems.join('；')); return }
      setDraft(result.value.config)
      setDirty(false)
      setMessage('已保存到 .dsh/meta.json；只影响新建任务。')
    }, error => { setSaving(false); setMessage('保存失败：' + describeError(error)) })
  }

  const candidates = [...new Set(skills.map(skill => skill.name))].filter(name =>
    name !== 'eng-delivery' && !(name in META_STAGES)).sort()
  const sonar = draft.sonar ?? {}
  return createElement('div', { style: { ...styles.section, display: 'flex', flexDirection: 'column', gap: 16 } },
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
      createElement('span', { style: label }, '复用 CI 扫描的 ceTaskId；质量门禁或新代码中高等级问题未通过时阻止审核。Token 仅从服务进程环境变量读取，不写入仓库。'),
      sonar.enabled === true ? createElement('div', { style: grid },
        ...([['host_url', '服务地址', 'https://sonar.example'], ['project_key', '项目 Key', 'my-project'],
          ['token_env', 'Token 环境变量名', 'SONAR_TOKEN']] as const).map(([key, title, placeholder]) =>
            createElement('label', { key, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              createElement('span', { style: label }, title),
              createElement('input', { style: input, value: sonar[key] ?? '', placeholder,
                onChange: (event: { target: HTMLInputElement }) => updateSonar({ [key]: event.target.value }) }),
            )),
        createElement('label', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          createElement('span', { style: label }, '分析对象'),
          createElement('select', { style: input, value: sonar.mode ?? 'branch',
            onChange: (event: { target: HTMLSelectElement }) => updateSonar({ mode: event.target.value as 'branch' | 'pull-request' }) },
          createElement('option', { value: 'branch' }, '分支'), createElement('option', { value: 'pull-request' }, '合并请求')),
        ),
      ) : null,
    ),
    createElement('div', { style: row },
      createElement(Button, { variant: 'outline', size: 'sm', disabled: loading || saving, onClick: refresh }, '刷新'),
      createElement(Button, { variant: 'primary', size: 'sm', disabled: loading || saving || !dirty, onClick: save },
        saving ? '保存中…' : '保存自适应配置'),
      createElement('span', { style: label }, '新项目可在工程会话中调用 dev_task init_project：扫描 → 预览 → 写入项目技能与规则。'),
    ),
    message ? createElement('p', { role: 'status', style: styles.status }, message) : null,
    view?.problems.length ? createElement('p', { role: 'alert', style: styles.status }, view.problems.join('；')) : null,
    selected ? createElement(SkillRuleDialog, { key: `${selected.skill.source}:${selected.skill.name}`, skill: selected.skill,
      profile: selected.profile, rules, description: '项目 Skill 的规则档案保存在其 profile.json，影响之后创建的自适应任务。',
      onSave: saveRules, onClose: () => setSelected(null) }) : null,
  )
}
