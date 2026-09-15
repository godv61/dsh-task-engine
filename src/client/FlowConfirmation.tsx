/** Page-owned confirmation avoids blocking native dialogs inside embedded browsers. */
import { t as flowText } from './flow-locale.ts'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

/** Ask before discarding a draft or removing a stage; only approval invokes the action. */
export function useFlowConfirmation() {
  const [pending, setPending] = useState<{ message: string; label: string; action: () => void }>()
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pending) return
    const prior = document.activeElement as HTMLElement | null
    panel.current?.focus()
    return () => prior?.focus()
  }, [pending])
  return {
    confirm: (message: string, label: string, action: () => void) => setPending({ message, label, action }),
    dialog: pending ? <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,.35)', display: 'grid', placeItems: 'center', padding: 20 }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={flowText("确认流程修改")} tabIndex={-1} style={{ width: 'min(460px,100%)', borderRadius: 16, background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', padding: 24, boxShadow: '0 12px 48px rgba(0,0,0,.2)' }} onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); setPending(undefined) }
        if (e.key === 'Tab') {
          const buttons = panel.current?.querySelectorAll<HTMLButtonElement>('button')
          const first = buttons?.[0], last = buttons?.[buttons.length - 1]
          if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }}>
        <h3>{flowText("确认流程修改")}</h3><p>{pending.message}</p><div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <Button onClick={() => setPending(undefined)}>{flowText("继续编辑")}</Button>
          <Button variant="primary" onClick={() => { const action = pending.action; setPending(undefined); action() }}>{pending.label}</Button>
        </div>
      </div>
    </div> : null,
  }
}
