/** Named test groups and immutable command receipts. Coverage is declared and reviewed, never inferred from test counts. */
import type { TaskState, VerificationReceipt } from './engine.ts'
import { receiptHasRequiredTests } from './verification-tests.ts'

export interface VerificationGroup {
  id: string
  command: string
  /** Production, test and shared configuration inputs to this check. */
  files: string[]
  item_ids: string[]
  key: string
  at: string
}
export interface VerificationRun {
  id: string
  group_id?: string
  plan_key?: string
  files: string[]
  receipt: VerificationReceipt
  evidence: string[]
  passed: boolean
  invalidated_reason?: string
}
export interface VerificationGroupView {
  id: string
  command: string
  status: 'passed' | 'failed' | 'blocked' | 'stale' | 'missing'
  test_count: number | null
  checked_at?: string
  problems: string[]
}

export function receiptProblems(receipt: VerificationReceipt): string[] {
  const problems: string[] = []
  if (receipt.sandbox?.runnerFailed) problems.push('ENVIRONMENT_BLOCKED: sandbox runner could not start; inspect the executor diagnostic')
  else if (receipt.sandbox?.denied) problems.push('ENVIRONMENT_BLOCKED: sandbox denied this command; inspect the denied path and request only the exact necessary command if needed')
  else if (receipt.exit_code !== 0 && /Cannot create resource output directory|spawn EPERM|access (?:is )?denied|拒绝访问/iu.test(`${receipt.stdout}\n${receipt.stderr}`))
    problems.push('ENVIRONMENT_BLOCKED: filesystem or child-process access failed; do not repair permissions or widen the session automatically')
  if (receipt.timed_out) problems.push('TEST_TIMEOUT: command exceeded its execution limit')
  if (receipt.aborted) problems.push('TEST_CANCELLED: command did not finish')
  if (receipt.exit_code !== 0) problems.push(`TEST_COMMAND_FAILED: exit code ${receipt.exit_code}; inspect stdout/stderr before retrying`)
  if (receipt.scope_changed_during_run) problems.push('INPUTS_CHANGED: test inputs changed during execution; rerun on stable inputs')
  if (!receiptHasRequiredTests(receipt)) problems.push(receipt.test_summary?.count === 0
    ? 'NO_PASSING_TESTS: tests failed, were all skipped, or no tests ran'
    : 'NO_TEST_SUMMARY: no supported nonzero test summary; use a real runner such as node --test --test-reporter=tap, Maven test, or pytest. Do not print a synthetic count. On Windows, if Node child-process capture is denied, check whether --experimental-test-isolation=none is supported and suitable for this suite.')
  return problems
}

export function groupKey(group: Pick<VerificationGroup, 'id' | 'command' | 'files' | 'item_ids'>): string {
  return JSON.stringify([group.id, group.command, [...group.files].sort(), [...group.item_ids].sort()])
}

export function itemDependencies(state: TaskState, ids: string[]): string[] {
  const found = new Set(ids)
  for (const id of found) for (const dependency of state.items.find(item => item.id === id)?.execution_plan?.depends_on ?? []) found.add(dependency)
  return [...found]
}

/** Inputs of prerequisite implementation units are included conservatively. */
export function groupInputs(state: TaskState, group: VerificationGroup): string[] {
  const dependencies = itemDependencies(state, group.item_ids).filter(id => !group.item_ids.includes(id))
  return [...new Set([...group.files,
    ...state.items.filter(item => dependencies.includes(item.id)).flatMap(item => item.execution_plan?.files ?? state.files),
    ...Object.values(state.verification_groups ?? {}).filter(other => other.item_ids.some(id => dependencies.includes(id))).flatMap(other => other.files)])].sort()
}

export function groupPlanningBlockers(state: TaskState): string[] {
  if (!state.verification_version) return []
  const groups = Object.values(state.verification_groups ?? {})
  if (!groups.length) return ['plan_verification is required: declare command, files (implementation + tests + relevant configuration), and item_ids before dispatch or verify']
  const blockers = state.files.filter(file => !groups.some(group => group.files.includes(file)))
    .map(file => `test coverage is undeclared for ${file}; include it in a verification group`)
  for (const item of state.items) {
    const owned = groups.filter(group => group.item_ids.includes(item.id))
    if (!owned.length) blockers.push(`item ${item.id}: plan a verification group for the complete implementation + test unit; do not make its own tests depend on this item being done`)
    else for (const file of item.execution_plan?.files ?? []) if (!owned.some(group => group.files.includes(file))) blockers.push(`item ${item.id}: its required verification groups do not cover ${file}`)
    for (const group of owned) for (const file of group.files) {
      if (item.execution_plan?.files.includes(file)) continue
      const owners = state.items.filter(candidate => candidate.execution_plan?.files.includes(file))
      if (owners.length && owners.every(owner => owner.id !== item.id && itemDependencies(state, [owner.id]).includes(item.id)))
        blockers.push(`item ${item.id}: required check ${group.id} waits for downstream delivery ${file}; merge implementation and its necessary tests into a complete unit, or keep integration checks task-level with item_ids=[]`)
    }
  }
  return blockers
}

export function latestGroupRun(state: TaskState, id: string): VerificationRun | undefined {
  const runs = state.verification_runs ?? []
  for (let index = runs.length - 1; index >= 0; index--) if (runs[index]!.group_id === id) return runs[index]
  return undefined
}

export function requiredGroups(state: TaskState, itemId?: string): VerificationGroup[] {
  const ids = itemId === undefined ? undefined : itemDependencies(state, [itemId])
  return Object.values(state.verification_groups ?? {}).filter(group => !ids || group.item_ids.some(id => ids.includes(id)))
}

export function groupEvidenceBlockers(state: TaskState, hashes?: Record<string, string>, itemId?: string): string[] {
  const problems = groupPlanningBlockers(state)
  for (const group of requiredGroups(state, itemId)) {
    const run = latestGroupRun(state, group.id)
    if (!run) problems.push(`verification group ${group.id}: run verify verification_group=${group.id}`)
    else if (run.invalidated_reason) problems.push(`verification group ${group.id}: ${run.invalidated_reason}; rerun verify`)
    else if (run.plan_key !== group.key) problems.push(`verification group ${group.id}: plan changed; rerun verify`)
    else if (!run.passed || receiptProblems(run.receipt).length) problems.push(`verification group ${group.id}: latest run did not pass; ${receiptProblems(run.receipt).join('; ')}`)
    else if (hashes && run.receipt.scope_hash !== hashes[group.id]) problems.push(`verification group ${group.id}: stale (inputs changed); rerun verify verification_group=${group.id}`)
  }
  return problems
}

export function verificationGroupViews(state: TaskState, hashes?: Record<string, string>): VerificationGroupView[] {
  return Object.values(state.verification_groups ?? {}).map(group => {
    const run = latestGroupRun(state, group.id)
    const problems = !run ? [`VERIFICATION_MISSING: run verify verification_group=${group.id}`]
      : run.invalidated_reason ? [`VERIFICATION_STALE: ${run.invalidated_reason}; rerun verify verification_group=${group.id}`]
      : run.plan_key !== group.key ? [`VERIFICATION_STALE: test plan changed; rerun verify verification_group=${group.id}`]
      : receiptProblems(run.receipt)
    const status = !run ? 'missing' : run.invalidated_reason || run.plan_key !== group.key ? 'stale'
      : problems.some(problem => problem.startsWith('ENVIRONMENT_BLOCKED')) ? 'blocked'
      : !run.passed || problems.length ? 'failed' : hashes && run.receipt.scope_hash !== hashes[group.id] ? 'stale' : 'passed'
    if (status === 'stale' && !problems.length) problems.push(`VERIFICATION_STALE: inputs changed; rerun verify verification_group=${group.id}`)
    if (status === 'failed' && !problems.length) problems.push('VERIFICATION_FAILED: latest run did not pass; inspect its receipt and rerun')
    return { id: group.id, command: group.command, status, test_count: run?.receipt.test_summary?.count ?? null,
      ...(run ? { checked_at: run.receipt.finished_at } : {}), problems }
  })
}

export function verificationKey(state: TaskState, itemId?: string): string | undefined {
  if (!state.verification_version) return state.verification.receipt?.finished_at
  return JSON.stringify(requiredGroups(state, itemId).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(group => [group.id, group.key, latestGroupRun(state, group.id)?.id]))
}

export function verificationTime(state: TaskState, itemId?: string): string | undefined {
  if (!state.verification_version) return state.verification.receipt?.finished_at
  return requiredGroups(state, itemId).map(group => latestGroupRun(state, group.id)?.receipt.finished_at).filter((at): at is string => at !== undefined).sort().pop()
}

/** Preserve a legacy receipt before replacing it; never assign it retroactive group coverage. */
export function preserveVerification(state: TaskState): void {
  const receipt = state.verification.receipt
  if (!receipt || state.verification_runs?.some(run => run.receipt.finished_at === receipt.finished_at && run.receipt.command === receipt.command)) return
  ;(state.verification_runs ??= []).push({ id: `legacy:${receipt.finished_at ?? 'unknown'}:${state.verification_runs.length}`, files: [...state.files], receipt: structuredClone(receipt),
    evidence: [...state.verification.evidence], passed: state.verification.passed })
}

export function refreshVerification(state: TaskState, hashes: Record<string, string>, scope: string): string[] {
  const problems = groupEvidenceBlockers(state, hashes)
  state.verification.passed = problems.length === 0
  state.verification.scope_hash = scope
  state.verification.problems = problems
  return problems
}

/** A changed item also invalidates downstream consumers; unknown scope remains task-wide. */
export function affectedItems(state: TaskState, declared?: string[]): string[] {
  if (!declared?.length) return state.items.map(item => item.id)
  for (const id of declared) if (!state.items.some(item => item.id === id)) throw new Error(`unknown affected item ${id}`)
  const affected = new Set(declared)
  let changed = true
  while (changed) {
    changed = false
    for (const item of state.items) if (!affected.has(item.id) && item.execution_plan?.depends_on.some(id => affected.has(id))) { affected.add(item.id); changed = true }
    const files = state.items.filter(item => affected.has(item.id)).flatMap(item => item.execution_plan?.files ?? state.files)
    for (const item of state.items) if (!affected.has(item.id) && (item.execution_plan?.files ?? state.files).some(file => files.includes(file))) { affected.add(item.id); changed = true }
    for (const group of Object.values(state.verification_groups ?? {})) if (group.item_ids.some(id => affected.has(id)))
      for (const id of group.item_ids) if (!affected.has(id)) { affected.add(id); changed = true }
  }
  return [...affected]
}
