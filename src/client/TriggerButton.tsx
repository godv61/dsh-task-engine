/**
 * Sidebar foot trigger for the full-screen task-engine workbench. Rendered in
 * the `sidebar.footer.action` list slot, above Settings: a compact rail icon
 * when the sidebar is collapsed, an icon + label when it is wide. Clicking
 * opens the shared visibility store, which the `shell.overlay` workbench reads.
 *
 * Geometry follows the DSH sidebar foot seats: collapsed seats center a fixed
 * 32px square (rail icons at 18), expanded seats own the full row with the
 * glyph at its native 16. The button never sets a percentage width when
 * collapsed — the slot host centers with `width: auto` and a 100% child would
 * stretch past the rail's icon column.
 *
 * @module dsh-task-engine/TriggerButton
 */

import { createElement } from 'react'
import { IconSettingsOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

const hover = 'var(--dsw-alias-bg-layer-2)'
const label = 'var(--dsw-alias-label-secondary)'

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
      width: wide ? '100%' : 32,
      minWidth: wide ? 0 : 32,
      height: 32,
      flex: wide ? '1 1 auto' : 'none',
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      color: label,
      borderRadius: 6,
      padding: wide ? '0 10px' : 0,
      margin: wide ? '0 0 2px' : '0 auto 2px',
      boxSizing: 'border-box',
      transition: 'background 120ms ease',
    },
  },
    createElement(IconSettingsOutline16, { size: wide ? 16 : 18 }),
    wide ? createElement('span', { style: { fontSize: 13 } }, '工程流程') : null,
  )
}
