/**
 * Sidebar foot trigger for the full-screen task-engine workbench. Rendered in
 * the `sidebar.footer.action` list slot, above Settings: a compact rail icon
 * when the sidebar is collapsed, an icon + label when it is wide. Clicking
 * opens the shared visibility store, which the `shell.overlay` workbench reads.
 *
 * @module dsh-task-engine/TriggerButton
 */

import { createElement } from 'react'
import { IconSettingsOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

export function TriggerButton({ wide, actions }: {
  wide: boolean
  actions: { open(): void }
}): ReturnType<typeof createElement> {
  return createElement('button', {
    type: 'button',
    title: '工程流程',
    'aria-haspopup': 'dialog',
    onClick: () => { actions.open() },
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: wide ? 'flex-start' : 'center',
      gap: wide ? 8 : 0,
      width: '100%',
      height: 32,
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      color: 'var(--dsw-alias-label-secondary)',
      borderRadius: 6,
      padding: wide ? '0 10px' : 0,
      boxSizing: 'border-box',
    },
  },
    createElement(IconSettingsOutline16, { size: wide ? 16 : 18 }),
    wide ? createElement('span', { style: { fontSize: 13 } }, '工程流程') : null,
  )
}