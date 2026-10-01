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

/** Stable localized chrome for the Markdown body. */
const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

/** Frontend mirror of the Host generate timeout, for the elapsed counter. */
const INIT_TIMEOUT_S = 150

const card: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12,
  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '12px 14px',
}

const projectInitPrompt = (workspace: string): string =>
  `请在当前项目根工作区 ${workspace} 使用工程化开发引擎初始化项目 Skill 和 Rule。先调用 dev_task init_project（phase=inspect），结合代表性源码、构建文件、测试和已有规范核实扫描结果。按项目实际情况拟定项目结构地图、技术栈、编码方法等 Skill 和必要的 Rule，并标明适用的元技能。调用 phase=propose 展示拟创建的文件、内容和挂载关系；等我审阅确认后再调用 phase=apply。不要覆盖同名资源，也不要把偶发代码写法当成团队规范。`

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

  useEffect(() => {
    if (!generating) {
      setElapsed(0)
      return
    }
    const started = Date.now()
    setElapsed(0)
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - started) / 1000))
    }, 1000)
    return () => { clearInterval(timer) }
  }, [generating])

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
        '扫描代码库并拟定项目地图、技术栈、编码 Skill 和 Rule。先预览生成内容，确认后才写入项目；已有同名资源不会被覆盖。'),
      createElement('p', { style: styles.muted },
        '使用方法：关闭此面板，在当前项目根工作区选择“工程化开发引擎”，把下面的请求发给新会话。'),
      createElement('textarea', { style: { ...styles.textarea, minHeight: 100 }, readOnly: true,
        'aria-label': '项目 Skill 和 Rule 初始化请求', value: projectInitPrompt(workspace) }),
      createElement('div', { style: styles.row },
        createElement(Button, { variant: 'primary', size: 'md', onClick: () => {
          if (!navigator.clipboard?.writeText) {
            setProjectInitMsg('当前浏览器不支持一键复制。请直接选中上方请求文本并复制。')
            return
          }
          void navigator.clipboard.writeText(projectInitPrompt(workspace)).then(
            () => setProjectInitMsg('已复制初始化请求。请在工程化开发引擎会话中粘贴发送。'),
            () => setProjectInitMsg('复制失败。请直接选中上方请求文本并复制。'))
        } }, '复制初始化请求'),
        projectInitMsg ? createElement('span', { role: 'status', style: styles.status }, projectInitMsg) : null),
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
