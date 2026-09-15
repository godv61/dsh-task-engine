/** Portable, versioned sequential workflows. JSON and Remote inputs use this parser. */
import { z } from 'zod'
import { validateWorkflow, type WorkflowConfig } from './engine.ts'

const name = z.string().trim().min(1).max(120).refine(v => !['__proto__', 'constructor', 'prototype'].includes(v), '保留名称不可用')
const names = z.array(name).max(100)
const guard = z.enum(['confirmation', 'requirement_confirmation', 'solution_confirmation', 'todos_done', 'verified', 'review_passed', 'artifacts_present'])
const configSchema = z.object({
  stages: names.min(2).max(30), start_stage: name,
  transitions: z.array(z.object({ from: name, to: name, requires: z.array(guard).max(7).default([]) }).strict()).max(29),
  artifacts: z.array(z.object({ stage: name, id: name, name, fields: names.min(1) }).strict()).max(100),
  commit: z.object({ policy: z.enum(['task', 'item', 'manual']), message_pattern: z.string().max(500), message_hint: z.string().max(1000), checkpoints: names, file_scope: z.boolean() }).strict(),
  high_risk_requires_verification: z.literal(true),
  evidence_scope: z.literal('stage'),
  stage_bindings: z.record(name, z.object({ skills: names.default([]), rules: names.default([]) }).strict()).default({}),
}).strict()

/** One active custom definition is stored in a project's custom_flow field. */
export interface CustomFlow {
  schema: 1
  id: string
  label: string
  version: number
  config: WorkflowConfig
}

/** Shared wire parser; semantic sequential validation is performed by parseCustomFlow. */
export const customFlowSchema = z.object({
  schema: z.literal(1), id: z.string().regex(/^custom:[a-z0-9][a-z0-9-]{0,63}$/),
  label: name, version: z.number().int().positive().safe(), config: configSchema,
}).strict()

/** Parse untrusted JSON; reject branches, loops, unused artifact requirements and invalid references. */
export function parseCustomFlow(value: unknown): { ok: true; value: CustomFlow } | { ok: false; problems: string[] } {
  const parsed = customFlowSchema.safeParse(value)
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) }
  const config = parsed.data.config
  const problems = validateWorkflow(config)
  if (config.start_stage !== config.stages[0]) problems.push('起始阶段必须是列表中的第一个阶段')
  if (config.transitions.length !== config.stages.length - 1 || config.transitions.some((t, i) => t.from !== config.stages[i] || t.to !== config.stages[i + 1])) {
    problems.push('第一版只支持按阶段列表顺序逐步执行，不支持跳转、分支或循环')
  }
  for (const t of config.transitions) {
    if (t.requires?.includes('artifacts_present') && !config.artifacts.some(a => a.stage === t.from)) problems.push(`${t.from}：请添加产物或取消「必填产物」`)
  }
  const terminal = config.stages[config.stages.length - 1]
  if (config.artifacts.some(a => a.stage === terminal)) problems.push('完成阶段不能设置待验收产物，请放到前一个阶段')
  if (config.commit.policy !== 'manual' && config.commit.checkpoints.length === 0) problems.push('请选择至少一个允许提交的阶段')
  return problems.length ? { ok: false, problems } : { ok: true, value: parsed.data }
}

/** Copy a template without changing its bindings; new evidence belongs to the current stage. */
export function customFromTemplate(config: WorkflowConfig, label = '我的流程'): CustomFlow {
  return { schema: 1, id: 'custom:my-workflow', label, version: 1, config: {
    ...structuredClone(config), evidence_scope: 'stage', high_risk_requires_verification: true,
  } }
}
