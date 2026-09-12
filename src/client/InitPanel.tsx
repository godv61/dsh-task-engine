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
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        createElement(StateDot, { state: exists ? 'done' : 'ongoing' }),
        createElement('span', { style: styles.bindingLabel }, exists ? `已初始化 · ${view!.lines} 行（上限 200）` : '未初始化'),
        view?.path !== undefined
          ? createElement('span', { style: styles.sourceBadge }, `已定位到 ${view.path}`)
          : null,
      ),
      createElement('p', { style: styles.muted },
        '项目根 AGENTS.md 会被 DSH 自动注入到每个会话。初始化一次，之后每次任务开工 AI 都自带这份项目认知（项目是什么 → 怎么跑 → 结构 → 约定 → 坑）。'),

      exists && !editing && draft === null
        ? createElement(MarkdownText, { text: view!.content, labels: MD_LABELS })
        : null,

      draft !== null
        ? createElement('div', { style: styles.section },
          createElement('span', { style: styles.sourceBadge }, `AI 草稿 · ${draft.lines} 行 · 尚未写入`),
          createElement(MarkdownText, { text: draft.content, labels: MD_LABELS }),
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
            }, exists ? '重新初始化（AI 扫描覆盖）' : '让 AI 初始化'),
            exists
              ? createElement(Button, { variant: 'outline', size: 'md', onClick: startEdit }, '手动编辑')
              : null,
          ),
    ),
  )
}