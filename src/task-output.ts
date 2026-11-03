/** Compact model-facing views. Persisted evidence remains complete and unchanged. */
import type { TaskItem, TaskState, VerificationReceipt } from './engine.ts'
import { hashText } from './snapshot.ts'
import { latestGroupRun } from './verification-state.ts'

function excerpt(value: string, limit = 400): string {
  return value.length <= limit ? value : value.slice(0, limit) + '… [details available]'
}

export function receiptView(receipt: VerificationReceipt | undefined, failed = false): unknown {
  if (!receipt) return undefined
  const { stdout, stderr, ...facts } = receipt
  return { ...facts, output: { stdout_characters: stdout.length, stderr_characters: stderr.length,
    ...(failed ? { stdout_tail: stdout.slice(-1800), stderr_tail: stderr.slice(-1200) } : {}) } }
}

export function verificationView(state: TaskState, detail = false): unknown {
  if (detail) return state.verification
  const receipt = state.verification.receipt
  return { ...state.verification, evidence: state.verification.evidence.map(value => excerpt(value)),
    receipt: receiptView(receipt, !!receipt && (receipt.exit_code !== 0 || receipt.timed_out || receipt.aborted
      || receipt.scope_changed_during_run === true || !(Number(receipt.test_summary?.count) > 0))) }
}

function itemView(item: TaskItem): unknown {
  const { execution_plan: plan, dispatch, review, independent_review: independent, ...rest } = item
  const { dispatch_history: _history, independent_review_history: _reviews, ...identity } = rest
  return { ...identity,
    ...(plan ? { execution_plan: { ...plan, files: undefined, file_count: plan.files.length,
      acceptance: undefined, acceptance_count: plan.acceptance.length,
      reason: excerpt(plan.reason) } } : {}),
    ...(dispatch ? { dispatch: { execution: dispatch.execution, status: dispatch.status, run_id: dispatch.run_id,
      at: dispatch.at, error: dispatch.error, description: excerpt(dispatch.description),
      ...(dispatch.output ? { output_available: true, output_characters: dispatch.output.length } : {}) } } : {}),
    ...(review ? { review: { ...review, verification_key: undefined,
      ...(review.verification_key ? { verification_key_hash: hashText(review.verification_key) } : {}),
      spec: { outcome: review.spec.outcome, note_count: review.spec.notes?.length ?? 0 },
      quality: { outcome: review.quality.outcome, note_count: review.quality.notes?.length ?? 0 } } } : {}),
    ...(independent ? { independent_review: { status: independent.status, run_id: independent.run_id,
      at: independent.at, spec: independent.spec, quality: independent.quality } } : {}) }
}

/** Call only after computing gates from the original state, never from this view. */
export function statusView(value: Record<string, any>, state: TaskState, detail = false,
  selection?: { section?: 'items' | 'verification' | 'artifacts' | 'bindings' | 'sonar' | undefined; itemId?: string | undefined; groupId?: string | undefined }): Record<string, unknown> {
  if (detail && selection?.section) {
    const section = selection.section
    const identity = { id: state.id, stage: state.stage, section }
    if (section === 'items') return { ...identity, items: selection.itemId ? state.items.filter(item => item.id === selection.itemId) : state.items }
    if (section === 'verification') return selection.groupId
      ? { ...identity, verification_group: selection.groupId, group: state.verification_groups?.[selection.groupId], latest_run: latestGroupRun(state, selection.groupId) }
      : { ...identity, verification: state.verification, verification_groups: state.verification_groups, verification_runs: state.verification_runs }
    return { ...identity, [section]: value[section] }
  }
  if (detail) return value
  const skillResults = Object.fromEntries(Object.entries(state.skill_results ?? {}).map(([stage, results]) => [stage,
    Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { ...result,
      evidence: result.evidence.map(text => excerpt(text)), receipt: receiptView(result.receipt, result.receipt?.exit_code !== 0) }]))]))
  const latestRuns = new Set(Object.keys(state.verification_groups ?? {}).map(id => latestGroupRun(state, id)?.id))
  return { ...value, items: state.items.map(itemView), verification: verificationView(state), skill_results: skillResults,
    review: { ...state.review, verification_key: undefined,
      ...(state.review.verification_key ? { verification_key_hash: hashText(state.review.verification_key) } : {}) },
    verification_runs: value.verification_runs?.filter((run: { id: string }) => latestRuns.has(run.id)),
    verification_history_count: state.verification_runs?.length ?? 0,
    ...(value.verification_planning ? { verification_planning: { ...value.verification_planning,
      groups: Object.fromEntries(Object.entries(state.verification_groups ?? {}).map(([id, group]) => [id,
        { ...group, files: undefined, file_count: group.files.length, key: undefined, plan_hash: hashText(group.key) }])) } } : {}),
    artifacts: Object.fromEntries(Object.entries(state.artifacts).map(([id, fields]) => [id,
      Object.fromEntries(Object.entries(fields).map(([name, body]) => [name, excerpt(body)]))])),
    ...(value.sonar?.audit ? { sonar: { ...value.sonar, audit: { gate: value.sonar.audit.gate,
      checked_at: value.sonar.audit.checked_at, report_path: value.sonar.audit.report_path,
      blocking_count: value.sonar.audit.blocking?.length ?? 0, findings_count: value.sonar.audit.findings?.length ?? 0 } } } : {}),
    details: { operation: 'status', task_id: state.id, detail: true,
      sections: ['items', 'verification', 'artifacts', 'bindings', 'sonar'],
      instruction: 'Request detail=true with section and optional item_id/verification_group for only the needed detail. Use load_skill for current bound Skill/Rule instructions.' } }
}
