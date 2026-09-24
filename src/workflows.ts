/**
 * Built-in workflow SKELETONS.
 *
 * A preset states how work MOVES: the stage graph and the guards on each edge.
 * It deliberately carries nothing about HOW to do the work, because a preset that
 * also baked in skills, a commit format and artifact fields would make every
 * project follow the shipped method whether or not that suits it.
 *
 * One reasonable engineering setup per skeleton is offered separately as a
 * {@link FlowRecommendation}, and enters a project only when a user adopts it
 * explicitly. After adoption those values are the user's own config: edited,
 * extended or removed, with nothing merged back by a later version.
 *
 * @module dsh-task-engine/workflows
 */

import type { ArtifactDef, CommitRule, ResourceRef, ReviewDepth, SkillBinding, StageBinding, WorkflowConfig } from './engine.ts'

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
  /**
   * An optional ready-made engineering setup a user may ADOPT into their own
   * config: stage bindings, commit format and artifact fields reflecting one
   * reasonable way of working.
   *
   * Separate from `config` on purpose. The skeleton states how the work moves;
   * the recommendation states one opinion about how to do it. A preset that also
   * imposed its recommendation would make every project follow the shipped method
   * whether or not that suits it — the opposite of letting the user decide.
   * Nothing here takes effect until a user adopts it, and once adopted the values
   * are theirs: edited, extended, or removed like any other config, never
   * silently merged back.
   */
  recommendation?: FlowRecommendation
}

/**
 * One ready-made engineering setup, offered for explicit adoption.
 *
 * Every field is optional because a preset may recommend a commit format without
 * recommending skills; an adopter receives only what is present.
 */
export interface FlowRecommendation {
  /** Stage bindings to write on adoption. */
  stage_bindings?: Record<string, StageBinding>
  /**
     * The commit TEXT conventions to write on adoption.
     *
     * Partial on purpose: a recommendation supplies only the writing convention —
     * the message pattern and hint. WHEN a commit gate fires and whether the file
     * scope is enforced are flow control and stay on the skeleton.
     */
  commit?: Partial<CommitRule>
  /** Artifact declarations to write on adoption. */
  artifacts?: ArtifactDef[]
  /** Per-item review depth to write on adoption. */
  review_depth?: ReviewDepth
}

/** The selectable preset workflows (shown in the workbench flow picker). */
export const FLOW_OPTIONS: readonly FlowOption[] = [
  { id: 'standard', label: '完整研发', description: '新功能、架构或跨模块改动、高风险任务：需求确认 → 方案确认 → 实现 → 验证 → 审核 → 提交' },
  { id: 'agile', label: '日常迭代', description: '目标明确的常规功能与缺陷修复：目标与验收 → 实现 → 验收与审查 → 提交' },
  { id: 'minimal', label: '快速修改', description: '局部、低风险、方案明确的改动：修改 → 检查与提交' },
]

/**
 * Standard review-gated delivery.
 *
 * The skeleton states how work MOVES: which stages exist, what may follow what,
 * and which confirmations or evidence an edge demands. Everything about HOW to do
 * the work — which skills run, what a commit message must look like, which
 * artifacts a stage records — lives in {@link STANDARD_RECOMMENDATION} and enters
 * a project only when the user adopts it.
 */
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
  // No artifacts, no commit policy, no skills: the skeleton carries none of them.
  artifacts: [],
  commit: { policy: 'task', message_pattern: '', message_hint: '无格式要求', checkpoints: ['代码审核'], file_scope: true },
  high_risk_requires_verification: true,
}

/**
 * One ready-made setup for the standard flow, offered for explicit adoption.
 *
 * This is a recommendation, not a default: it reflects one reasonable way to work
 * and nothing here takes effect until a user adopts it. After adoption these
 * values are ordinary user config — edited, extended or removed — and no later
 * version merges anything back in.
 */
const STANDARD_RECOMMENDATION: FlowRecommendation = {
  commit: {
    // Only the TEXT conventions. Policy, checkpoints and scope stay on the
    // skeleton: they decide when a gate fires, not how a message reads.
    message_pattern: '^【(\\S+)】【(?:TASK|T\\d+)】.+',
    message_hint: '【<task_id>】【TASK/T1】说明 —— 第一段填本任务 id（如 GREET-001），写结果不写空泛动作',
  },
  artifacts: [
    { stage: '需求评审', id: 'requirement', name: '需求说明', fields: ['scope', 'acceptance_criteria'] },
    { stage: '设计', id: 'design', name: '设计文档', fields: ['approach', 'risks', 'impact'] },
    { stage: '代码审核', id: 'review', name: '评审记录', fields: ['conclusion', 'issues'] },
  ],
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

/** Lighter four-stage flow: the skeleton only. */
const AGILE: WorkflowConfig = {
  stages: ['需求', '开发', '交付', '审查'],
  start_stage: '需求',
  transitions: [
    { from: '需求', to: '开发', requires: ['requirement_confirmation'] },
    { from: '开发', to: '交付', requires: ['todos_done'] },
    { from: '交付', to: '审查', requires: [] },
  ],
  artifacts: [],
  commit: { policy: 'item', message_pattern: '', message_hint: '无格式要求', checkpoints: ['交付'], file_scope: true },
  high_risk_requires_verification: false,
}

/** One ready-made setup for the agile flow, offered for explicit adoption. */
const AGILE_RECOMMENDATION: FlowRecommendation = {
  commit: {
    // `item` policy emits two label shapes: `T<n>` mid-flow and `TASK` at the
    // closing checkpoint. The pattern accepts BOTH, so the label the engine hands
    // the model always satisfies the rule that validates it.
    message_pattern: '^【(\\S+)】【(?:TASK|T\\d+)】.+',
    message_hint: '【<task_id>】【TASK/T1】说明 —— 第一段填本任务 id；实施项提交用 T1、T2，收尾提交用 TASK',
  },
  artifacts: [
    { stage: '需求', id: 'requirement', name: '需求说明', fields: ['scope'] },
    // The 审查 stage binds code-review, whose instructions write this artifact with
    // `record artifact=review`. Declaring it keeps that binding executable: the
    // engine refuses an undeclared artifact, so a bound skill pointing at one would
    // be a contract the recommendation made impossible to satisfy.
    { stage: '审查', id: 'review', name: '评审记录', fields: ['conclusion', 'issues'] },
  ],
  stage_bindings: {
    '需求': { skills: [bundled('requirement-analysis', 'security-redlines')] },
    '开发': { skills: [bundled('code-implement', 'coding-conventions', 'security-redlines')] },
    '交付': { skills: [bundled('code-verify'), bundled('code-commit', 'commit-conventions')] },
    '审查': { skills: [bundled('code-review', 'coding-conventions', 'security-redlines')] },
  },
}

/** Minimal two-stage flow: the skeleton only. */
const MINIMAL: WorkflowConfig = {
  stages: ['开发', '交付'],
  start_stage: '开发',
  transitions: [
    { from: '开发', to: '交付', requires: ['todos_done'] },
  ],
  artifacts: [],
  commit: { policy: 'task', message_pattern: '', message_hint: '无格式要求', checkpoints: ['交付'], file_scope: false },
  high_risk_requires_verification: false,
}

/** One ready-made setup for the minimal flow, offered for explicit adoption. */
const MINIMAL_RECOMMENDATION: FlowRecommendation = {
  // A fast-change flow checks each change once, not twice under two headings a
  // short change rarely distinguishes. The item still has to be reviewed — what
  // drops is the duplicated verdict, which is where the weight actually was.
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
  recommendation?: FlowRecommendation,
): FlowPreset {
  return {
    id, version, label, description,
    capabilities: deriveCapabilities(config),
    config,
    // exactOptionalPropertyTypes: omit rather than assign undefined.
    ...(recommendation !== undefined ? { recommendation } : {}),
  }
}

export const FLOW_PRESETS: Record<string, FlowPreset> = {
  standard: preset('standard', 3, '完整研发', '新功能、架构或跨模块改动、高风险任务：需求确认 → 方案确认 → 实现 → 验证 → 审核 → 提交', STANDARD, STANDARD_RECOMMENDATION),
  // Version 3 across all three: the preset is now a bare skeleton and its former
  // built-in bindings, commit rule and artifacts are a separate recommendation a
  // user adopts explicitly. Tasks created before this keep their frozen config and
  // are unaffected; a project's existing config is likewise left exactly as it is.
  agile: preset('agile', 3, '日常迭代', '目标明确的常规功能与缺陷修复：目标与验收 → 实现 → 验收与审查 → 提交', AGILE, AGILE_RECOMMENDATION),
  minimal: preset('minimal', 3, '快速修改', '局部、低风险、方案明确的改动：修改 → 检查与提交，每项一次检查', MINIMAL, MINIMAL_RECOMMENDATION),
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
 * Apply a project's own config over a preset skeleton.
 *
 * The project's values are taken as given. There is nothing to merge against any
 * more: the skeleton carries no skills, no commit rule, no artifacts and no
 * review depth, so whatever the user configured IS the configuration. Earlier
 * versions merged a project's skills into the preset's built-in set, which had two
 * consequences this removes — a built-in skill could never be dropped, and an
 * attempt to give a built-in skill a different rule list was discarded because the
 * skill reference already existed.
 *
 * `stage_bindings` entirely replaces the skeleton's (empty) map; a stage the user
 * omits simply has no bindings, which is a legitimate state rather than a gap to
 * be filled from a recommendation.
 */
function applyProjectConfig(base: WorkflowConfig, project?: ProjectConfig): WorkflowConfig {
  if (project === undefined) return base
  const next: WorkflowConfig = { ...base }
  if (project.stage_bindings !== undefined) {
    const bindings: Record<string, StageBinding> = {}
    for (const [stage, binding] of Object.entries(project.stage_bindings)) {
      const entry: StageBinding = {}
      if ((binding.skills ?? []).length > 0) entry.skills = [...binding.skills!]
      const legacy = dedupe(binding.legacy_rules ?? [])
      if (legacy.length > 0) entry.legacy_rules = legacy
      bindings[stage] = entry
    }
    next.stage_bindings = bindings
  }
  if (project.commit !== undefined) next.commit = project.commit
  if (project.artifacts !== undefined) next.artifacts = project.artifacts
  if (project.review_depth !== undefined) next.review_depth = project.review_depth
  if (project.commit_required !== undefined) next.commit_required = project.commit_required
  return next
}

/**
 * Write a preset's recommendation into a config, for a user who asked for it.
 *
 * This is the ADOPTION step. It is a deliberate, one-time act: the returned config
 * is the user's own from then on, and nothing re-applies or re-merges the
 * recommendation later, so a value the user deletes stays deleted.
 * @param presetId - the preset whose recommendation to adopt.
 * @param current - the user's current config, if any values should be kept.
 * @returns the config with the recommendation applied, or undefined for an unknown preset.
 */
export function adoptRecommendation(
  presetId: string,
  current?: ProjectConfig,
): ProjectConfig | undefined {
  const preset = FLOW_PRESETS[presetId]
  if (preset === undefined) return undefined
  const rec = preset.recommendation
  if (rec === undefined) return { flow: presetId, ...current }
  // The recommendation supplies a starting point; anything the user already set
  // wins, so adopting never overwrites an existing decision.
  //
  // The commit rule is assembled from BOTH halves, because they live in different
  // places by design: the skeleton owns when a gate fires and whether the scope is
  // protected, the recommendation owns how a message reads. Writing the
  // recommendation's half alone would produce a config with no checkpoints and no
  // scope protection — the flow control would silently disappear on adoption.
  const commit: CommitRule = {
    ...preset.config.commit,
    ...(rec.commit ?? {}),
    ...(current?.commit ?? {}),
  }
  const config: ProjectConfig = {
    flow: presetId,
    stage_bindings: current?.stage_bindings ?? rec.stage_bindings ?? {},
    commit,
    artifacts: current?.artifacts ?? rec.artifacts ?? preset.config.artifacts,
    ...(current?.review_depth !== undefined
      ? { review_depth: current.review_depth }
      : (rec.review_depth !== undefined ? { review_depth: rec.review_depth } : {})),
    ...(current?.commit_required !== undefined ? { commit_required: current.commit_required } : {}),
  }
  return config
}

/**
 * A project's own configuration, as stored in `.dsh/eng.json`.
 *
 * Every field beyond `flow` is optional and is the user's to set. A field that is
 * absent means "not configured", never "use the built-in value".
 */
export interface ProjectConfig {
  flow: string
  stage_bindings?: Record<string, StageBinding>
  commit?: CommitRule
  artifacts?: ArtifactDef[]
  review_depth?: ReviewDepth
  commit_required?: boolean
}

/**
 * Resolve a preset workflow plus a project's stage-binding additions into the
 * complete engine config. Unknown `flow` ids fail closed with an explicit
 * `UNKNOWN_FLOW` result instead of silently falling back to `standard`, so a
 * project that names a missing or stale preset stops instead of running the
 * wrong gate.
 * @param flow - workflow id from the project's `.dsh/eng.json`.
 * @param project - the project's own config, applied verbatim over the skeleton.
 */
export function resolveFlow(flow: string, project?: ProjectConfig): FlowResolve {
  const preset = FLOW_PRESETS[flow]
  if (preset === undefined) {
    return { ok: false, code: 'UNKNOWN_FLOW', flow, knownFlows: Object.keys(FLOW_PRESETS) }
  }
  const { flow: _ignored, ...rest } = project ?? { flow }
  return { ok: true, config: applyProjectConfig(preset.config, { flow, ...rest }), preset }
}
