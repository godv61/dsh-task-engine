/** One editor for the rules and evidence owned by a skill, regardless of entry point. */
import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ResourceModal } from './ResourceModal.tsx'
import { formatResourceRef, type EvidenceKind, type ResourceRef, type SkillProfile } from '../engine.ts'
import type { RuleCatalogEntry } from './TaskEngineSection.tsx'

export function SkillRuleDialog({ skill, profile, rules, description, saveLabel, onSave, onClose }: {
  skill: ResourceRef
  profile?: SkillProfile
  rules: RuleCatalogEntry[]
  description?: string
  saveLabel?: string
  onSave: (profile: SkillProfile) => Promise<void>
  onClose: () => void
}) {
  const [draftRules, setDraftRules] = useState<ResourceRef[]>(profile?.rules ?? [])
  const [evidence, setEvidence] = useState<EvidenceKind | ''>(profile?.evidence ?? '')
  const [query, setQuery] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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

  const filtered = rules.filter(rule => {
    const key = formatResourceRef(rule.ref)
    const chosen = draftRules.some(item => formatResourceRef(item) === key)
    return chosen || `${rule.name} ${rule.sourceLabel}`.toLowerCase().includes(query.trim().toLowerCase())
  })
  const catalogKeys = new Set(rules.map(rule => formatResourceRef(rule.ref)))
  const missingRules = draftRules.filter(rule => !catalogKeys.has(formatResourceRef(rule)))

  return <ResourceModal
    placement="inline"
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
      <label className="te-skill-evidence">完成凭证
        <select className="te-input" aria-label="技能完成凭证" value={evidence} onChange={event => { setEvidence(event.target.value as EvidenceKind | ''); setDirty(true) }}>
          <option value="">沿用旧配置默认值</option>
          <option value="command">命令执行记录</option>
          <option value="artifact">产物内容</option>
          <option value="review">审核结果</option>
          <option value="manual">人工确认</option>
          <option value="none">无需凭证</option>
        </select>
      </label>
      <div className="te-binding-heading"><strong>适用规则</strong><span className="te-binding-count">已选 {draftRules.length}</span></div>
      <input className="te-input" type="search" aria-label="搜索规则" placeholder="搜索规则名称或来源" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="te-skill-rule-list" role="group" aria-label="规则列表">
        {rules.length === 0 && missingRules.length === 0 ? <p className="te-binding-empty">规则库为空，请先到“规则”页创建或安装。</p> : null}
        {rules.length > 0 && filtered.length === 0 ? <p className="te-binding-empty">没有匹配的规则。</p> : null}
        {missingRules.map(rule => <label key={formatResourceRef(rule)} className="te-skill-rule-row">
          <input type="checkbox" checked onChange={() => toggle(rule)} />
          <span>{rule.name}</span><small>{rule.source} · 规则文件未找到</small>
        </label>)}
        {filtered.map(rule => {
          const key = formatResourceRef(rule.ref)
          const checked = draftRules.some(item => formatResourceRef(item) === key)
          return <label key={key} className="te-skill-rule-row">
            <input type="checkbox" checked={checked} onChange={() => toggle(rule.ref)} />
            <span>{rule.name}</span><small>{rule.sourceLabel}</small>
          </label>
        })}
      </div>
    </div>
  </ResourceModal>
}
