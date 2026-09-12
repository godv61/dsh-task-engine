/**
 * A fixed, centered modal for the skill/rule viewer and editor. It gives the
 * markdown view and the edit form a wide, scrollable surface instead of the
 * inline card, using theme tokens so it follows light/dark and brand overrides.
 *
 * @module dsh-task-engine/ResourceModal
 */

import { createElement, useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

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
 * Render a wide centered modal. Escape and mask click close it; the title is
 * the accessible dialog label.
 * @param title - dialog heading.
 * @param children - scrollable body.
 * @param footer - optional action row (Cancel / Save).
 * @param onClose - close from Escape, the mask, or the close button.
 * @param description - optional supporting sentence under the title.
 */
export function ResourceModal({ title, description, onClose, footer, children }: {
  title: string
  description?: string
  onClose: () => void
  footer?: ReactNode
  children?: ReactNode
}): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  return createPortal(
    createElement('div', { style: rootStyle, role: 'presentation' },
      createElement('div', { style: maskStyle, 'aria-hidden': true, onClick: onClose }),
      createElement('div', { style: dialogStyle, role: 'dialog', 'aria-modal': true, 'aria-label': title },
        createElement('div', { style: headerStyle },
          createElement('h2', { style: titleStyle }, title),
          createElement('button', { type: 'button', style: closeBtnStyle, 'aria-label': '关闭', onClick: onClose },
            createElement(IconCloseOutline16, { size: 14 }),
          ),
        ),
        description !== undefined && description !== ''
          ? createElement('p', { style: descStyle }, description)
          : null,
        createElement('div', { style: bodyStyle }, children),
        footer !== undefined ? createElement('div', { style: footerStyle }, footer) : null,
      ),
    ),
    document.body,
  )
}