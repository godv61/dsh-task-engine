/**
 * The "任务台账 (tasks)" tab of the workbench: a read-only audit view of
 * every task record under the workspace's `.dsh/`. Each task shows its stage,
 * and each implementation item shows its start record plus the
 * two-stage (specification / quality) review verdicts. This is the visible
 * mirror of the implementation/review audit the `dev_task` tool records — no editing.
 *
 * @module dsh-task-engine/TaskLedger
 */

import { createElement, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { styles } from './styles.ts'
import { describeError } from './shared.ts'
import type { TaskEngineRemote, TaskLedgerEntry, TaskLedgerItem } from './TaskEngineSection.ts'
import { formatEastEightTime } from '../time.ts'
import { validReviewPolicy } from '../reviewer-spec.ts'

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
  return formatEastEightTime(at)
}

function metricsText(m: import('../delivery-contract.ts').RunMetrics): string {
  return `${Math.round(m.elapsed_ms / 1000)} 秒 · 工具 ${m.tool_calls ?? '未知'} 次 · 错误 ${m.errors ?? '未知'} 次 · 输入 ${m.input_tokens ?? '未知'} / 缓存输入 ${m.cached_input_tokens ?? '未知'} / 输出 ${m.output_tokens ?? '未知'} token`
}

/** Read-only run status remains visible even if the parent's next model request fails. */
function deliveryDetails(task: TaskLedgerEntry): ReturnType<typeof createElement> | null {
  const delivery = task.delivery
  if (!delivery) return null
  const labels = { queued: '排队', starting: '启动中', running: '调查中', returned: '已返回', failed: '失败' }
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    createElement('div', { style: metaLine }, delivery.intent === 'analysis' ? '分析与方案 · 业务代码只读' : '代码实施 · 项目门禁生效', ' · ' + delivery.reason),
    delivery.metrics ? createElement('div', { style: metaLine }, '主会话 · ' + metricsText(delivery.metrics), '（截至接受交付；子代理单列，耗时不相加）') : null,
    ...delivery.runs.map(run => createElement('details', { key: run.id, style: itemRow },
      createElement('summary', null, `${run.question.id} · ${labels[run.status]}${run.acceptance === 'pending_parent' ? ' · 待主会话核对' : run.acceptance === 'used_in_delivery' ? ' · 证据已用于交付' : run.acceptance === 'not_used' ? ' · 未用于最终证据' : ''} · ${run.question.question}`),
      createElement('div', { style: metaLine }, `运行 ${run.run_id ?? run.id} · ${timeText(run.started_at ?? run.at)}`),
      run.metrics ? createElement('div', { style: metaLine }, metricsText(run.metrics)) : null,
      run.report ? createElement('div', { style: { whiteSpace: 'pre-wrap', fontSize: 12 } }, run.report.summary, '\n未确认：' + (run.report.limitations.join('；') || '无额外说明')) : null,
      run.error ? createElement('div', { role: 'alert' }, run.error) : null)),
    delivery.result ? createElement('details', null, createElement('summary', null, '已交付的分析结论与方案'),
      createElement('div', { style: { whiteSpace: 'pre-wrap' } }, delivery.result.conclusion, '\n\n', delivery.result.proposal,
        '\n未确认：' + (delivery.result.limitations.join('；') || '无额外说明')),
      ...delivery.result.evidence.map((e, i) => createElement('details', { key: i, style: { fontSize: 12, overflowWrap: 'anywhere' } },
        createElement('summary', null, `${e.file}:${e.start_line}–${e.end_line} · ${e.range_hash ? '交付时行段快照' : '历史源码引文'}`),
        createElement('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, e.quote),
        e.highlight ? createElement('div', null, '引用高亮：', e.highlight) : null,
        createElement('div', { style: metaLine }, `文件 SHA-256：${e.content_hash}`, e.range_hash ? `行段 SHA-256：${e.range_hash}` : '')))) : null)
}

/** Render one item's start record and two-stage review (when present). */
function itemAudit(item: TaskLedgerItem): ReturnType<typeof createElement> {
  const lines: Array<ReturnType<typeof createElement>> = []
  const executionLabel = (mode: string): string => ({ direct: '主会话执行', spawn: '子代理执行（独立上下文）', fork: '子代理执行（继承会话历史）', unknown: '未记录（旧记录）' })[mode] ?? mode
  const statusLabel = (status?: string): string => ({ starting: '启动中', running: '运行中', completed: '已结束', failed: '失败' })[status ?? ''] ?? '未启动'
  if (item.execution_plan) {
    const plan = item.execution_plan
    for (const change of plan.changes ?? []) lines.push(createElement('div', { key: `change-${change.path}`, style: metaLine },
      `计划${change.kind === 'rename' ? '重命名' : '删除'}：${change.path}${change.to ? ` → ${change.to}` : ''}；审核需读取变更前快照。`))
    lines.push(createElement('div', { key: 'plan', style: metaLine }, `计划方式：${executionLabel(plan.mode)} · ${plan.requested === 'auto' ? '自动选择' : '指定方式'}`),
      createElement('div', { key: 'reason', style: metaLine }, `选择原因：${plan.reason}`),
      createElement('div', { key: 'review-plan', style: metaLine }, `审核方式：${plan.review === 'independent' ? '独立审核子代理' : '主会话审核'} · ${plan.review_reason}`))
    if (plan.depends_on.length) lines.push(createElement('div', { key: 'deps', style: metaLine }, `前置实施项：${plan.depends_on.join('、')}`))
  }
  if (item.independent_review) {
    const review = item.independent_review
    lines.push(createElement('details', { key: 'independent-review' },
      createElement('summary', null, `独立审核 · ${statusLabel(review.status)}${review.spec ? ` · 规格${review.spec === 'pass' ? '通过' : '不通过'}` : ''}${review.quality ? ` · 质量${review.quality === 'pass' ? '通过' : '不通过'}` : ''} · ${review.run_id ?? '等待运行 ID'}`),
      createElement('p', { style: metaLine }, validReviewPolicy(review.policy, review.run_id) ? '只读限制已验证' : '尚无有效只读限制回执'),
      review.metrics ? createElement('p', { style: metaLine }, metricsText(review.metrics)) : null,
      review.read_files?.length ? createElement('p', { style: metaLine }, `${review.read_coverage ? '全文行内容已核对' : '路径读取记录（未核对全文）'}：${review.read_files.join('、')}`) : null,
      createElement('pre', { style: { whiteSpace: 'pre-wrap' } }, review.output ?? ''),
      review.error ? createElement('p', { role: 'alert' }, review.error) : null))
  }
  if (item.dispatch_history?.length) lines.push(createElement('details', { key: 'dispatch-history' },
    createElement('summary', null, `历史委派（${item.dispatch_history.length}）`),
    ...item.dispatch_history.map((entry, index) => createElement('p', { key: index }, `${entry.provider ?? 'direct'} · ${entry.run_id ?? ''} · ${entry.status ?? ''} · ${timeText(entry.at)}`))))
  if (item.dispatch !== undefined) {
    if (item.dispatch.run_id) lines.push(createElement('details', { key: 'child' },
      createElement('summary', null, `${executionLabel(item.dispatch.provider ?? 'spawn')} · ${statusLabel(item.dispatch.status)} · ${item.dispatch.run_id}`),
      item.dispatch.metrics ? createElement('p', { style: metaLine }, metricsText(item.dispatch.metrics)) : null,
      createElement('pre', { style: { whiteSpace: 'pre-wrap' } }, item.dispatch.output ?? ''),
      item.dispatch.error ? createElement('p', { role: 'alert' }, item.dispatch.error) : null))
    lines.push(createElement('div', { key: 'dispatch', style: metaLine },
      createElement('span', { style: badge }, `实际方式：${executionLabel(item.dispatch.execution ?? item.dispatch.provider ?? 'unknown')}`),
      createElement('details', null, createElement('summary', { style: { cursor: 'pointer' } }, '实施说明'),
        createElement('p', { style: { whiteSpace: 'pre-wrap' } }, item.dispatch.description === '' ? '（无描述）' : item.dispatch.description)),
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
      `最近一次 SonarQube 审核：${outcome} · 问题总数 ${audit.findings.length} 条 · 原始阻断 ${audit.blocking_count} 条 · 未解决阻断 ${unresolved} 条 · ${timeText(audit.checked_at)}`),
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
      `人工确认误报：${entry.issue_key} · ${entry.reason} · ${timeText(entry.approved_at)}`)),
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
  const [recordErrors, setRecordErrors] = useState<{ file: string; message: string }[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const epoch = useRef(0)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [risk, setRisk] = useState('all')
  const [stage, setStage] = useState('all')
  const [lifecycle, setLifecycle] = useState('open')

  const refresh = useCallback(() => {
    if (workspace === '') return
    const requestEpoch = ++epoch.current
    setLoadingMore(false)
    setError('')
    setLoading(true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('读取超时，请刷新页面或重新登录后重试')), 15_000)
    })
    // DSH validates positional arity before decoding optional values. An empty
    // cursor explicitly requests the first page and survives JSON transport.
    void Promise.race([remote.readTasks(workspace, ''), timeout]).then((result) => {
      if (requestEpoch !== epoch.current) return
      setLoading(false)
      if (result.ok) { setTasks(result.value.tasks); setRecordErrors(result.value.errors ?? []); setCursor(result.value.next_cursor); setTotal(result.value.total_count ?? result.value.tasks.length) }
      else setError('读取台账失败：' + describeError(result.error))
    }, (reason: unknown) => {
      if (requestEpoch !== epoch.current) return
      setLoading(false)
      setError('读取台账失败：' + describeError(reason))
    }).finally(() => { if (timer !== undefined) clearTimeout(timer) })
  }, [remote, workspace])

  useEffect(() => { refresh(); return () => { epoch.current++ } }, [refresh])
  const loadMore = async (): Promise<void> => {
    if (!cursor || loadingMore) return
    const requestEpoch = epoch.current
    setLoadingMore(true)
    try {
      const result = await remote.readTasks(workspace, cursor)
      if (requestEpoch !== epoch.current) return
      if (!result.ok) throw new Error(describeError(result.error))
      setTasks(previous => [...new Map([...previous, ...result.value.tasks].map(task => [task.task_id, task])).values()])
      setRecordErrors(previous => [...previous, ...(result.value.errors ?? [])])
      setCursor(result.value.next_cursor)
      setTotal(result.value.total_count ?? total)
    } catch (error) { if (requestEpoch === epoch.current) setError(describeError(error)) }
    finally { if (requestEpoch === epoch.current) setLoadingMore(false) }
  }

  const visible = tasks.filter(task => `${task.task_id} ${task.title} ${task.branch}`.toLowerCase().includes(query.toLowerCase()) && (risk === 'all' || task.risk_level === risk) && (stage === 'all' || task.stage === stage) && (lifecycle === 'all' || (lifecycle === 'archived' ? task.lifecycle === 'archived' : task.lifecycle !== 'archived')))
  const archivedCount = tasks.filter(task => task.lifecycle === 'archived').length
  const activeCount = tasks.filter(task => task.lifecycle === 'active').length
  const readyCount = tasks.filter(task => task.lifecycle === 'ready_to_close').length
  visible.sort((left, right) => (right.updated_at ?? right.completed_at ?? '').localeCompare(left.updated_at ?? left.completed_at ?? ''))
  return createElement('div', { style: styles.section },
    createElement('div', { className: 'te-toolbar' },
      createElement('input', { className: 'te-input', placeholder: '搜索任务、标题或分支', value: query, onChange: (e: { target: HTMLInputElement }) => setQuery(e.target.value) }),
      createElement('select', { className: 'te-input', 'aria-label': '任务状态筛选', value: lifecycle, onChange: (e: { target: HTMLSelectElement }) => setLifecycle(e.target.value) },
        createElement('option', { value: 'open' }, '进行中 / 待归档'),
        createElement('option', { value: 'archived' }, '已归档 (' + archivedCount + ')'),
        createElement('option', { value: 'all' }, '全部任务')),
      createElement('select', { className: 'te-input', 'aria-label': '风险筛选', value: risk, onChange: (e: { target: HTMLSelectElement }) => setRisk(e.target.value) }, createElement('option', { value: 'all' }, '全部风险'), createElement('option', { value: 'standard' }, '标准'), createElement('option', { value: 'high_risk' }, '高风险')),
      createElement('select', { className: 'te-input', 'aria-label': '阶段筛选', value: stage, onChange: (e: { target: HTMLSelectElement }) => setStage(e.target.value) }, createElement('option', { value: 'all' }, '全部阶段'), ...Array.from(new Set(tasks.map(t => t.stage))).map(value => createElement('option', { key: value, value }, value))),
    ),
    createElement('div', { style: headerRow },
      createElement('span', { style: styles.bindingLabel }, '任务台账'),
      createElement('span', { style: metaLine }, '已载入任务：进行中 ' + activeCount + ' · 待归档 ' + readyCount + ' · 已归档 ' + archivedCount),
      createElement('span', { style: styles.sourceBadge }, '只读 · 来自 .dsh/task-*.json'),
      createElement(Button, { variant: 'outline', size: 'sm', disabled: loading, onClick: refresh }, loading ? '读取中…' : '刷新'),
    ),
    cursor ? createElement('div', { style: headerRow },
      createElement('span', null, `目录共 ${total} 条记录；筛选仅针对已载入任务。`),
      createElement(Button, { variant: 'outline', size: 'sm', disabled: loading || loadingMore, onClick: () => { void loadMore() } }, loadingMore ? '读取中…' : '加载更多')) : null,
    recordErrors.length ? createElement('div', { role: 'alert' }, ...recordErrors.map(entry =>
      createElement('p', { key: entry.file }, `${entry.file}：${entry.message}`))) : null,
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
              task.delivery ? createElement('span', { style: badge }, task.delivery.intent === 'analysis' ? '原因与方案' : '代码实施') : null,
              createElement('span', { style: { ...badge, fontWeight: 600 } }, task.lifecycle === 'archived' ? '已归档' : task.lifecycle === 'ready_to_close' ? '待归档' : '进行中'),
              task.complexity ? createElement('span', { style: badge }, `复杂度：${{ low: '低', medium: '中', high: '高', ultra: '超高' }[task.complexity] ?? task.complexity}`) : null,
              createElement('span', { style: badge }, task.branch),
              createElement('span', { className: 'te-badge', style: task.risk_level === 'high_risk' ? { color: 'var(--dsw-alias-state-error-primary)' } : {} }, task.risk_level === 'high_risk' ? '高风险' : '标准'),
              task.delivery?.intent === 'analysis' ? null : createElement('span', { className: 'te-badge' }, task.evidence_status
                ? ({ valid: '测试回执有效', stale: '测试回执已过期', failed: '测试执行失败', blocked: '测试受环境阻塞', missing: '待运行测试', historical: task.verification_passed ? '交付时测试回执有效' : '交付时测试回执未通过', unknown: '测试回执有效性待确认' })[task.evidence_status]
                : task.verification_passed ? '历史测试回执通过' : '待运行测试'),
              task.delivery?.intent === 'analysis' ? null : createElement('span', { className: 'te-badge' }, task.review_status
                ? ({ valid: '审核通过 · 当前有效', stale: '审核已过期', missing: '待审核', blocked: '审核阻断', historical: `交付时审核：${task.review_outcome ?? 'pending'}` })[task.review_status]
                : `审核：${task.review_outcome ?? 'pending'}`),
              task.updated_at ? createElement('span', { style: metaLine }, '更新于 ' + timeText(task.updated_at)) : null,
            ),
            createElement('div', { style: metaLine }, (task.delivery?.intent === 'analysis' ? '分析交付' : '实施项 ' + task.items_done + '/' + task.items.length) + ' · 下一步：' + task.next_action,
              task.completed_at ? ' · 归档于 ' + timeText(task.completed_at) : '',
              task.related_task ? ' · 关联 ' + task.related_task.kind + '：' + task.related_task.id : ''),
            sonarAudit(task),
            deliveryDetails(task),
            task.requirements ? createElement('details', { style: { fontSize: 13 } },
              createElement('summary', null, `需求总结 · ${{ clarifying: '待澄清', draft: '待整理', awaiting_confirmation: '待用户确认', confirmed: '用户已确认', changes_requested: '用户要求修改', stale: '文档已变化，需重新确认' }[task.requirements.status]}${task.requirements.version ? ` · v${task.requirements.version}` : ''}`),
              createElement('div', { style: metaLine }, task.requirements.path ?? '尚未生成文档',
                task.requirements.confirmed_at ? ' · 确认于 ' + timeText(task.requirements.confirmed_at) : '',
                task.requirements.pending_questions ? ` · ${task.requirements.pending_questions} 个问题待回答` : ''),
              task.requirements.feedback ? createElement('p', null, '用户意见：', task.requirements.feedback) : null,
              task.requirements.content ? createElement('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, task.requirements.content) : null) : null,
            task.verification_groups?.length ? createElement('details', { style: metaLine },
              createElement('summary', { style: { cursor: 'pointer' } }, `测试分组（${task.verification_groups.length}）`),
              createElement('span', null, '回执证明测试程序已执行并产生通过结果；需求覆盖与验收结论见逐项审核。'),
              ...task.verification_groups.map(group => createElement('div', { key: group.id, style: itemRow },
                createElement('span', null, `${group.id} · ${{ passed: '通过', failed: '失败', blocked: '环境阻塞', stale: '证据已过期', missing: '待运行' }[group.status]} · 测试数 ${group.test_count ?? '未识别'}${group.checked_at ? ' · ' + timeText(group.checked_at) : ''}`),
                createElement('code', null, group.command),
                ...group.problems.map(problem => createElement('span', { key: problem }, problem))))) : null,
            task.delivery?.intent === 'analysis' && !task.items.length ? null : createElement('details', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8 } },
              createElement('summary', { style: { cursor: 'pointer', fontSize: 13 } }, '实施项与审查记录（' + task.items.length + '）'),
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
