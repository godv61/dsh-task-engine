/**
 * Config-driven engineering workflow engine — pure and harness-free.
 *
 * `legalTargets`, `assertAdvance`, `validateCommitMessage`, and
 * `commitCheckpoint` are pure functions over a `WorkflowConfig` and a `TaskState`.
 * They hold every hard gate the `dev_task` tool exposes, so the state machine is
 * unit-testable without a harness and the same code enforces the process whatever
 * config (stage graph, guards, commit policy) a project supplies.
 *
 * @module dsh-task-engine/engine
 */

import type { ProjectType } from './project.ts'

export type WorkSize = 'tiny' | 'standard' | 'complex'
export type RiskLevel = 'standard' | 'high_risk'
export type ItemStatus = 'todo' | 'doing' | 'done'

/** Guard names the engine resolves natively. Opaque names are config errors. */
export type GuardName =
  | 'requirement_confirmation'
  | 'solution_confirmation'
  | 'todos_done'
  | 'verified'
  | 'review_passed'
  | 'artifacts_present'

/** One allowed stage transition and the guards that must already hold. */
export interface Transition {
  from: string
  to: string
  requires?: GuardName[]
}

/** A stage-owned artifact: the `record` operation writes it, `artifacts_present` checks it. */
export interface ArtifactDef {
  /** Stage that owns this artifact (checked against the state's current stage). */
  stage: string
  /** Stable id the `record` operation writes under (unique per stage). */
  id: string
  /** Human-readable name surfaced in errors. */
  name: string
  /** Non-empty field keys; `artifacts_present` requires each to hold a non-empty value. */
  fields: string[]
}

/** Commit policy and message shape. Empty `message_pattern` disables format checking. */
export interface CommitRule {
  policy: 'task' | 'item' | 'manual'
  message_pattern: string
  message_hint: string
  /** Stages at which a commit checkpoint sits (a commit is due before leaving these). */
  checkpoints: string[]
  /** When true (default), a commit may only touch files listed in the task's `files`. */
  file_scope: boolean
}

/** Skills and rules a stage pins for progressive disclosure when the task enters it. */
export interface StageBinding {
  /** Skill names to load for this stage (resolved through the DSH skill registry). */
  skills?: string[]
  /** Rule names to read for this stage (resolved under the configured rule roots). */
  rules?: string[]
}

export interface WorkflowConfig {
  stages: string[]
  start_stage: string
  transitions: Transition[]
  /** Artifacts each stage must record before its `artifacts_present` guard passes. */
  artifacts: ArtifactDef[]
  commit: CommitRule
  /** A high_risk task cannot cross an edge guarded by `verified` without passing evidence. */
  high_risk_requires_verification: boolean
  /** Per-stage skill/rule bindings disclosed when the task enters the stage. */
  stage_bindings?: Record<string, StageBinding>
}

/**
 * A task's frozen workflow: the preset id, its version, and the complete
 * resolved config at create time. The task's `status`/`advance`/`verify`/
 * `review`/`commit` re-read this snapshot instead of re-interpreting the
 * project's current `.dsh/eng.json`, so a later config change cannot drift an
 * in-flight task's gates.
 */
export interface FlowSnapshot {
  flow: string
  version: number
  config: WorkflowConfig
  /** SHA-256 of the canonical JSON of `config`; a mismatch proves the snapshot was edited after creation. Absent on pre-0.22 records. */
  hash?: string
}

/** One delegated implementation unit: a subagent fetch plus its two-stage review. */
export interface ItemDispatch {
  /** Subagent task description (the `description` passed to the `subagent` tool). */
  description: string
  /** ISO-8601 timestamp when the subagent was dispatched. */
  at: string
}

/** Verdict of one review stage over a completed item. */
export interface ItemReviewStage {
  outcome: 'pass' | 'fail'
  /** Key findings: what passed or the defect list when `outcome` is `fail`. */
  notes?: string[]
}

/** Two-stage review of an item: specification conformance then code quality. */
export interface ItemReview {
  /** Stage one: the implementation did the right scope (specification conformance). */
  spec: ItemReviewStage
  /** Stage two: the code meets quality conventions (boundary, error, naming). */
  quality: ItemReviewStage
}

export interface TaskItem {
  id: string
  title: string
  status: ItemStatus
  /** Agent-reported dispatch intent, not independent proof that a subagent ran. */
  dispatch?: ItemDispatch
  /** Audit trail: the two-stage review verdicts over the completed item. */
  review?: ItemReview
}

/** A verification receipt from a real command execution, never a model claim. */
export interface VerificationReceipt {
  /** The command that ran. */
  command: string
  /** Exit code; -1 encodes a signal-killed run (no usable exit code). */
  exit_code: number
  /** True when the executor's timeout was the first cause to cut the command short. */
  timed_out: boolean
  /** True when the caller's cancellation aborted the command. */
  aborted: boolean
  /** ISO timestamp when the run began. */
  started_at: string
  /** ISO timestamp when the run settled. */
  finished_at: string
  /** Absolute project root the command ran in; binds the receipt to the task's workspace. */
  root?: string
  /** Captured stdout tail. */
  stdout: string
  /** Captured stderr tail. */
  stderr: string
  sandbox?: { mode: string; denied: boolean; enforcement?: string; runnerFailed?: boolean }
  /** Fingerprint of declared task files after validation; code edits invalidate the receipt. */
  scope_hash?: string
}

export interface TaskState {
  schema: 1
  id: string
  title: string
  branch: string
  work_size: WorkSize
  risk_level: RiskLevel
  /** Frozen workflow captured at create time; gates re-read this, not the live config. Absent on pre-snapshot task records. */
  flow?: FlowSnapshot
  stage: string
  requirement_confirmed: boolean
  solution_confirmed: boolean
  items: TaskItem[]
  verification: { passed: boolean; evidence: string[]; receipt?: VerificationReceipt }
  review: { outcome: 'pending' | 'pass' | 'blocked' }
  /** Recorded artifacts (artifact id -> field -> value). */
  artifacts: Record<string, Record<string, string>>
  /** Repo-relative paths this task may touch (checked by the file-scope commit gate). */
  files: string[]
  commits: { label: string; hash?: string }[]
  /** Absolute project root recorded at create time; receipts bind to it and writes may not escape it. Absent on pre-0.21 records. */
  root?: string
  /** Language stack detected at create time. Absent on pre-0.21 records. */
  project_type?: ProjectType
  /** Audit trail of risk changes; a high_risk → standard downgrade only appears here after human approval. Absent on pre-0.22 records. */
  risk_downgrades?: { from: string; to: string; at: string }[]
  /** Fingerprint of the bundled rules at create time; a drift on disclosure means the shipped rules changed since this task froze. Absent on pre-0.22 records. */
  bindings_fingerprint?: string
  /** Monotonic record revision; every write must compare-and-swap on it so concurrent agents cannot silently overwrite each other. Absent on pre-0.23 records (treated as 0). */
  revision?: number
  /** Time of the latest successful tool write, absent on older records. */
  updated_at?: string
  /** New tasks enforce skill evidence and checkpoint completion; old snapshots remain readable. */
  execution_version?: 1
  skill_results?: Record<string, Record<string, { session_id: string; load_call_id: string; evidence: string[]; receipt?: VerificationReceipt }>>
}

export interface Result {
  ok: boolean
  errors?: string[]
}

/** The full guard vocabulary. Unknown guard names are configuration errors. */
const GUARD_NAMES: readonly GuardName[] = [
  'requirement_confirmation',
  'solution_confirmation',
  'todos_done',
  'verified',
  'review_passed',
  'artifacts_present',
]

/**
 * Validate a merged workflow for structural soundness.
 *
 * Returns one human-readable problem per defect, or an empty list when the
 * config can drive the state machine. This is what makes a hand-edited
 * `.dsh/eng.json` fail loudly instead of driving gates that reference stages
 * or guards that do not exist.
 * @param config - the merged workflow to check.
 * @returns problem strings; empty means valid.
 */
export function validateWorkflow(config: WorkflowConfig): string[] {
  const problems: string[] = []
  if (config.stages.length === 0) problems.push('stages must not be empty')
  const seen = new Set<string>()
  for (const stage of config.stages) {
    if (seen.has(stage)) problems.push(`duplicate stage "${stage}"`)
    seen.add(stage)
  }
  if (!config.stages.includes(config.start_stage)) {
    problems.push(`start_stage "${config.start_stage}" is not in stages`)
  }
  const edges = new Set<string>()
  config.transitions.forEach((transition, index) => {
    if (!config.stages.includes(transition.from)) {
      problems.push(`transition ${index + 1}: from "${transition.from}" is not a stage`)
    }
    if (!config.stages.includes(transition.to)) {
      problems.push(`transition ${index + 1}: to "${transition.to}" is not a stage`)
    }
    const edge = `${transition.from}->${transition.to}`
    if (edges.has(edge)) problems.push(`duplicate transition "${edge}"`)
    edges.add(edge)
    for (const guard of transition.requires ?? []) {
      if (!GUARD_NAMES.includes(guard)) {
        problems.push(`transition ${index + 1}: unknown guard "${String(guard)}"`)
      }
    }
  })
  const artifactKeys = new Set<string>()
  config.artifacts.forEach((artifact, index) => {
    if (!config.stages.includes(artifact.stage)) {
      problems.push(`artifact ${index + 1}: stage "${artifact.stage}" is not a stage`)
    }
    const key = artifact.id
    // Artifact ids must be unique across ALL stages, not just within a stage:
    // `state.artifacts` is keyed by id, so two stages sharing an id would let a
    // later stage silently reuse an earlier stage's recorded values.
    if (artifactKeys.has(key)) problems.push(`duplicate artifact id "${key}" (ids are unique across all stages)`)
    artifactKeys.add(key)
    if (artifact.fields.length === 0) {
      problems.push(`artifact ${index + 1} ("${artifact.id}"): fields must not be empty`)
    }
    const fieldSet = new Set<string>()
    for (const field of artifact.fields) {
      if (fieldSet.has(field)) {
        problems.push(`artifact ${index + 1} ("${artifact.id}"): duplicate field "${field}"`)
      }
      fieldSet.add(field)
    }
  })
  const bindings = config.stage_bindings ?? {}
  for (const [stage, binding] of Object.entries(bindings)) {
    if (!config.stages.includes(stage)) {
      problems.push(`stage_bindings: stage "${stage}" is not a stage`)
    }
    for (const skill of binding.skills ?? []) {
      if (typeof skill !== 'string' || skill.trim() === '') {
        problems.push(`stage_bindings "${stage}": empty skill name`)
      }
    }
    for (const rule of binding.rules ?? []) {
      if (typeof rule !== 'string' || rule.trim() === '') {
        problems.push(`stage_bindings "${stage}": empty rule name`)
      }
    }
  }
  if (!['task', 'item', 'manual'].includes(config.commit.policy)) {
    problems.push(`commit.policy "${config.commit.policy}" is not task|item|manual`)
  }
  for (const checkpoint of config.commit.checkpoints) {
    if (!config.stages.includes(checkpoint)) {
      problems.push(`commit.checkpoint "${checkpoint}" is not a stage`)
    }
  }
  if (config.commit.message_pattern !== '') {
    try {
      new RegExp(config.commit.message_pattern)
    } catch {
      problems.push('commit.message_pattern is not a valid regular expression')
    }
  }
  return problems
}

function requireKnownStage(stage: string, config: WorkflowConfig): Result {
  if (!config.stages.includes(stage)) {
    return { ok: false, errors: [`unknown stage "${stage}"`] }
  }
  return { ok: true }
}

/** Artifacts a stage owns; `artifacts_present` checks these against the recorded values. */
export function artifactsForStage(stage: string, config: WorkflowConfig): ArtifactDef[] {
  return config.artifacts.filter(artifact => artifact.stage === stage)
}

/** Skills and rules a stage pins, or undefined when the stage declares none. */
export function bindingsForStage(stage: string, config: WorkflowConfig): StageBinding | undefined {
  return config.stage_bindings?.[stage]
}

/** Target stages reachable from `stage` via a configured transition. */
export function legalTargets(stage: string, config: WorkflowConfig): string[] {
  return config.transitions
    .filter(transition => transition.from === stage)
    .map(transition => transition.to)
}

/** The edge from `from` to `to`, or undefined when not configured. */
export function findTransition(from: string, to: string, config: WorkflowConfig): Transition | undefined {
  return config.transitions.find(transition => transition.from === from && transition.to === to)
}

/**
 * Structural explanation of a failing `todos_done` gate: which items block it
 * and why. Empty means the gate passes. A `done` item must also carry a
 * two-stage review whose both stages passed, so the implementation and its
 * audit trail are completed together.
 */
export function todosBlockers(state: TaskState): string[] {
  if (state.items.length === 0) return ['no implementation items']
  const blockers: string[] = []
  for (const item of state.items) {
    if (item.status !== 'done') {
      blockers.push(`item "${item.id}" is ${item.status}`)
      continue
    }
    if (item.review === undefined) {
      blockers.push(`item "${item.id}" is done but has no two-stage review`)
      continue
    }
    if (item.review.spec.outcome !== 'pass') blockers.push(`item "${item.id}" spec review is not pass`)
    if (item.review.quality.outcome !== 'pass') blockers.push(`item "${item.id}" quality review is not pass`)
  }
  return blockers
}

function guardSatisfied(guard: GuardName, state: TaskState, config: WorkflowConfig): boolean {
  switch (guard) {
    case 'requirement_confirmation':
      return state.requirement_confirmed
    case 'solution_confirmation':
      return state.solution_confirmed
    case 'todos_done':
      return todosBlockers(state).length === 0
    case 'verified': {
      if (!state.verification.passed) return false
      if (config.high_risk_requires_verification && state.risk_level === 'high_risk') {
        // A high-risk task's `verified` gate demands a real command receipt, not
        // a model-declared pass: the receipt must come from a run that exited 0
        // and was neither timed out nor aborted.
        const receipt = state.verification.receipt
        return receipt !== undefined && receipt.exit_code === 0 && !receipt.timed_out && !receipt.aborted
      }
      return true
    }
    case 'review_passed':
      return state.review.outcome === 'pass'
    case 'artifacts_present': {
      const required = artifactsForStage(state.stage, config)
      return required.every(artifact => {
        const recorded = state.artifacts[artifact.id]
        if (recorded === undefined) return false
        return artifact.fields.every(field => recorded[field] !== undefined && recorded[field].trim() !== '')
      })
    }
  }
}

/**
 * Validate an advance from `state.stage` to `targetStage`.
 *
 * Returns `{ ok: false, errors }` when the target is unknown, the edge is not
 * configured, or any declared guard is unmet. This is the hard transition gate:
 * the tool rejects rather than degrades.
 */
export function assertAdvance(state: TaskState, targetStage: string, config: WorkflowConfig): Result {
  const known = requireKnownStage(targetStage, config)
  if (!known.ok) return known

  const transition = findTransition(state.stage, targetStage, config)
  if (!transition) {
    return {
      ok: false,
      errors: [`no transition from "${state.stage}" to "${targetStage}"` +
        ` (legal: ${legalTargets(state.stage, config).join(', ') || 'none'})`],
    }
  }

  const unmet = (transition.requires ?? []).filter(guard => !guardSatisfied(guard, state, config))
  if (unmet.length > 0) {
    const details = unmet.map(guard => {
      if (guard === 'todos_done') return `todos_done (${todosBlockers(state).join('; ')})`
      return guard
    })
    return { ok: false, errors: [`guards unmet: ${details.join(', ')}`] }
  }
  if (state.execution_version === 1 && config.commit.policy !== 'manual'
    && config.commit.checkpoints.includes(state.stage)
    && !state.commits.some(commit => commit.label === 'TASK' && commit.hash)) {
    return { ok: false, errors: ['commit required before leaving this checkpoint: call commit, perform the approved git commit, then record its hash'] }
  }
  return { ok: true }
}

/**
 * Structured unmet guards for the edge from `state.stage` to `targetStage`,
 * resolved only when the edge exists. Empty when the target is unknown or the
 * edge is not configured (in which case {@link assertAdvance} reports its own
 * error). Lets the tool split confirmation gates (approved by a human) from the
 * rest (which the task record must satisfy before any ask).
 */
export function unmetGuards(state: TaskState, targetStage: string, config: WorkflowConfig): GuardName[] {
  const transition = findTransition(state.stage, targetStage, config)
  if (!transition) return []
  return (transition.requires ?? []).filter(guard => !guardSatisfied(guard, state, config))
}

/** Validate a commit summary against the configured message pattern. */
export function validateCommitMessage(message: string, config: WorkflowConfig): Result {
  if (config.commit.message_pattern === '') return { ok: true }
  const re = new RegExp(config.commit.message_pattern)
  if (re.test(message)) return { ok: true }
  return {
    ok: false,
    errors: [`commit summary "${message}" does not match ${config.commit.message_hint}`],
  }
}

/**
 * Extract the task id from a commit summary. The first capture group of the
 * message pattern is the task id by convention (`【<task_id>】【T1】…`). Returns
 * `undefined` when the flow declares no pattern (so the summary carries no
 * canonical id) or the summary does not match. The commit-msg hook uses the id
 * to locate the exact task instead of guessing by branch.
 */
export function taskIdFromMessage(message: string, config: WorkflowConfig): string | undefined {
  if (config.commit.message_pattern === '') return undefined
  const match = new RegExp(config.commit.message_pattern).exec(message)
  return match?.[1]
}

export interface CommitCheckpoint {
  allowed: boolean
  label?: string
  reason?: string
}

/**
 * Decide whether the current task state permits a commit and with what label.
 *
 * `manual` never auto-commits. `task` allows a single `TASK` at a checkpoint
 * stage. `item` allows `T<n>` commits mid-flow and a closing `TASK` at a
 * checkpoint. A stage only permits a commit once its outgoing guards already
 * hold, so the engine cannot be asked to commit before its own state is valid.
 */
export function commitCheckpoint(state: TaskState, config: WorkflowConfig): CommitCheckpoint {
  const { policy, checkpoints } = config.commit
  if (policy === 'manual') {
    return { allowed: false, reason: 'commit policy is manual — await an explicit user instruction' }
  }

  if (checkpoints.includes(state.stage)) {
    const ready = config.transitions
      .filter(transition => transition.from === state.stage)
      .every(transition => (transition.requires ?? []).every(g => guardSatisfied(g, state, config)))
    if (!ready) {
      return { allowed: false, reason: 'checkpoint stage reached but its outgoing guards are unmet' }
    }
    return { allowed: true, label: 'TASK' }
  }

  if (policy === 'item') {
    const done = state.items.filter(item => item.status === 'done').length
    if (done > 0) {
      return { allowed: true, label: `T${done}` }
    }
  }

  return { allowed: false, reason: 'no commit is due at this stage under the current policy' }
}

export interface FileScopeResult {
  ok: boolean
  /** Paths outside the declared scope (present only when the scope is set but violated). */
  outside: string[]
  /** True when the task declared no `files` at all (file_scope on). */
  noScope: boolean
}

/**
 * Check a commit's file set against the task's declared scope. No-op when
 * `file_scope` is off; an empty declared scope refuses every commit (the task
 * must first declare what it may touch).
 */
/**
 * Engine bookkeeping files that travel with the branch as team-shared facts
 * (`.dsh/task-*.json`, `.dsh/eng.json`). They are metadata, not deliverables,
 * so the file-scope gate never counts them as out-of-scope.
 */
function isEngineMeta(file: string): boolean {
  return /^\.dsh\/(task-[^/]+\.json|eng\.json)$/.test(file)
}

export function checkFileScope(state: TaskState, committing: string[], config: WorkflowConfig): FileScopeResult {
  if (!config.commit.file_scope) return { ok: true, outside: [], noScope: false }
  if (state.files.length === 0) return { ok: false, outside: [], noScope: true }
  const outside = committing.filter(file => !state.files.includes(file) && !isEngineMeta(file))
  return outside.length === 0
    ? { ok: true, outside: [], noScope: false }
    : { ok: false, outside, noScope: false }
}

/** A fresh task pinned to its frozen workflow's start stage. */
export function newTask(input: {
  id: string
  title: string
  branch: string
  work_size: WorkSize
  risk_level: RiskLevel
  flow: FlowSnapshot
  root?: string
  project_type?: ProjectType
}): TaskState {
  return {
    schema: 1,
    id: input.id,
    title: input.title,
    branch: input.branch,
    work_size: input.work_size,
    risk_level: input.risk_level,
    flow: input.flow,
    stage: input.flow.config.start_stage,
    requirement_confirmed: false,
    solution_confirmed: false,
    items: [],
    verification: { passed: false, evidence: [] },
    review: { outcome: 'pending' },
    artifacts: {},
    files: [],
    commits: [],
    revision: 1,
    ...(input.root !== undefined ? { root: input.root } : {}),
    ...(input.project_type !== undefined ? { project_type: input.project_type } : {}),
  }
}
