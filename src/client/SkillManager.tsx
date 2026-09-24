/** Manage skill files and the one rule list owned by each skill. */
import { useEffect, useState } from 'react'
import { ResourceManager } from './ResourceManager.tsx'
import { compactProjectConfig, type ProjectConfig } from '../workflows.ts'
import { formatResourceRef, type ResourceRef } from '../engine.ts'
import type { SkillCatalogEntry, RuleCatalogEntry, TaskEngineRemote } from './TaskEngineSection.tsx'

export function SkillManager({ workspace, remote }: { workspace: string; remote: TaskEngineRemote }) {
  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([])
  const [rules, setRules] = useState<RuleCatalogEntry[]>([])
  const [selected, setSelected] = useState('')
  const [message, setMessage] = useState('')
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let active = true
    void Promise.all([remote.read(workspace), remote.listSkills(workspace), remote.listRules(workspace)])
      .then(([saved, availableSkills, availableRules]) => {
        if (!active) return
        if (!saved.ok || !saved.value.ok || !availableSkills.ok || !availableRules.ok) {
          setMessage('读取技能规则配置失败，请重新打开技能页。')
          return
        }
        const effective = saved.value.config
        setConfig(compactProjectConfig({ flow: saved.value.flow, stage_bindings: effective.stage_bindings,
          skill_profiles: effective.skill_profiles, commit: effective.commit,
          artifacts: effective.artifacts, review_depth: effective.review_depth,
          commit_required: effective.commit_required }))
        setSkills(availableSkills.value.skills)
        setRules(availableRules.value.rules)
      })
      .catch(() => { if (active) setMessage('读取技能规则配置失败，请重新打开技能页。') })
    return () => { active = false }
  }, [remote, workspace])

  const chosen = skills.find(skill => formatResourceRef(skill.ref) === selected)
  const profile = selected === '' ? undefined : config?.skill_profiles?.[selected]

  const toggle = (rule: ResourceRef): void => {
    if (!config || !selected) return
    const key = formatResourceRef(rule)
    const previous = profile?.rules ?? []
    const next = previous.some(item => formatResourceRef(item) === key)
      ? previous.filter(item => formatResourceRef(item) !== key)
      : [...previous, rule]
    setConfig({ ...config, skill_profiles: {
      ...config.skill_profiles,
      [selected]: { ...profile, rules: next },
    } })
    setDirty(true)
    setMessage('')
  }

  const setEvidence = (value: string): void => {
    if (!config || !selected) return
    const { evidence: _previous, ...rest } = profile ?? { rules: [] }
    setConfig({ ...config, skill_profiles: {
      ...config.skill_profiles,
      [selected]: value === '' ? rest : { ...rest, evidence: value as 'command' | 'artifact' | 'review' | 'manual' | 'none' },
    } })
    setDirty(true)
    setMessage('')
  }

  const save = async (): Promise<void> => {
    if (!config) return
    const result = await remote.write({ path: workspace, ...config })
    if (!result.ok || !result.value.ok) {
      setMessage(result.ok ? result.value.problems.join('；') : '保存失败，请重试。')
      return
    }
    setDirty(false)
    setMessage('已保存；所有引用此技能的节点将使用同一套规则。')
  }

  return <div>
    <ResourceManager workspace={workspace} remote={remote} kind="skill" />
    <section className="te-binding-picker" aria-label="技能规则" style={{ marginTop: 24, padding: 16 }}>
      <h3>技能配置</h3>
      <p>规则归属于技能；节点只选择技能。同一个技能在所有节点使用同一套规则。</p>
      <select aria-label="选择技能配置规则" value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="">选择技能</option>
        {skills.map(skill => <option key={formatResourceRef(skill.ref)} value={formatResourceRef(skill.ref)}>{skill.name}（{skill.sourceLabel}）</option>)}
      </select>
      {chosen && <div className="te-rule-list" style={{ marginTop: 12 }}>
        <label>完成凭证 {' '}
          <select aria-label="技能完成凭证" value={profile?.evidence ?? ''} onChange={event => setEvidence(event.target.value)}>
            <option value="">沿用旧配置默认值</option>
            <option value="command">命令执行记录</option>
            <option value="artifact">产物内容</option>
            <option value="review">审核结果</option>
            <option value="manual">人工确认</option>
            <option value="none">无需凭证</option>
          </select>
        </label>
        {rules.map(rule => {
          const key = formatResourceRef(rule.ref)
          return <label key={key} className="te-binding-filter">
            <input type="checkbox" checked={(profile?.rules ?? []).some(item => formatResourceRef(item) === key)} onChange={() => toggle(rule.ref)} />{' '}
            {rule.name}（{rule.sourceLabel}）
          </label>
        })}
      </div>}
      <div style={{ marginTop: 12 }}>
        <button type="button" disabled={!dirty} onClick={() => { void save().catch(() => setMessage('保存失败，请重试。')) }}>保存技能配置</button>
        {message && <span role="status" style={{ marginLeft: 12 }}>{message}</span>}
      </div>
    </section>
  </div>
}
