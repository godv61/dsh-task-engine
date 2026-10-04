/** Human-readable, credential-free record of one SonarQube review run. */
import { localReviewGate, unresolvedBlockingFindings, type SonarAudit, type SonarPolicy } from './sonar.ts'

function line(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\r\n]+/gu, ' ').replaceAll('`', '\\`').replaceAll('|', '\\|')
}

export function sonarReportPath(taskId: string, audit: SonarAudit): string {
  const stamp = audit.checked_at.replace(/[^A-Za-z0-9-]/gu, '-')
  return `.dsh/reviews/${taskId}/${stamp}-${audit.analysis_id.slice(0, 8)}.md`
}

export function renderSonarReport(taskId: string, policy: SonarPolicy, audit: SonarAudit): string {
  const blocked = new Set(audit.blocking.map(finding => finding.key))
  const rows = [
    `# SonarQube 代码审核：${line(taskId)}`,
    '',
    `- 时间：${line(audit.checked_at)}`,
    `- 来源：${line(policy.source ?? 'ci')}`,
    `- 项目 Key：${line(policy.project_key)}`,
    `- 分析目标：${line(audit.target)}`,
    `- 本次结论：${line(audit.gate)}`,
    `- 问题：${audit.findings.length} 条；阻断：${audit.blocking.length} 条`,
    ...(policy.source === 'ide-local' ? [
      `- 人工复核后的任务门禁：${localReviewGate(audit)}；未解决阻断：${unresolvedBlockingFindings(audit).length} 条`,
    ] : []),
    `- 本地审核范围：${policy.include_paths?.length ? policy.include_paths.map(line).join('、') : '任务登记的全部代码文件'}`,
    '',
    '## 本次分析的文件',
    '',
    ...(audit.scanned_files?.length ? audit.scanned_files.map(file => `- ${line(file)}`) : ['- 由 CI 或服务端分析范围决定']),
    '',
    '## 未覆盖的文件',
    '',
    ...(audit.uncovered_files?.length ? audit.uncovered_files.map(file => `- ${line(file)}`) : ['- 无']),
    '',
    '## 新代码问题',
    '',
    ...(audit.findings.length ? audit.findings.map((finding, index) =>
      `${index + 1}. ${blocked.has(finding.key) ? '**阻断** ' : ''}${line(finding.severity)} · ${line(finding.rule)} · ${line(finding.file)}${finding.line === undefined ? '' : `:${finding.line}`}\n   ${line(finding.message)}（${line(finding.key)}）`)
      : ['- 无']),
    '',
    '## 逐项误报复核',
    '',
    ...(audit.dispositions?.length ? audit.dispositions.flatMap(entry => [
      `- ${line(entry.issue_key)} · ${line(entry.kind)} · 批准于 ${line(entry.approved_at)}`,
      `  - 原因：${line(entry.reason)}`,
      ...entry.evidence.map(value => `  - 证据：${line(value)}`),
    ]) : ['- 无']),
    '',
    '本报告记录一次审核；代码或规则变化后请重新测试并审核。Token 不写入报告。',
    '',
  ]
  return rows.join('\n')
}
