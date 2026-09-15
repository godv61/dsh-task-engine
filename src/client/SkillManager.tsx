/**
 * The "技能 (skill)" tab of the workbench: the mountable skill catalog plus
 * inline create, view, edit, and delete. Skills are SKILL.md files, so editing
 * reads the current frontmatter + body through `readSkill`, lets the user
 * change the description / whenToUse / body, and writes it back with
 * `writeSkill`. Bundled skills are read-only but viewable as rendered Markdown;
 * project and user skills are editable and deletable in place.
 *
 * @module dsh-task-engine/SkillManager
 */

import { createElement, useCallback, useEffect, useState, type CSSProperties, type ChangeEvent } from 'react'
import { Button, MarkdownText, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { ResourceModal } from './ResourceModal.tsx'
import { styles } from './styles.ts'
import { describeError, sourceLabel } from './shared.ts'
import type { SkillCatalogEntry, TaskEngineRemote } from './TaskEngineSection.ts'

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

/** Which level a source reads/writes as; bundled skills are view-only. */
function levelOf(source: string): 'project' | 'user' | 'bundled' {
  if (source === 'bundled') return 'bundled'
  return source.startsWith('user') ? 'user' : 'project'
}

/** Join a path and a child name without node:path (Windows accepts forward slashes). */
function joinPath(dir: string, name: string): string {
  if (dir === '') return name
  return dir.replace(/[\\/]+$/u, '') + '/' + name
}

export function SkillManager({ workspace, remote }: {
  workspace: string
  remote: TaskEngineRemote
}): ReturnType<typeof createElement> {
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([])
  const [level, setLevel] = useState<'project' | 'user'>('project')

  // Edit form fields; `editing` holds the skill name being edited/viewed (null = create).
  const [editing, setEditing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [whenToUse, setWhenToUse] = useState('')
  const [body, setBody] = useState('')
  const [msg, setMsg] = useState('')

  // Directory install form: an existing SKILL.md bundle on this machine.
  const [installing, setInstalling] = useState(false)
  const [installDir, setInstallDir] = useState('')
  const [installLevel, setInstallLevel] = useState<'project' | 'user'>('project')

  // Directory picker (host lists each level; the web never sees absolute paths).
  const [browsing, setBrowsing] = useState(false)
  const [browsePath, setBrowsePath] = useState('')
  const [browseDraft, setBrowseDraft] = useState('')
  const [browseEntries, setBrowseEntries] = useState<{ name: string; hasSkill: boolean }[]>([])
  const [browseRoots, setBrowseRoots] = useState<string[]>([])
  const [browseHasSkill, setBrowseHasSkill] = useState(false)
  const [browseError, setBrowseError] = useState('')

  const refreshBrowse = (path: string): void => {
    setBrowsePath(path)
    setBrowseDraft(path)
    setBrowseError('')
    void remote.listDirs({ path }).then((r) => {
      if (r.ok && r.value.ok) {
        setBrowseEntries(r.value.entries)
        setBrowseRoots(r.value.roots)
        setBrowseHasSkill(r.value.currentHasSkill)
        setBrowsePath(r.value.path)
        setBrowseDraft(r.value.path)
      } else {
        setBrowseEntries([])
        setBrowseError(describeError(r.ok ? r.value.error : r.error))
      }
    }, () => { setBrowseEntries([]); setBrowseError('目录读取失败') })
  }

  const openBrowse = (): void => {
    setBrowsing(true)
    setBrowseError('')
    refreshBrowse('')
  }

  const browseUp = (): void => {
    const p = browsePath.replace(/[\\/]+$/u, '')
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
    refreshBrowse(idx <= 2 ? '' : p.slice(0, idx))
  }

  const refresh = useCallback(() => {
    void remote.listSkills(workspace).then((r) => {
      if (r.ok) setSkills(r.value.skills)
    }, () => {
      /* catalog is best-effort */
    })
  }, [remote, workspace])

  useEffect(() => { refresh() }, [refresh])

  const closeForm = (): void => {
    setEditing(null); setCreating(false); setViewing(false)
    setName(''); setDescription(''); setWhenToUse(''); setBody(''); setMsg('')
  }

  const startCreate = (): void => {
    setEditing(null)
    setCreating(true)
    setViewing(false)
    setInstalling(false)
    setLevel('project')
    setName(''); setDescription(''); setWhenToUse(''); setBody(''); setMsg('')
  }

  const startInstall = (): void => {
    setEditing(null)
    setCreating(false)
    setViewing(false)
    setInstalling(true)
    setInstallDir(''); setInstallLevel('project'); setMsg('')
  }

  const submitInstall = async (): Promise<void> => {
    setMsg('')
    const result = await remote.installSkill({
      sourceDir: installDir,
      level: installLevel,
      path: installLevel === 'project' ? workspace : undefined,
    })
    if (!result.ok) {
      setMsg('安装失败：' + describeError(result.error))
      return
    }
    if (!result.value.ok) {
      setMsg('安装失败：' + (result.value.error ?? '未知错误'))
      return
    }
    setMsg(`已安装 skill「${result.value.name}」→ ${result.value.path}`)
    setInstalling(false)
    refresh()
  }

  const loadSkill = (skillName: string, lvl: 'project' | 'user' | 'bundled'): void => {
    setMsg('')
    void remote.readSkill({ name: skillName, level: lvl, path: workspace }).then((r) => {
      if (r.ok && r.value.ok) {
        setName(r.value.name)
        setDescription(r.value.description)
        setWhenToUse(r.value.whenToUse)
        setBody(r.value.content)
      } else {
        setMsg('读取失败：' + (r.ok ? (r.value.error ?? '未知错误') : describeError(r.error)))
      }
    })
  }

  const startEdit = (sk: SkillCatalogEntry): void => {
    const lvl = levelOf(sk.source)
    setEditing(sk.name)
    setCreating(false)
    setViewing(false)
    setLevel(lvl === 'user' ? 'user' : 'project')
    loadSkill(sk.name, lvl)
  }

  const startView = (sk: SkillCatalogEntry): void => {
    setEditing(sk.name)
    setCreating(false)
    setViewing(true)
    loadSkill(sk.name, 'bundled')
  }

  const submit = async (): Promise<void> => {
    setMsg('')
    const target = editing ?? name
    const result = await remote.writeSkill({
      name: target,
      description,
      whenToUse: whenToUse.trim() === '' ? undefined : whenToUse,
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
    setMsg(`已保存 skill「${result.value.name}」`)
    setEditing(null)
    setCreating(false)
    refresh()
  }

  const remove = async (sk: SkillCatalogEntry): Promise<void> => {
    setMsg('')
    const lvl = levelOf(sk.source)
    if (lvl === 'bundled') return
    const result = await remote.deleteSkill({ name: sk.name, level: lvl, path: workspace })
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
    setMsg(`已删除 skill「${result.value.name}」`)
    if (editing === sk.name) setEditing(null)
    setConfirming(null)
    refresh()
  }

  const formOpen = editing !== null || creating || installing

  const renderRow = (sk: SkillCatalogEntry): ReturnType<typeof createElement> =>
    createElement('div', {
      key: sk.name,
      style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
    },
      createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        createElement('span', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
          sk.name,
          sk.source !== 'bundled' ? createElement('span', { style: styles.sourceBadge }, `（${sourceLabel(sk.source)}）`) : null),
        createElement('span', { style: styles.sourceBadge }, sk.description),
      ),
      sk.source === 'bundled'
        ? createElement(Button, { variant: 'outline', size: 'sm', onClick: () => { startView(sk) } }, '查看')
        : createElement('div', { style: { display: 'flex', gap: 6 } },
          createElement(Button, { variant: 'outline', size: 'sm', onClick: () => { startEdit(sk) } }, '编辑'),
          confirming === sk.name
            ? createElement(Button, { variant: 'primary', size: 'sm', onClick: () => { void remove(sk) } }, '确认删除')
            : createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => { setConfirming(sk.name) } }, '删除'),
        ),
    )

  const renderForm = (): ReturnType<typeof createElement> => {
    if (viewing) {
      return createElement(ResourceModal, {
        title: `查看 skill「${editing ?? ''}」`,
        description: '内置 · 只读' + (whenToUse !== '' && whenToUse !== undefined ? ` · 使用时机：${whenToUse}` : ''),
        onClose: closeForm,
        footer: createElement(Button, { variant: 'ghost', size: 'sm', onClick: closeForm }, '关闭'),
      },
        createElement(MarkdownText, { text: body, labels: MD_LABELS }),
      )
    }
    return createElement(ResourceModal, {
      title: editing === null ? '新建 skill' : `编辑 skill「${editing ?? ''}」`,
      onClose: closeForm,
      footer: createElement('div', { style: styles.row },
        createElement(Button, {
          variant: 'primary', size: 'sm',
          disabled: (editing === null && name.trim() === '') || description.trim() === '' || body.trim() === '',
          onClick: () => { void submit() },
        }, '保存'),
        createElement(Button, { variant: 'ghost', size: 'sm', onClick: closeForm }, '取消'),
      ),
    },
      createElement('div', { style: styles.chips },
        createElement(Pill, { active: level === 'project', onClick: () => { setLevel('project') }, title: '写到工作区 .dsh/skills，团队共享' }, '项目级'),
        createElement(Pill, { active: level === 'user', onClick: () => { setLevel('user') }, title: '写到 $DSH_HOME/skills，个人所有项目可用' }, '用户级'),
      ),
      editing === null
        ? createElement('input', { style: control, placeholder: 'name（如 my-skill，只含小写字母数字和 -）', value: name, onChange: (ev: ChangeEvent<HTMLInputElement>) => { setName(ev.target.value) } })
        : createElement('span', { style: styles.sourceBadge }, `name 固定为 ${name}（改名请删除后重建）`),
      createElement('input', { style: control, placeholder: 'description（一句话说明它做什么）', value: description, onChange: (ev: ChangeEvent<HTMLInputElement>) => { setDescription(ev.target.value) } }),
      createElement('input', { style: control, placeholder: 'whenToUse（可选：什么情况该用）', value: whenToUse, onChange: (ev: ChangeEvent<HTMLInputElement>) => { setWhenToUse(ev.target.value) } }),
      createElement('textarea', { style: { ...styles.textarea, minHeight: 300 }, placeholder: '正文（告诉大模型这个阶段怎么干）', value: body, onChange: (ev: ChangeEvent<HTMLTextAreaElement>) => { setBody(ev.target.value) } }),
      msg !== '' ? createElement('p', { style: styles.status }, msg) : null,
    )
  }

  const renderInstallForm = (): ReturnType<typeof createElement> =>
    createElement(ResourceModal, {
      title: '安装现有 skill（目录型）',
      description: '把一个本机已有的 skill 目录（含 SKILL.md，可带 references / scripts 等文件）安装到项目级或用户级。',
      onClose: () => { setInstalling(false); setMsg('') },
      footer: createElement('div', { style: styles.row },
        createElement(Button, {
          variant: 'primary', size: 'sm',
          disabled: installDir.trim() === '',
          onClick: () => { void submitInstall() },
        }, '安装'),
        createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => { setInstalling(false); setMsg('') } }, '取消'),
      ),
    },
      createElement('div', { style: styles.chips },
        createElement(Pill, { active: installLevel === 'project', onClick: () => { setInstallLevel('project') }, title: '装到工作区 .dsh/skills，团队共享' }, '项目级'),
        createElement(Pill, { active: installLevel === 'user', onClick: () => { setInstallLevel('user') }, title: '装到 $DSH_HOME/skills，个人所有项目可用' }, '用户级'),
      ),
      createElement('div', { style: styles.row },
        createElement('input', {
          style: { ...control, flex: '1 1 220px', minWidth: 160 },
          placeholder: '源目录绝对路径（本机 skill 目录，需含 SKILL.md）',
          value: installDir,
          onChange: (ev: ChangeEvent<HTMLInputElement>) => { setInstallDir(ev.target.value) },
        }),
        createElement(Button, { variant: 'outline', size: 'sm', onClick: openBrowse }, '浏览…'),
      ),
      createElement('p', { style: styles.hint }, '要求：目录内有 SKILL.md（frontmatter 含 name + description）。skill 可以是完整包（references / scripts / 模板等都会保留）；安装自动排除 node_modules / .git / __pycache__ 等缓存目录（上限 1000 文件 / 100 MB），同名内置技能拒绝覆盖，同名已装技能需先删除。点「浏览…」选择目录，或直接输入路径。'),
      msg !== '' ? createElement('p', { style: styles.status }, msg) : null,
    )

  const renderBrowseModal = (): ReturnType<typeof createElement> =>
    createElement(ResourceModal, {
      title: '选择 skill 目录',
      description: '目录列表由你的 DSH 主机读取；展开到含 SKILL.md 的目录后点「选此目录」。',
      onClose: () => { setBrowsing(false) },
      footer: createElement('div', { style: styles.row },
        createElement('span', {
          style: {
            ...styles.sourceText, flex: '1 1 auto',
            color: browseHasSkill ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)',
          },
        }, browseHasSkill ? '✓ 当前目录含 SKILL.md，可直接安装' : '当前目录不含 SKILL.md——进入含 SKILL.md 的子目录再选'),
        createElement(Button, {
          variant: 'primary', size: 'sm',
          disabled: browsePath.trim() === '',
          onClick: () => { setInstallDir(browsePath); setBrowsing(false) },
        }, '选此目录'),
        createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => { setBrowsing(false) } }, '取消'),
      ),
    },
      createElement('div', { style: { ...styles.row, marginBottom: 6 } },
        createElement('input', {
          style: { ...control, flex: '1 1 200px', minWidth: 140 },
          placeholder: '输入绝对路径后回车前往',
          value: browseDraft,
          onChange: (ev: ChangeEvent<HTMLInputElement>) => { setBrowseDraft(ev.target.value) },
          onKeyDown: (ev: { key: string }) => { if (ev.key === 'Enter') refreshBrowse(browseDraft.trim()) },
        }),
        createElement(Button, { variant: 'ghost', size: 'sm', onClick: () => { refreshBrowse(browseDraft.trim()) } }, '前往'),
        createElement(Button, { variant: 'ghost', size: 'sm', disabled: browsePath === '', onClick: browseUp, title: '进入上级目录' }, '↑ 上级'),
      ),
      browseRoots.length > 1
        ? createElement('div', { style: { ...styles.chips, marginBottom: 6 } },
          ...browseRoots.map(root =>
            createElement(Button, { key: root, variant: 'ghost', size: 'sm', onClick: () => { refreshBrowse(root) } }, root.replace(/[\\/]+$/u, ''))),
        )
        : null,
      browseError !== ''
        ? createElement('p', { style: { ...styles.status, color: 'var(--dsw-alias-state-error-primary)' } }, browseError)
        : null,
      createElement('div', { style: { maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 } },
        browseEntries.length === 0 && browseError === ''
          ? createElement('p', { style: styles.sourceText }, '（此目录下没有子目录）')
          : null,
        ...browseEntries.map(entry =>
          createElement('button', {
            key: entry.name,
            type: 'button',
            onClick: () => { refreshBrowse(joinPath(browsePath, entry.name)) },
            style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', padding: '5px 8px', borderRadius: 6, color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
          },
            createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '📁 ' + entry.name),
            entry.hasSkill ? createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-success-primary)' } }, '· 含 SKILL.md ✓') : null,
          ),
        ),
      ),
    )

  return createElement('div', { style: styles.section },
    createElement('div', { style: card },
      createElement('div', { style: styles.bindingStage },
        createElement('span', { style: styles.bindingLabel }, '已安装的 skill'),
        skills.length === 0
          ? createElement('p', { style: styles.muted }, '暂无 skill，点下方「新建 skill」创建，或「安装 skill」导入本机已有的 skill 目录。')
          : createElement('div', { style: styles.section },
            ...skills.map(renderRow),
          ),
      ),
      createElement('div', { style: styles.row },
        createElement(Button, { variant: 'outline', size: 'md', onClick: startCreate }, '新建 skill'),
        createElement(Button, { variant: 'outline', size: 'md', onClick: startInstall }, '安装 skill'),
      ),
    ),
    installing ? renderInstallForm() : null,
    browsing ? renderBrowseModal() : null,
    formOpen && !installing ? renderForm() : null,
  )
}