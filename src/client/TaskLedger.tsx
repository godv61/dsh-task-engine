/**
 * The "任务台账 (tasks)" tab of the workbench: a read-only audit view of
 * every task record under the workspace's `.dsh/`. Each task shows its stage,
 * and each implementation item shows its subagent dispatch trail plus the
 * two-stage (specification / quality) review verdicts. This is the visible
 * mirror of the dispatch/review audit the `dev_task` tool records — no editing.
 *
 * @module dsh-task-engine/TaskLedger
 */

import { createElement, useCallback, useEffect, useState, type CSSProperties } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { styles } from './styles.ts'
import { describeError } from './shared.ts'
import type { TaskEngineRemote, TaskLedgerEntry, TaskLedgerItem } from './TaskEngineSection.ts'

const card: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 10,
  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '12px 14px',
}

const headerRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
}

const itemRow: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4,
  padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l2)',
}

const metaLine: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
  fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
}

const badge: CSSProperties = {
  fontSize: 11, padding: '1px 7px', borderRadius: 10,
  border: '1px solid var(--dsw-alias-border-l2)',
  color: 'var(--dsw-alias-label-secondary)',
}

/** Tone a review verdict: pass renders green, fail red, todo grey. */
function verdictDot(outcome: 'pass' | 'fail'): ReturnType<typeof createElement> {
  return createElement(StateDot, { state: outcome === 'pass' ? 'done' : 'error' })
}

function itemStatusDot(status: string): ReturnType<typeof createElement> {
  return createElement(StateDot, { state: status === 'done' ? 'done' : 'ongoing' })
}

function timeText(at: string): string {
  return at.slice(0, 19).replace('T', ' ')
}

/** Render one item's audit trail: dispatch + two-stage review (when present). */
function itemAudit(item: TaskLedgerItem): ReturnType<typeof createElement> {
  const lines: Array<ReturnType<typeof createElement>> = []
  if (item.dispatch !== undefined) {
    lines.push(createElement('div', { key: 'dispatch', style: metaLine },
      createElement('span', { style: badge }, '已派发'),
      createElement('span', null, item.dispatch.description === '' ? '（无描述）' : item.dispatch.description),
      createElement('span', { style: badge }, timeText(item.dispatch.at)),
    ))
  }
  if (item.review !== undefined) {
    const spec = item.review.spec
    const quality = item.review.quality
    lines.push(createElement('div', { key: 'review', style: metaLine },
      verdictDot(spec.outcome),
      createElement('span', null, `规格符合 ${spec.outcome === 'pass' ? '通过' : '不通过'}`),
      createElement('span', null, '·'),
      verdictDot(quality.outcome),
      createElement('span', null, `代码质量 ${quality.outcome === 'pass' ? '通过' : '不通过'}`),
    ))
    const failNotes = [spec, quality].flatMap(stage => stage.outcome === 'fail' ? (stage.notes ?? []) : [])
    if (failNotes.length > 0) {
      lines.push(createElement('div', { key: 'notes', style: metaLine },
        ...failNotes.map(note => createElement('span', { key: note, style: badge }, note)),
      ))
    }
  }
  if (lines.length === 0) {
    lines.push(createElement('div', { key: 'none', style: metaLine }, createElement('span', { style: badge }, '未派发 / 未审查')))
  }
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, ...lines)
}

export function TaskLedger({ workspace, remote }: {
  workspace: string
  remote: TaskEngineRemote
}): ReturnType<typeof createElement> {
  const [tasks, setTasks] = useState<TaskLedgerEntry[]>([])
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    if (workspace === '') return
    setError('')
    void remote.readTasks(workspace).then((result) => {
      if (result.ok) setTasks(result.value.tasks)
      else setError('读取台账失败：' + describeError(result.error))
    }, (reason: unknown) => {
      setError('读取台账失败：' + describeError(reason))
    })
  }, [remote, workspace])

  useEffect(() => { refresh() }, [refresh])

  return createElement('div', { style: styles.section },
    createElement('div', { style: headerRow },
      createElement('span', { style: styles.bindingLabel }, '任务台账'),
      createElement('span', { style: styles.sourceBadge }, '只读 · 来自 .dsh/task-*.json'),
      createElement(Button, { variant: 'outline', size: 'sm', onClick: refresh }, '刷新'),
    ),
    error !== ''
      ? createElement('p', { style: styles.status }, error)
      : tasks.length === 0
        ? createElement('p', { style: styles.muted }, '当前工作区还没有任务：开工后（dev_task create）会在这里列出派发与审查留痕。')
        : createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          ...tasks.map(task => createElement('div', { key: task.task_id, style: card },
            createElement('div', { style: headerRow },
              createElement('span', { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, task.task_id),
              createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, task.title),
              createElement('span', { style: badge }, task.stage),
              createElement('span', { style: badge }, task.branch),
            ),
            createElement('div', { style: { display: 'flex', flexDirection: 'column' } },
              ...task.items.map(item => createElement('div', { key: item.id, style: itemRow },
                createElement('div', { style: headerRow },
                  itemStatusDot(item.status),
                  createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, item.id),
                  createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, item.title),
                ),
                itemAudit(item),
              )),
            ),
          )),
        ),
  )
}