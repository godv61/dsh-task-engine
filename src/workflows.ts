/**
 * Built-in engineering workflows. A workflow is a complete, engine-resolved
 * `WorkflowConfig` a project adopts by id: the stage graph, transition guards,
 * artifacts, commit rule, and default skill/rule bindings are all baked in
 * here. A project overrides only its stage bindings by APPENDING skill/rule
 * names to the preset defaults; every guard, artifact, and commit field stays
 * a fixed property of the chosen preset, so a project cannot hand-edit the gate
 * semantics or cancel a core binding.
 *
 * @module dsh-task-engine/workflows
 */

import type { StageBinding, WorkflowConfig } from './engine.ts'

/** A preset workflow a project can select by id. */
export interface FlowOption {
  id: string
  label: string
  description: string
}

/** A gate capability a flow either has or lacks; high-risk tasks require a subset. */
export type WorkflowCapability = 'artifact_gate' | 'verification_gate' | 'file_scope' | 'review_gate'

/** A versioned preset: fixed gate semantics plus its derived capability set. */
export interface FlowPreset extends FlowOption {
  /** Preset schema version; bumped only by a shipped preset edit (`standard@1` → `standard@2`). */
  version: number
  /** Gate capabilities derived from the preset's own structure. */
  capabilities: WorkflowCapability[]
  /** The complete engine config this preset resolves to. */
  config: WorkflowConfig
}

/** The selectable preset workflows (shown in the workbench flow picker). */
export const FLOW_OPTIONS: readonly FlowOption[] = [
  { id: 'standard', label: '标准研发', description: '需求评审 → 设计 → 开发 → 交付 → 代码审核，含产物门 + 确认门' },
  { id: 'agile', label: '敏捷轻量', description: '需求 → 开发 → 交付 → 审查，四阶段、少产物' },
  { id: 'minimal', label: '纯代码', description: '开发 → 交付，两阶段，只留提交门禁' },
]

/** Standard review-gated delivery: the default workflow. */
const STANDARD: WorkflowConfig = {
  stages: ['需求评审', '设计', '开发', '交付', '代码审核', '完成'],
  start_stage: '需求评审',
  transitions: [
    { from: '需求评审', to: '设计', requires: ['requirement_confirmation', 'artifacts_present'] },
    { from: '设计', to: '开发', requires: ['solution_confirmation', 'artifacts_present'] },
    { from: '开发', to: '交付', requires: ['todos_done'] },
    { from: '交付', to: '代码审核', requires: ['verified'] },
    { from: '代码审核', to: '完成', requires: ['review_passed', 'artifacts_present'] },
  ],
  artifacts: [
    { stage: '需求评审', id: 'requirement', name: '需求说明', fields: ['scope', 'acceptance_criteria'] },
    { stage: '设计', id: 'design', name: '设计文档', fields: ['approach', 'risks', 'impact'] },
    { stage: '代码审核', id: 'review', name: '评审记录', fields: ['conclusion', 'issues'] },
  ],
  commit: {
    policy: 'task',
    message_pattern: '^【(\\S+)】【(?:TASK|T\\d+)】.+',
    message_hint: '【<task_id>】【TASK/T1】说明 —— 第一段填本任务 id（如 GREET-001），写结果不写空泛动作',
    checkpoints: ['代码审核'],
    file_scope: true,
  },
  high_risk_requires_verification: true,
  stage_bindings: {
    '需求评审': { skills: ['requirement-analysis'], rules: ['security-redlines'] },
    '设计': { skills: ['solution-design'] },
    '开发': { skills: ['code-implement'], rules: ['coding-conventions'] },
    '交付': { skills: ['code-verify'], rules: ['coding-conventions'] },
    '代码审核': { skills: ['code-review', 'code-commit'], rules: ['security-redlines', 'commit-conventions'] },
  },
}

/** Lighter four-stage flow with few artifacts, for fast-moving projects. */
const AGILE: WorkflowConfig = {
  stages: ['需求', '开发', '交付', '审查'],
  start_stage: '需求',
  transitions: [
    { from: '需求', to: '开发', requires: ['requirement_confirmation'] },
    { from: '开发', to: '交付', requires: ['todos_done'] },
    { from: '交付', to: '审查', requires: [] },
  ],
  artifacts: [
    { stage: '需求', id: 'requirement', name: '需求说明', fields: ['scope'] },
  ],
  commit: {
    policy: 'item',
    message_pattern: '^【(\\S+)】【T\\d+】.+',
    message_hint: '【<task_id>】【T1】说明 —— 第一段填本任务 id',
    checkpoints: ['交付'],
    file_scope: true,
  },
  high_risk_requires_verification: false,
  stage_bindings: {
    '需求': { skills: ['requirement-analysis'] },
    '开发': { skills: ['code-implement'], rules: ['coding-conventions'] },
    '交付': { skills: ['code-verify', 'code-commit'], rules: ['commit-conventions'] },
    '审查': { skills: ['code-review'] },
  },
}

/** Minimal two-stage flow: only a commit gate, no artifact doors. */
const MINIMAL: WorkflowConfig = {
  stages: ['开发', '交付'],
  start_stage: '开发',
  transitions: [
    { from: '开发', to: '交付', requires: ['todos_done'] },
  ],
  artifacts: [],
  commit: {
    policy: 'task',
    message_pattern: '',
    message_hint: '无格式要求',
    checkpoints: ['交付'],
    file_scope: false,
  },
  high_risk_requires_verification: false,
  stage_bindings: {
    '开发': { skills: ['code-implement'] },
    '交付': { skills: ['code-commit'], rules: ['commit-conventions'] },
  },
}

/**
 * Derive a preset's capability set from its own structure, so the capability
 * claims can never drift from the actual gate graph.
 */
function deriveCapabilities(config: WorkflowConfig): WorkflowCapability[] {
  const caps: WorkflowCapability[] = []
  const guards = new Set(config.transitions.flatMap(t => t.requires ?? []))
  if (guards.has('verified')) caps.push('verification_gate')
  if (guards.has('review_passed')) caps.push('review_gate')
  if (guards.has('artifacts_present')) caps.push('artifact_gate')
  if (config.commit.file_scope) caps.push('file_scope')
  return caps
}

function preset(
  id: string,
  version: number,
  label: string,
  description: string,
  config: WorkflowConfig,
): FlowPreset {
  return { id, version, label, description, capabilities: deriveCapabilities(config), config }
}

export const FLOW_PRESETS: Record<string, FlowPreset> = {
  standard: preset('standard', 2, '标准研发', '需求评审 → 设计 → 开发 → 交付 → 代码审核，审核后提交', STANDARD),
  agile: preset('agile', 1, '敏捷轻量', '需求 → 开发 → 交付 → 审查，四阶段、少产物', AGILE),
  minimal: preset('minimal', 1, '纯代码', '开发 → 交付，两阶段，只留提交门禁', MINIMAL),
}

/** Whether `flow` names a built-in workflow. */
export function isKnownFlow(flow: string): boolean {
  return Object.prototype.hasOwnProperty.call(FLOW_PRESETS, flow)
}

/**
 * The capabilities a high-risk task must have from its flow. A `high_risk`
 * task therefore cannot be created on a flow that lacks a verification gate,
 * file-scope protection, or a code review gate — choosing a looser flow can
 * never downgrade the risk bar.
 */
export const HIGH_RISK_REQUIRED_CAPABILITIES: readonly WorkflowCapability[] = [
  'verification_gate',
  'file_scope',
  'review_gate',
]

/** Whether a flow's derived capabilities cover every required capability. */
export function flowSatisfies(flow: string, required: readonly WorkflowCapability[]): boolean {
  const preset = FLOW_PRESETS[flow]
  if (preset === undefined) return false
  return required.every(cap => preset.capabilities.includes(cap))
}

/** Resolve an unknown flow id's failure, surprising no caller with a fallback. */
export interface UnknownFlow {
  ok: false
  code: 'UNKNOWN_FLOW'
  flow: string
  knownFlows: string[]
}

/** Resolve a known flow id's complete config. */
export interface KnownFlow {
  ok: true
  config: WorkflowConfig
  preset: FlowPreset
}

export type FlowResolve = KnownFlow | UnknownFlow

/** Stable ordered dedupe that keeps each name's first occurrence. */
function dedupe(names: string[]): string[] {
  return [...new Set(names)]
}

/**
 * Merge a project's stage-binding additions into a preset's defaults without
 * ever removing a core binding. A stage's `skills`/`rules` become the preset
 * defaults followed by the project additions, de-duplicated in order; the seed
 * bindings can therefore never be cancelled by an override, only extended.
 */
function mergeBindings(base: WorkflowConfig, override?: Record<string, StageBinding>): WorkflowConfig {
  if (override === undefined) return base
  let changed = false
  const merged: Record<string, StageBinding> = { ...base.stage_bindings }
  for (const [stage, addition] of Object.entries(override)) {
    const existing = merged[stage]
    const skills = dedupe([...(existing?.skills ?? []), ...(addition.skills ?? [])])
    const rules = dedupe([...(existing?.rules ?? []), ...(addition.rules ?? [])])
    const binding: StageBinding = {}
    if (skills.length > 0) binding.skills = skills
    if (rules.length > 0) binding.rules = rules
    merged[stage] = binding
    changed = true
  }
  if (!changed) return base
  return { ...base, stage_bindings: merged }
}

/**
 * Resolve a preset workflow plus a project's stage-binding additions into the
 * complete engine config. Unknown `flow` ids fail closed with an explicit
 * `UNKNOWN_FLOW` result instead of silently falling back to `standard`, so a
 * project that names a missing or stale preset stops instead of running the
 * wrong gate.
 * @param flow - workflow id from the project's `.dsh/eng.json`.
 * @param override - optional whole `stage_bindings` map APPENDED to the preset defaults.
 */
export function resolveFlow(flow: string, override?: { stage_bindings?: Record<string, StageBinding> }): FlowResolve {
  const preset = FLOW_PRESETS[flow]
  if (preset === undefined) {
    return { ok: false, code: 'UNKNOWN_FLOW', flow, knownFlows: Object.keys(FLOW_PRESETS) }
  }
  return { ok: true, config: mergeBindings(preset.config, override?.stage_bindings), preset }
}
