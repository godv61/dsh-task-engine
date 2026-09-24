/** Manage skill files and the one rule list owned by each skill. */
import { useEffect, useState } from 'react'
import { ResourceManager } from './ResourceManager.tsx'
import { SkillRuleDialog } from './SkillRuleDialog.tsx'
import { compactProjectConfig, type ProjectConfig } from '../workflows.ts'
import { formatResourceRef, type ResourceRef, type SkillProfile } from '../engine.ts'
import type { RuleCatalogEntry, TaskEngineRemote } from './TaskEngineSection.tsx'

export function SkillManager({ workspace, remote }: { workspace: string; remote: TaskEngineRemote }) {
  const [config, setConfig] = useState<ProjectConfig | null>(null)
  const [rules, setRules] = useState<RuleCatalogEntry[]>([])
  const [selected, setSelected] = useState<ResourceRef | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    void Promise.all([remote.read(workspace), remote.listRules(workspace)])
      .then(([saved, availableRules]) => {
        if (!active) return
        if (!saved.ok || !saved.value.ok || !availableRules.ok) {
          setMessage('读取技能规则配置失败，请重新打开技能页。')
          return
        }
        const effective = saved.value.config
        setConfig(compactProjectConfig({ flow: saved.value.flow, stage_bindings: effective.stage_bindings,
          skill_profiles: effective.skill_profiles, commit: effective.commit,
          artifacts: effective.artifacts, review_depth: effective.review_depth,
          commit_required: effective.commit_required }))
        setRules(availableRules.value.rules)
      })
      .catch(() => { if (active) setMessage('读取技能规则配置失败，请重新打开技能页。') })
    return () => { active = false }
  }, [remote, workspace])

  const saveProfile = async (profile: SkillProfile): Promise<void> => {
    if (!config || !selected) throw new Error('配置尚未加载，请稍后重试。')
    const key = formatResourceRef(selected)
    const next = { ...config, skill_profiles: { ...config.skill_profiles, [key]: profile } }
    const result = await remote.write({ path: workspace, ...next })
    if (!result.ok || !result.value.ok) throw new Error(result.ok ? result.value.problems.join('；') : '保存失败，请重试。')
    setConfig(next)
    setMessage(`已保存 ${selected.name} 的规则配置。`)
    setSelected(null)
  }

  return <div>
    <ResourceManager workspace={workspace} remote={remote} kind="skill" onConfigureSkill={config ? ref => { setMessage(''); setSelected(ref) } : undefined} />
    {selected === null && message ? <p role="status" className="te-success">{message}</p> : null}
    {selected !== null ? <SkillRuleDialog key={formatResourceRef(selected)} skill={selected}
      profile={config?.skill_profiles?.[formatResourceRef(selected)]} rules={rules}
      onSave={saveProfile} onClose={() => setSelected(null)} /> : null}
  </div>
}
