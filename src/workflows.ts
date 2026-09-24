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

import { formatResourceRef } from './engine.ts'
import type { ArtifactDef, CommitRule, ResourceRef, ReviewDepth, SkillBinding, SkillProfile, StageBinding, WorkflowConfig } from './engine.ts'

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
    // Entering 审查 is unconditional. A review guard on this edge would be
    // circular — it would demand the verdict BEFORE the stage that produces it —
    // and it would also block the commit at 交付, since a commit requires its
    // stage's outgoing guards. What 审查 requires is declared as completion_guards
    // instead, because a terminal stage has no outgoing edge to carry it.
    { from: '交付', to: '审查', requires: [] },
  ],
  artifacts: [],
  commit: { policy: 'item', message_pattern: '', message_hint: '无格式要求', checkpoints: ['交付'], file_scope: true },
  high_risk_requires_verification: false,
  // 审查 is terminal and IS the review, so there is no outgoing edge to carry
  // the guard. Declaring it here is what makes a blocked review prevent
  // completion; without it the stage could be reached and finished with the
  // review failing, which is what the assessment found.
  completion_guards: ['review_passed'],
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
  // Version 4 for agile: 交付 → 审查 now requires review_passed, where it previously
  // required nothing. That is a gate-semantics change, so a task created before it
  // keeps its frozen version 3 config and behaves exactly as it did.
  //
  // Version 3 across all three: the preset is now a bare skeleton and its former
  // built-in bindings, commit rule and artifacts are a separate recommendation a
  // user adopts explicitly. Tasks created before this keep their frozen config and
  // are unaffected; a project's existing config is likewise left exactly as it is.
  agile: preset('agile', 4, '日常迭代', '目标明确的常规功能与缺陷修复：目标与验收 → 实现 → 验收与审查 → 提交', AGILE, AGILE_RECOMMENDATION),
  minimal: preset('minimal', 3, '快速修改', '局部、低风险、方案明确的改动：修改 → 检查与提交，每项一次检查', MINIMAL, MINIMAL_RECOMMENDATION),
}

/** Whether `flow` names a built-in workflow. */
export function isKnownFlow(flow: string): boolean {
  return Object.prototype.hasOwnProperty.call(FLOW_PRESETS, flow)
}

/** Keep bindings for stages shared with a newly selected flow. */
export function retainStageBindings(
  flow: string,
  bindings: Record<string, StageBinding>,
): { bindings: Record<string, StageBinding>; dropped: string[] } {
  const stages = new Set(FLOW_PRESETS[flow]?.config.stages ?? [])
  const kept: Record<string, StageBinding> = {}
  const dropped: string[] = []
  for (const [stage, binding] of Object.entries(bindings)) {
    if (stages.has(stage)) kept[stage] = binding
    else dropped.push(stage)
  }
  return { bindings: kept, dropped }
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
    const profiles: Record<string, SkillProfile> = { ...(project.skill_profiles ?? {}) }
    const explicitProfiles = new Set(Object.keys(project.skill_profiles ?? {}))
    const problems: string[] = []
    const bindings: Record<string, StageBinding> = {}
    for (const [stage, binding] of Object.entries(project.stage_bindings)) {
      const entry: StageBinding = {}
      if (binding === null || typeof binding !== 'object') {
        problems.push(`stage_bindings "${stage}" must be an object`)
        bindings[stage] = entry
        continue
      }
      if (binding.skill_refs !== undefined && binding.skills !== undefined) {
        problems.push(`stage_bindings "${stage}" has both skill_refs and legacy skills`)
      }
      if (binding.skill_refs !== undefined) {
        if (!Array.isArray(binding.skill_refs)) {
          problems.push(`stage_bindings "${stage}" skill_refs must be an array`)
        }
        entry.skills = (Array.isArray(binding.skill_refs) ? binding.skill_refs : []).flatMap(ref => {
          if (ref === null || typeof ref !== 'object') {
            problems.push(`stage_bindings "${stage}" has an invalid skill reference`)
            return []
          }
          const key = formatResourceRef(ref)
          const profile = profiles[key]
          if (profile === undefined) {
            problems.push(`skill profile "${key}" is missing`)
            return []
          }
          if (profile === null || !Array.isArray(profile.rules)) {
            problems.push(`skill profile "${key}" must declare a rules array`)
            return []
          }
          return [{ skill: ref, rules: profile.rules, ...(profile.evidence !== undefined ? { evidence: profile.evidence } : {}) }]
        })
      } else if (binding.skills !== undefined) {
        // Read pre-migration inline bindings, then normalize their rule lists to
        // a single profile per skill. Divergent copies cannot be reconciled by
        // guessing which stage should win.
        if (!Array.isArray(binding.skills)) {
          problems.push(`stage_bindings "${stage}" skills must be an array`)
        }
        entry.skills = (Array.isArray(binding.skills) ? binding.skills : []).flatMap(skill => {
          if (skill === null || typeof skill !== 'object' || skill.skill === null || typeof skill.skill !== 'object') {
            problems.push(`stage_bindings "${stage}" has an invalid skill binding`)
            return []
          }
          const key = formatResourceRef(skill.skill)
          if (explicitProfiles.has(key)) {
            // The project profile is authoritative. Inline methods are a legacy
            // transport shape and may be stale after the skill is edited.
            const profile = profiles[key]
            if (profile === null || !Array.isArray(profile?.rules)) {
              problems.push(`skill profile "${key}" must declare a rules array`)
              return []
            }
            return [{ skill: skill.skill, rules: profile.rules,
              ...(profile.evidence !== undefined ? { evidence: profile.evidence } : {}) }]
          }
          const candidate: SkillProfile = { rules: skill.rules ?? [], ...(skill.evidence !== undefined ? { evidence: skill.evidence } : {}) }
          const existing = profiles[key]
          if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(candidate)) {
            problems.push(`skill "${key}" has different rules or evidence in multiple stages; copy it as a distinct skill`)
          } else profiles[key] = candidate
          return [skill]
        })
      }
      const legacy = dedupe(binding.legacy_rules ?? [])
      if (legacy.length > 0) entry.legacy_rules = legacy
      bindings[stage] = entry
    }
    next.stage_bindings = bindings
    next.skill_profiles = profiles
    if (problems.length > 0) next.configuration_errors = problems
  } else if (project.skill_profiles !== undefined) {
    next.skill_profiles = project.skill_profiles
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
    ...(current?.skill_profiles !== undefined ? { skill_profiles: current.skill_profiles } : {}),
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
  skill_profiles?: Record<string, SkillProfile>
  commit?: CommitRule
  artifacts?: ArtifactDef[]
  review_depth?: ReviewDepth
  commit_required?: boolean
}

/** Persist stages as references and each skill's rules exactly once. */
export function compactProjectConfig(project: ProjectConfig): ProjectConfig {
  const resolved = resolveFlow(project.flow, project)
  if (!resolved.ok) return project
  const profiles = resolved.config.skill_profiles ?? {}
  const bindings: Record<string, StageBinding> = {}
  for (const [stage, binding] of Object.entries(resolved.config.stage_bindings ?? {})) {
    bindings[stage] = {
      skill_refs: (binding.skills ?? []).map(entry => entry.skill),
      ...(binding.legacy_rules?.length ? { legacy_rules: binding.legacy_rules } : {}),
    }
  }
  return { ...project, stage_bindings: bindings, skill_profiles: profiles }
}

/** A single bundled body to copy when adopting a recommendation. */
export interface RecommendedResourceCopy {
  kind: 'skill' | 'rule'
  name: string
  targetName: string
}

/**
 * Turn source-qualified bundled references into editable project/user references.
 * Repeated rule references share one target and therefore one physical file.
 * This is invoked only for an explicit adoption save; existing configurations
 * are never migrated or rewritten merely because they are opened.
 */
export function materializeBundledReferences(
  project: ProjectConfig,
  level: 'project' | 'user',
): { config: ProjectConfig; copies: RecommendedResourceCopy[] } {
  const compact = compactProjectConfig(project)
  const copies = new Map<string, RecommendedResourceCopy>()
  const remap = (ref: ResourceRef, kind: 'skill' | 'rule'): ResourceRef => {
    if (ref.source !== 'bundled') return ref
    const targetName = `${ref.name}-copy`
    copies.set(`${kind}:${ref.name}`, { kind, name: ref.name, targetName })
    return { source: level, name: targetName }
  }
  const stage_bindings: Record<string, StageBinding> = {}
  for (const [stage, binding] of Object.entries(compact.stage_bindings ?? {})) {
    stage_bindings[stage] = {
      ...binding,
      ...(binding.skill_refs ? { skill_refs: binding.skill_refs.map(ref => remap(ref, 'skill')) } : {}),
    }
  }
  const skill_profiles: Record<string, SkillProfile> = {}
  for (const [key, profile] of Object.entries(compact.skill_profiles ?? {})) {
    // A user-level skill's profile is globally owned and may legitimately use
    // bundled rules. A project adoption must never rewrite that global method.
    if (key.startsWith('user:')) {
      skill_profiles[key] = profile
      continue
    }
    const colon = key.indexOf(':')
    const ref = colon < 0 ? undefined : { source: key.slice(0, colon), name: key.slice(colon + 1) } as ResourceRef
    const mapped = ref?.source === 'bundled' ? remap(ref, 'skill') : ref
    const mappedKey = mapped ? formatResourceRef(mapped) : key
    if (skill_profiles[mappedKey] !== undefined) {
      throw new Error(`采用推荐配置后技能档案重复：${mappedKey}`)
    }
    skill_profiles[mappedKey] = { ...profile, rules: profile.rules.map(rule => remap(rule, 'rule')) }
  }
  return { config: { ...compact, stage_bindings, skill_profiles }, copies: [...copies.values()] }
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
