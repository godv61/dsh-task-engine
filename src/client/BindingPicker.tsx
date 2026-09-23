/** Searchable stage bindings; filtering never changes the selection or preset defaults. */
import { createElement, useMemo, useState } from 'react'
import { sourceLabel } from './shared.ts'

interface BindingResource {
  name: string
  description?: string
  source: string
}

export function BindingPicker({ title, resources, selected, defaults, onToggle }: {
  title: string
  resources: BindingResource[]
  selected: string[]
  defaults: string[]
  onToggle: (name: string) => void
}): ReturnType<typeof createElement> {
  const [query, setQuery] = useState('')
  const [selectedOnly, setSelectedOnly] = useState(false)
  const chosen = useMemo(() => new Set([...defaults, ...selected]), [defaults, selected])
  const catalog = useMemo(() => {
    const entries = new Map<string, BindingResource>()
    for (const resource of resources) {
      if (!entries.has(resource.name)) entries.set(resource.name, resource)
    }
    // Keep unresolved bindings visible so catalog loading cannot silently hide selections.
    for (const name of chosen) {
      if (!entries.has(name)) entries.set(name, { name, source: 'missing' })
    }
    return [...entries.values()]
  }, [resources, chosen])
  const search = query.trim().toLocaleLowerCase()
  const visible = catalog.filter(resource =>
    (!selectedOnly || chosen.has(resource.name)) &&
    `${resource.name} ${resource.description ?? ''}`.toLocaleLowerCase().includes(search))

  return (
    <section className="te-binding-picker" aria-label={`${title}绑定`}>
      <div className="te-binding-heading">
        <h4>{title}</h4>
        <span className="te-binding-count">已选 {chosen.size} / {catalog.length}</span>
      </div>
      <div className="te-binding-tools">
        <input type="search" className="te-input" aria-label={`搜索${title}`} placeholder={`搜索${title}名称${title === '技能' ? '或描述' : ''}`} value={query} onChange={event => setQuery(event.target.value)} />
        <label className="te-binding-filter">
          <input type="checkbox" checked={selectedOnly} onChange={event => setSelectedOnly(event.target.checked)} />
          仅看已选
        </label>
      </div>
      <div className="te-binding-list" role="group" aria-label={`${title}列表`} tabIndex={0}>
        {visible.map(resource => {
          const fixed = defaults.includes(resource.name)
          const checked = chosen.has(resource.name)
          return (
            <label key={resource.name} className={`te-binding-option${checked ? ' is-selected' : ''}${fixed ? ' is-fixed' : ''}`}>
              <input type="checkbox" aria-label={resource.name} checked={checked} disabled={fixed} onChange={() => onToggle(resource.name)} />
              <span className="te-binding-detail">
                <span className="te-binding-name">{resource.name}</span>
                <span className="te-binding-meta">{resource.source === 'missing' ? '资源未找到' : sourceLabel(resource.source)}{fixed ? ' · 预设默认' : ''}</span>
                {resource.description ? <span className="te-binding-description" title={resource.description}>{resource.description}</span> : null}
              </span>
            </label>
          )
        })}
        {visible.length === 0 ? <p className="te-binding-empty">{catalog.length === 0 ? `暂无${title}，请在上方“${title}”页添加。` : search ? '没有匹配项，请尝试其他关键词。' : '当前节点尚未选择附加项。'}</p> : null}
      </div>
      <span className="te-binding-count" role="status">显示 {visible.length} 项{search || selectedOnly ? '（已筛选）' : ''}</span>
    </section>
  )
}
