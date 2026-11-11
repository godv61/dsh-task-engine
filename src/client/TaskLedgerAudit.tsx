/**
 * The "任务台账 (tasks)" tab of the workbench: a read-only audit view of
 * every task record under the workspace's `.dsh/`. Each task shows its stage,
 * and each implementation item shows its start record plus the
 * two-stage (specification / quality) review verdicts. This is the visible
 * mirror of the implementation/review audit the `dev_task` tool records — no editing.
 *
 * @module dsh-task-engine/TaskLedger
 */

import { createElement, type CSSProperties } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskLedgerEntry, TaskLedgerItem } from './TaskEngineSection.ts'
import { formatEastEightTime } from '../time.ts'
import { validReviewPolicy } from '../reviewer-spec.ts'

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

function timeText(at: string): string {
  return formatEastEightTime(at)
}

function metricsText(m: import('../delivery-contract.ts').RunMetrics): string {
  return `${Math.round(m.elapsed_ms / 1000)} 秒 · 工具 ${m.tool_calls ?? '未知'} 次 · 错误 ${m.errors ?? '未知'} 次 · 输入 ${m.input_tokens ?? '未知'} / 缓存输入 ${m.cached_input_tokens ?? '未知'} / 输出 ${m.output_tokens ?? '未知'} token`
}

/** Read-only run status remains visible even if the parent's next model request fails. */
export function deliveryDetails(task: TaskLedgerEntry): ReturnType<typeof createElement> | null {
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
export function itemAudit(item: TaskLedgerItem): ReturnType<typeof createElement> {
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

export function sonarAudit(task: TaskLedgerEntry): ReturnType<typeof createElement> | null {
  if (!task.sonar) return null
  const audit = task.sonar.audit
  if (!audit) return createElement('div', { style: metaLine }, 'SonarQube 已启用，尚未运行代码审核。')
  const source = ({ 'ide-local': '本地规则审核', local: '本机上传扫描', ci: 'CI 扫描' } as Record<string, string>)[task.sonar.source] ?? task.sonar.source
  const reviewGate = audit.review_gate ?? audit.gate
  const outcome = reviewGate === 'NO_CHANGES' ? '无待扫描变更' : reviewGate === 'OK' ? '通过'
    : audit.uncovered_files.length ? '覆盖不足' : '未通过'
  const unresolved = audit.unresolved_count ?? audit.blocking_count
  return createElement('details', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8 } },
    createElement('summary', { style: { cursor: 'pointer', fontSize: 13 } },
      `最近一次 SonarQube 审核：${outcome} · 问题总数 ${audit.findings.length} 条 · 原始阻断 ${audit.blocking_count} 条 · 未解决阻断 ${unresolved} 条 · ${timeText(audit.checked_at)}`),
    createElement('p', { style: metaLine },
      `来源：${source}；分析目标：${audit.target}；原始结果：${audit.gate}。这是该次审核记录；代码或规则变更后需重新测试并审核。`),
    audit.report_path ? createElement('p', { style: metaLine }, `审核文件：${audit.report_path}`) : null,
    audit.scanned_files?.length ? createElement('details', null,
      createElement('summary', { style: { cursor: 'pointer', fontSize: 12 } }, `本次分析文件（${audit.scanned_files.length}）`),
      ...audit.scanned_files.map(file => createElement('div', { key: file, style: metaLine }, file)))
      : task.sonar.source === 'ide-local' && audit.scanned_files?.length === 0
        ? createElement('p', { style: metaLine }, '实际分析 0 个文件。') : null,
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
      ? (reviewGate === 'OK' ? createElement('p', { style: metaLine }, '没有新增代码问题。') : null)
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
