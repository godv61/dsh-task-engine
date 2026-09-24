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

/**
 * A resource reference that names where the resource lives.
 *
 * A bare name is ambiguous once project and user directories can both hold one:
 * `coding-conventions` in a project and `coding-conventions` in the user home are
 * different resources that happen to share a name, and a binding written as a
 * plain string cannot say which was meant. Every stored reference therefore
 * carries its source layer, and a legacy bare name is resolved by the documented
 * precedence and recorded as the layer it resolved to.
 */
export interface ResourceRef {
  /** Source layer the resource belongs to. */
  source: ResourceSource
  /** Resource name within that layer. */
  name: string
}

/** Where a skill or rule came from. `bundled` ships with the plugin. */
export type ResourceSource = 'bundled' | 'project' | 'user'

/** Render a reference as `source:name`, the form used in config and status output. */
export function formatResourceRef(ref: ResourceRef): string {
  return `${ref.source}:${ref.name}`
}

/**
 * Parse a `source:name` reference. Returns undefined for a bare name, which is
 * the legacy shape and must go through precedence resolution instead.
 * @param text - the stored reference text.
 * @returns the parsed reference, or undefined when it carries no source.
 */
export function parseResourceRef(text: string): ResourceRef | undefined {
  const match = /^(bundled|project|user):(.+)$/u.exec(text)
  if (match === null) return undefined
  return { source: match[1] as ResourceSource, name: match[2]! }
}

/**
 * One skill bound to a stage, with the complete list of rules that apply to it.
 *
 * Rules belong to the SKILL, not to the stage. A skill has exactly one rule list:
 * wherever that skill is bound, the same rules come with it. There is no
 * per-stage rule list, no inheritance from a stage or a preset, and no override
 * layer, because a stage-level list forced every reader to compute a merge before
 * knowing what actually applied, and made "which rules is this skill running
 * under?" unanswerable without inspecting the whole composition.
 *
 * To use one skill under two different rule sets, copy it into a distinct skill
 * and configure that one separately. Explicit duplication is easier to reason
 * about than an implicit inheritance chain, and it keeps the answer to the
 * question above local to the skill.
 */
export interface SkillBinding {
  /** The skill, named with its source layer. */
  skill: ResourceRef
  /** Rules this skill follows, each named with its source layer. */
  rules: ResourceRef[]
}

/**
 * What a stage binds for progressive disclosure when the task enters it.
 *
 * A stage selects skills only. Its rules are whatever those skills carry.
 */
export interface StageBinding {
  skills?: SkillBinding[]
  /**
   * Stage-level rule names from a pre-migration config, preserved verbatim.
   *
   * Rules used to belong to the stage, so a stage with several skills gave no
   * indication which skill a rule was meant for. Assigning them silently would
   * invent an answer the config never contained, and dropping them would remove a
   * constraint the user configured. They are therefore carried here unchanged:
   * still disclosed, still enforced — so nothing is lost — while the status output
   * names them as unassigned so a human can decide which skill each belongs to, or
   * split the skill if the answer differs per stage.
   */
  legacy_rules?: string[]
}

/**
 * How thoroughly a flow audits each implementation item.
 *
 * `two-stage` requires both a specification-conformance and a quality verdict per
 * item, which suits a full-development flow. `single` requires one combined
 * verdict, which is what a fast-change flow needs: the work still has to be
 * checked before it counts as done, but the same change is not re-reviewed twice
 * under two headings that a short change rarely distinguishes.
 */
export type ReviewDepth = 'two-stage' | 'single'

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
  /**
   * How much per-item review this flow demands before `todos_done` passes.
   *
   * The three presets differ in task complexity, not in how seriously they take
   * safety, so a lighter flow must be able to ask for a lighter audit rather than
   * inheriting the heaviest one. Omitting the field keeps the historical
   * behaviour (`two-stage`), so configs and frozen snapshots written before this
   * field existed read exactly as they did.
   */
  review_depth?: ReviewDepth
  /**
   * Whether finishing the task must include a recorded Git commit.
   *
   * A Git commit is one delivery mode, not a universal completion condition: a
   * non-code task or a project outside version control has nothing to commit.
   * Omitting the field keeps the historical behaviour (`true`), so existing
   * configs and frozen snapshots are unaffected.
   */
  commit_required?: boolean
  /**
   * Guards a flow requires to hold at COMPLETION, for stages that have no way out.
   *
   * A guard normally rides an edge: `代码审核 → 完成` requiring `review_passed` is how
   * the standard flow states that the review must pass before the end. But a flow
   * whose final stage is where the work happens has no such edge — the agile flow's
   * `审查` IS the review, and it is terminal. Hanging a review guard on `交付 → 审查`
   * would be circular (demanding the verdict before the stage that produces it) and
   * would also block the commit at `交付`, because a commit requires its stage's
   * outgoing guards.
   *
   * Declaring the requirement here lets completion check it directly and keeps the
   * statement next to the stage it describes, rather than hidden in edge order.
   */
  completion_guards?: GuardName[]
}

/**
 * A frozen copy of one resource's body, taken when the task was created.
 *
 * Names alone cannot keep an in-flight task stable: editing a skill or rule that
 * a running task uses would silently change what that task is doing. The body is
 * copied, and identical bodies are stored once and shared by content hash, so two
 * tasks using the same rule do not duplicate several kilobytes each.
 */
export interface FrozenResource {
  ref: ResourceRef
  /** SHA-256 of the body, which is also the key under which it is stored. */
  hash: string
  /** The body itself, so a deleted or edited source cannot change a running task. */
  content: string
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
  /**
   * The skill and rule bodies this task actually resolved, captured at creation.
   * Absent on records written before resource freezing; those fall back to live
   * resolution.
   */
  resources?: FrozenResource[]
}

/** One delegated implementation unit: a subagent fetch plus its two-stage review. */
export interface ItemDispatch {
  /** Subagent task description (the `description` passed to the `subagent` tool). */
  description: string
  /** ISO-8601 timestamp when the subagent was dispatched. */
  at: string
}

/**
 * Explicit task completion, recorded once every configured condition holds.
 *
 * Reaching the last configured stage is not the same fact as finishing the work,
 * and conflating them let a flow whose final stage is also its commit checkpoint
 * arrive at that stage with no delivery record at all: the "commit before leaving
 * a checkpoint" rule fires on the way OUT of a stage, and a terminal stage has no
 * way out. Completion is therefore its own recorded event, checked by the engine,
 * so every preset ends through the same lifecycle regardless of how few working
 * stages it has.
 */
export interface TaskCompletion {
  /** ISO-8601 timestamp of the completion call. */
  at: string
  /** The commit recorded at completion, when the flow's delivery mode requires one. */
  commit_hash?: string
}

/**
 * A recorded rework: why the task went back, and exactly what that invalidated.
 *
 * The graph only has forward edges, but the work does not: a requirement can
 * change after implementation started, and a defect can be found during review.
 * Before this existed, the only way back was a hand-edited record, which left
 * every downstream conclusion nominally intact — a confirmation, verification
 * receipt or review verdict that described a superseded tree would still read as
 * passing.
 *
 * The invalidated set is computed from the DECLARED kind rather than from a
 * blanket rule, because the two cases differ: a changed requirement invalidates
 * the requirement confirmation and everything downstream of it, while fixing a
 * defect found in review invalidates the verification and review of that work but
 * leaves the agreed requirement standing. Invalidating everything on every
 * rework would be simpler and would also throw away conclusions that are still
 * true, forcing work to be redone for no reason.
 */
export interface TaskRevision {
  /** What kind of change this was; decides the invalidation scope. */
  kind: 'requirement' | 'solution' | 'defect'
  /** Why the task went back, in the author's words. */
  reason: string
  /** The stage the task returned to. */
  to: string
  /** The stage it was at when the rework was recorded. */
  from: string
  /** ISO-8601 timestamp. */
  at: string
  /** Conclusion names this rework invalidated, for audit. */
  invalidated: string[]
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
  /** Set by the `complete` operation once every configured condition holds. Absent while the task is still open. */
  completed?: TaskCompletion
  /** Rework history, newest last. Absent when the task never went back. */
  revisions?: TaskRevision[]
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
    // A skill carries its own rules, so each binding is checked as a unit: an
    // empty skill reference or a malformed rule reference is reported with the
    // skill it belongs to, which is where the user has to fix it.
    for (const [index, entry] of (binding.skills ?? []).entries()) {
      if (typeof entry?.skill?.name !== 'string' || entry.skill.name.trim() === '') {
        problems.push(`stage_bindings "${stage}": skill ${index + 1} has no name`)
        continue
      }
      if (!['bundled', 'project', 'user'].includes(entry.skill.source)) {
        problems.push(`stage_bindings "${stage}": skill "${entry.skill.name}" has unknown source "${String(entry.skill.source)}"`)
      }
      for (const rule of entry.rules ?? []) {
        if (typeof rule?.name !== 'string' || rule.name.trim() === '') {
          problems.push(`stage_bindings "${stage}": skill "${entry.skill.name}" has a rule with no name`)
          continue
        }
        if (!['bundled', 'project', 'user'].includes(rule.source)) {
          problems.push(`stage_bindings "${stage}": skill "${entry.skill.name}" rule "${rule.name}" has unknown source "${String(rule.source)}"`)
        }
      }
    }
    // Stage-level rules exist only as a migration state: they are disclosed and
    // enforced, but they are not a feature. Reporting them keeps the pending
    // decision visible instead of letting it settle into a permanent dual model.
    if ((binding.legacy_rules ?? []).length > 0) {
      problems.push(`stage_bindings "${stage}": ${binding.legacy_rules!.length} legacy stage-level rule(s) are unassigned and still in force; assign each to the skill that should carry it`)
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
  // An unrecognised depth would silently fall back to the heaviest one, hiding a
  // typo behind stricter-than-intended behaviour.
  if (config.review_depth !== undefined && config.review_depth !== 'two-stage' && config.review_depth !== 'single') {
    problems.push(`review_depth "${String(config.review_depth)}" is not one of: two-stage, single`)
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
export function todosBlockers(state: TaskState, config?: WorkflowConfig): string[] {
  if (state.items.length === 0) return ['no implementation items']
  const depth = config?.review_depth ?? 'two-stage'
  const blockers: string[] = []
  for (const item of state.items) {
    if (item.status !== 'done') {
      blockers.push(`item "${item.id}" is ${item.status}`)
      continue
    }
    if (item.review === undefined) {
      // Every depth still requires the item to have been reviewed: a lighter flow
      // checks less per change, it does not skip checking. Only the number of
      // required verdicts differs.
      blockers.push(`item "${item.id}" is done but has no review`)
      continue
    }
    if (item.review.spec?.outcome !== 'pass') blockers.push(`item "${item.id}" spec review is not pass`)
    // `quality` is read defensively: a record written under a lighter depth, or an
    // older snapshot, may carry only the specification verdict. Requiring the
    // field to exist would crash on such a record instead of reporting it.
    if (depth === 'two-stage' && item.review.quality?.outcome !== 'pass') {
      blockers.push(`item "${item.id}" quality review is not pass`)
    }
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
      return todosBlockers(state, config).length === 0
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
      if (guard === 'todos_done') return `todos_done (${todosBlockers(state, config).join('; ')})`
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
 * Whether this task's flow ever demands a passing verification.
 *
 * A preset that never guards an edge on `verified` is telling the engine that
 * verification is not one of its completion conditions, so a downstream stage
 * must not invent the requirement.
 * @param config - the frozen workflow config.
 * @returns true when any configured transition requires `verified`.
 */
export function flowRequiresVerification(config: WorkflowConfig): boolean {
  return config.transitions.some(transition => (transition.requires ?? []).includes('verified'))
}

/**
 * Stages where a passing verification must still HOLD, derived from the graph.
 *
 * `verified` guards the edge INTO a stage, so the requirement follows the task
 * past that edge rather than applying from the start: a task sitting at 需求评审
 * has produced nothing to verify. Once a task has crossed a `verified` edge,
 * though, the requirement stays with it — that is the case the old code missed,
 * where re-verifying and failing let the task continue and commit.
 *
 * Computed by walking forward from every `verified` edge's target, so it is a
 * property of the configured graph rather than a hardcoded stage name.
 * @param config - the frozen workflow config.
 * @returns the set of stages at or after a verification gate.
 */
export function verificationHeldStages(config: WorkflowConfig): Set<string> {
  const held = new Set<string>()
  const queue = config.transitions
    .filter(transition => (transition.requires ?? []).includes('verified'))
    .map(transition => transition.to)
  while (queue.length > 0) {
    const stage = queue.shift()!
    if (held.has(stage)) continue
    held.add(stage)
    for (const transition of config.transitions) {
      if (transition.from === stage && !held.has(transition.to)) queue.push(transition.to)
    }
  }
  return held
}

/**
 * Why the current state fails the flow's verification requirement, if it does.
 *
 * Applies only once the task has reached a stage that sits at or after a
 * verification gate, so it never fires on a task that has not yet had anything
 * to verify. Completion and commit share this rule, which is what stops a failed
 * re-verification from being outrun by advancing to a stage whose own outgoing
 * edge happens not to repeat the guard.
 * @param state - the task state.
 * @param config - the frozen workflow config.
 * @returns human-readable blockers; empty when the requirement does not apply or holds.
 */
export function verificationBlockers(state: TaskState, config: WorkflowConfig): string[] {
  if (state.execution_version !== 1) return []
  if (!verificationHeldStages(config).has(state.stage)) return []
  const blockers: string[] = []
  if (!state.verification.passed) {
    blockers.push('this flow requires a passing verification at this stage, and the current verification is not passing')
  }
  if (config.high_risk_requires_verification && state.risk_level === 'high_risk') {
    const receipt = state.verification.receipt
    if (receipt === undefined) {
      blockers.push('a high-risk task needs a real command receipt, and none is recorded')
    } else if (receipt.exit_code !== 0 || receipt.timed_out || receipt.aborted) {
      blockers.push('a high-risk task needs a command that exited 0 without timing out or aborting')
    }
  }
  return blockers
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

  // A flow that requires verification requires it HERE, wherever "here" is. The
  // outgoing-guard check below only sees the current stage's edges, so a task
  // that re-verified and failed could reach a stage whose edge does not repeat
  // `verified` and be authorized anyway. Completion and commit share this rule.
  const verification = verificationBlockers(state, config)
  if (verification.length > 0) {
    return { allowed: false, reason: verification.join('; ') }
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

/**
 * Whether a stage is terminal in the configured graph (no outgoing transition).
 * @param stage - the stage to test.
 * @param config - the frozen workflow config.
 * @returns true when nothing follows this stage.
 */
export function isTerminalStage(stage: string, config: WorkflowConfig): boolean {
  return !config.transitions.some(transition => transition.from === stage)
}

/**
 * Whether the delivery mode requires a recorded commit before completion.
 * @param config - the frozen workflow config.
 * @returns true when a commit must be recorded (the historical default).
 */
export function commitRequired(config: WorkflowConfig): boolean {
  return config.commit_required ?? true
}

/**
 * Every reason the task may not be marked complete.
 *
 * Completion is its own fact, checked here rather than inferred from standing on
 * the last stage. Three things can hold it back: the task has not reached a
 * terminal stage, the flow's own `todos_done` conditions are unmet, or the
 * delivery mode wants a commit that is not recorded. Deliberately NOT included:
 * a blanket demand for a commit on every flow, because a commit is one delivery
 * mode rather than a universal finish line.
 * @param state - the task state.
 * @param config - the frozen workflow config.
 * @returns human-readable blockers; empty when the task may complete.
 */
/**
 * Configurations a stage needs but that cannot be resolved.
 *
 * Disclosure is not enforcement. `missing_rules` was reported in status and never
 * blocked anything, so deleting a rule a stage was bound to still let the task
 * advance — leaving a stage running without the constraints it was configured
 * with, while the record looked fine.
 *
 * This is a pure decision over names, so the tool and the hook reach the same
 * verdict from the same inputs. It takes the unresolved names rather than reading
 * anything, because resolution needs a filesystem and this must stay callable from
 * both planes.
 * @param unresolved - references that resolved nowhere, as `source:name` or a bare legacy name.
 * @param stage - the stage whose configuration is being checked.
 * @returns one blocker per unresolved resource, empty when the stage is complete.
 */
export function resourceBlockers(unresolved: readonly string[], stage: string): string[] {
  return unresolved.map(name =>
    `${stage}: "${name}" is bound here but resolves nowhere — a stage cannot be completed without the rules it was configured with. `
    + 'Restore the file, point the binding at the right layer, or remove the binding. If this task was created before resource freezing, its snapshot is absent and it must read live files.')
}

/**
 * The outcomes a flow's FINAL stage is required to have, derived from its guards.
 *
 * Completion used to check only standing-on-a-final-stage, unfinished items and
 * whether a commit existed. A flow that declares `review_passed` or `verified` on
 * its way into the terminal stage was therefore satisfiable by ARRIVING there: the
 * agile flow's review verdict and the standard flow's verification could both be
 * failing while `complete` succeeded.
 *
 * Derived rather than hardcoded, because a flow that declares no verification gate
 * must not be made to demand one — the requirement is whatever the flow said.
 * @param config - the effective workflow.
 * @returns the guard names the final stage's incoming edges require.
 */
export function terminalRequirements(config: WorkflowConfig): GuardName[] {
  const terminals = new Set(config.stages.filter(stage => isTerminalStage(stage, config)))
  const required = new Set<GuardName>(config.completion_guards ?? [])
  for (const transition of config.transitions) {
    if (!terminals.has(transition.to)) continue
    for (const guard of transition.requires ?? []) required.add(guard)
  }
  return [...required]
}

export function completionBlockers(state: TaskState, config: WorkflowConfig): string[] {
  const blockers: string[] = []
  if (state.completed !== undefined) return []
  if (!isTerminalStage(state.stage, config)) {
    blockers.push(`task is at "${state.stage}", which is not a final stage; advance to one of: ${config.stages.filter(s => isTerminalStage(s, config)).join(', ')}`)
  }
  for (const guard of new Set(config.transitions.flatMap(transition => transition.requires ?? []))) {
    // Only conditions that describe the finished work. Confirmation guards are
    // per-edge approvals and are already enforced on the way through.
    if (guard === 'todos_done') {
      const unmet = todosBlockers(state, config)
      if (unmet.length > 0) blockers.push(`implementation items are not finished: ${unmet.join('; ')}`)
    }
  }
  // The final stage's own incoming guards. Reaching the last stage is not the same
  // as having satisfied what the flow said that stage means: a declared review or
  // verification must actually hold, not merely have been arrived at. Derived from
  // the flow, so a flow that declares no verification gate is not made to demand
  // one. Confirmation guards are excluded — they are per-edge human approvals
  // already recorded on the way through, and re-asking would demand a second
  // approval for the same decision.
  const requirements = terminalRequirements(config).filter(guard => guard !== 'requirement_confirmation' && guard !== 'solution_confirmation')
  // Read defensively: a record written before this field existed, or built by a
// caller that never ran a review, has no verdict to read — which is not a passing
// one. Treating "no review recorded" as absent rather than crashing keeps the gate
// honest and the function total.
  const reviewOutcome = state.review?.outcome
  if (requirements.includes('review_passed') && reviewOutcome !== 'pass') {
    blockers.push(`this flow requires a passing review before completion, and the recorded review is "${reviewOutcome ?? 'none'}"`)
  }
  if (requirements.includes('verified') && state.verification?.passed !== true) {
    blockers.push('this flow requires a passing verification before completion, and the recorded verification is not passing')
  }
  if (commitRequired(config)) {
    const hasCommit = state.commits.some(commit => commit.hash !== undefined)
    if (!hasCommit) blockers.push('this flow requires a recorded commit before completion, and none is recorded')
  }
  return blockers
}

/**
 * Which recorded conclusions a rework of the given kind invalidates.
 *
 * Derived from what each kind of change actually supersedes:
 *
 * - `requirement`: the agreed requirement changed, so its confirmation no longer
 *   speaks for the work, and neither does the solution built on it. Verification,
 *   review and item audits all judged a tree derived from the old requirement.
 * - `solution`: the requirement stands, but the approach changed. Its confirmation
 *   falls, along with everything that judged the implementation of the old one.
 * - `defect`: a defect in the work as specified. The requirement and solution stay
 *   agreed; what falls is the evidence that the OLD implementation was correct —
 *   verification, review, and the per-item audits.
 *
 * A confirmation is always re-askable rather than silently assumed, because the
 * human who approved it approved a different thing.
 * @param kind - the kind of change being recorded.
 * @returns the conclusion names to clear.
 */
export function invalidatedBy(kind: TaskRevision['kind']): string[] {
  switch (kind) {
    case 'requirement':
      return ['requirement_confirmation', 'solution_confirmation', 'verification', 'review', 'item_reviews', 'commits']
    case 'solution':
      return ['solution_confirmation', 'verification', 'review', 'item_reviews', 'commits']
    case 'defect':
      return ['verification', 'review', 'item_reviews', 'commits']
  }
}

/**
 * The result of applying one rework to a task record.
 *
 * Kept separate from the mutation so the caller can report what changed, and so
 * the clearing rules above are asserted directly in tests.
 */
export interface RevisionOutcome {
  /** The stage the task now sits at. */
  stage: string
  /** The conclusions that were cleared. */
  invalidated: string[]
}

/**
 * Apply a rework to a task record, clearing exactly the superseded conclusions.
 *
 * Confirmation flags are reset rather than deleted because the engine reads them
 * as booleans; the other conclusions are cleared by removing the record that
 * carried them, so `status` reports them as absent instead of stale.
 * @param state - the task state, mutated in place.
 * @param revision - the rework to apply.
 * @returns the stage reached and the conclusions cleared.
 */
export function applyRevision(state: TaskState, revision: TaskRevision): RevisionOutcome {
  const cleared = invalidatedBy(revision.kind)
  if (cleared.includes('requirement_confirmation')) state.requirement_confirmed = false
  if (cleared.includes('solution_confirmation')) state.solution_confirmed = false
  if (cleared.includes('verification')) {
    state.verification = { passed: false, evidence: [] }
  }
  if (cleared.includes('review')) {
    state.review = { outcome: 'pending' }
  }
  if (cleared.includes('item_reviews')) {
    for (const item of state.items) {
      delete item.review
      // An item whose audit is gone is no longer proven done, so it returns to
      // the state where its work is still outstanding.
      if (item.status === 'done') item.status = 'doing'
    }
  }
  if (cleared.includes('commits')) state.commits = []
  // Going back means the task is open again; a completed task that reworks is a
  // task whose completion no longer describes it.
  delete state.completed
  state.stage = revision.to
  state.revisions = [...(state.revisions ?? []), { ...revision, invalidated: cleared }]
  return { stage: revision.to, invalidated: cleared }
}

/**
 * A project's `.dsh/eng.json` as read off disk.
 *
 * This describes what a file MAY contain so the resolver can narrow it; declaring
 * only the fields a valid file is allowed would make an invalid one look valid to
 * the parser and hide the error until much later.
 */
export interface ParsedProjectConfig {
  flow?: string
  /** The project's own stage bindings, taken verbatim. */
  stage_bindings?: Record<string, StageBinding>
  /** The project's own commit policy, replacing any preset default. */
  commit?: CommitRule
  /** The project's own artifact declarations. */
  artifacts?: ArtifactDef[]
  /** The project's own per-item review depth. */
  review_depth?: ReviewDepth
  /** Whether a recorded commit is required before completion. */
  commit_required?: boolean
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
