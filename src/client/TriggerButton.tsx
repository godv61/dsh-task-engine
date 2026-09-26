/**
 * Sidebar foot trigger for the full-screen task-engine workbench. Rendered in
 * the `sidebar.footer.action` list slot, above Settings: a compact rail icon
 * when the sidebar is collapsed, an icon + label when it is wide. Clicking
 * opens the shared visibility store, which the `shell.overlay` workbench reads.
 *
 * Geometry mirrors the native Settings trigger, measured live on the shell:
 * rail = 36px circle with an 18px icon; expanded = 42px tall, 12px radius,
 * padding `0 10px 0 8px` (icon column at x=18), 14px/22px label. Matching the
 * native row keeps both foot seats on one icon column and one baseline.
 *
 * @module dsh-task-engine/TriggerButton
 */

import { createElement } from 'react'
import { IconSettings } from './icons.ts'

const hover = 'var(--dsw-alias-bg-layer-2)'
const label = 'var(--dsw-alias-label-primary)'

export function TriggerButton({ wide, actions }: {
  wide: boolean
  actions: { open(): void }
}): ReturnType<typeof createElement> {
  return createElement('button', {
    type: 'button',
    title: '工程流程',
    'aria-haspopup': 'dialog',
    onClick: () => { actions.open() },
    onMouseEnter: (event: { currentTarget: HTMLButtonElement }) => { event.currentTarget.style.background = hover },
    onMouseLeave: (event: { currentTarget: HTMLButtonElement }) => { event.currentTarget.style.background = 'transparent' },
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: wide ? 'flex-start' : 'center',
      gap: wide ? 8 : 0,
      width: wide ? '100%' : 36,
      minWidth: wide ? 0 : 36,
      height: wide ? 42 : 36,
      flex: wide ? '1 1 auto' : 'none',
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      color: label,
      borderRadius: wide ? 12 : '50%',
      padding: wide ? '0 10px 0 8px' : 0,
      // The native settings row bleeds 2px past its seat on both sides so its
      // hover chrome spans the full row; matching keeps both icon columns on
      // the same x.
      margin: wide ? '0 -2px' : '0 auto 2px',
      fontSize: wide ? 14 : undefined,
      lineHeight: wide ? '22px' : undefined,
      boxSizing: 'border-box',
      transition: 'background 120ms ease',
    },
  },
    createElement(IconSettings, { size: wide ? 16 : 18 }),
    wide ? createElement('span', { style: { fontSize: 14, lineHeight: '22px' } }, '工程流程') : null,
  )
}
