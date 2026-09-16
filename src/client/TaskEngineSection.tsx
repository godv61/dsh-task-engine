/**
 * The "工程流程配置" settings section: a picker over preset workflows plus one
 * editable surface — which skill/rule each node mounts. The stage graph, guards,
 * artifact fields, commit rule, and verification requirement are fixed by the
 * chosen preset, so the page no longer edits those; a project customizes
 * behavior by overriding its stage bindings (and by editing skill/rule content
 * in the sibling tabs). Editing and saving run the same `validateWorkflow` the
 * `dev_task` tool enforces.
 *
 * @module dsh-task-engine/TaskEngineSection
 */

import type { ResourceImportRequest, ResourcePreview } from '../resource-types.ts'
import { createElement, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  Button, Pill, StateDot, DisclosureRow,
  IconBranchOutline16, IconCheckOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { validateWorkflow, type StageBinding, type WorkflowConfig } from '../engine.ts'
import { FLOW_PRESETS, FLOW_OPTIONS, resolveFlow } from '../workflows.ts'
import { styles, border } from './styles.ts'
import { describeError, sourceLabel } from './shared.ts'

/** Resolve a flow id plus staged bindings into a complete config for preview (unknown ids preview the standard preset; writes still reject them). */
function resolvedConfig(flow: string, stageBindings: Record<string, StageBinding>): WorkflowConfig {
  const resolved = resolveFlow(flow, { stage_bindings: stageBindings })
  return resolved.ok ? resolved.config : FLOW_PRESETS.standard.config
}

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error?: unknown }

/** The `read`/`write` result: preset flow, resolved workflow, plus validation state. */
interface EngConfigView {
  ok: boolean
  source: 'default' | 'project' | 'invalid'
  flow: string
  config: WorkflowConfig
  problems: string[]
}

/** One skill in the mountable catalog. */
export interface SkillCatalogEntry {
  name: string
  description: string
  source: string
}

/** One rule in the mountable catalog. */
export interface RuleCatalogEntry {
  name: string
  source: string
}

/** Result of creating one skill or rule. */
export interface WriteResourceResult {
  ok: boolean
  name: string
  path: string
  error?: string
}

/** Full editable content of one skill. */
export interface ReadSkillResult {
  ok: boolean
  name: string
  description: string
  whenToUse: string
  content: string
  error?: string
}

/** Full editable content of one rule. */
export interface ReadRuleResult {
  ok: boolean
  name: string
  content: string
  error?: string
}

/** One implementation item's audit trail in the task ledger view. */
export interface TaskLedgerItem {
  id: string
  title: string
  status: string
  dispatch?: { description: string; at: string }
  review?: {
    spec: { outcome: 'pass' | 'fail'; notes?: string[] }
    quality: { outcome: 'pass' | 'fail'; notes?: string[] }
  }
}

/** One task's ledger projection: identity, stage, and per-item audit trail. */
export interface TaskLedgerEntry {
  risk_level?: string
  updated_at?: string
  verification_passed?: boolean
  review_outcome?: string
  task_id: string
  title: string
  stage: string
  branch: string
  items: TaskLedgerItem[]
}

/** `readTasks` result: every task record under the workspace's `.dsh/`. */
export interface TaskLedgerView {
  tasks: TaskLedgerEntry[]
}

/** `readInit` result: the workspace's root `AGENTS.md`, or absent. */
export interface InitView {
  exists: boolean
  content: string
  lines: number
  /** Absolute AGENTS.md location when resolved outside the workspace root. */
  path?: string
}

/** `generateInit` result: a model-drafted AGENTS.md body (not yet written). */
export interface InitDraft {
  ok: boolean
  content: string
  lines: number
  error?: string
}

/** `writeInit` result: write succeeded, or failed with the offending line count. */
export interface InitWriteResult {
  ok: boolean
  lines: number
  error?: string
}

/** The mounted `task-engine` Remote namespace. */
export interface TaskEngineRemote {
  resourceRoots(request: { kind: 'skill' | 'rule'; path: string }): Promise<RemoteResult<{ project: string; user: string }>>
  previewResource(request: ResourceImportRequest): Promise<RemoteResult<ResourcePreview>>
  importResource(request: ResourceImportRequest): Promise<RemoteResult<ResourcePreview>>
  read(path: string): Promise<RemoteResult<EngConfigView>>
  write(request: { path: string; flow: string; stage_bindings?: Record<string, StageBinding> }): Promise<RemoteResult<EngConfigView>>
  listSkills(path: string): Promise<RemoteResult<{ skills: SkillCatalogEntry[] }>>
  listRules(path: string): Promise<RemoteResult<{ rules: RuleCatalogEntry[] }>>
  writeSkill(request: { name: string; description: string; whenToUse?: string; content: string; level: 'project' | 'user'; path?: string }): Promise<RemoteResult<WriteResourceResult>>
  installSkill(request: { sourceDir: string; level: 'project' | 'user'; path?: string }): Promise<RemoteResult<WriteResourceResult>>
  listDirs(request: { path: string }): Promise<RemoteResult<{ ok: boolean; path: string; entries: { name: string; hasSkill: boolean }[]; roots: string[]; currentHasSkill: boolean; error?: string }>>
  writeRule(request: { name: string; content: string; level: 'project' | 'user'; path?: string }): Promise<RemoteResult<WriteResourceResult>>
  readSkill(request: { name: string; level: 'project' | 'user' | 'bundled'; path?: string }): Promise<RemoteResult<ReadSkillResult>>
  readRule(request: { name: string; level: 'project' | 'user' | 'bundled'; path?: string }): Promise<RemoteResult<ReadRuleResult>>
  deleteSkill(request: { name: string; level: 'project' | 'user'; path?: string }): Promise<RemoteResult<WriteResourceResult>>
  deleteRule(request: { name: string; level: 'project' | 'user'; path?: string }): Promise<RemoteResult<WriteResourceResult>>
  readTasks(path: string): Promise<RemoteResult<TaskLedgerView>>
  readInit(path: string): Promise<RemoteResult<InitView>>
  writeInit(request: { path: string; content: string; overwrite?: boolean }): Promise<RemoteResult<InitWriteResult>>
  generateInit(request: { path: string }): Promise<RemoteResult<InitDraft>>
}

/** Props the workbench hands this flow-editing tab (workspace already selected). */
interface SectionProps {
  workspace: string
  remote: TaskEngineRemote
}

const cardV: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
  border: `1px solid ${border}`, borderRadius: 8, padding: '10px 12px',
}

export function TaskEngineSection(props: SectionProps): ReturnType<typeof createElement> {
  const { remote, workspace } = props

  const [flow, setFlow] = useState('standard')
  const [stageBindings, setStageBindings] = useState<Record<string, StageBinding>>({})
  const [source, setSource] = useState<string>('default')
  const [savedAt, setSavedAt] = useState<string>('')
  const [loadError, setLoadError] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [configProblems, setConfigProblems] = useState<string[]>([])
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([])
  const [rules, setRules] = useState<RuleCatalogEntry[]>([])

  useEffect(() => {
    if (workspace === '') return
    let alive = true
    setLoadError('')
    setLoading(true)
    void remote.read(workspace).then((result) => {
      if (!alive) return
      setLoading(false)
      if (result.ok) {
        setFlow(result.value.flow)
        setStageBindings(result.value.config.stage_bindings ?? {})
        setSource(result.value.source)
        setConfigProblems(result.value.problems)
        setSavedAt('')
      } else {
        setLoadError('读取配置失败：' + describeError(result.error))
      }
    }, (error: unknown) => {
      if (alive) { setLoading(false); setLoadError('读取配置失败：' + describeError(error)) }
    })
    return () => { alive = false }
  }, [remote, workspace, loadAttempt])

  const refreshCatalogs = useCallback(() => {
    if (workspace === '') return
    void remote.listSkills(workspace).then((result) => {
      if (result.ok) setSkills(result.value.skills)
    }, () => {
      /* catalog is best-effort; bindings still render without it */
    })
    void remote.listRules(workspace).then((result) => {
      if (result.ok) setRules(result.value.rules)
    }, () => {
      /* catalog is best-effort */
    })
  }, [remote, workspace])

  useEffect(() => {
    refreshCatalogs()
  }, [refreshCatalogs])

  const stages = useMemo(() => (FLOW_PRESETS[flow] ?? FLOW_PRESETS.standard).config.stages, [flow])
  const problems = useMemo(
    () => validateWorkflow(resolvedConfig(flow, stageBindings)),
    [flow, stageBindings],
  )

  const selectFlow = (id: string): void => {
    setFlow(id)
    setStageBindings({ ...(FLOW_PRESETS[id]?.config.stage_bindings ?? {}) })
  }

  if (loadError !== '') {
    return (
      <div style={styles.wrap}>
        <h2 style={styles.title}>工程流程配置</h2>
        <div style={styles.problems}>
          <span style={styles.problemsTitle}><StateDot state="error" />读取失败</span>
          <p style={styles.muted}>{loadError}</p>
          <Button onClick={() => setLoadAttempt(n => n + 1)}>重试</Button>
        </div>
      </div>
    )
  }

  if (loading) return <p role="status">正在读取流程配置…</p>

  return (
    <div style={styles.wrap}>
      {configProblems.length > 0 && <p role="alert" style={styles.problems}>原配置有问题：{configProblems.join('；')}。请选择有效预设并保存修复。</p>}
      <div style={styles.head}>
        <h2 style={styles.title}>工程流程配置</h2>
        <p style={styles.muted}>选一套流程，再给每个节点挂上 skill / rule。阶段流转、守卫、提交规则都由流程预设固化，无需手工配置。</p>
      </div>

      <div style={styles.sourceRow}>
        <StateDot state={source === 'project' ? 'done' : source === 'invalid' ? 'warning' : 'ongoing'} />
        <span style={styles.sourceText}>{sourceText(source)}</span>
      </div>

      <div style={styles.field}>
        <span style={styles.fieldLabel}>流程预设</span>
        <div style={styles.flowGrid}>
          {FLOW_OPTIONS.map(option => {
            const active = flow === option.id
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => { selectFlow(option.id) }}
                style={{ ...styles.flowOption, ...(active ? styles.flowOptionActive : {}) }}
              >
                <span style={styles.flowOptionTitle}>
                  <StateDot state={active ? 'done' : 'ongoing'} size={8} />
                  {option.label}
                </span>
                <p style={styles.flowOptionDesc}>{option.description}</p>
              </button>
            )
          })}
        </div>
        <p style={styles.hint}>{FLOW_OPTIONS.find(option => option.id === flow)?.description}</p>
      </div>

      <SectionCard icon={<IconBranchOutline16 size={16} />} title="流程节点" hint="该流程预设固定的阶段顺序；改变流程请切换上面的预设。" >
        <div style={styles.chips}>
          {stages.map((stage) => (
            <Pill key={stage} active={stage === (FLOW_PRESETS[flow]?.config.start_stage ?? '')} title={stage === FLOW_PRESETS[flow]?.config.start_stage ? '起始阶段' : undefined}>
              {stage}
            </Pill>
          ))}
        </div>
      </SectionCard>

      <SectionCard icon={<IconSettingsOutline16 size={16} />} title="阶段技能 / 规则" hint="选一个节点，勾选它「用什么 skill（技能）」和「守哪条 rule（规则）」。流程自带的默认绑定不会因取消勾选而移除（只会保留并追加你新勾选的）；要新建或改正文，切到上方的「技能」/「规则」标签页。" >
        <BindingEditor stages={stages} stageBindings={stageBindings} setStageBindings={setStageBindings} skills={skills} rules={rules} />
      </SectionCard>

      {problems.length > 0
        ? (
          <div style={styles.problems}>
            <span style={styles.problemsTitle}><StateDot state="error" />有 {problems.length} 个问题（保存会被拒绝）</span>
            <ul style={styles.problemsList}>
              {problems.map(p => <li key={p}>{p}</li>)}
            </ul>
          </div>
        )
        : (
          <span style={styles.okText}>
            <StateDot state="done" />{source === 'project' ? '配置有效' : '使用流程预设默认绑定（尚未保存）'}
          </span>
        )}

      <div style={styles.actions}>
        <Button
          variant="primary"
          size="md"
          icon={<IconCheckOutline16 size={16} />}
          disabled={problems.length > 0 || saving}
          onClick={() => { setSaving(true); void save(remote, flow, stageBindings, workspace, setSavedAt, setSource).then(ok => { if (ok) setConfigProblems([]) }).finally(() => setSaving(false)) }}
        >
          {saving ? '正在保存…' : '保存到 .dsh/eng.json'}
        </Button>
        {savedAt !== ''
          ? (
            <span style={styles.okText}><StateDot state={savedAt.startsWith('已') ? 'done' : 'error'} />{savedAt}</span>
          )
          : null}
      </div>
    </div>
  )
}

function sourceText(source: string): string {
  switch (source) {
    case 'project': return '项目配置（.dsh/eng.json）'
    case 'invalid': return '原文件无法解析，显示标准预设'
    default: return '标准预设（工作区尚无 .dsh/eng.json）'
  }
}

interface SectionCardProps {
  icon: ReturnType<typeof createElement>
  title: string
  hint?: string
  children: ReturnType<typeof createElement>
}

function SectionCard({ icon, title, hint, children }: SectionCardProps): ReturnType<typeof createElement> {
  const [open, setOpen] = useState(true)
  return (
    <div style={styles.section}>
      <DisclosureRow
        icon={icon}
        title={title}
        open={open}
        expandable
        onToggle={() => { setOpen(!open) }}
        keepContentWhenOpen
      >
        <div style={styles.cardBody}>
          {hint !== undefined ? <p style={styles.muted}>{hint}</p> : null}
          {children}
        </div>
      </DisclosureRow>
    </div>
  )
}

function BindingEditor({ stages, stageBindings, setStageBindings, skills, rules }: {
  stages: string[]
  stageBindings: Record<string, StageBinding>
  setStageBindings: (b: Record<string, StageBinding>) => void
  skills: SkillCatalogEntry[]
  rules: RuleCatalogEntry[]
}): ReturnType<typeof createElement> {
  const [stage, setStage] = useState(stages[0] ?? '')
  const currentStage = stages.includes(stage) ? stage : (stages[0] ?? '')

  const toggleSkill = (skill: string): void => {
    if (currentStage === '') return
    const current = stageBindings[currentStage]?.skills ?? []
    const next = current.includes(skill) ? current.filter(s => s !== skill) : [...current, skill].sort()
    setStageBindings({ ...stageBindings, [currentStage]: { ...(stageBindings[currentStage] ?? {}), skills: next } })
  }

  const toggleRule = (rule: string): void => {
    if (currentStage === '') return
    const current = stageBindings[currentStage]?.rules ?? []
    const next = current.includes(rule) ? current.filter(s => s !== rule) : [...current, rule].sort()
    setStageBindings({ ...stageBindings, [currentStage]: { ...(stageBindings[currentStage] ?? {}), rules: next } })
  }

  if (currentStage === '') {
    return <p style={styles.muted}>当前流程没有节点。</p>
  }

  const boundSkills = stageBindings[currentStage]?.skills ?? []
  const boundRules = stageBindings[currentStage]?.rules ?? []

  return (
    <div style={styles.section}>
      <p style={styles.hint}>绑定按名称生效；同名资源可在资源管理中按项目／个人分别查看。完成节点的技能必须在进入完成前执行，测试技能建议放在交付节点。</p>
      <div style={styles.field}>
        <span style={styles.fieldLabel}>选择节点（改哪个节点的挂载）</span>
        <div style={styles.chips}>
          {stages.map(s => (
            <Pill key={s} active={s === currentStage} onClick={() => { setStage(s) }}>{s}</Pill>
          ))}
        </div>
      </div>

      <div style={cardV}>
        <div style={styles.bindingStage}>
          <span style={styles.fieldLabel}>skill（这个节点做什么）</span>
          <div style={styles.chips}>
            {skills.length === 0
              ? <span style={styles.sourceBadge}>暂无可用 skill —— 切到上方「技能」标签页新建</span>
              : skills.filter((sk, index, all) => all.findIndex(other => other.name === sk.name) === index).map(sk => (
                <Pill key={sk.name} active={boundSkills.includes(sk.name)} onClick={() => { toggleSkill(sk.name) }} title={`${sk.description}（${sourceLabel(sk.source)}）`}>
                  {sk.name}
                  {sk.source !== 'bundled' ? <span style={styles.sourceBadge}>（{sourceLabel(sk.source)}）</span> : null}
                </Pill>
              ))}
          </div>
        </div>

        <div style={styles.bindingStage}>
          <span style={styles.fieldLabel}>rule（这个节点守什么）</span>
          <div style={styles.chips}>
            {rules.length === 0
              ? <span style={styles.sourceBadge}>暂无可用 rule —— 切到上方「规则」标签页新建</span>
              : rules.filter((rule, index, all) => all.findIndex(other => other.name === rule.name) === index).map(rule => (
                <Pill key={rule.name} active={boundRules.includes(rule.name)} onClick={() => { toggleRule(rule.name) }} title={`来源：${sourceLabel(rule.source)}`}>
                  {rule.name}
                  {rule.source !== 'bundled' ? <span style={styles.sourceBadge}>（{sourceLabel(rule.source)}）</span> : null}
                </Pill>
              ))}
          </div>
        </div>

        {boundSkills.length === 0 && boundRules.length === 0
          ? <p style={styles.hint}>这个节点还没挂任何 skill / rule —— 点上面的名称勾选。</p>
          : null}
      </div>
    </div>
  )
}

async function save(remote: TaskEngineRemote, flow: string, stageBindings: Record<string, StageBinding>, workspace: string, setSavedAt: (s: string) => void, setSource: (s: string) => void): Promise<boolean> {
  try {
    const result = await remote.write({ path: workspace, flow, stage_bindings: stageBindings })
    if (!result.ok) { setSavedAt('保存失败：' + describeError(result.error)); return false }
    if (!result.value.ok) { setSavedAt('保存失败：' + result.value.problems.join('；')); return false }
    setSource(result.value.source)
    setSavedAt('已保存')
    return true
  } catch (error) { setSavedAt('保存失败：' + describeError(error)); return false }
}
