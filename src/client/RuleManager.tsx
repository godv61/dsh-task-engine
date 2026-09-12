/**
 * The "规则 (rule)" tab of the workbench: the mountable rule catalog plus
 * inline create, view, edit, and delete. Rules are plain markdown files, so
 * editing reads the current body through `readRule` and writes it back with
 * `writeRule`. Bundled rules are read-only but viewable as rendered Markdown;
 * project and user rules are editable and deletable in place.
 *
 * @module dsh-task-engine/RuleManager
 */

import { createElement, useCallback, useEffect, useState, type CSSProperties, type ChangeEvent } from 'react'
import { Button, MarkdownText, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { ResourceModal } from './ResourceModal.tsx'
import { styles } from './styles.ts'
import { describeError, sourceLabel } from './shared.ts'
import type { RuleCatalogEntry, TaskEngineRemote } from './TaskEngineSection.ts'

/** Stable localized chrome for the Markdown body; a new identity drops the memo. */
const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

const control: CSSProperties = {
  background: 'var(--dsw-alias-bg-layer-1)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '5px 8px',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  minWidth: 0,
}

const card: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '10px 12px',
}

function levelOf(source: string): 'project' | 'user' | 'bundled' {
  if (source === 'bundled') return 'bundled'
  return source.startsWith('user') ? 'user' : 'project'
}

export function RuleManager({ workspace, remote }: {
  workspace: string
  remote: TaskEngineRemote
}): ReturnType<typeof createElement> {
  const [rules, setRules] = useState<RuleCatalogEntry[]>([])
  const [level, setLevel] = useState<'project' | 'user'>('project')
  const [editing, setEditing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [msg, setMsg] = useState('')

  const refresh = useCallback(() => {
    void remote.listRules(workspace).then((r) => {
      if (r.ok) setRules(r.value.rules)
    }, () => {
      /* catalog is best-effort */
    })
  }, [remote, workspace])

  useEffect(() => { refresh() }, [refresh])

  const closeForm = (): void => {
    setEditing(null); setCreating(false); setViewing(false)
    setName(''); setBody(''); setMsg('')
  }

  const startCreate = (): void => {
    setEditing(null)
    setCreating(true)
    setViewing(false)
    setLevel('project')
    setName(''); setBody(''); setMsg('')
  }

  const loadRule = (ruleName: string, lvl: 'project' | 'user' | 'bundled'): void => {
    setMsg('')
    void remote.readRule({ name: ruleName, level: lvl, path: workspace }).then((r) => {
      if (r.ok && r.value.ok) {
        setName(r.value.name)
        setBody(r.value.content)
      } else {
        setMsg('读取失败：' + (r.ok ? (r.value.error ?? '未知错误') : describeError(r.error)))
      }
    })
  }

  const startEdit = (rule: RuleCatalogEntry): void => {
    const lvl = levelOf(rule.source)
    setEditing(rule.name)
    setCreating(false)
    setViewing(false)
    setLevel(lvl === 'user' ? 'user' : 'project')
    loadRule(rule.name, lvl)
  }

  const startView = (rule: RuleCatalogEntry): void => {
    setEditing(rule.name)
    setCreating(false)
    setViewing(true)
    loadRule(rule.name, 'bundled')
  }

  const submit = async (): Promise<void> => {
    setMsg('')
    const result = await remote.writeRule({
      name: editing ?? name,
      content: body,
      level,
      path: level === 'project' ? workspace : undefined,
    })
    if (!result.ok) {
      setMsg('保存失败：' + describeError(result.error))
      return
    }
    if (!result.value.ok) {
      setMsg('保存失败：' + (result.value.error ?? '未知错误'))
      return
    }
    setMsg(`已保存 rule「${result.value.name}」`)
    setEditing(null)
    setCreating(false)
    refresh()
  }

  const remove = async (rule: RuleCatalogEntry): Promise<void> => {
    setMsg('')
    const lvl = levelOf(rule.source)
    if (lvl === 'bundled') return
    const result = await remote.deleteRule({ name: rule.name, level: lvl, path: workspace })
    if (!result.ok) {
      setMsg('删除失败：' + describeError(result.error))
      setConfirming(null)
      return
    }
    if (!result.value.ok) {
      setMsg('删除失败：' + (result.value.error ?? '未知错误'))
      setConfirming(null)
      return
    }
    setMsg(`已删除 rule「${result.value.name}」`)
    if (editing === rule.name) setEditing(null)
    setConfirming(null)
    refresh()
  }

  const formOpen = editing !== null || creating

  const renderRow = (rule: RuleCatalogEntry): ReturnType<typeof createElement> =>
    createElement('div', {
      key: rule.name,
      style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
    },
      createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
        rule.name,
        rule.source !== 'bundled' ? createElement('span', { style: styles.sourceBadge }, `（${sourceLabel(rule.source)}）`) : null),
      rule.source === 'bundled'
        ? createElement(Button, { variant: 'outline', size: 'sm', onClick: () => { startView(rule) } }, '查看')
        : createElement('div', { style: { display: 'flex', gap: 6 } },
          createElement(Button, { variant: 'outline', size: 'sm', onClick: () => { startEdit(rule) } }, '编辑'),
          confirming === rule.name
            ? createElement(Button, { variant: 'primary', size: 'sm', onClick: () => { void remove(rule) } }, '确认删除')
            : createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => { setConfirming(rule.name) } }, '删除'),
        ),
    )

  const renderForm = (): ReturnType<typeof createElement> => {
    if (viewing) {
      return createElement(ResourceModal, {
        title: `查看 rule「${editing ?? ''}」`,
        description: '内置 · 只读',
        onClose: closeForm,
        footer: createElement(Button, { variant: 'ghost', size: 'sm', onClick: closeForm }, '关闭'),
      },
        createElement(MarkdownText, { text: body, labels: MD_LABELS }),
      )
    }
    return createElement(ResourceModal, {
      title: editing === null ? '新建 rule' : `编辑 rule「${editing ?? ''}」`,
      onClose: closeForm,
      footer: createElement('div', { style: styles.row },
        createElement(Button, {
          variant: 'primary', size: 'sm',
          disabled: (editing === null && name.trim() === '') || body.trim() === '',
          onClick: () => { void submit() },
        }, '保存'),
        createElement(Button, { variant: 'ghost', size: 'sm', onClick: closeForm }, '取消'),
      ),
    },
      createElement('div', { style: styles.chips },
        createElement(Pill, { active: level === 'project', onClick: () => { setLevel('project') }, title: '写到工作区 .dsh/rules，团队共享' }, '项目级'),
        createElement(Pill, { active: level === 'user', onClick: () => { setLevel('user') }, title: '写到 $DSH_HOME/rules，个人所有项目可用' }, '用户级'),
      ),
      editing === null
        ? createElement('input', { style: control, placeholder: 'name（如 my-redlines，只含小写字母数字和 -）', value: name, onChange: (ev: ChangeEvent<HTMLInputElement>) => { setName(ev.target.value) } })
        : createElement('span', { style: styles.sourceBadge }, `name 固定为 ${name}（改名请删除后重建）`),
      createElement('textarea', { style: { ...styles.textarea, minHeight: 260 }, placeholder: '正文（这条规则约束大模型遵守什么）', value: body, onChange: (ev: ChangeEvent<HTMLTextAreaElement>) => { setBody(ev.target.value) } }),
      msg !== '' ? createElement('p', { style: styles.status }, msg) : null,
    )
  }

  return createElement('div', { style: styles.section },
    createElement('div', { style: card },
      createElement('div', { style: styles.bindingStage },
        createElement('span', { style: styles.bindingLabel }, '已安装的 rule'),
        rules.length === 0
          ? createElement('p', { style: styles.muted }, '暂无 rule，点下方「新建 rule」创建一个。')
          : createElement('div', { style: styles.section },
            ...rules.map(renderRow),
          ),
      ),
      createElement(Button, { variant: 'outline', size: 'md', onClick: startCreate }, '新建 rule'),
    ),
    formOpen ? renderForm() : null,
  )
}