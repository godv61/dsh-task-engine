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
import type { ProjectInitPreview } from './TaskEngineSection.tsx'
import type { InitResource } from '../project-init.ts'

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
  }, [workspace])

  const generateProject = async (): Promise<void> => {
    setProjectBusy(true)
    setProjectDraft(null)
    setProjectResources([])
    setProjectInitMsg('')
    try {
      const result = await remote.generateProjectInit({ path: workspace })
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

  return createElement('div', { style: styles.section },
    createElement('div', { style: card },
      createElement('h2', { style: { margin: 0, fontSize: 17 } }, '项目 Skill / Rule 初始化'),
      createElement('p', { style: styles.muted },
        '在此扫描仓库并生成项目 Skill / Rule 提案。项目地图覆盖整个仓库，当前需求的专属信息应写入任务产物。逐项审阅后确认写入；已有同名资源不会被覆盖。'),
      createElement('p', { style: styles.muted },
        '团队共享时，请将生成的 .dsh/skills、.dsh/rules 和 .dsh/meta.json 纳入 Git；审核报告可保留在本地。'),
      createElement('div', { style: styles.row },
        createElement(Button, { variant: 'primary', size: 'md', disabled: projectBusy,
          onClick: () => { void generateProject() } }, projectBusy ? '扫描与生成中…' : '扫描并生成提案'),
        projectBusy ? createElement('span', { style: styles.status }, `已耗时 ${elapsed} 秒`) : null),
      projectResources.length > 0
        ? createElement('div', { style: styles.section },
          createElement('p', { style: styles.muted },
            `项目：${workspace}。提案包含 ${projectResources.length} 个 Skill / Rule；项目地图需覆盖：${projectDraft?.project_map_coverage.join('、') ?? '检查修改后显示'}。`),
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
