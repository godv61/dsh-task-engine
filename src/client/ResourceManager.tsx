/** Skill and rule catalogs with OS selection, preview, and explicit mutations. */
import { createElement as h, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { ResourceModal } from './ResourceModal.tsx'
import { describeError } from './shared.ts'
import type { TaskEngineRemote, ReadSkillResult } from './TaskEngineSection.tsx'
import type { ResourceRef } from '../engine.ts'
import type { ResourceImportRequest, ResourcePreview } from '../resource-types.ts'

const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }
type Row = { name: string; description?: string; source: string }
type Level = 'project' | 'user'
const levelOf = (row: Row): Level | 'bundled' => row.source === 'bundled' ? 'bundled' : row.source.startsWith('user') ? 'user' : 'project'
const sourceText = (source: string) => source === 'bundled' ? '内置' : source.startsWith('user') ? '个人' : '项目'
const sizeText = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const fail = (r: { ok: boolean; error?: unknown }) => describeError(r.error ?? '操作失败')

export function ResourceManager({ workspace, remote, kind, onConfigureSkill }: { workspace: string; remote: TaskEngineRemote; kind: 'skill' | 'rule'; onConfigureSkill?: (ref: ResourceRef) => void }) {
  const noun = kind === 'skill' ? '技能' : '规则'
  const [rows, setRows] = useState<Row[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, refresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [roots, setRoots] = useState<{ project: string; user: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [request, setRequest] = useState<ResourceImportRequest | null>(null)
  const [preview, setPreview] = useState<ResourcePreview | null>(null)
  const [level, setLevel] = useState<Level>('project')
  const [manual, setManual] = useState(false)
  const [sourceDir, setSourceDir] = useState('')
  const [dirs, setDirs] = useState<{ name: string; hasSkill: boolean }[]>([])
  const [browsePath, setBrowsePath] = useState('')
  const [editing, setEditing] = useState<Row | 'new' | null>(null)
  const [viewing, setViewing] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [whenToUse, setWhenToUse] = useState('')
  const [body, setBody] = useState('')
  const [templateSource, setTemplateSource] = useState<Row | null>(null)
  const [deleting, setDeleting] = useState<Row | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const fileEpoch = useRef(0)
  const browseEpoch = useRef(0)
  const readonly = editing !== null && editing !== 'new' && levelOf(editing) === 'bundled'

  useEffect(() => {
    let active = true
    setLoading(true); setRows([]); setError('')
    const run = async () => {
      try {
        const r = kind === 'skill' ? await remote.listSkills(workspace) : await remote.listRules(workspace)
        if (!active) return
        if (!r.ok) throw new Error(fail(r))
        setRows('skills' in r.value ? r.value.skills : r.value.rules)
      } catch (e) { if (active) setError('加载失败：' + describeError(e)) }
      finally { if (active) setLoading(false) }
    }
    void run()
    void remote.resourceRoots({ kind, path: workspace }).then(r => { if (active && r.ok) setRoots(r.value) }, () => { /* Catalog remains usable; importing reports the concrete target on preview. */ })
    return () => { active = false; fileEpoch.current++ }
  }, [workspace, remote, kind, revision])

  useEffect(() => {
    let active = true
    setPreview(null)
    if (!request) return
    setBusy(true); setError('')
    void remote.previewResource({ ...request, level, path: workspace }).then(r => {
      if (!active) return
      if (!r.ok) setError(fail(r))
      else if (!r.value.ok) setError(r.value.error ?? '预览失败')
      else setPreview(r.value)
    }, e => { if (active) setError(describeError(e)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [request, level, workspace, remote])

  const close = () => { if (busy) return; fileEpoch.current++; setImporting(false); setEditing(null); setTemplateSource(null); setDeleting(null); setRequest(null); setError('') }
  const choose = () => { setError(''); if (input.current) { input.current.value = ''; input.current.click() } }
  const selected = async (files: File[]) => {
    if (!files.length) return
    const epoch = ++fileEpoch.current
    setImporting(true); setManual(false); setRequest(null); setPreview(null); setBusy(true); setError(''); setNotice('')
    try {
      files = files.filter(f => !(f.webkitRelativePath || f.name).split('/').some(p => ['node_modules', '.git', '__pycache__', '.venv', 'venv', '.cache', '.DS_Store'].includes(p)))
      if (!files.length || files.length > 1000 || files.reduce((n, f) => n + f.size, 0) > 100 * 1024 * 1024 || files.some(f => f.size > 20 * 1024 * 1024)) throw new Error('请选择不超过 1000 个文件 / 100 MB 的技能包，单文件不超过 20 MB')
      const entries = []
      for (const file of files) {
        const data = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < data.length; i += 32768) binary += String.fromCharCode(...data.subarray(i, i + 32768))
        entries.push({ path: file.webkitRelativePath || file.name, base64: btoa(binary) })
      }
      if (epoch === fileEpoch.current) setRequest({ kind, level, path: workspace, files: entries })
    } catch (e) { if (epoch === fileEpoch.current) setError(describeError(e)) }
    finally { if (epoch === fileEpoch.current) setBusy(false) }
  }
  const install = async () => {
    if (!request || !preview || preview.conflict || busy) return
    setBusy(true); setError('')
    try {
      const r = await remote.importResource({ ...request, level, path: workspace, expectedHash: preview.hash })
      if (!r.ok) throw new Error(fail(r))
      if (!r.value.ok) throw new Error(r.value.error ?? '安装失败')
      setNotice(`已安装${noun}「${r.value.name}」 · ${r.value.target}`)
      setImporting(false); setRequest(null); refresh(n => n + 1)
    } catch (e) { setError(describeError(e)) }
    finally { setBusy(false) }
  }
  const browse = async (path: string) => {
    const epoch = ++browseEpoch.current
    setError('')
    try {
      const r = await remote.listDirs({ path })
      if (epoch !== browseEpoch.current) return
      if (!r.ok) throw new Error(fail(r))
      if (!r.value.ok) throw new Error(r.value.error ?? '目录读取失败')
      setBrowsePath(r.value.path); setSourceDir(r.value.path); setDirs(r.value.entries)
    } catch (e) { if (epoch === browseEpoch.current) setError(describeError(e)) }
  }
  const edit = async (row: Row | 'new', view = false) => {
    setTemplateSource(null)
    setEditing(row); setViewing(view); setName(row === 'new' ? '' : row.name); setDescription(''); setWhenToUse(''); setBody(''); setError('')
    if (row === 'new') { setLevel('project'); return }
    const lvl = levelOf(row); setLevel(lvl === 'user' ? 'user' : 'project'); setBusy(true)
    try {
      const r = kind === 'skill' ? await remote.readSkill({ name: row.name, level: lvl, path: workspace }) : await remote.readRule({ name: row.name, level: lvl, path: workspace })
      if (!r.ok) throw new Error(fail(r))
      if (!r.value.ok) throw new Error(r.value.error ?? '读取失败')
      setBody(r.value.content)
      if (kind === 'skill') { const skill = r.value as ReadSkillResult; setDescription(skill.description); setWhenToUse(skill.whenToUse) }
    } catch (e) { setError(describeError(e)) }
    finally { setBusy(false) }
  }
  const copyTemplate = async (row: Row) => {
    if (busy || levelOf(row) !== 'bundled') return
    setBusy(true); setError('')
    try {
      const r = kind === 'skill' ? await remote.readSkill({ name: row.name, level: 'bundled', path: workspace }) : await remote.readRule({ name: row.name, level: 'bundled', path: workspace })
      if (!r.ok) throw new Error(fail(r))
      if (!r.value.ok) throw new Error(r.value.error ?? '读取内置样本失败')
      const used = new Set(rows.map(item => item.name))
      const base = `${row.name}-copy`
      let candidate = base
      for (let index = 2; used.has(candidate); index++) candidate = `${base}-${index}`
      setName(candidate); setBody(r.value.content); setLevel('project'); setViewing(false)
      if (kind === 'skill') { const skill = r.value as ReadSkillResult; setDescription(skill.description); setWhenToUse(skill.whenToUse) }
      else { setDescription(''); setWhenToUse('') }
      setTemplateSource(row); setEditing('new'); setNotice('')
    } catch (e) { setError('复制样本失败：' + describeError(e)) }
    finally { setBusy(false) }
  }
  const save = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (editing === 'new' && rows.some(r => r.name === name && (levelOf(r) === level || levelOf(r) === 'bundled'))) throw new Error('同名资源已存在，请换名或编辑现有资源')
      const r = kind === 'skill' ? await remote.writeSkill({ name, description, whenToUse, content: body, level, path: workspace }) : await remote.writeRule({ name, content: body, level, path: workspace })
      if (!r.ok) throw new Error(fail(r))
      if (!r.value.ok) throw new Error(r.value.error ?? '保存失败')
      const copied = templateSource !== null
      setNotice(`已保存${noun} · ${r.value.path}${copied ? '；请按需配置完成凭证、规则与阶段绑定' : ''}`); setEditing(null); setTemplateSource(null); refresh(n => n + 1)
      if (copied && kind === 'skill') onConfigureSkill?.({ source: level, name: r.value.name })
    } catch (e) { setError(describeError(e)) }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!deleting || busy) return
    const lvl = levelOf(deleting)
    if (lvl === 'bundled') return
    setBusy(true); setError('')
    try {
      const r = kind === 'skill' ? await remote.deleteSkill({ name: deleting.name, level: lvl, path: workspace }) : await remote.deleteRule({ name: deleting.name, level: lvl, path: workspace })
      if (!r.ok) throw new Error(fail(r))
      if (!r.value.ok) throw new Error(r.value.error ?? '删除失败')
      setNotice(`已删除${noun}「${deleting.name}」`); setDeleting(null); refresh(n => n + 1)
    } catch (e) { setError(describeError(e)) }
    finally { setBusy(false) }
  }
  const status = () => error ? h('div', { className: 'te-alert', role: 'alert' }, error) : null
  const targets = () => h('div', { className: 'te-targets' },
    ...(['project', 'user'] as const).map(lvl => h('button', { type: 'button', key: lvl, className: `te-target ${level === lvl ? 'selected' : ''}`, 'aria-pressed': level === lvl, disabled: busy || (editing !== null && editing !== 'new'), onClick: () => { setPreview(null); setLevel(lvl) } },
      h('strong', null, lvl === 'project' ? '项目共享' : '个人全局'), h('small', null, lvl === 'project' ? '仅当前工作区使用' : '此主机上的所有项目可用'))),
    h('code', { className: 'te-path' }, roots?.[level] ?? (level === 'project' ? `${workspace}/.dsh/${kind}s` : `DSH_HOME/${kind}s`)))
  const visible = rows.filter(r => `${r.name} ${r.description ?? ''}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || levelOf(r) === filter))
  return h('section', { className: 'te-resource' },
    h('input', { type: 'file', ref: input, hidden: true, 'aria-label': kind === 'skill' ? '选择技能文件夹' : '选择规则文件', ...(kind === 'skill' ? { webkitdirectory: '', multiple: true } : { accept: '.md,text/markdown' }), onChange: (e: ChangeEvent<HTMLInputElement>) => { void selected(Array.from(e.target.files ?? [])) } }),
    h('div', { className: 'te-section-heading' }, h('div', null, h('h2', null, `${noun}库`), h('p', null, kind === 'skill' ? '把可复用的工作方法带入项目。' : '为项目明确约定，让每次交付保持一致。')), h('div', { className: 'te-actions' }, h(Button, { variant: 'outline', onClick: () => { void edit('new') } }, `新建${noun}`), h(Button, { variant: 'primary', onClick: choose }, `安装${noun}`))),
    h('div', { className: 'te-toolbar' }, h('input', { className: 'te-input', placeholder: `搜索${noun}名称${kind === 'skill' ? '或描述' : ''}`, value: query, onChange: (e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value) }), h('select', { className: 'te-input', 'aria-label': '筛选来源', value: filter, onChange: (e: ChangeEvent<HTMLSelectElement>) => setFilter(e.target.value) }, h('option', { value: 'all' }, `全部来源 · ${rows.length}`), h('option', { value: 'bundled' }, '内置'), h('option', { value: 'project' }, '项目'), h('option', { value: 'user' }, '个人')), h(Button, { variant: 'ghost', onClick: () => refresh(n => n + 1), disabled: loading }, '刷新')),
    notice ? h('div', { className: 'te-success', role: 'status' }, notice) : null,
    !importing && !editing && !deleting ? status() : null,
    loading ? h('div', { className: 'te-empty', role: 'status' }, '正在加载…') : visible.length === 0 ? h('div', { className: 'te-empty' }, h('h3', null, query || filter !== 'all' ? '没有匹配的结果' : `还没有${noun}`), h('p', null, '调整筛选，或使用右上角按钮添加。')) : h('div', { className: 'te-resource-grid' }, ...visible.map(row => h('article', { className: 'te-resource-card', key: row.source + '/' + row.name },
      h('div', { className: 'te-card-top' }, h('span', { className: 'te-resource-icon', 'aria-hidden': true }, kind === 'skill' ? '◇' : '≡'), h('span', { className: 'te-badge' }, sourceText(row.source))),
      h('h3', null, row.name), h('p', null, row.description || '项目约定与执行规则'),
      h('div', { className: 'te-actions' }, kind === 'skill' && onConfigureSkill ? h(Button, { variant: 'primary', size: 'sm', onClick: () => onConfigureSkill({ source: levelOf(row), name: row.name }) }, '配置规则') : null, h(Button, { variant: 'outline', size: 'sm', onClick: () => { void edit(row, true) } }, '查看'), levelOf(row) === 'bundled' ? h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => { void copyTemplate(row) } }, '以此为模板新建') : h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void edit(row) } }, '编辑'), levelOf(row) !== 'bundled' ? h('button', { className: 'te-delete', onClick: () => { setDeleting(row); setError('') } }, '删除') : null)))),
    kind === 'skill' ? h('button', { className: 'te-link', onClick: () => { setImporting(true); setManual(true); setError('') } }, '高级：从 Harness 主机路径安装') : null,
    importing ? h(ResourceModal, { title: `安装${noun}`, description: '先检查内容和安装位置，确认后才会写入。', onClose: close, footer: h('div', { className: 'te-actions' }, h(Button, { variant: 'ghost', disabled: busy, onClick: close }, '取消'), h(Button, { variant: 'primary', disabled: busy || !preview || preview.conflict, onClick: () => { void install() } }, busy ? '处理中…' : '确认安装')) },
      targets(), h('div', { className: 'te-actions' }, h(Button, { variant: 'outline', disabled: busy, onClick: choose }, '重新选择'), kind === 'skill' ? h(Button, { variant: 'ghost', disabled: busy, onClick: () => setManual(!manual) }, manual ? '收起高级方式' : '主机路径') : null),
      manual ? h('div', { className: 'te-advanced' }, h('p', null, '此路径位于 Harness 主机；浏览器选择器读取的是你当前电脑。'), h('div', { className: 'te-toolbar' }, h('input', { className: 'te-input', 'aria-label': '主机技能目录', value: sourceDir, onChange: (e: ChangeEvent<HTMLInputElement>) => { setSourceDir(e.target.value); setRequest(null) } }), h(Button, { variant: 'outline', onClick: () => { void browse(sourceDir) } }, '浏览'), h(Button, { variant: 'outline', disabled: busy || !sourceDir.trim(), onClick: () => setRequest({ kind, level, path: workspace, files: [], sourceDir }) }, '预览目录')), h('div', { className: 'te-dir-list' }, browsePath ? h('button', { onClick: () => { void browse(browsePath.replace(/[\\/][^\\/]+[\\/]?$/u, '') || '/') } }, '↑ 上级目录') : null, ...dirs.map(d => h('button', { key: d.name, onClick: () => { setRequest(null); void browse(browsePath.replace(/[\\/]+$/u, '') + '/' + d.name) } }, d.name + (d.hasSkill ? ' · SKILL.md' : ''))))) : null,
      busy ? h('p', { role: 'status' }, '正在校验文件，请稍候…') : null, status(),
      preview ? h('div', { className: 'te-preview' }, h('h3', null, preview.name), h('p', null, preview.description), h('div', { className: 'te-actions' }, h('span', { className: 'te-badge' }, `${preview.files} 个文件`), h('span', { className: 'te-badge' }, sizeText(preview.bytes))), h('code', { className: 'te-path' }, preview.target), preview.conflict ? h('div', { className: 'te-alert', role: 'alert' }, '已有同名资源。请取消并检查现有内容，安装不会覆盖它。') : null, h('div', { className: 'te-markdown' }, h(MarkdownText, { text: preview.content, labels }))) : null) : null,
    editing ? h(ResourceModal, { title: editing === 'new' ? `新建${noun}` : `${viewing ? '查看' : '编辑'}${noun} · ${name}`, onClose: close, footer: h('div', { className: 'te-actions' }, h(Button, { variant: 'ghost', disabled: busy, onClick: close }, '关闭'), readonly ? h(Button, { variant: 'outline', disabled: busy, onClick: () => { void copyTemplate(editing as Row) } }, '以此为模板新建') : null, !readonly ? h(Button, { variant: 'outline', disabled: busy, onClick: () => setViewing(!viewing) }, viewing ? '编辑内容' : '预览') : null, !readonly ? h(Button, { variant: 'primary', disabled: busy || !name.trim() || !body.trim() || (kind === 'skill' && !description.trim()), onClick: () => { void save() } }, busy ? '处理中…' : '保存') : null) },
      !readonly ? targets() : h('p', { className: 'te-badge' }, '内置样本 · 只读'), templateSource ? h('p', null, `以「${templateSource.name}」为模板复制正文。新资源的完成凭证、规则和阶段绑定需单独配置，保存本身不会启用它。`) : null, status(),
      viewing ? h('div', { className: 'te-markdown' }, h(MarkdownText, { text: body, labels })) : h('div', { className: 'te-form' }, h('label', null, '名称', h('input', { className: 'te-input', value: name, disabled: editing !== 'new' || busy, onChange: (e: ChangeEvent<HTMLInputElement>) => setName(e.target.value), placeholder: '小写字母、数字和连字符' })), kind === 'skill' ? h('label', null, '描述', h('input', { className: 'te-input', value: description, disabled: busy, onChange: (e: ChangeEvent<HTMLInputElement>) => setDescription(e.target.value) })) : null, kind === 'skill' ? h('label', null, '使用时机（可选）', h('input', { className: 'te-input', value: whenToUse, disabled: busy, onChange: (e: ChangeEvent<HTMLInputElement>) => setWhenToUse(e.target.value) })) : null, h('label', null, 'Markdown 正文', h('textarea', { className: 'te-input te-editor', value: body, disabled: busy, onChange: (e: ChangeEvent<HTMLTextAreaElement>) => setBody(e.target.value) })))) : null,
    deleting ? h(ResourceModal, { title: `删除${noun}「${deleting.name}」？`, description: levelOf(deleting) === 'user' ? '这是个人全局资源，删除会影响此主机上的所有项目。' : '删除将影响当前项目。', onClose: close, footer: h('div', { className: 'te-actions' }, h(Button, { variant: 'outline', disabled: busy, onClick: close }, '保留'), h('button', { className: 'te-danger-button', disabled: busy, onClick: () => { void remove() } }, busy ? '删除中…' : '确认永久删除')) }, h('code', { className: 'te-path' }, `${roots?.[levelOf(deleting) === 'user' ? 'user' : 'project'] ?? '资源目录'}/${deleting.name}${kind === 'rule' ? '.md' : ''}`), h('p', null, '此操作不会进入回收站，请确认已有备份。'), status()) : null)
}
