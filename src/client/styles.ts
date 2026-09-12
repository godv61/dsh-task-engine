/**
 * Shared inline styles for the settings page. Colors come from the DSH theme
 * tokens (`--dsw-alias-*`) so the page follows light/dark and brand overrides;
 * only neutral layout (gap, padding, wrapping) is literal. Primitive components
 * carry their own token styling; this module covers the page's layout chrome.
 *
 * @module dsh-task-engine/styles
 */

import type { CSSProperties } from 'react'

const text = 'var(--dsw-alias-label-primary)'
const textSecondary = 'var(--dsw-alias-label-secondary)'
const textTertiary = 'var(--dsw-alias-label-tertiary)'
const border = 'var(--dsw-alias-border-l2)'
const surface = 'var(--dsw-alias-bg-layer-2)'
const danger = 'var(--dsw-alias-state-error-primary)'
const success = 'var(--dsw-alias-state-success-primary)'
const warn = 'var(--dsw-alias-state-warn-primary)'
const brand = 'var(--dsw-alias-state-business-primary)'

export const styles: Record<string, CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 16, padding: 20, maxWidth: 900 },
  head: { display: 'flex', flexDirection: 'column', gap: 4 },
  title: { margin: 0, color: text },
  muted: { margin: 0, color: textSecondary, fontSize: 13, lineHeight: 1.5 },

  sourceRow: { display: 'flex', alignItems: 'center', gap: 8 },
  sourceText: { color: textTertiary, fontSize: 13 },

  workspaceRow: { display: 'flex', alignItems: 'center', gap: 8 },
  workspaceLabel: { color: textSecondary, fontSize: 13 },

  flowCard: { border: `1px solid ${border}`, borderRadius: 10, background: surface, padding: 12, overflowX: 'auto' },

  section: { display: 'flex', flexDirection: 'column', gap: 12 },
  cardBody: { padding: '4px 0 8px', display: 'flex', flexDirection: 'column', gap: 12 },

  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 220px', minWidth: 180 },
  fieldLabel: { color: textSecondary, fontSize: 13 },
  hint: { color: textTertiary, fontSize: 12, margin: 0, lineHeight: 1.4 },

  chips: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' },

  cardRow: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    border: `1px solid ${border}`, borderRadius: 8, padding: '8px 10px',
  },

  inline: { display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 8 },

  textarea: {
    background: 'var(--dsw-alias-bg-layer-1)',
    border: `1px solid ${border}`,
    borderRadius: 8,
    padding: '8px 10px',
    color: text,
    fontSize: 13,
    minHeight: 90,
    resize: 'vertical',
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  },

  sourceBadge: { color: textTertiary, fontSize: 11 },
  bindingStage: { display: 'flex', flexDirection: 'column', gap: 6 },
  bindingLabel: { color: text, fontSize: 13, fontWeight: 600 },

  problems: {
    display: 'flex', flexDirection: 'column', gap: 8,
    border: `1px solid ${danger}`, borderRadius: 8, padding: '10px 12px',
  },
  problemsTitle: { color: danger, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 },
  problemsList: { margin: 0, paddingLeft: 20, color: text, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 },
  noticeBox: {
    border: `1px solid ${warn}`, borderRadius: 8, padding: '10px 12px',
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  noticeTitle: { color: warn, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 },

  okText: { color: success, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 },
  status: { color: textTertiary, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 },

  actions: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 },
}

export { text, textSecondary, textTertiary, border, surface, danger, success, warn, brand }