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

import { formatResourceRef } from './engine.ts'
import type { ResourceRef, SkillBinding, StageBinding, WorkflowConfig } from './engine.ts'

/** A preset workflow a project can select by id. */
export interface FlowOption {
  id: string
  label: string
  description: string
}

/**
 * Build one skill binding from a bare name plus its bundled rules.
 *
 * The preset's own bindings are all bundled resources, so the `bundled:` prefix
 * is applied here rather than repeated at every call site. Project and user
 * resources enter through a project's config, where their source is explicit.
 * @param skill - the bundled skill name.
 * @param rules - bundled rule names that belong to this skill.
 * @returns the binding.
 */
function bundled(skill: string, ...rules: string[]): SkillBinding {
  const ref = (name: string): ResourceRef => ({ source: 'bundled', name })
  return { skill: ref(skill), rules: rules.map(ref) }
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
    '需求评审': { skills: [bundled('requirement-analysis', 'security-redlines')] },
    '设计': { skills: [bundled('solution-design')] },
    '开发': { skills: [bundled('code-implement', 'coding-conventions', 'security-redlines')] },
    '交付': { skills: [bundled('code-verify')] },
    '代码审核': {
      skills: [
        bundled('code-review', 'coding-conventions', 'security-redlines'),
        bundled('code-commit', 'commit-conventions'),
      ],
    },
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
    // The 审查 stage binds code-review, whose instructions write this artifact with
    // `record artifact=review`. Declaring it here keeps that binding executable:
    // the engine refuses an undeclared artifact, so a bound skill pointing at one
    // would be a contract the preset itself made impossible to satisfy.
    { stage: '审查', id: 'review', name: '评审记录', fields: ['conclusion', 'issues'] },
  ],
  commit: {
    // `item` policy emits two label shapes: `T<n>` for a mid-flow item commit and
    // `TASK` for the closing commit at the checkpoint. The pattern below accepts
    // BOTH, so the label the engine hands the model always satisfies the preset's
    // own rule. Previously it accepted only `T\d+` while the checkpoint stage
    // returned `TASK`, which made the closing commit impossible to phrase: the
    // status line and the validator disagreed about the contract.
    policy: 'item',
    message_pattern: '^【(\\S+)】【(?:TASK|T\\d+)】.+',
    message_hint: '【<task_id>】【TASK/T1】说明 —— 第一段填本任务 id；实施项提交用 T1、T2，收尾提交用 TASK',
    checkpoints: ['交付'],
    file_scope: true,
  },
  high_risk_requires_verification: false,
  stage_bindings: {
    '需求': { skills: [bundled('requirement-analysis', 'security-redlines')] },
    '开发': { skills: [bundled('code-implement', 'coding-conventions', 'security-redlines')] },
    '交付': { skills: [bundled('code-verify'), bundled('code-commit', 'commit-conventions')] },
    '审查': { skills: [bundled('code-review', 'coding-conventions', 'security-redlines')] },
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
  // A fast-change flow checks each change once, not twice under two headings a
  // short change rarely distinguishes. The item still has to be reviewed — what
  // drops is the duplicated verdict, which is where the weight actually was: this
  // flow used to carry the same per-item audit burden as the full one.
  review_depth: 'single',
  stage_bindings: {
    '开发': { skills: [bundled('code-implement', 'coding-conventions', 'security-redlines')] },
    '交付': { skills: [bundled('code-commit', 'commit-conventions')] },
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
  // Version 2: the closing-commit label shape was unified with the message pattern,
  // and the `review` artifact the bound code-review skill writes was declared. Tasks
  // created before this keep their frozen version 1 config and are unaffected.
  agile: preset('agile', 2, '敏捷轻量', '需求 → 开发 → 交付 → 审查，四阶段、少产物', AGILE),
  // Version 2: per-item review depth is declared as `single` instead of inheriting
  // the full flow's two verdicts per item. Tasks created before this keep their
  // frozen version 1 config, which has no `review_depth` and therefore reads as
  // two-stage exactly as it behaved.
  minimal: preset('minimal', 2, '纯代码', '开发 → 交付，两阶段，每项一次检查后提交', MINIMAL),
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
 * Merge a project's stage bindings into a preset's defaults without ever removing
 * a core skill. Skills are appended and de-duplicated by their source-qualified
 * reference, so a project cannot cancel a shipped binding and two same-named
 * skills from different layers stay distinct.
 *
 * Rules are NOT merged here. A rule belongs to the skill that carries it, so a
 * project wanting a skill under a different rule set supplies its own skill
 * binding whose `rules` list is used as given. There is no stage-level rule list
 * to merge into and no override layer to compute — the skill's list is the answer.
 *
 * `legacy_rules` from a project pass through untouched: they are the stage-level
 * rules of a pre-migration config, still enforced, awaiting a human decision
 * about which skill owns them.
 */
function mergeBindings(base: WorkflowConfig, override?: Record<string, StageBinding>): WorkflowConfig {
  if (override === undefined) return base
  let changed = false
  const merged: Record<string, StageBinding> = { ...base.stage_bindings }
  for (const [stage, addition] of Object.entries(override)) {
    const existing = merged[stage]
    const skills: SkillBinding[] = [...(existing?.skills ?? [])]
    const seen = new Set(skills.map(skill => formatResourceRef(skill.skill)))
    for (const skill of addition.skills ?? []) {
      const key = formatResourceRef(skill.skill)
      if (seen.has(key)) continue
      seen.add(key)
      skills.push(skill)
    }
    const legacy = dedupe([...(existing?.legacy_rules ?? []), ...(addition.legacy_rules ?? [])])
    const binding: StageBinding = {}
    if (skills.length > 0) binding.skills = skills
    if (legacy.length > 0) binding.legacy_rules = legacy
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
