/** Task-scoped engineering flows. The grade selects gates; risk remains separate. */
import type { ArtifactDef, EvidenceKind, WorkflowConfig } from './engine.ts'

export type Complexity = 'low' | 'medium' | 'high' | 'ultra'
export type MetaSkill = 'requirements-analysis' | 'architecture-design' | 'task-orchestration'
  | 'code-development' | 'test-validation' | 'code-review'

export const COMPLEXITY_OPTIONS: readonly { id: Complexity; label: string; guidance: string }[] = [
  { id: 'low', label: '低', guidance: '边界明确的局部修改；一个实施项即可说明改动。' },
  { id: 'medium', label: '中', guidance: '常规功能或缺陷修复；先写清需求与验收条件。' },
  { id: 'high', label: '高', guidance: '跨模块或有先后依赖的需求；按实现顺序编排任务与交接产物。' },
  { id: 'ultra', label: '超高', guidance: '完整新模块或大范围重构；先明确架构边界，再按依赖顺序实施。' },
]

export const META_STAGES: Readonly<Record<MetaSkill, string>> = {
  'requirements-analysis': '需求分析',
  'architecture-design': '架构设计',
  'task-orchestration': '任务编排',
  'code-development': '代码开发',
  'test-validation': '测试',
  'code-review': '代码审核',
}

/** Evidence required by each core meta-skill when its profile does not override it. */
export const META_EVIDENCE: Readonly<Record<MetaSkill, EvidenceKind>> = {
  'requirements-analysis': 'artifact',
  'architecture-design': 'artifact',
  'task-orchestration': 'artifact',
  'code-development': 'none',
  'test-validation': 'none',
  'code-review': 'review',
}

export const ADAPTIVE_VERSION = 1

const COMMON_ARTIFACTS: ArtifactDef[] = [
  { stage: '需求分析', id: 'requirement', name: '需求与验收条件', fields: ['goal', 'scope', 'acceptance'] },
  { stage: '架构设计', id: 'architecture', name: '架构边界', fields: ['approach', 'impact', 'tradeoffs'] },
  { stage: '任务编排', id: 'task-plan', name: '按实现顺序排列的任务', fields: ['steps', 'dependencies', 'handoffs'] },
]

/** A grade is a per-task snapshot, never a project-wide forced flow. */
export function adaptiveWorkflow(grade: Complexity): WorkflowConfig {
  const prefix = grade === 'low' ? []
    : grade === 'medium' ? ['需求分析']
      : grade === 'high' ? ['需求分析', '任务编排']
        : ['需求分析', '架构设计', '任务编排']
  const stages = [...prefix, '代码开发', '测试', '代码审核', '完成']
  const transitions = stages.slice(0, -1).map((from, index) => {
    const to = stages[index + 1]!
    const requires = from === '需求分析' || from === '架构设计' || from === '任务编排'
      ? ['artifacts_present' as const]
      : from === '代码开发' ? ['todos_done' as const]
        : from === '测试' ? ['verified' as const]
          : from === '代码审核' ? ['review_passed' as const] : []
    return { from, to, requires }
  })
  return {
    stages,
    start_stage: stages[0]!,
    transitions,
    artifacts: COMMON_ARTIFACTS.filter(artifact => stages.includes(artifact.stage)),
    // CI and scanner review need a tested commit; local IDE-style review overrides this per task.
    commit: { policy: 'task', message_pattern: '', message_hint: '无格式要求', checkpoints: ['测试'], file_scope: true },
    high_risk_requires_verification: true,
    review_depth: grade === 'low' ? 'single' : 'two-stage',
  }
}

export function isComplexity(value: unknown): value is Complexity {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'ultra'
}

export function metaForStage(stage: string): MetaSkill | undefined {
  return (Object.entries(META_STAGES) as [MetaSkill, string][]).find(([, label]) => label === stage)?.[0]
}
