/**
 * A centered resource dialog or an in-layout configuration panel. Dialogs trap
 * focus; the in-layout panel pushes the workbench instead of masking it.
 *
 * @module dsh-task-engine/ResourceModal
 */

import { createElement, useEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from './icons.ts'

const rootStyle: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 24,
}

const maskStyle: CSSProperties = {
  position: 'absolute', inset: 0,
  background: 'var(--dsw-alias-bg-mask-1)',
  backdropFilter: 'var(--dsw-mask-blur)',
}

const dialogStyle: CSSProperties = {
  position: 'relative', zIndex: 1,
  display: 'flex', flexDirection: 'column',
  width: 'min(760px, 100%)', maxHeight: '85vh',
  borderRadius: 24, background: 'var(--dsw-alias-bg-layer-2)',
  boxShadow: 'var(--dsw-elevation-prominent)', overflow: 'hidden',
}

const drawerStyle: CSSProperties = {
  ...dialogStyle,
  width: 'min(560px, 100%)', height: '100%', maxHeight: '100%',
  borderRadius: '16px 0 0 16px',
}

const inlineStyle: CSSProperties = {
  ...dialogStyle,
  width: '100%', height: 'min(720px, calc(100vh - 32px))', maxHeight: 'calc(100vh - 32px)',
  borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2)',
  boxShadow: 'none',
}

const headerStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  padding: '18px 18px 10px 24px', flex: 'none',
}

const titleStyle: CSSProperties = {
  margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
}

const closeBtnStyle: CSSProperties = {
  flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 28, height: 28, border: 'none', borderRadius: 8, background: 'transparent',
  cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', padding: 0,
}

const descStyle: CSSProperties = {
  margin: 0, padding: '0 24px', fontSize: 13, lineHeight: '20px',
  color: 'var(--dsw-alias-label-secondary)', flex: 'none',
}

const bodyStyle: CSSProperties = {
  flex: '1 1 auto', minHeight: 0, overflowY: 'auto',
  padding: '16px 24px 4px', display: 'flex', flexDirection: 'column',
}

const footerStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
  padding: '12px 24px 20px', flex: 'none',
}

/**
 * Render a centered modal or right-side drawer. Escape and mask click close it;
 * the title is the accessible dialog label.
 * @param title - dialog heading.
 * @param children - scrollable body.
 * @param footer - optional action row (Cancel / Save).
 * @param onClose - close from Escape, the mask, or the close button.
 * @param description - optional supporting sentence under the title.
 * @param placement - where to place the dialog.
 */
export function ResourceModal({ title, description, onClose, footer, children, placement = 'center' }: {
  title: string
  description?: string
  onClose: () => void
  footer?: ReactNode
  children?: ReactNode
  placement?: 'center' | 'right' | 'inline'
}): ReactNode {
  const dialog = useRef<HTMLDivElement>(null)
  const closer = useRef(onClose)
  closer.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    if (placement !== 'inline') dialog.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (!dialog.current?.contains(document.activeElement)) return
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closer.current(); return }
      if (placement === 'inline') return
      if (e.key !== 'Tab') return
      const nodes = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([hidden]),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(el => el.getClientRects().length)
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (!first || !last) { e.preventDefault(); return }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus() }
  }, [placement])

  const panel = createElement('div', { style: placement === 'inline' ? inlineStyle : placement === 'right' ? drawerStyle : dialogStyle,
    className: placement === 'inline' ? 'te-inline-panel' : undefined,
    ref: dialog, tabIndex: -1, role: placement === 'inline' ? 'complementary' : 'dialog',
    ...(placement === 'inline' ? {} : { 'aria-modal': true }), 'aria-label': title },
    createElement('div', { style: headerStyle },
      createElement('h2', { style: titleStyle }, title),
      createElement('button', { type: 'button', style: closeBtnStyle, 'aria-label': '关闭', onClick: onClose },
        createElement(IconClose, { size: 14 }),
      ),
    ),
    description !== undefined && description !== ''
      ? createElement('p', { style: descStyle }, description)
      : null,
    createElement('div', { style: bodyStyle }, children),
    footer !== undefined ? createElement('div', { style: footerStyle }, footer) : null,
  )
  if (placement === 'inline') return panel

  return createPortal(
    createElement('div', { style: placement === 'right' ? { ...rootStyle, justifyContent: 'flex-end', padding: 0 } : rootStyle, className: `te-modal${placement === 'right' ? ' te-drawer' : ''}`, role: 'presentation' },
      createElement('div', { style: placement === 'right' ? { ...maskStyle, background: 'rgba(0, 0, 0, 0.18)' } : maskStyle, 'aria-hidden': true, onClick: onClose }),
      panel,
    ),
    document.body,
  )
}
