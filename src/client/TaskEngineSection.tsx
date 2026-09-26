/**
 * The "工程流程配置" settings section: a picker over preset workflows plus one
 * editable surface — which skill/rule each node mounts. The stage graph and
 * guards are fixed by the chosen preset; text and artifact conventions are
 * optional user configuration. Editing and saving run the same `validateWorkflow` the
 * `dev_task` tool enforces.
 *
 * @module dsh-task-engine/TaskEngineSection
 */

import type { ResourceImportRequest, ResourcePreview } from '../resource-types.ts'
import { createElement, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button, Pill, StateDot, DisclosureRow,
  IconCheckOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  formatResourceRef,
  parseResourceRef,
  validateWorkflow,
  type ArtifactDef,
  type CommitRule,
  type ResourceRef,
  type ReviewDepth,
  type SkillBinding,
  type SkillProfile,
  type StageBinding,
  type WorkflowConfig,
} from '../engine.ts'

/**
 * Read a `source:name` reference produced by the catalog, falling back to the
 * bundled layer for a bare name.
 *
 * Every reference the UI writes is source-qualified, because a bare name cannot
 * say which layer was meant once project and user directories can both hold one.
 * The fallback exists only so a hand-written config that still carries bare names
 * can be opened without crashing, mirroring how the engine resolves legacy text.
 * @param text - the reference text from a catalog entry.
 * @returns the parsed reference.
 */
function refFromText(text: string): ResourceRef {
  return parseResourceRef(text) ?? { source: 'bundled', name: text }
}
import { FLOW_PRESETS, FLOW_OPTIONS, adoptRecommendation, resolveFlow, retainStageBindings, type ProjectConfig } from '../workflows.ts'
import { styles } from './styles.ts'
import { describeError } from './shared.ts'
import { SkillRuleDialog } from './SkillRuleDialog.tsx'

/**
 * Resolve a flow id plus the user's staged bindings into a complete config for preview.
 *
 * The preset is a skeleton, so a bare `{ stage_bindings }` is the WHOLE config: the
 * user's bindings, and nothing merged in behind them. Unknown ids preview the
 * standard preset; writes still reject them.
 * @param flow - preset id.
 * @param stageBindings - the user's staged bindings.
 * @returns the resolved config.
 */
function resolvedConfig(flow: string, stageBindings: Record<string, StageBinding>, skillProfiles: Record<string, SkillProfile>): WorkflowConfig {
  const resolved = resolveFlow(flow, { flow, stage_bindings: stageBindings, skill_profiles: skillProfiles })
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
  adoption?: { created: string[]; reused: string[] }
}

/** One skill in the mountable catalog. */
export interface SkillCatalogEntry {
  name: string
  description: string
  source: string
  /** Source-qualified reference, so two same-named skills in different layers stay distinct. */
  ref: ResourceRef
  /** Localized label for `ref.source`, resolved once so the list does not re-derive it. */
  sourceLabel: string
}

/** One rule in the mountable catalog. */
export interface RuleCatalogEntry {
  name: string
  source: string
  /** Source-qualified reference, so two same-named rules in different layers stay distinct. */
  ref: ResourceRef
  /** Localized label for `ref.source`. */
  sourceLabel: string
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
  write(request: { path: string; flow: string; stage_bindings?: Record<string, StageBinding>; skill_profiles?: Record<string, SkillProfile>; materialize_bundled?: 'project' | 'user' }): Promise<RemoteResult<EngConfigView>>
  listSkills(path: string): Promise<RemoteResult<{ skills: SkillCatalogEntry[] }>>
  listRules(path: string): Promise<RemoteResult<{ rules: RuleCatalogEntry[] }>>
  writeSkill(request: { name: string; description: string; whenToUse?: string; content: string; level: 'project' | 'user'; path?: string }): Promise<RemoteResult<WriteResourceResult>>
  installSkill(request: { sourceDir: string; level: 'project' | 'user'; path?: string }): Promise<RemoteResult<WriteResourceResult>>
  listDirs(request: { path: string }): Promise<RemoteResult<{ ok: boolean; path: string; entries: { name: string; hasSkill: boolean }[]; roots: string[]; currentHasSkill: boolean; error?: string }>>
  writeRule(request: { name: string; content: string; level: 'project' | 'user'; path?: string }): Promise<RemoteResult<WriteResourceResult>>
  writeUserSkillProfile(request: { name: string; profile: SkillProfile }): Promise<RemoteResult<{ ok: boolean; error?: string }>>
  readSkill(request: { name: string; level: 'project' | 'codex-project' | 'user' | 'bundled'; path?: string }): Promise<RemoteResult<ReadSkillResult>>
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

export function TaskEngineSection(props: SectionProps): ReturnType<typeof createElement> {
  const { remote, workspace } = props

  const [flow, setFlow] = useState('standard')
  const [stageBindings, setStageBindings] = useState<Record<string, StageBinding>>({})
  const [skillProfiles, setSkillProfiles] = useState<Record<string, SkillProfile>>({})
  // The panel holds the WHOLE config it is editing, not only the bindings. It
  // used to keep just the bindings and send just those, so a commit rule, the
  // artifact declarations and the review depth were resolved for the preview and
  // then dropped on save — the panel showed one config and the file held another.
  const [commitRule, setCommitRule] = useState<CommitRule | undefined>(undefined)
  const [artifacts, setArtifacts] = useState<ArtifactDef[] | undefined>(undefined)
  const [reviewDepth, setReviewDepth] = useState<ReviewDepth | undefined>(undefined)
  const [commitRequired, setCommitRequired] = useState<boolean | undefined>(undefined)
  const [source, setSource] = useState<string>('default')
  const [savedAt, setSavedAt] = useState<string>('')
  /** True while the in-memory bindings differ from what is on disk. */
  const [dirty, setDirty] = useState(false)
  const [loadError, setLoadError] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [configProblems, setConfigProblems] = useState<string[]>([])
  const [flowNotice, setFlowNotice] = useState('')
  const [pendingAdoption, setPendingAdoption] = useState(false)
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([])
  const [rules, setRules] = useState<RuleCatalogEntry[]>([])
  const [configuringSkill, setConfiguringSkill] = useState<ResourceRef | null>(null)

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
        setSkillProfiles(result.value.config.skill_profiles ?? {})
        setCommitRule(result.value.config.commit)
        setArtifacts(result.value.config.artifacts)
        setReviewDepth(result.value.config.review_depth)
        setCommitRequired(result.value.config.commit_required)
        setSource(result.value.source)
        setConfigProblems(result.value.problems)
        setFlowNotice('')
        setPendingAdoption(false)
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
      /* catalog is best-effort; the existing profile remains editable */
    })
  }, [remote, workspace])

  useEffect(() => {
    refreshCatalogs()
  }, [refreshCatalogs])

  const stages = useMemo(() => (FLOW_PRESETS[flow] ?? FLOW_PRESETS.standard).config.stages, [flow])
  const problems = useMemo(
    () => validateWorkflow(resolvedConfig(flow, stageBindings, skillProfiles)),
    [flow, stageBindings, skillProfiles],
  )
  const hasBundledReferences = useMemo(() =>
    Object.values(stageBindings).some(binding =>
      (binding.skills ?? []).some(entry => entry.skill.source === 'bundled'
        || (entry.skill.source !== 'user' && entry.rules.some(rule => rule.source === 'bundled')))
      || (binding.skill_refs ?? []).some(ref => ref.source === 'bundled'))
    || Object.entries(skillProfiles).some(([key, profile]) =>
      key.startsWith('bundled:') || (!key.startsWith('user:') && profile.rules.some(rule => rule.source === 'bundled'))),
  [stageBindings, skillProfiles])

  /**
   * Switch flow skeletons, protecting unsaved edits.
   *
   * Selecting a flow chooses how work MOVES and nothing else. It deliberately does
   * not seed any skills, commit format or artifact fields: those are engineering
   * method, and the user receives them only by pressing the adopt button. Seeding
   * them here is what previously made a preset's built-in method forced on every
   * project the moment a flow was picked.
   *
   * Clicking the already-selected flow is a no-op, so a stray click cannot discard
   * the user's work.
   */
  const selectFlow = (id: string): void => {
    if (id === flow) return
    const { bindings, dropped } = retainStageBindings(id, stageBindings)
    if (dirty && dropped.length > 0 && !window.confirm(`切换后将移除不属于新流程的节点绑定：${dropped.join('、')}。继续？`)) return
    setStageBindings(bindings)
    setFlowNotice(dropped.length > 0
      ? `已移除不属于「${FLOW_PRESETS[id]?.label ?? id}」的节点绑定：${dropped.join('、')}。保存后才会写入项目配置。`
      : '')
    setFlow(id)
    setPendingAdoption(false)
    // Shared stages keep their bindings; a removed stage cannot be saved against
    // the new state graph and must not silently remain as an invalid hidden key.
    setDirty(true)
    setSavedAt('')
  }

  /**
   * Adopt the current flow's recommended setup into the user's config.
   *
   * This is the explicit act that supplies optional text and artifact fields.
   * Existing skill and rule bindings remain the user's choice. After this the
   * values are ordinary config, so a value the user deletes stays deleted and no
   * upgrade merges anything back.
   */
  const adopt = (): void => {
    const adopted = adoptRecommendation(flow, {
      flow, stage_bindings: stageBindings, skill_profiles: skillProfiles,
      ...(commitRequired !== undefined ? { commit_required: commitRequired } : {}),
    })
    if (adopted === undefined) return
    if (dirty && !window.confirm('采用推荐的提交文本、产物字段和评审深度？现有技能与规则会保留。')) return
    setFlowNotice('')
    setCommitRule(adopted.commit)
    setArtifacts(adopted.artifacts)
    setReviewDepth(adopted.review_depth)
    setDirty(true)
    setSavedAt('')
  }

  const updateSkillProfile = async (profile: SkillProfile): Promise<void> => {
    if (!configuringSkill) return
    if (configuringSkill.source === 'user') {
      const result = await remote.writeUserSkillProfile({ name: configuringSkill.name, profile })
      if (!result.ok || !result.value.ok) throw new Error(result.ok ? result.value.error : '保存用户级技能规则失败，请重试。')
    }
    const key = formatResourceRef(configuringSkill)
    const bindings: Record<string, StageBinding> = {}
    for (const [name, binding] of Object.entries(stageBindings)) {
      bindings[name] = { ...binding, skills: binding.skills?.map(entry =>
        formatResourceRef(entry.skill) === key
          ? { skill: entry.skill, rules: profile.rules, ...(profile.evidence ? { evidence: profile.evidence } : {}) }
          : entry) }
    }
    setStageBindings(bindings)
    setSkillProfiles({ ...skillProfiles, [key]: profile })
    setDirty(true)
    setSavedAt('')
    setConfiguringSkill(null)
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
    <div className={`te-config-layout${configuringSkill ? ' is-open' : ''}`}>
    <div className="te-config-main" style={styles.wrap}>
      {configProblems.length > 0 && <p role="alert" style={styles.problems}>原配置有问题：{configProblems.join('；')}。请选择有效预设并保存修复。</p>}
      {flowNotice && <p role="status" className="te-flow-notice">{flowNotice}</p>}
      <div style={styles.head}>
        <h2 style={styles.title}>工程流程配置</h2>
        <p style={styles.muted}>
          流程决定工作怎么流转（阶段与门禁）；技能、规则、提交格式和产物字段由你自己配置。
          需要提交文本、产物字段和评审深度的起点时，可以「采用推荐配置」。技能与规则请按项目需要自行创建并绑定。
        </p>
      </div>

      <div style={styles.adoptRow}>
        <Button size="sm" onClick={adopt}>采用「{FLOW_PRESETS[flow]?.label ?? flow}」的推荐配置</Button>
        <span style={styles.muted}>
          仅写入可修改的文本与字段，不增删现有技能和规则绑定。
        </span>
      </div>
      {hasBundledReferences && <div style={styles.adoptRow}>
        <Button size="sm" onClick={() => {
          setPendingAdoption(true)
          setDirty(true)
          setSavedAt('')
          setFlowNotice('保存后会把当前配置中的内置引用复制到项目，保留已有项目副本及其他配置。')
        }}>把当前内置引用迁移到项目</Button>
        <span style={styles.muted}>将当前内置引用复制为项目资源。</span>
      </div>}

      <div style={styles.sourceRow}>
        <StateDot state={source === 'project' ? 'done' : source === 'invalid' ? 'warning' : 'ongoing'} />
        <span style={styles.sourceText}>{sourceText(source)}</span>
      </div>

      <div style={styles.field}>
        <h3>流程预设</h3>
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
      </div>

      <SectionCard icon={<IconSettingsOutline16 size={16} />} title="阶段技能" >
        <BindingEditor stages={stages} stageBindings={stageBindings} setStageBindings={(next) => { setStageBindings(next); setDirty(true); setSavedAt('') }} skillProfiles={skillProfiles} setSkillProfiles={(next) => { setSkillProfiles(next); setDirty(true); setSavedAt('') }} skills={skills} onConfigureSkill={setConfiguringSkill} />
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
            <StateDot state="done" />{source === 'project' ? '配置有效' : '使用空白流程配置（尚未保存）'}
          </span>
        )}

      <div style={styles.actions}>
        <Button
          variant="primary"
          size="md"
          icon={<IconCheckOutline16 size={16} />}
          disabled={problems.length > 0 || saving}
          onClick={() => { setSaving(true); void save(remote, { flow, stage_bindings: stageBindings, skill_profiles: skillProfiles, ...(commitRule !== undefined ? { commit: commitRule } : {}), ...(artifacts !== undefined ? { artifacts } : {}), ...(reviewDepth !== undefined ? { review_depth: reviewDepth } : {}), ...(commitRequired !== undefined ? { commit_required: commitRequired } : {}), ...(pendingAdoption ? { materialize_bundled: 'project' as const } : {}) }, workspace, setSavedAt, setSource).then(view => { if (view) { setConfigProblems([]); setDirty(false); setPendingAdoption(false); setStageBindings(view.config.stage_bindings ?? {}); setSkillProfiles(view.config.skill_profiles ?? {}); refreshCatalogs() } }).finally(() => setSaving(false)) }}
        >
          {saving ? '正在保存…' : dirty ? '保存到 .dsh/eng.json' : '已保存 · 无需保存'}
        </Button>
        {savedAt !== ''
          ? (
            <span style={styles.okText}><StateDot state={savedAt.startsWith('已') ? 'done' : 'error'} />{savedAt}</span>
          )
          : null}
      </div>
    </div>
      {configuringSkill ? <SkillRuleDialog key={formatResourceRef(configuringSkill)} skill={configuringSkill}
        profile={skillProfiles[formatResourceRef(configuringSkill)]}
        rules={configuringSkill.source === 'user' ? rules.filter(rule => rule.ref.source !== 'project') : rules}
        description={configuringSkill.source === 'user'
          ? '用户级技能的规则配置立即保存到用户目录，所有项目与会话共用；节点选择仍需在页面底部保存。'
          : '规则属于技能，所有引用此技能的节点都会同步。应用后请点击页面底部保存。'}
        saveLabel={configuringSkill.source === 'user' ? '保存用户级规则' : '应用到当前配置'}
        onSave={updateSkillProfile} onClose={() => setConfiguringSkill(null)} /> : null}
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
        titleClassName="te-disclosure-title"
        open={open}
        expandable
        expandOnRowClick
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

function BindingEditor({ stages, stageBindings, setStageBindings, skillProfiles, setSkillProfiles, skills, onConfigureSkill }: {
  stages: string[]
  stageBindings: Record<string, StageBinding>
  setStageBindings: (b: Record<string, StageBinding>) => void
  skillProfiles: Record<string, SkillProfile>
  setSkillProfiles: (profiles: Record<string, SkillProfile>) => void
  skills: SkillCatalogEntry[]
  onConfigureSkill: (ref: ResourceRef) => void
}): ReturnType<typeof createElement> {
  const [stage, setStage] = useState(stages[0] ?? '')
  const [query, setQuery] = useState('')
  const currentStage = stages.includes(stage) ? stage : (stages[0] ?? '')

  const bindingFor = (name: string): StageBinding => stageBindings[name] ?? {}

  const setSkills = (name: string, next: SkillBinding[]): void => {
    setStageBindings({ ...stageBindings, [name]: { ...bindingFor(name), skills: next } })
  }

  const toggleSkill = (raw: string): void => {
    if (currentStage === '') return
    const current = bindingFor(currentStage).skills ?? []
    const profile = skillProfiles[raw]
    const alreadyBound = current.some(entry => formatResourceRef(entry.skill) === raw)
    const next = alreadyBound
      ? current.filter(entry => formatResourceRef(entry.skill) !== raw)
      : [...current, { skill: refFromText(raw), rules: profile?.rules ?? [], ...(profile?.evidence !== undefined ? { evidence: profile.evidence } : {}) }].sort((a, b) =>
        formatResourceRef(a.skill).localeCompare(formatResourceRef(b.skill)))
    if (!alreadyBound && profile === undefined) setSkillProfiles({ ...skillProfiles, [raw]: { rules: [] } })
    setSkills(currentStage, next)
  }

  if (currentStage === '') {
    return <p style={styles.muted}>当前流程没有节点。</p>
  }

  const boundSkills: SkillBinding[] = bindingFor(currentStage).skills ?? []
  const unassigned = bindingFor(currentStage).legacy_rules ?? []
  const boundKeys = new Set(boundSkills.map(entry => formatResourceRef(entry.skill)))
  const needle = query.trim().toLowerCase()
  const available = skills.filter(entry => !boundKeys.has(formatResourceRef(entry.ref))
    && `${entry.name} ${entry.description} ${entry.sourceLabel}`.toLowerCase().includes(needle))

  return (
    <div style={styles.section}>
      <div style={styles.field}>
        <span style={styles.bindingLabel}>选择节点</span>
        <div style={styles.chips}>
          {stages.map(s => (
            <Pill key={s} active={s === currentStage} onClick={() => { setStage(s) }}>{s}</Pill>
          ))}
        </div>
      </div>

      {/* Legacy stage-level rules keep working and stay visible until assigned. */}
      {unassigned.length > 0 ? (
        <div className="te-alert">
          以下规则属于<strong>节点</strong>而不是任何技能（旧配置）：{unassigned.join('、')}。
          它们仍然生效，但需要指定归属——把每条规则加到你希望承载它的技能下，然后从这里移除；
          若同一技能在不同节点需要不同规则，请复制该技能再分别配置。
        </div>
      ) : null}

      <div className="te-transfer" key={currentStage}>
        <section className="te-transfer-pane" aria-label="可用技能">
          <div className="te-binding-heading"><h4>可用技能</h4><span className="te-binding-count">{skills.filter(entry => !boundKeys.has(formatResourceRef(entry.ref))).length} 项</span></div>
          <input className="te-input te-transfer-search" type="search" value={query} placeholder="搜索技能名称或说明" aria-label="搜索可用技能" onChange={event => setQuery(event.target.value)} />
          <div className="te-transfer-list" role="group" aria-label="可用技能列表">
            {skills.length === 0 ? <p className="te-binding-empty">暂无技能，请先在“技能”页添加。</p> : null}
            {skills.length > 0 && available.length === 0 ? <p className="te-binding-empty">没有可添加的技能。</p> : null}
            {available.map(entry => <button key={formatResourceRef(entry.ref)} type="button" className="te-transfer-row" onClick={() => toggleSkill(formatResourceRef(entry.ref))} aria-label={`添加技能 ${entry.name}`}>
              <span className="te-transfer-row-main"><strong>{entry.name}</strong><small>{entry.sourceLabel}{entry.description ? ` · ${entry.description}` : ''}</small></span>
              <span className="te-transfer-action" aria-hidden="true">＋</span>
            </button>)}
          </div>
        </section>
        <div className="te-transfer-arrow" aria-hidden="true">→</div>
        <section className="te-transfer-pane" aria-label="当前节点技能">
          <div className="te-binding-heading"><h4>{currentStage} · 已绑定</h4><span className="te-binding-count">{boundSkills.length} 项</span></div>
          <p className="te-transfer-caption">规则属于技能；点“配置规则”即可统一修改。</p>
          <div className="te-transfer-list" role="group" aria-label="已绑定技能列表">
            {boundSkills.length === 0 ? <p className="te-binding-empty">此节点尚未绑定技能。点击左侧 ＋ 添加。</p> : null}
            {boundSkills.map(entry => {
              const raw = formatResourceRef(entry.skill)
              const catalog = skills.find(skill => formatResourceRef(skill.ref) === raw)
              return <div key={raw} className="te-transfer-row is-bound">
                <span className="te-transfer-row-main"><strong>{entry.skill.name}</strong><small>{catalog?.sourceLabel ?? entry.skill.source} · {entry.rules.length} 条规则{catalog ? '' : ' · 资源未找到'}</small></span>
                <span className="te-transfer-actions">
                  <button type="button" className="te-transfer-config" onClick={() => onConfigureSkill(entry.skill)}>配置规则</button>
                  <button type="button" className="te-transfer-remove" onClick={() => toggleSkill(raw)} aria-label={`移除技能 ${entry.skill.name}`}>×</button>
                </span>
              </div>
            })}
          </div>
        </section>
      </div>
    </div>
  )
}

/**
 * Persist the configuration the user is editing.
 *
 * The commit rule, artifact declarations and review depth go with the bindings.
 * Sending only `stage_bindings` meant those three were resolved for the preview and
 * then dropped on save, so the panel showed one config while the file held another.
 * @param remote - the task-engine remote.
 * @param config - the config being saved, as the panel currently shows it.
 * @param workspace - absolute workspace directory.
 * @param setSavedAt - status setter.
 * @param setSource - source setter.
 * @returns whether the save succeeded.
 */
async function save(
  remote: TaskEngineRemote,
  config: ProjectConfig & { materialize_bundled?: 'project' | 'user' },
  workspace: string,
  setSavedAt: (s: string) => void,
  setSource: (s: string) => void,
): Promise<EngConfigView | undefined> {
  try {
    const result = await remote.write({ path: workspace, ...config })
    if (!result.ok) { setSavedAt('保存失败：' + describeError(result.error)); return undefined }
    if (!result.value.ok) { setSavedAt('保存失败：' + result.value.problems.join('；')); return undefined }
    setSource(result.value.source)
    const reused = result.value.adoption?.reused.length ?? 0
    setSavedAt(reused > 0 ? `已保存；保留了 ${reused} 份已有项目资源` : '已保存')
    return result.value
  } catch (error) { setSavedAt('保存失败：' + describeError(error)); return undefined }
}
