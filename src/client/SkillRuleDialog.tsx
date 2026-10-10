/** One editor for the rules and evidence owned by a skill, regardless of entry point. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ResourceModal } from './ResourceModal.tsx'
import { formatResourceRef, type EvidenceKind, type ResourceRef, type SkillProfile } from '../engine.ts'
import type { RuleCatalogEntry } from './TaskEngineSection.tsx'

const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  command: '命令执行记录', artifact: '产物内容', review: '审核结果', manual: '人工确认', none: '无需凭证',
}

const EVIDENCE_HELP: Record<EvidenceKind, string> = {
  command: '适合能用命令验收的技能。DSH 实际执行检查命令，保存退出码和输出；命令失败会阻止通过。',
  artifact: '适合需求分析、架构设计、任务编排。DSH 检查该阶段声明的产物字段是否已填写。',
  review: '适合代码审核。需要在任务中记录“通过”的审核结论；已启用的 Sonar 审核仍须通过。',
  manual: '适合无法自动判断的事项。执行者提交说明后，DSH 请求使用者明确批准并记录结果。',
  none: '仅要求加载技能并遵循其规则，不另收技能完成凭证；阶段本身的产物、测试和审核门禁仍有效。',
}

export function SkillRuleDialog({ skill, profile, defaultEvidence, rules, description, saveLabel, onSave, onClose }: {
  skill: ResourceRef
  profile?: SkillProfile
  defaultEvidence?: EvidenceKind
  rules: RuleCatalogEntry[]
  description?: string
  saveLabel?: string
  onSave: (profile: SkillProfile) => Promise<void>
  onClose: () => void
}) {
  const [draftRules, setDraftRules] = useState<ResourceRef[]>(profile?.rules ?? [])
  const [evidence, setEvidence] = useState<EvidenceKind | ''>(profile?.evidence ?? '')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'selected' | 'project' | 'user' | 'bundled'>('all')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const effectiveEvidence = evidence || defaultEvidence

  const close = (): void => {
    if (busy) return
    if (dirty && !window.confirm('技能规则配置尚未保存，确定放弃修改？')) return
    onClose()
  }

  const toggle = (rule: ResourceRef): void => {
    const key = formatResourceRef(rule)
    setDraftRules(previous => previous.some(item => formatResourceRef(item) === key)
      ? previous.filter(item => formatResourceRef(item) !== key)
      : [...previous, rule].sort((a, b) => formatResourceRef(a).localeCompare(formatResourceRef(b))))
    setDirty(true)
    setError('')
  }

  const save = async (): Promise<void> => {
    if (busy || !dirty) return
    setBusy(true)
    setError('')
    try {
      await onSave({ rules: draftRules, ...(evidence ? { evidence } : {}) })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败，请重试。')
    } finally {
      setBusy(false)
    }
  }

  const selectedKeys = new Set(draftRules.map(formatResourceRef))
  const filtered = rules.filter(rule => {
    const key = formatResourceRef(rule.ref)
    const chosen = selectedKeys.has(key)
    const matches = `${rule.name} ${rule.sourceLabel} ${rule.source}`.toLowerCase().includes(query.trim().toLowerCase())
    return matches && (filter === 'all' || filter === 'selected' && chosen
      || filter === 'project' && (rule.ref.source === 'project' || rule.ref.source === 'codex-project')
      || filter === 'user' && rule.ref.source === 'user'
      || filter === 'bundled' && rule.ref.source === 'bundled')
  }).sort((a, b) => Number(selectedKeys.has(formatResourceRef(b.ref))) - Number(selectedKeys.has(formatResourceRef(a.ref)))
    || a.name.localeCompare(b.name))
  const catalogKeys = new Set(rules.map(rule => formatResourceRef(rule.ref)))
  const missingRules = draftRules.filter(rule => !catalogKeys.has(formatResourceRef(rule)))
  const visibleMissing = missingRules.filter(rule => (filter === 'all' || filter === 'selected')
    && rule.name.toLowerCase().includes(query.trim().toLowerCase()))

  return <ResourceModal
    placement="right"
    title={`配置规则 · ${skill.name}`}
    description={description ?? '规则属于技能；此处的配置会用于所有绑定该技能的节点。'}
    onClose={close}
    footer={<>
      {error ? <span role="alert" className="te-dialog-error">{error}</span> : null}
      <Button variant="ghost" disabled={busy} onClick={close}>取消</Button>
      <Button variant="primary" disabled={busy || !dirty} onClick={() => { void save() }}>{busy ? '处理中…' : (saveLabel ?? '保存配置')}</Button>
    </>}
  >
    <div className="te-skill-config">
      <div className="te-binding-heading"><strong>适用规则</strong><span className="te-binding-count">已选 {draftRules.length}</span></div>
      <p className="te-evidence-help">这里挂载的是 DSH Skill 的项目 Rule，不是 SonarQube 服务器规则。</p>
      <input className="te-input" type="search" aria-label="搜索规则" placeholder="搜索规则名称或来源" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="te-rule-filters" role="group" aria-label="筛选规则">
        {([['all', '全部'], ['selected', `已选 ${draftRules.length}`], ['project', '项目'], ['user', '用户'], ['bundled', '内置']] as const).map(([value, label]) =>
          <button key={value} type="button" aria-pressed={filter === value} className="te-rule-filter"
            onClick={() => setFilter(value)}>{label}</button>)}
      </div>
      <div className="te-skill-rule-list" role="group" aria-label="规则列表">
        {rules.length === 0 && missingRules.length === 0 ? <p className="te-binding-empty">规则库为空，请先到“规则”页创建或安装。</p> : null}
        {rules.length > 0 && filtered.length === 0 && visibleMissing.length === 0 ? <p className="te-binding-empty">没有匹配的规则。</p> : null}
        {visibleMissing.map(rule => <label key={formatResourceRef(rule)} className="te-skill-rule-row">
          <input type="checkbox" checked onChange={() => toggle(rule)} />
          <span>{rule.name}</span><small>{rule.source} · 规则文件未找到</small>
        </label>)}
        {filtered.map(rule => {
          const key = formatResourceRef(rule.ref)
          const checked = selectedKeys.has(key)
          return <label key={key} className="te-skill-rule-row">
            <input type="checkbox" checked={checked} onChange={() => toggle(rule.ref)} />
            <span>{rule.name}</span><small>{rule.sourceLabel}</small>
          </label>
        })}
      </div>
      <details className="te-evidence-advanced">
        <summary>高级设置 · 完成凭证：{evidence ? EVIDENCE_LABEL[evidence]
          : defaultEvidence ? `未单独设置（默认：${EVIDENCE_LABEL[defaultEvidence]}）` : '未单独设置'}</summary>
        <p className="te-evidence-help">此项只决定任务阶段如何记录 Skill 的完成结果，不改变 Rule 内容、触发方式或 SonarQube 审核。</p>
        <label className="te-skill-evidence">验收方式
          <select className="te-input" aria-label="技能完成凭证" value={evidence} onChange={event => { setEvidence(event.target.value as EvidenceKind | ''); setDirty(true) }}>
            <option value="">{defaultEvidence
              ? `未单独设置（默认：${EVIDENCE_LABEL[defaultEvidence]}）`
              : '未单独设置（由任务流程决定）'}</option>
            <option value="command">命令执行记录</option>
            <option value="artifact">产物内容</option>
            <option value="review">审核结果</option>
            <option value="manual">人工确认</option>
            <option value="none">无需凭证</option>
          </select>
        </label>
        <p className="te-evidence-help" role="status">{evidence
          ? EVIDENCE_HELP[evidence]
          : effectiveEvidence
            ? `不写入单独的完成凭证配置；新任务默认采用“${EVIDENCE_LABEL[effectiveEvidence]}”。${EVIDENCE_HELP[effectiveEvidence]}`
            : '不写入单独的完成凭证配置；实际要求由创建任务时的流程决定。'}</p>
        <details className="te-evidence-guide">
          <summary>查看每种完成凭证的用途</summary>
          <ul>{(Object.keys(EVIDENCE_LABEL) as EvidenceKind[]).map(kind =>
            <li key={kind}><strong>{EVIDENCE_LABEL[kind]}</strong>：{EVIDENCE_HELP[kind]}</li>)}</ul>
        </details>
      </details>
    </div>
  </ResourceModal>
}
