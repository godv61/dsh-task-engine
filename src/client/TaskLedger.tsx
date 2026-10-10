/**
 * The "任务台账 (tasks)" tab of the workbench: a read-only audit view of
 * every task record under the workspace's `.dsh/`. Each task shows its stage,
 * and each implementation item shows its start record plus the
 * two-stage (specification / quality) review verdicts. This is the visible
 * mirror of the implementation/review audit the `dev_task` tool records — no editing.
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

/** Render one item's start record and two-stage review (when present). */
function itemAudit(item: TaskLedgerItem): ReturnType<typeof createElement> {
  const lines: Array<ReturnType<typeof createElement>> = []
  if (item.dispatch !== undefined) {
    lines.push(createElement('div', { key: 'dispatch', style: metaLine },
      createElement('span', { style: badge }, '已开始'),
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
    const status = item.status === 'done' ? '已标记完成，缺少实施项审查记录'
      : item.status === 'doing' ? '实施中，待审查' : '待开始'
    lines.push(createElement('div', { key: 'none', style: metaLine }, createElement('span', { style: badge }, status)))
  }
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, ...lines)
}

function sonarAudit(task: TaskLedgerEntry): ReturnType<typeof createElement> | null {
  if (!task.sonar) return null
  const audit = task.sonar.audit
  if (!audit) return createElement('div', { style: metaLine }, 'SonarQube 已启用，尚未运行代码审核。')
  const source = ({ 'ide-local': '本地规则审核', local: '本机上传扫描', ci: 'CI 扫描' } as Record<string, string>)[task.sonar.source] ?? task.sonar.source
  const reviewGate = audit.review_gate ?? audit.gate
  const outcome = reviewGate === 'OK' ? '通过' : '未通过'
  const unresolved = audit.unresolved_count ?? audit.blocking_count
  return createElement('details', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8 } },
    createElement('summary', { style: { cursor: 'pointer', fontSize: 13 } },
      `最近一次 SonarQube 审核：${outcome} · 未解决 ${unresolved} 条 · 原始命中 ${audit.blocking_count} 条 · ${timeText(audit.checked_at)}`),
    createElement('p', { style: metaLine },
      `来源：${source}；分析目标：${audit.target}；原始结果：${audit.gate}。这是该次审核记录；代码或规则变更后需重新测试并审核。`),
    audit.report_path ? createElement('p', { style: metaLine }, `审核文件：${audit.report_path}`) : null,
    audit.scanned_files?.length ? createElement('details', null,
      createElement('summary', { style: { cursor: 'pointer', fontSize: 12 } }, `本次分析文件（${audit.scanned_files.length}）`),
      ...audit.scanned_files.map(file => createElement('div', { key: file, style: metaLine }, file))) : null,
    audit.profile_coverage?.length ? createElement('details', null,
      createElement('summary', { style: { cursor: 'pointer', fontSize: 12 } }, '本次涉及语言的项目规则与本地分析器'),
      ...audit.profile_coverage.map(profile => createElement('div', { key: profile.language, style: metaLine },
        `${profile.language}：服务端启用 ${profile.active_rules} 条规则；本地分析器 ${profile.analyzer}`)),
      createElement('div', { style: metaLine }, '规则来自当前项目的 Quality Profile；本次实际审核文件与发现见上方记录。服务端 Quality Gate 以服务端扫描结果为准。')) : null,
    ...audit.uncovered_files.map(file => createElement('div', { key: `uncovered-${file}`, style: metaLine },
      `未覆盖：${file}`)),
    ...(audit.dispositions ?? []).map(entry => createElement('div', { key: `disposition-${entry.issue_key}`, style: metaLine },
      `人工确认误报：${entry.issue_key} · ${entry.reason} · ${entry.approved_at}`)),
    audit.findings.length === 0
      ? createElement('p', { style: metaLine }, '没有新增代码问题。')
      : createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        ...audit.findings.map(finding => createElement('div', { key: finding.key, style: {
          ...itemRow, padding: '6px 0', fontSize: 12, overflowWrap: 'anywhere',
        } },
        createElement('div', { style: headerRow },
          createElement('strong', null, finding.severity),
          createElement('code', null, finding.rule),
          createElement('span', null, `${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}`)),
        createElement('span', null, finding.message)))))
}

export function TaskLedger({ workspace, remote }: {
  workspace: string
  remote: TaskEngineRemote
}): ReturnType<typeof createElement> {
  const [tasks, setTasks] = useState<TaskLedgerEntry[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [risk, setRisk] = useState('all')
  const [stage, setStage] = useState('all')

  const refresh = useCallback(() => {
    if (workspace === '') return
    setError('')
    setLoading(true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('读取超时，请刷新页面或重新登录后重试')), 15_000)
    })
    void Promise.race([remote.readTasks(workspace), timeout]).then((result) => {
      setLoading(false)
      if (result.ok) setTasks(result.value.tasks)
      else setError('读取台账失败：' + describeError(result.error))
    }, (reason: unknown) => {
      setLoading(false)
      setError('读取台账失败：' + describeError(reason))
    }).finally(() => { if (timer !== undefined) clearTimeout(timer) })
  }, [remote, workspace])

  useEffect(() => { refresh() }, [refresh])

  const visible = tasks.filter(task => `${task.task_id} ${task.title} ${task.branch}`.toLowerCase().includes(query.toLowerCase()) && (risk === 'all' || task.risk_level === risk) && (stage === 'all' || task.stage === stage))
  return createElement('div', { style: styles.section },
    createElement('div', { className: 'te-toolbar' },
      createElement('input', { className: 'te-input', placeholder: '搜索任务、标题或分支', value: query, onChange: (e: { target: HTMLInputElement }) => setQuery(e.target.value) }),
      createElement('select', { className: 'te-input', 'aria-label': '风险筛选', value: risk, onChange: (e: { target: HTMLSelectElement }) => setRisk(e.target.value) }, createElement('option', { value: 'all' }, '全部风险'), createElement('option', { value: 'standard' }, '标准'), createElement('option', { value: 'high_risk' }, '高风险')),
      createElement('select', { className: 'te-input', 'aria-label': '阶段筛选', value: stage, onChange: (e: { target: HTMLSelectElement }) => setStage(e.target.value) }, createElement('option', { value: 'all' }, '全部阶段'), ...Array.from(new Set(tasks.map(t => t.stage))).map(value => createElement('option', { key: value, value }, value))),
    ),
    createElement('div', { style: headerRow },
      createElement('span', { style: styles.bindingLabel }, '任务台账'),
      createElement('span', { style: styles.sourceBadge }, '只读 · 来自 .dsh/task-*.json'),
      createElement(Button, { variant: 'outline', size: 'sm', disabled: loading, onClick: refresh }, loading ? '读取中…' : '刷新'),
    ),
    loading ? createElement('p', { role: 'status' }, '正在读取任务…') : error !== ''
      ? createElement('p', { style: styles.status }, error)
      : tasks.length === 0
        ? createElement('p', { style: styles.muted }, '当前工作区还没有任务：开工后（dev_task create）会在这里列出实施与审查记录。')
        : visible.length === 0 ? createElement('div', { className: 'te-empty' }, '没有匹配的任务，请调整筛选。') : createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          ...visible.map(task => createElement('div', { key: task.task_id, style: card },
            createElement('div', { style: headerRow },
              createElement('span', { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, task.task_id),
              createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, task.title),
              createElement('span', { style: badge }, task.stage),
              task.complexity ? createElement('span', { style: badge }, `复杂度：${{ low: '低', medium: '中', high: '高', ultra: '超高' }[task.complexity] ?? task.complexity}`) : null,
              createElement('span', { style: badge }, task.branch),
              createElement('span', { className: 'te-badge', style: task.risk_level === 'high_risk' ? { color: 'var(--dsw-alias-state-error-primary)' } : {} }, task.risk_level === 'high_risk' ? '高风险' : '标准'),
              createElement('span', { className: 'te-badge' }, task.verification_passed ? '验证通过' : '待验证'),
              createElement('span', { className: 'te-badge' }, `审核：${task.review_outcome ?? 'pending'}`),
              task.updated_at ? createElement('span', { style: metaLine }, '更新于 ' + timeText(task.updated_at)) : null,
            ),
            sonarAudit(task),
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
