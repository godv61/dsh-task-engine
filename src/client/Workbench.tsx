/**
 * The full-screen task-engine workbench, registered into `shell.overlay` so it
 * covers the whole app frame. It reads the shared visibility store: closed it
 * renders nothing (the overlay layer stays click-through), open it paints a
 * header, a workspace selector, a tab bar, and the active tab — the flow
 * editor, the skill manager, or the rule manager.
 *
 * @module dsh-task-engine/Workbench
 */

import { createElement, useState, type CSSProperties, type ChangeEvent } from 'react'
import { Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconClose, IconSettings } from './icons.ts'
import { workbenchTheme } from './workbench-theme.ts'
import { styles } from './styles.ts'
import type { WorkspaceItem } from './shared.ts'
import type { TaskEngineRemote } from './TaskEngineSection.ts'
import { TaskEngineSection } from './TaskEngineSection.tsx'
import { InitPanel } from './InitPanel.tsx'
import { SkillManager } from './SkillManager.tsx'
import { RuleManager } from './RuleManager.tsx'
import { TaskLedger } from './TaskLedger.tsx'
import type { VisibilityState } from './visibility.ts'

const overlay: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--dsw-alias-bg-base)',
  zIndex: 20,
}

const header: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '20px 28px',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}

const headerBrand: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }
const headerText: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }
const headerTitle: CSSProperties = { fontSize: 20, fontWeight: 650, color: 'var(--dsw-alias-label-primary)' }
const headerSub: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', margin: 0 }

const tabbar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '12px 28px', flexWrap: 'wrap',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}

const body: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '16px clamp(12px, 2vw, 28px)',
}

const selectStyle: CSSProperties = {
  marginLeft: 'auto',
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '5px 8px',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
}

const closeStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  borderRadius: 6,
  color: 'var(--dsw-alias-label-secondary)',
}
const TABS = [
  { id: 'init', label: '项目初始化' },
  { id: 'flow', label: '流程配置' },
  { id: 'tasks', label: '任务台账' },
  { id: 'skills', label: '技能' },
  { id: 'rules', label: '规则' },
] as const

type TabId = (typeof TABS)[number]['id']

export function Workbench({ useStore, actions, useWorkspaces, remote }: {
  useStore: <S>(selector: (state: VisibilityState) => S) => S
  actions: { close(): void }
  useWorkspaces: <S>(selector: (state: { items: readonly WorkspaceItem[] }) => S) => S
  remote: TaskEngineRemote
}): null | ReturnType<typeof createElement> {
  const open = useStore((s) => s.open)
  const workspaces = useWorkspaces((s) => s.items)
  const [tab, setTab] = useState<TabId>('init')
  const [workspace, setWorkspace] = useState('')

  if (!open) return null

  const current = workspaces.some(w => w.path === workspace) ? workspace : (workspaces[0]?.path ?? '')

  return createElement('div', { style: overlay, className: 'te-workbench' },
    createElement('style', null, workbenchTheme),
    createElement('div', { style: header },
      createElement('div', { style: headerBrand },
        createElement(IconSettings, { size: 18 }),
        createElement('div', { style: headerText },
          createElement('span', { style: headerTitle }, '工程流程'),
          createElement('p', { style: headerSub }, '工程化交付工作台 · 需求评审 → 设计 → 开发 → 交付 → 代码审核'),
        ),
      ),
      createElement('button', {
        type: 'button',
        title: '关闭',
        onClick: () => { actions.close() },
        style: closeStyle,
        onMouseEnter: (event: { currentTarget: HTMLButtonElement }) => { event.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)' },
        onMouseLeave: (event: { currentTarget: HTMLButtonElement }) => { event.currentTarget.style.background = 'transparent' },
      },
        createElement(IconClose, { size: 16 })),
    ),
    createElement('div', { style: tabbar },
      ...TABS.map(t => createElement(Pill, { key: t.id, active: tab === t.id, onClick: () => { setTab(t.id) } }, t.label)),
      workspaces.length > 0
        ? createElement('select', {
          style: selectStyle, 'aria-label': '当前工作区',
          value: current,
          onChange: (ev: ChangeEvent<HTMLSelectElement>) => { setWorkspace(ev.target.value) },
        }, ...workspaces.map(w => createElement('option', { key: w.path, value: w.path }, w.title || w.path)))
        : null,
    ),
    createElement('div', { style: body },
      createElement('div', { className: 'te-content', key: current },
      createElement('p', { style: { ...styles.hint, marginBottom: 10 }, title: current }, '工作区 · ' + current),
      current === ''
        ? createElement('p', { style: styles.muted }, '当前没有工作区：请先在侧栏创建一个工作区，再回来配置流程。')
        : tab === 'init'
          ? createElement(InitPanel, { workspace: current, remote })
          : tab === 'flow'
            ? createElement(TaskEngineSection, { workspace: current, remote })
            : tab === 'tasks'
              ? createElement(TaskLedger, { workspace: current, remote })
              : tab === 'skills'
                ? createElement(SkillManager, { workspace: current, remote })
                : createElement(RuleManager, { workspace: current, remote })),
    ),
  )
}
