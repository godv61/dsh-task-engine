/**
 * The "项目初始化" tab of the workbench: shows the workspace's root `AGENTS.md`,
 * lets the user regenerate it from an AI scan of the project, or edit and write
 * it by hand. The model draft is a preview only — nothing is written until the
 * user confirms, so overwriting an existing governance file is always a
 * deliberate, human-actioned step.
 *
 * @module dsh-task-engine/InitPanel
 */

import { createElement, useCallback, useEffect, useState, type CSSProperties, type ChangeEvent } from 'react'
import { Button, MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { styles } from './styles.ts'
import { describeError } from './shared.ts'
import type { InitDraft, InitView, TaskEngineRemote } from './TaskEngineSection.tsx'
import type { ProjectInitPreview, ProjectInitPromptView } from './TaskEngineSection.tsx'
import { missingProjectMetaSkills, projectMetaSkillTargets, type InitResource } from '../project-init.ts'
import { META_STAGES } from '../adaptive.ts'

/** Stable localized chrome for the Markdown body. */
const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

/** Frontend mirror of the Host generate timeout, for the elapsed counter. */
const INIT_TIMEOUT_S = 150

const card: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12,
  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '12px 14px',
}

export function InitPanel({ workspace, remote }: {
  workspace: string
  remote: TaskEngineRemote
}): ReturnType<typeof createElement> {
  const [view, setView] = useState<InitView | null>(null)
  const [generating, setGenerating] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [draft, setDraft] = useState<InitDraft | null>(null)
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState('')
  const [msg, setMsg] = useState('')
  const [projectInitMsg, setProjectInitMsg] = useState('')
  const [projectBusy, setProjectBusy] = useState(false)
  const [projectDraft, setProjectDraft] = useState<ProjectInitPreview | null>(null)
  const [projectResources, setProjectResources] = useState<InitResource[]>([])
  const [projectPlan, setProjectPlan] = useState<ProjectInitPromptView | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [planMessage, setPlanMessage] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [userPrompt, setUserPrompt] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)

  useEffect(() => {
    if (!generating && !projectBusy) {
      setElapsed(0)
      return
    }
    const started = Date.now()
    setElapsed(0)
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - started) / 1000))
    }, 1000)
    return () => { clearInterval(timer) }
  }, [generating, projectBusy])

  useEffect(() => {
    setProjectDraft(null)
    setProjectResources([])
    setProjectInitMsg('')
    setProjectPlan(null)
    setSystemPrompt('')
    setUserPrompt('')
    setPromptDirty(false)
    setPlanBusy(true)
    let active = true
    void remote.inspectProjectInit({ path: workspace }).then(result => {
      if (!active) return
      setPlanBusy(false)
      if (!result.ok) { setPlanMessage(`读取初始化计划失败：${describeError(result.error)}`); return }
      setProjectPlan(result.value)
      setSystemPrompt(result.value.system_prompt)
      setUserPrompt(result.value.user_prompt)
      setPlanMessage('')
    }, error => {
      if (!active) return
      setPlanBusy(false)
      setPlanMessage(`读取初始化计划失败：${error instanceof Error ? error.message : String(error)}`)
    })
    return () => { active = false }
  }, [workspace, remote])

  const reloadProjectPlan = async (): Promise<void> => {
    if (promptDirty && !window.confirm('重新扫描将覆盖本页修改的初始化提示词，确定继续？')) return
    setPlanBusy(true)
    setPlanMessage('')
    try {
      const result = await remote.inspectProjectInit({ path: workspace })
      if (!result.ok) throw new Error(describeError(result.error))
      setProjectPlan(result.value)
      setSystemPrompt(result.value.system_prompt)
      setUserPrompt(result.value.user_prompt)
      setPromptDirty(false)
    } catch (error) {
      setPlanMessage(`重新扫描失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setPlanBusy(false) }
  }

  const generateProject = async (): Promise<void> => {
    setProjectBusy(true)
    setProjectDraft(null)
    setProjectResources([])
    setProjectInitMsg('')
    try {
      const result = await remote.generateProjectInit({ path: workspace, system_prompt: systemPrompt, user_prompt: userPrompt })
      if (!result.ok) throw new Error(describeError(result.error))
      if (!result.value.ok) throw new Error(result.value.error ?? '项目初始化提案无效')
      setProjectDraft(result.value)
      setProjectResources(result.value.resources)
      setProjectInitMsg('提案已生成并校验。请逐项审阅内容与挂载关系，确认后再写入。')
    } catch (error) {
      setProjectInitMsg(`生成失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setProjectBusy(false) }
  }

  const updateProjectResource = (index: number, change: Partial<InitResource>): void => {
    setProjectResources(current => current.map((resource, at) => at === index ? { ...resource, ...change } : resource))
    setProjectDraft(null)
    setProjectInitMsg('提案已修改。请先点击“检查修改”，通过后才能写入。')
  }

  const checkProject = async (): Promise<void> => {
    setProjectBusy(true)
    setProjectInitMsg('')
    try {
      const result = await remote.previewProjectInit({ path: workspace, resources: projectResources })
      if (!result.ok) throw new Error(describeError(result.error))
      if (!result.value.ok) throw new Error(result.value.error ?? '提案校验失败')
      setProjectDraft(result.value)
      setProjectInitMsg('提案检查通过，可以确认写入。')
    } catch (error) {
      setProjectDraft(null)
      setProjectInitMsg(`检查失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setProjectBusy(false) }
  }

  const applyProject = async (): Promise<void> => {
    if (projectDraft === null || !window.confirm(`确认在 ${workspace} 创建 ${projectDraft.files_to_create.length} 个 Skill / Rule 文件并更新 .dsh/meta.json？`)) return
    setProjectBusy(true)
    setProjectInitMsg('')
    try {
      const result = await remote.applyProjectInit({ path: workspace, resources: projectDraft.resources,
        expected_hash: projectDraft.expected_hash, existing_hash: projectDraft.existing_hash })
      if (!result.ok) throw new Error(describeError(result.error))
      if (!result.value.ok) throw new Error(result.value.error ?? '写入失败')
      setProjectInitMsg(`已创建 ${result.value.created.length} 个项目配置文件：${result.value.created.join('、')}`)
      setProjectDraft(null)
      setProjectResources([])
    } catch (error) {
      setProjectInitMsg(`写入失败：${error instanceof Error ? error.message : String(error)}。若已有部分文件，请刷新并检查。`)
    } finally { setProjectBusy(false) }
  }

  const refresh = useCallback(() => {
    void remote.readInit(workspace).then((r) => {
      if (r.ok) setView(r.value)
    }, () => {
      /* init view is best-effort */
    })
  }, [remote, workspace])

  useEffect(() => { refresh() }, [refresh])

  const generate = async (): Promise<void> => {
    setMsg('')
    setGenerating(true)
    setDraft(null)
    setEditing(false)
    const r = await remote.generateInit({ path: workspace })
    setGenerating(false)
    if (!r.ok) {
      setMsg('生成失败：' + describeError(r.error))
      return
    }
    if (!r.value.ok) {
      setMsg('生成失败：' + (r.value.error ?? '未知错误'))
      return
    }
    setDraft(r.value)
  }

  const write = async (content: string, overwrite: boolean): Promise<void> => {
    setMsg('')
    const r = await remote.writeInit({ path: workspace, content, overwrite })
    if (!r.ok) {
      setMsg('保存失败：' + describeError(r.error))
      return
    }
    if (!r.value.ok) {
      setMsg('保存失败：' + (r.value.error ?? '未知错误'))
      return
    }
    setDraft(null)
    setEditing(false)
    setMsg(`已写入 AGENTS.md（${r.value.lines} 行）`)
    refresh()
  }

  const startEdit = (): void => {
    setEditing(true)
    setDraft(null)
    setBody(view?.content ?? '')
    setMsg('')
  }

  const exists = view?.exists === true
  const plannedSkills = projectPlan?.inventory.suggestions.filter(item => item.kind === 'skill') ?? []
  const plannedRules = projectPlan?.inventory.suggestions.filter(item => item.kind === 'rule') ?? []
  const proposedSkills = projectResources.filter(item => item.kind === 'skill')
  const proposedRules = projectResources.filter(item => item.kind === 'rule')
  const existingSkillNames = new Set(projectPlan?.existing.filter(item => item.exists).map(item => item.name) ?? [])
  const missingStageSkills = projectPlan === null ? []
    : missingProjectMetaSkills(projectPlan.inventory.project_name, projectResources, existingSkillNames)

  return createElement('div', { style: styles.section },
    createElement('div', { style: card },
      createElement('h2', { style: { margin: 0, fontSize: 17 } }, '项目 Skill / Rule 初始化'),
      createElement('p', { style: styles.muted },
        '在此扫描仓库并生成项目 Skill / Rule 提案。六个元技能各有一个项目专属 Skill，确认后自动挂载；项目地图覆盖整个仓库，Rule 按证据生成。逐项审阅后确认写入；已有同名资源会复用，不会被覆盖。'),
      createElement('p', { style: styles.muted },
        '团队共享时，请将生成的 .dsh/skills、.dsh/rules 和 .dsh/meta.json 纳入 Git；审核报告可保留在本地。'),
      createElement('p', { style: styles.muted },
        '当前初始化使用目录、构建清单及有限源码证据，不会自动运行 OpenSpec 或 CodeGraph。可在编辑提示词时加入你已经核实的图谱或规格信息；请保留证据路径。'),
      createElement('div', { style: card },
        createElement('div', { style: styles.row },
          createElement('strong', null, '初始化依据与预期资源'),
          createElement(Button, { variant: 'outline', size: 'sm', disabled: planBusy || projectBusy,
            onClick: () => { void reloadProjectPlan() } }, planBusy ? '扫描中…' : '重新扫描仓库输入')),
        planMessage ? createElement('p', { role: 'status', style: styles.status }, planMessage) : null,
        projectPlan ? createElement('div', { style: styles.section },
          createElement('p', { style: styles.muted },
            `已检查 ${projectPlan.inventory.modules.length} 个一级模块、${projectPlan.inventory.manifests.length} 份构建清单。六个元技能的项目 Skill 必须齐备；其它 Skill 是可选候选，已有文件会复用。Rule 只在找到可验证的团队约束时提出。`),
          ...projectMetaSkillTargets(projectPlan.inventory.project_name).map(({ meta, name }) => createElement('div',
            { key: `stage-${meta}`, style: { ...styles.muted, marginBottom: 4 } },
            `${META_STAGES[meta]}：${name} · ${existingSkillNames.has(name) ? '已有文件，确认时自动挂载' : '本次必须生成并挂载'}`)),
          ...[...plannedSkills, ...plannedRules].map(item => createElement('div', { key: `${item.kind}-${item.name}`, style: { ...styles.muted, marginBottom: 4 } },
            `${item.kind === 'skill' ? 'Skill' : 'Rule'} · ${item.name} · ${projectPlan.existing.find(existing => existing.name === item.name)?.exists ? '已存在' : '待生成候选'} · 关联阶段：${item.meta_skills.map(meta => META_STAGES[meta as keyof typeof META_STAGES] ?? meta).join('、') || '由生成结果决定'}。${item.why}`)),
          plannedRules.length === 0 ? createElement('p', { style: styles.muted }, '规则候选不预设数量；模型必须依据已读取的源码、测试或团队规范提出 Rule。') : null,
          createElement('details', { open: true },
            createElement('summary', null, '本次交给模型的提示词（可编辑）'),
            createElement('p', { style: styles.muted }, '系统提示词规定输出格式与证据边界；仓库提示词包含扫描到的清单和有限源码摘录。修改后直接点击“扫描并生成提案”，只影响本次生成，不会写入项目配置。'),
            createElement('label', null, '系统提示词', createElement('textarea', { style: { ...styles.textarea, minHeight: 130 }, value: systemPrompt,
              onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setSystemPrompt(event.target.value); setPromptDirty(true) } })),
            createElement('label', null, '仓库提示词与证据', createElement('textarea', { style: { ...styles.textarea, minHeight: 230 }, value: userPrompt,
              onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { setUserPrompt(event.target.value); setPromptDirty(true) } })),
          ),
        ) : null),
      createElement('div', { style: styles.row },
        createElement(Button, { variant: 'primary', size: 'md', disabled: projectBusy || planBusy || projectPlan === null || !systemPrompt.trim() || !userPrompt.trim(),
          onClick: () => { void generateProject() } }, projectBusy ? '扫描与生成中…' : '扫描并生成提案'),
        projectBusy ? createElement('span', { style: styles.status }, `已耗时 ${elapsed} 秒`) : null),
      projectDraft !== null || projectResources.length > 0
        ? createElement('div', { style: styles.section },
          createElement('p', { style: styles.muted },
            `项目：${workspace}。提案包含 ${proposedSkills.length} 个 Skill、${proposedRules.length} 个 Rule；项目地图需覆盖：${projectDraft?.project_map_coverage.join('、') ?? '检查修改后显示'}。`),
          createElement('p', { style: styles.muted },
            Object.entries(META_STAGES).map(([id, title]) => {
              const proposed = proposedSkills.filter(item => item.meta_skills?.includes(id as keyof typeof META_STAGES)).map(item => item.name)
              const existing = projectPlan === null ? [] : projectMetaSkillTargets(projectPlan.inventory.project_name)
                .filter(item => item.meta === id && existingSkillNames.has(item.name)).map(item => item.name)
              return `${title}：${[...existing, ...proposed].join('、') || '缺少专属项目 Skill'}`
            }).join('；')),
          missingStageSkills.length ? createElement('p', { role: 'status', style: styles.status },
            `还缺少 ${missingStageSkills.length} 个元技能专属 Skill 或挂载：${missingStageSkills.map(item => META_STAGES[item.meta]).join('、')}。请修改提案后点击“检查修改”。`) : null,
          ...projectResources.map((resource, index) => createElement('div', { key: `${resource.kind}-${resource.name}`, style: card },
            createElement('div', { style: styles.row },
              createElement('strong', null, `${resource.kind === 'skill' ? 'Skill' : 'Rule'} · ${resource.name}`),
              createElement(Button, { variant: 'ghost', size: 'sm', disabled: projectBusy,
                onClick: () => { setProjectResources(current => current.filter((_, at) => at !== index)); setProjectDraft(null); setProjectInitMsg('已移除建议。请重新检查提案。') } }, '移除建议')),
            resource.kind === 'skill'
              ? createElement('div', { style: styles.section },
                createElement('label', null, '简介', createElement('input', { style: styles.input, value: resource.description ?? '',
                  onChange: (event: ChangeEvent<HTMLInputElement>) => { updateProjectResource(index, { description: event.target.value }) } })),
                createElement('label', null, '挂载元技能（逗号分隔）', createElement('input', { style: styles.input,
                  value: (resource.meta_skills ?? []).join(', '),
                  onChange: (event: ChangeEvent<HTMLInputElement>) => { updateProjectResource(index, { meta_skills: event.target.value.split(',').map(item => item.trim()).filter(Boolean) as InitResource['meta_skills'] }) } })),
                createElement('label', null, '关联 Rule（逗号分隔）', createElement('input', { style: styles.input,
                  value: (resource.rules ?? []).join(', '),
                  onChange: (event: ChangeEvent<HTMLInputElement>) => { updateProjectResource(index, { rules: event.target.value.split(',').map(item => item.trim()).filter(Boolean) }) } })))
              : null,
            createElement('label', null, '内容', createElement('textarea', { style: { ...styles.textarea, minHeight: 180 },
              value: resource.content,
              onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { updateProjectResource(index, { content: event.target.value }) } })))),
          createElement('div', { style: styles.row },
            createElement(Button, { variant: 'outline', size: 'md', disabled: projectBusy,
              onClick: () => { void checkProject() } }, '检查修改'),
            createElement(Button, { variant: 'primary', size: 'md', disabled: projectBusy || projectDraft === null,
              onClick: () => { void applyProject() } }, '确认写入项目')),
          projectDraft !== null ? createElement('p', { style: styles.muted }, `将创建：${projectDraft.files_to_create.join('、')}，并更新 .dsh/meta.json`) : null)
        : null,
      projectInitMsg ? createElement('p', { role: 'status', style: styles.status }, projectInitMsg) : null,
    ),
    createElement('div', { style: card },
      createElement('h2', { style: { margin: 0, fontSize: 17 } }, 'AGENTS.md 初始化'),
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        createElement(StateDot, { state: exists ? 'done' : 'ongoing' }),
        createElement('span', { style: styles.bindingLabel }, exists ? `AGENTS.md 已存在 · ${view!.lines} 行（上限 200）` : 'AGENTS.md 未创建'),
        view?.path !== undefined
          ? createElement('span', { style: styles.sourceBadge }, `已定位到 ${view.path}`)
          : null,
      ),
      createElement('p', { style: styles.muted },
        '项目根 AGENTS.md 会被 DSH 自动注入到每个会话。初始化一次，之后每次任务开工 AI 都自带这份项目认知（项目是什么 → 怎么跑 → 结构 → 约定 → 坑）。'),

      exists && !editing && draft === null
        ? createElement('div', { style: styles.mdPreview },
          createElement(MarkdownText, { text: view!.content, labels: MD_LABELS }))
        : null,

      draft !== null
        ? createElement('div', { style: styles.section },
          createElement('div', { style: styles.sourceRow },
            createElement(StateDot, { state: 'ongoing', size: 8 }),
            createElement('span', { style: styles.sourceBadge }, `AI 草稿 · ${draft.lines} 行 · 尚未写入`),
          ),
          createElement('div', { style: styles.mdPreview },
            createElement(MarkdownText, { text: draft.content, labels: MD_LABELS })),
        )
        : null,

      editing
        ? createElement('textarea', {
          style: { ...styles.textarea, minHeight: 300 },
          placeholder: 'AGENTS.md 正文（Markdown，≤200 行）',
          value: body,
          onChange: (ev: ChangeEvent<HTMLTextAreaElement>) => { setBody(ev.target.value) },
        })
        : null,

      generating
        ? createElement('p', { style: styles.status },
          `AI 正在扫描项目并生成草稿… 已耗时 ${elapsed} 秒（最长 ${INIT_TIMEOUT_S} 秒），请稍候`)
        : null,
      msg !== '' ? createElement('p', { style: styles.status }, msg) : null,

      draft !== null
        ? createElement('div', { style: styles.row },
          createElement(Button, {
            variant: 'primary', size: 'md',
            disabled: draft.lines > 200,
            onClick: () => { if (exists && !window.confirm('确定覆盖现有 AGENTS.md？')) return; void write(draft.content, exists) },
          }, exists ? '保存并覆盖' : '保存'),
          draft.lines > 200 ? createElement('span', { style: styles.sourceBadge }, `草稿 ${draft.lines} 行超限，请点「放弃」后重试`) : null,
          createElement(Button, { variant: 'ghost', size: 'md', onClick: () => { setDraft(null) } }, '放弃'),
        )
        : editing
          ? createElement('div', { style: styles.row },
            createElement(Button, {
              variant: 'primary', size: 'md',
              disabled: body.trim() === '',
              onClick: () => { if (exists && !window.confirm('确定覆盖现有 AGENTS.md？')) return; void write(body, exists) },
            }, exists ? '保存并覆盖' : '保存'),
            createElement(Button, { variant: 'ghost', size: 'md', onClick: () => { setEditing(false) } }, '取消'),
          )
          : createElement('div', { style: styles.row },
            createElement(Button, {
              variant: 'primary', size: 'md',
              disabled: generating,
              title: exists ? '用 AI 重新扫描项目并覆盖现有 AGENTS.md' : '用 AI 扫描项目并生成 AGENTS.md',
              onClick: () => { void generate() },
            }, exists ? '重新生成 AGENTS.md' : '生成 AGENTS.md'),
            exists
              ? createElement(Button, { variant: 'outline', size: 'md', onClick: startEdit }, '手动编辑')
              : null,
          ),
    ),
  )
}
