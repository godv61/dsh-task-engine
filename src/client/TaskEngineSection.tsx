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
import { FLOW_PRESETS, FLOW_OPTIONS, adoptRecommendation, resolveFlow, type ProjectConfig } from '../workflows.ts'
import { styles } from './styles.ts'
import { describeError } from './shared.ts'

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
  write(request: { path: string; flow: string; stage_bindings?: Record<string, StageBinding>; skill_profiles?: Record<string, SkillProfile> }): Promise<RemoteResult<EngConfigView>>
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
        setSkillProfiles(result.value.config.skill_profiles ?? {})
        setCommitRule(result.value.config.commit)
        setArtifacts(result.value.config.artifacts)
        setReviewDepth(result.value.config.review_depth)
        setCommitRequired(result.value.config.commit_required)
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
    () => validateWorkflow(resolvedConfig(flow, stageBindings, skillProfiles)),
    [flow, stageBindings, skillProfiles],
  )

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
    if (dirty && !window.confirm('当前流程配置有未保存的修改，切换流程会丢弃它们。继续切换？')) return
    setFlow(id)
    // The bindings are the user's own and are not touched by choosing a skeleton.
    setDirty(true)
    setSavedAt('')
  }

  /**
   * Adopt the current flow's recommended setup into the user's config.
   *
   * This is the explicit act that supplies a starting point: skills, commit text
   * and artifact fields. It is offered once and applied once — after this the
   * values are ordinary config, so a value the user deletes stays deleted and no
   * upgrade merges anything back.
   */
  const adopt = (): void => {
    const adopted = adoptRecommendation(flow)
    if (adopted === undefined) return
    if (dirty && !window.confirm('采用推荐配置会替换当前的技能与规则设置。继续？')) return
    setStageBindings({ ...(adopted.stage_bindings ?? {}) })
    const adoptedFlow = resolveFlow(flow, adopted)
    setSkillProfiles(adoptedFlow.ok ? adoptedFlow.config.skill_profiles ?? {} : {})
    setCommitRule(adopted.commit)
    setArtifacts(adopted.artifacts)
    setReviewDepth(adopted.review_depth)
    setDirty(true)
    setSavedAt('')
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
        <p style={styles.muted}>
          流程决定工作怎么流转（阶段与门禁）；技能、规则、提交格式和产物字段由你自己配置。
          需要一份现成的起点时，可以「采用推荐配置」——采用后这些就完全属于你，可随意修改或删除。
        </p>
      </div>

      <div style={styles.adoptRow}>
        <Button size="sm" onClick={adopt}>采用「{FLOW_PRESETS[flow]?.label ?? flow}」的推荐配置</Button>
        <span style={styles.muted}>
          写入推荐技能、提交信息格式与产物字段。仅在你点击时发生一次；删除后不会自动补回。
        </span>
      </div>

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

      <SectionCard icon={<IconSettingsOutline16 size={16} />} title="阶段技能" hint="节点选择技能；同一技能的规则在所有节点保持一致，均可修改或移除。" >
        <BindingEditor stages={stages} stageBindings={stageBindings} setStageBindings={(next) => { setStageBindings(next); setDirty(true); setSavedAt('') }} skillProfiles={skillProfiles} setSkillProfiles={(next) => { setSkillProfiles(next); setDirty(true); setSavedAt('') }} skills={skills} rules={rules} />
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
          onClick={() => { setSaving(true); void save(remote, { flow, stage_bindings: stageBindings, skill_profiles: skillProfiles, ...(commitRule !== undefined ? { commit: commitRule } : {}), ...(artifacts !== undefined ? { artifacts } : {}), ...(reviewDepth !== undefined ? { review_depth: reviewDepth } : {}), ...(commitRequired !== undefined ? { commit_required: commitRequired } : {}) }, workspace, setSavedAt, setSource).then(ok => { if (ok) { setConfigProblems([]); setDirty(false) } }).finally(() => setSaving(false)) }}
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

function BindingEditor({ stages, stageBindings, setStageBindings, skillProfiles, setSkillProfiles, skills, rules }: {
  stages: string[]
  stageBindings: Record<string, StageBinding>
  setStageBindings: (b: Record<string, StageBinding>) => void
  skillProfiles: Record<string, SkillProfile>
  setSkillProfiles: (profiles: Record<string, SkillProfile>) => void
  skills: SkillCatalogEntry[]
  rules: RuleCatalogEntry[]
}): ReturnType<typeof createElement> {
  const [stage, setStage] = useState(stages[0] ?? '')
  const [expanded, setExpanded] = useState<string | null>(null)
  // The skill catalog grows with installed and user-created skills.
  const [query, setQuery] = useState('')
  const [onlySelected, setOnlySelected] = useState(false)
  const currentStage = stages.includes(stage) ? stage : (stages[0] ?? '')

  const bindingFor = (name: string): StageBinding => stageBindings[name] ?? {}

  /**
   * The skills to render, after the search box and the selection filter.
   *
   * A bound skill always matches the search, because hiding it would make the panel disagree
   * with the configuration it is showing.
   * @returns the skills to display, in catalog order.
   */
  const visibleSkills = (): SkillCatalogEntry[] => {
    const bound = bindingFor(currentStage).skills ?? []
    const boundKeys = new Set(bound.map(entry => formatResourceRef(entry.skill)))
    const needle = query.trim().toLowerCase()
    return skills.filter(entry => {
      const raw = formatResourceRef(entry.ref)
      const inForce = boundKeys.has(raw)
      if (onlySelected && !inForce) return false
      if (needle === '') return true
      return inForce
        || entry.name.toLowerCase().includes(needle)
        || entry.description.toLowerCase().includes(needle)
        || entry.sourceLabel.toLowerCase().includes(needle)
    })
  }

  const setSkills = (name: string, next: SkillBinding[]): void => {
    setStageBindings({ ...stageBindings, [name]: { ...bindingFor(name), skills: next } })
  }

  const toggleSkill = (raw: string): void => {
    if (currentStage === '') return
    const current = bindingFor(currentStage).skills ?? []
    const profile = skillProfiles[raw]
    const next = current.some(entry => formatResourceRef(entry.skill) === raw)
      ? current.filter(entry => formatResourceRef(entry.skill) !== raw)
      : [...current, { skill: refFromText(raw), rules: profile?.rules ?? [], ...(profile?.evidence !== undefined ? { evidence: profile.evidence } : {}) }].sort((a, b) =>
        formatResourceRef(a.skill).localeCompare(formatResourceRef(b.skill)))
    if (profile === undefined) setSkillProfiles({ ...skillProfiles, [raw]: { rules: [] } })
    setSkills(currentStage, next)
  }

  if (currentStage === '') {
    return <p style={styles.muted}>当前流程没有节点。</p>
  }

  const boundSkills: SkillBinding[] = bindingFor(currentStage).skills ?? []
  const unassigned = bindingFor(currentStage).legacy_rules ?? []

  return (
    <div style={styles.section}>
      <p style={styles.hint}>
        节点只选择技能；规则在“技能”页统一维护。这里可查看技能当前生效的规则。
        需要同一技能用不同规则时，复制成另一个技能再分别配置。
      </p>
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

      <div className="te-binding-grid" key={currentStage}>
        <section className="te-binding-picker" aria-label="技能绑定">
          <div className="te-binding-heading">
            <h4>技能</h4>
            <span className="te-binding-count">
              已选 {boundSkills.length}
              {visibleSkills().length !== skills.length ? ` · 显示 ${visibleSkills().length}/${skills.length}` : ''}
            </span>
          </div>
          {/*
            Search and a source filter, because the list grows without bound. With
            a few dozen skills, scrolling to find one is the whole interaction, and a
            flat list that only gets longer stops being usable rather than merely
            becoming long.
          */}
          <div className="te-binding-controls">
            <input
              className="te-binding-search"
              type="search"
              value={query}
              placeholder="搜索技能名或说明…"
              aria-label="搜索技能"
              onChange={event => setQuery(event.target.value)}
            />
            <label className="te-binding-filter">
              <input type="checkbox" checked={onlySelected} onChange={() => setOnlySelected(value => !value)} />
              {' '}仅看已选
            </label>
          </div>
          <div className="te-binding-list" role="group" aria-label="技能列表" tabIndex={0}>
            {skills.length === 0 ? <p className="te-binding-empty">暂无技能，请在上方“技能”页添加。</p> : null}
            {skills.length > 0 && visibleSkills().length === 0
              ? <p className="te-binding-empty">没有匹配的技能。</p>
              : null}
            {visibleSkills().map(entry => {
              const raw = formatResourceRef(entry.ref)
              const bound = boundSkills.find(candidate => formatResourceRef(candidate.skill) === raw)
              const open = expanded === raw
              return (
                <div key={raw} className={`te-binding-option${bound !== undefined ? ' is-selected' : ''}`}>
                  <input
                    type="checkbox"
                    aria-label={raw}
                    checked={bound !== undefined}
                    onChange={() => toggleSkill(raw)}
                  />
                  <span className="te-binding-detail">
                    <span className="te-binding-name">
                      {entry.name}
                    </span>
                    <span className="te-binding-meta">
                      {entry.sourceLabel} · {bound === undefined ? '未绑定' : `${bound.rules.length} 条规则`}
                    </span>
                    {bound !== undefined ? (
                      <button type="button" className="te-link" onClick={() => setExpanded(open ? null : raw)}>
                        {open ? '收起规则' : '查看规则'}
                      </button>
                    ) : null}
                    {/*
                      Only the OPEN skill's rules are rendered, and inside a bounded
                      region. Expanding a second skill used to push the first off
                      screen and the page kept growing with no way to see the total.
                    */}
                    {open && bound !== undefined ? (
                      <span className="te-rule-list">
                        {bound.rules.length === 0 ? <span className="te-binding-meta">该技能尚未配置规则。</span> : null}
                        {bound.rules.map(rule => {
                          const ruleRaw = formatResourceRef(rule)
                          const catalog = rules.find(candidate => formatResourceRef(candidate.ref) === ruleRaw)
                          return <span key={ruleRaw} className="te-binding-meta">{catalog?.name ?? ruleRaw}{catalog ? `（${catalog.sourceLabel}）` : ''}</span>
                        })}
                      </span>
                    ) : null}
                  </span>
                </div>
              )
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
  config: ProjectConfig,
  workspace: string,
  setSavedAt: (s: string) => void,
  setSource: (s: string) => void,
): Promise<boolean> {
  try {
    const result = await remote.write({ path: workspace, ...config })
    if (!result.ok) { setSavedAt('保存失败：' + describeError(result.error)); return false }
    if (!result.value.ok) { setSavedAt('保存失败：' + result.value.problems.join('；')); return false }
    setSource(result.value.source)
    setSavedAt('已保存')
    return true
  } catch (error) { setSavedAt('保存失败：' + describeError(error)); return false }
}
