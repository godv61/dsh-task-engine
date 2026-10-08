import { createElement, useEffect, useState, type CSSProperties } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SonarProjectRuleView } from '../sonar-rule-catalog.ts'
import type { TaskEngineRemote } from './TaskEngineSection.tsx'
import { describeError } from './shared.ts'

const muted: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }
const outline: CSSProperties = { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7,
  background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' }

/** Read-only rule browser. Each request is scoped to the selected project's effective profile. */
export function SonarRuleViewer({ workspace, host, remote, onClose }: { workspace: string; host: string;
  remote: TaskEngineRemote; onClose(): void }): ReturnType<typeof createElement> {
  const [view, setView] = useState<SonarProjectRuleView | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showOther, setShowOther] = useState(false)

  useEffect(() => {
    let active = true
    void remote.readSonarProjectRules({ path: workspace }).then(result => {
      if (!active) return
      setBusy(false)
      if (result.ok) setView(result.value)
      else setError(describeError(result.error))
    }, failure => { if (active) { setBusy(false); setError(describeError(failure)) } })
    return () => { active = false }
  }, [remote, workspace])

  const selectLanguage = (language: string) => {
    if (busy || language === view?.selected_language) return
    setBusy(true)
    setError('')
    setSearch('')
    void remote.readSonarProjectRules({ path: workspace, language }).then(result => {
      setBusy(false)
      if (result.ok) setView(result.value)
      else setError(describeError(result.error))
    }, failure => { setBusy(false); setError(describeError(failure)) })
  }
  const hasAnalyzedProfiles = view?.profiles.some(profile => profile.analyzed) ?? false
  const profiles = view?.profiles.filter(profile => showOther || !hasAnalyzedProfiles || profile.analyzed) ?? []
  const query = search.trim().toLowerCase()
  const rules = view?.rules.filter(rule => !query || `${rule.key} ${rule.name} ${rule.severity}`.toLowerCase().includes(query)) ?? []
  const profile = view?.profiles.find(item => item.language === view.selected_language)
  const profileUrl = profile ? `${host.replace(/\/$/u, '')}/profiles/show?name=${encodeURIComponent(profile.name)}&language=${encodeURIComponent(profile.language.toLowerCase())}` : ''
  return createElement('div', { role: 'presentation', style: { position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(0,0,0,.35)' }, onClick: onClose },
  createElement('section', { role: 'dialog', 'aria-modal': true, 'aria-label': '查看当前项目 SonarQube 规则',
    onClick: (event: { stopPropagation(): void }) => event.stopPropagation(), style: {
      position: 'absolute', right: 0, top: 0, bottom: 0, width: 'min(760px, 96vw)', padding: 20,
      boxSizing: 'border-box', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
      display: 'flex', flexDirection: 'column', gap: 12, boxShadow: '-8px 0 30px rgba(0,0,0,.14)' } },
    createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      createElement('strong', null, '当前项目的 SonarQube 规则'),
      createElement(Button, { variant: 'outline', size: 'sm', onClick: onClose }, '关闭')),
    createElement('p', { style: { ...muted, margin: 0 } },
      '这里列出 SonarQube 当前项目 Quality Profile 中启用的规则；Quality Gate 是扫描结果的通过条件，不是规则列表。'),
    error ? createElement('div', { role: 'alert', style: { color: 'var(--dsw-alias-danger, #b42318)' } }, error) : null,
    busy && !view ? createElement('div', { style: muted }, '正在读取当前项目的质量配置和规则…') : null,
    view ? createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 } },
      createElement('div', { style: muted }, hasAnalyzedProfiles
        ? `最近一次服务端分析涉及：${view.analyzed_languages.join('、')}。默认只显示这些语言。`
        : '服务器尚未返回可匹配的已分析语言，显示所有生效的语言配置。'),
      hasAnalyzedProfiles && view.profiles.some(item => !item.analyzed)
        ? createElement('label', { style: muted }, createElement('input', { type: 'checkbox', checked: showOther,
          onChange: (event: { target: HTMLInputElement }) => setShowOther(event.target.checked) }),
          ` 显示其它语言配置（${view.profiles.filter(item => !item.analyzed).length}）`)
        : null,
      createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 110, overflowY: 'auto' } },
        ...profiles.map(item => createElement('button', { key: item.key, type: 'button', disabled: busy,
          onClick: () => selectLanguage(item.language), style: { ...outline, cursor: 'pointer', padding: '5px 9px',
            fontWeight: item.language === view.selected_language ? 700 : 400,
            borderColor: item.language === view.selected_language ? 'var(--dsw-alias-label-primary)' : undefined } },
          `${item.language} · ${item.active_rules}`))),
      profile ? createElement('div', { style: { ...outline, padding: 10, display: 'flex', flexWrap: 'wrap',
        gap: 8, justifyContent: 'space-between', alignItems: 'center' } },
        createElement('span', null, `${profile.language} / ${profile.name}：服务器启用 ${profile.active_rules} 条，已读取 ${view.rule_total} 条`),
        createElement('a', { href: profileUrl, target: '_blank', rel: 'noopener noreferrer' }, '在 SonarQube 查看配置')) : null,
      profile && view.rule_total !== profile.active_rules
        ? createElement('div', { role: 'alert' }, '服务端配置统计与规则列表数量不一致，请刷新后核对。') : null,
      createElement('input', { type: 'search', 'aria-label': '搜索 SonarQube 规则编号或名称', placeholder: '搜索规则编号、名称或严重性',
        value: search, onChange: (event: { target: HTMLInputElement }) => setSearch(event.target.value),
        style: { ...outline, padding: '8px 10px', width: '100%', boxSizing: 'border-box' } }),
      createElement('div', { style: muted }, busy ? '正在切换语言…' : `显示 ${rules.length} / ${view.rule_total} 条规则`),
      createElement('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 } },
        ...rules.map(rule => createElement('a', { key: rule.key,
          href: `${host.replace(/\/$/u, '')}/coding_rules?selected=${encodeURIComponent(rule.key)}`,
          target: '_blank', rel: 'noopener noreferrer', style: { ...outline, padding: '9px 11px', textDecoration: 'none' } },
          createElement('strong', null, rule.name),
          createElement('div', { style: muted }, `${rule.key} · ${rule.severity}`)))),
      createElement('p', { style: { ...muted, margin: 0 } },
        '本地分析器状态按语言判断；即使显示 SYNCED，也不保证这里每条服务端规则都能在提交前本地执行。')) : null))
}
