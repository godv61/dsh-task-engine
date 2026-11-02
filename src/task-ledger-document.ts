import type { TaskLedgerEntry } from './task-ledger-types.ts'
import { formatEastEightTime } from './time.ts'

export const requirementLabels = {
  clarifying: '待澄清',
  draft: '待整理',
  awaiting_confirmation: '待用户确认',
  confirmed: '用户已确认',
  changes_requested: '用户要求修改',
  stale: '内容已变化，需重新确认',
} as const
export function evidenceLabel(t: TaskLedgerEntry): string {
  return {
    valid: '测试回执有效',
    stale: '测试回执已过期',
    failed: '测试执行失败',
    blocked: '测试受环境阻塞',
    missing: '待运行测试',
    historical: t.verification_passed ? '交付时测试回执通过' : '交付时测试回执未通过',
    unknown: '测试回执有效性待确认',
  }[t.evidence_status ?? 'unknown']
}
export function reviewLabel(t: TaskLedgerEntry): string {
  return {
    valid: '审核通过 · 当前有效',
    stale: '审核已过期',
    missing: '待审核',
    blocked: '审核阻断',
    historical: `交付时审核：${t.review_outcome ?? '未记录'}`,
  }[t.review_status ?? 'missing']
}
export function lifecycleLabel(t: TaskLedgerEntry): string {
  return t.lifecycle === 'archived'
    ? '已归档'
    : t.lifecycle === 'ready_to_close'
      ? '待归档'
      : t.requirements && t.requirements.status !== 'confirmed'
        ? requirementLabels[t.requirements.status]
        : '进行中'
}
export const intentLabel = (t: TaskLedgerEntry): string =>
  t.delivery?.intent === 'analysis' ? '原因与方案' : '代码实施'
export function registeredFiles(t: TaskLedgerEntry): { path: string; owners: string[]; plannedOnly: boolean }[] {
  const scope = new Set(t.content?.files ?? [])
  return [...new Set([...scope, ...t.items.flatMap((i) => i.execution_plan?.files ?? [])])].sort().map((path) => ({
    path,
    owners: t.items.filter((i) => i.execution_plan?.files.includes(path)).map((i) => i.id),
    plannedOnly: !scope.has(path),
  }))
}
/** A read-only export of the same facts. This never creates another task or approval. */
export function taskDocument(t: TaskLedgerEntry): string {
  const r = t.requirements,
    c = t.content
  const sections = [
    `# ${t.task_id} · ${t.title}`,
    `状态：${lifecycleLabel(t)} · 当前阶段：${t.stage} · ${intentLabel(t)}`,
    `分支：${t.branch || '未记录'}\n\n更新：${t.updated_at ? formatEastEightTime(t.updated_at) : '未记录'}\n\n下一步：${t.next_action}`,
  ]
  if (r) {
    sections.push(
      `## 需求确认\n\n${requirementLabels[r.status]}${r.version ? ` · v${r.version}` : ''}\n\n${r.path ?? '尚未生成需求总结'}`,
    )
    if (r.confirmed_at) sections.push('用户确认于 ' + formatEastEightTime(r.confirmed_at))
    if (r.feedback) sections.push('用户意见：' + r.feedback)
  }
  for (const a of c?.artifacts ?? [])
    sections.push(`## ${a.name}\n\n` + a.fields.map((f) => `### ${f.label}\n\n${f.value}`).join('\n\n'))
  if (!c?.artifacts.length && r?.content) sections.push('## 需求总结正文\n\n' + r.content)
  if (r?.materials?.length)
    sections.push(
      '## 确认材料\n\n' +
        r.materials
          .map((m) => `- ${m.name} · v${m.version}${m.retired_at ? ' · 已停用' : ''} · ${m.path}\n  SHA-256：${m.hash}`)
          .join('\n'),
    )
  if (t.delivery?.result) {
    const a = t.delivery.result
    sections.push(
      `## 分析结论\n\n${a.conclusion}\n\n## 修复建议\n\n${a.proposal}\n\n未确认：${a.limitations.join('；') || '无额外说明'}`,
    )
  }
  sections.push(
    '## 实施计划\n\n' +
      (t.items.length
        ? t.items
            .map((i) => {
              const p = i.execution_plan
              return (
                `### ${i.id} · ${i.title}\n\n状态：${i.status === 'done' ? '已完成' : i.status === 'doing' ? '进行中' : '待开始'}` +
                (p
                  ? `\n\n执行：${p.mode === 'direct' ? '主会话' : '子代理'} · ${p.reason}\n\n依赖：${p.depends_on.join('、') || '无'}\n\n文件：${p.files.join('、')}\n\n验收：${p.acceptance.map((value) => '- ' + value).join('\n')}\n\n审核：${p.review === 'independent' ? '独立只读审核' : '主会话审核'} · ${p.review_reason}`
                  : '\n\n尚未登记执行计划。') +
                (i.review ? `\n\n规格：${i.review.spec.outcome} · 质量：${i.review.quality.outcome}` : '')
              )
            })
            .join('\n\n')
        : t.delivery?.intent === 'analysis'
          ? '分析任务，不包含代码实施。'
          : '尚未登记实施项。'),
  )
  sections.push(
    '## 登记文件范围\n\n登记范围和执行计划不代表实际 Git 变更。\n\n' +
      (registeredFiles(t)
        .map(
          (f) =>
            `- ${f.path}${f.plannedOnly ? '（仅执行计划）' : ''}${f.owners.length ? ' · ' + f.owners.join('、') : ''}`,
        )
        .join('\n') || '尚未登记。'),
  )
  if (c?.verification_inputs.length)
    sections.push(
      '## 验证输入\n\n这些是测试输入，不自动代表本任务修改文件。\n\n' +
        c.verification_inputs
          .map((g) => `### ${g.group_id}\n\n${g.files.map((f) => '- ' + f).join('\n')}`)
          .join('\n\n'),
    )
  if (t.delivery?.intent !== 'analysis')
    sections.push(
      `## 验证与审核\n\n${evidenceLabel(t)}\n\n${reviewLabel(t)}\n\n测试回执仅证明测试执行结果，不代表业务需求已经验收。`,
      ...(t.verification_groups ?? []).map(
        (g) =>
          `### ${g.id}\n\n状态：${g.status} · 测试数：${g.test_count ?? '未识别'}\n\n命令：${g.command}${g.problems.length ? '\n\n' + g.problems.join('\n') : ''}`,
      ),
    )
  if (t.sonar?.audit)
    sections.push(
      `## SonarQube 审核记录\n\n原始结果：${t.sonar.audit.gate} · 时间：${formatEastEightTime(t.sonar.audit.checked_at)}\n\n报告：${t.sonar.audit.report_path ?? '未记录'}\n\n这是该次扫描记录；当前有效性以上方门禁状态为准。`,
    )
  sections.push(`---\n来源：${c?.ledger_path ?? '任务台账'}\n\n本文为台账的只读导出，不创建新的需求批准或交付验收。`)
  return sections.join('\n\n') + '\n'
}
