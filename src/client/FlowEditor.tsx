/** Project workflow editor; drafts never change the running task's frozen config. */
import { t as flowText } from './flow-locale.ts'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { customFromTemplate, parseCustomFlow, type CustomFlow } from '../custom-flow.ts'
import { FLOW_OPTIONS, FLOW_PRESETS, resolveFlow } from '../workflows.ts'
import type { GuardName, WorkflowConfig, StageBinding } from '../engine.ts'
import type { TaskEngineRemote, SkillCatalogEntry, RuleCatalogEntry } from './TaskEngineSection.tsx'
import { describeError } from './shared.ts'
import { useFlowConfirmation } from './FlowConfirmation.tsx'
import { styles } from './styles.ts'

type Draft = { flow: string; custom?: CustomFlow; bindings: Record<string, StageBinding> }
const GUARDS: readonly [GuardName, string][] = [
  ['confirmation', flowText("人工确认")], ['requirement_confirmation', flowText("需求确认")], ['solution_confirmation', flowText("方案确认")],
  ['todos_done', flowText("实施项完成并通过两阶段审查")], ['verified', flowText("验证通过")], ['review_passed', flowText("审核通过")], ['artifacts_present', flowText("必填产物齐全")],
]
const textList = (text: string): string[] => text.split(/[,，\n]/).map(v => v.trim()).filter(Boolean)
const clone = <T,>(value: T): T => structuredClone(value)
const fallback: Draft = { flow: 'standard', bindings: {} }

/** Rebuild sequential edges while preserving each stage's exit requirements. */
function reorder(config: WorkflowConfig, stages: string[]): WorkflowConfig {
  return { ...config, stages, start_stage: stages[0] ?? '', transitions: stages.slice(0, -1).map((from, i) => ({ from, to: stages[i + 1]!, requires: config.transitions.find(t => t.from === from)?.requires ?? [] })) }
}

/** Edit the active project workflow or copy an immutable preset into a custom definition. */
export function FlowEditor({ workspace, remote, onDirtyChange }: { workspace: string; remote: TaskEngineRemote; onDirtyChange?: (dirty: boolean) => void }) {
  const { confirm, dialog } = useFlowConfirmation()
  const [draft, setDraft] = useState<Draft>(fallback)
  const [saved, setSaved] = useState(JSON.stringify(fallback))
  const [revision, setRevision] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [readError, setReadError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState(0)
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([])
  const [rules, setRules] = useState<RuleCatalogEntry[]>([])
  const [catalogError, setCatalogError] = useState('')
  const upload = useRef<HTMLInputElement>(null)
  const dirty = JSON.stringify(draft) !== saved
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => {
    let live = true
    setLoading(true); setReadError(false); setMessage(''); setCatalogError('')
    void remote.read(workspace).then(result => {
      if (!live) return
      if (!result.ok) { setReadError(true); setMessage(describeError(result.error)); return }
      const view = result.value
      if (!view.ok) { setReadError(true); setMessage(view.problems.join('；')); return }
      const next: Draft = { flow: view.flow, bindings: view.config.stage_bindings ?? {}, ...(view.custom_flow ? { custom: view.custom_flow } : {}) }
      setDraft(next); setSaved(JSON.stringify(next)); setRevision(view.revision); setSelected(0)
    }).catch(error => { if (live) { setReadError(true); setMessage(describeError(error)) } }).finally(() => { if (live) setLoading(false) })
    void Promise.all([remote.listSkills(workspace), remote.listRules(workspace)]).then(([s, r]) => {
      if (!live) return
      if (s.ok) setSkills(s.value.skills)
      if (r.ok) setRules(r.value.rules)
      if (!s.ok || !r.ok) setCatalogError(flowText("资源列表读取失败，请重新读取；保存时仍会检查资源。"))
    }).catch(() => { if (live) setCatalogError(flowText("资源列表读取失败，请重新读取。")) })
    return () => { live = false }
  }, [workspace, remote, attempt])

  const resolved = resolveFlow(draft.flow, { stage_bindings: draft.bindings, ...(draft.custom ? { custom_flow: draft.custom } : {}) })
  const config = draft.custom?.config ?? (resolved.ok ? resolved.config : FLOW_PRESETS.standard.config)
  const custom = draft.custom
  const parsed = custom ? parseCustomFlow(custom) : undefined
  const problems = parsed && !parsed.ok ? parsed.problems : !resolved.ok ? resolved.problems ?? [flowText("流程无效")] : []
  const index = Math.min(selected, config.stages.length - 1)
  const stage = config.stages[index] ?? ''
  const edge = config.transitions.find(t => t.from === stage)
  const binding = config.stage_bindings?.[stage] ?? {}
  const missing = Object.entries(config.stage_bindings ?? {}).flatMap(([s, b]) => [
    ...(b.skills ?? []).filter(n => !skills.some(x => x.name === n)).map(n => flowText("{value0}：缺少技能 {value1}", { value0: s, value1: n })),
    ...(b.rules ?? []).filter(n => !rules.some(x => x.name === n)).map(n => flowText("{value0}：缺少规则 {value1}", { value0: s, value1: n })),
  ])
  const update = (next: WorkflowConfig) => { if (custom) setDraft({ ...draft, custom: { ...custom, config: next } }); setMessage('') }
  const withDiscard = (action: () => void) => { if (dirty) confirm(flowText("有未保存的流程修改，放弃后无法恢复。"), flowText("放弃修改"), action); else action() }
  const useTemplate = (id: string) => withDiscard(() => { setDraft({ flow: id, bindings: {} }); setSelected(0); setMessage('') })
  const bind = (kind: 'skills' | 'rules', values: string[]) => {
    const bindings = { ...config.stage_bindings, [stage]: { ...binding, [kind]: values } }
    if (custom) update({ ...config, stage_bindings: bindings })
    else setDraft({ ...draft, bindings })
  }
  const rename = (value: string) => {
    value = value.trim()
    if (value === stage) return
    if (!value.trim() || config.stages.includes(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) { setMessage(flowText("阶段名称不能为空、重复或使用保留名称")); return }
    const next = clone(config)
    next.stages[index] = value
    if (next.start_stage === stage) next.start_stage = value
    next.transitions = next.transitions.map(t => ({ ...t, from: t.from === stage ? value : t.from, to: t.to === stage ? value : t.to }))
    next.artifacts = next.artifacts.map(a => ({ ...a, stage: a.stage === stage ? value : a.stage }))
    next.commit.checkpoints = next.commit.checkpoints.map(s => s === stage ? value : s)
    next.stage_bindings = Object.fromEntries(Object.entries(next.stage_bindings ?? {}).map(([s, b]) => [s === stage ? value : s, b]))
    update(next)
  }
  const move = (direction: number) => {
    const stages = [...config.stages]
    ;[stages[index], stages[index + direction]] = [stages[index + direction]!, stages[index]!]
    update(reorder(config, stages)); setSelected(index + direction)
  }
  const addStage = () => {
    let name = flowText("新阶段"), n = 1
    while (config.stages.includes(name)) name = flowText("新阶段 {value0}", { value0: ++n })
    const stages = [...config.stages]; stages.splice(stages.length - 1, 0, name)
    update(reorder(config, stages)); setSelected(stages.length - 2)
  }
  const removeStage = () => confirm(flowText("删除「{value0}」及它的条件、产物与绑定？", { value0: stage }), flowText("确认删除"), () => {
    const next = clone(config)
    next.artifacts = next.artifacts.filter(a => a.stage !== stage)
    next.commit.checkpoints = next.commit.checkpoints.filter(s => s !== stage)
    delete next.stage_bindings?.[stage]
    update(reorder(next, next.stages.filter((_, i) => i !== index))); setSelected(Math.max(0, index - 1))
  })
  async function save() {
    setSaving(true); setMessage('')
    try {
      const result = await remote.write({ path: workspace, flow: draft.flow, ...(custom ? { custom_flow: custom } : { stage_bindings: draft.bindings }), ...(revision ? { expected_revision: revision } : {}) })
      if (!result.ok) { setMessage(flowText("保存失败：") + describeError(result.error)); return }
      if (!result.value.ok) { setMessage(flowText("保存失败：") + result.value.problems.join('；')); return }
      const next = { ...draft, ...(result.value.custom_flow ? { custom: result.value.custom_flow } : {}) }
      setDraft(next); setSaved(JSON.stringify(next)); setRevision(result.value.revision)
      setMessage(flowText("已保存。新任务使用此流程，进行中的任务保持原配置。"))
    } catch (error) { setMessage(flowText("保存失败：") + describeError(error)) } finally { setSaving(false) }
  }
  async function importFile(file: File) {
    try {
      if (file.size > 256 * 1024) throw new Error(flowText("流程文件不能超过 256 KB"))
      const result = parseCustomFlow(JSON.parse(await file.text()))
      if (!result.ok) { setMessage(flowText("导入失败：") + result.problems.join('；')); return }
      withDiscard(() => { setDraft({ flow: result.value.id, custom: result.value, bindings: {} }); setSelected(0); setMessage(flowText("已导入草稿，请检查资源并保存。")) })
    } catch (error) { setMessage(flowText("导入失败：") + describeError(error)) }
  }
  function exportFile() {
    if (!custom) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(custom, null, 2) + '\n'], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = custom.id.replace(':', '-') + '.json'; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  if (loading) return <p role="status">{flowText("正在读取流程配置…")}</p>
  if (readError) return <div style={styles.wrap}><h2>{flowText("流程配置读取失败")}</h2><p role="alert">{message}</p><p>{flowText("请检查项目 .dsh/eng.json 后重新读取，原文件不会被自动覆盖。")}</p><Button onClick={() => setAttempt(n => n + 1)}>{flowText("重新读取")}</Button></div>
  return <div className="te-flow-editor" style={{ ...styles.wrap, maxWidth: 1120 }}>
    <style>{`.te-flow-layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:20px}.te-flow-editor input:not([type=checkbox]),.te-flow-editor select,.te-flow-editor textarea{box-sizing:border-box;width:100%;padding:9px 10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;min-width:0}.te-flow-editor label{font-size:13px}.te-flow-editor button{white-space:nowrap}.te-flow-editor .te-flow-stage{white-space:normal}.te-flow-editor h3{margin:0 0 12px}.te-flow-editor fieldset{border:0;padding:0;margin:0;min-width:0}.te-flow-stage{width:100%;text-align:left;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;overflow-wrap:anywhere}.te-flow-stage[aria-current=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-layer-2)}@media(max-width:680px){.te-flow-layout{grid-template-columns:1fr}.te-flow-stage-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}}`}</style>
    <div><h2 style={styles.title}>{flowText("按你的习惯，安排每一步")}</h2><p style={styles.muted}>{flowText("预设开箱即用。复制后可自由调整阶段、退出条件和资源；最后一个阶段表示流程完成。")}</p></div>
    <fieldset disabled={saving} style={{ display: 'grid', gap: 18 }}>
      <div style={styles.flowGrid}>{FLOW_OPTIONS.map(o => <button className="te-flow-stage" key={o.id} aria-current={draft.flow === o.id} onClick={() => useTemplate(o.id)}><strong>{o.label}</strong><p style={styles.hint}>{o.description}</p></button>)}</div>
      <div style={styles.actions}>
        <Button onClick={() => { const next = customFromTemplate(config); setDraft({ flow: next.id, custom: next, bindings: {} }); setMessage(''); setSelected(0) }}>{custom ? flowText("复制为新草稿") : flowText("复制当前预设并自定义")}</Button>
        <Button onClick={() => withDiscard(() => { const next = customFromTemplate({ stages: [flowText("工作"), flowText("完成")], start_stage: flowText("工作"), transitions: [{ from: flowText("工作"), to: flowText("完成"), requires: [] }], artifacts: [], commit: { policy: 'manual', message_pattern: '', message_hint: '', checkpoints: [], file_scope: false }, high_risk_requires_verification: true }); setDraft({ flow: next.id, custom: next, bindings: {} }); setSelected(0); setMessage('') })}>{flowText("从空白创建")}</Button>
        <Button onClick={() => upload.current?.click()}>{flowText("导入 JSON")}</Button>
        {custom && <Button disabled={problems.length > 0} onClick={exportFile}>{flowText("导出 JSON")}</Button>}
        <input ref={upload} type="file" accept=".json,application/json" hidden aria-label={flowText("导入流程文件")} onChange={e => { const file = e.target.files?.[0]; if (file) void importFile(file); e.target.value = '' }} />
      </div>
      {custom && <div style={styles.row}><Field label={flowText("流程名称")}><input value={custom.label} onChange={e => setDraft({ ...draft, custom: { ...custom, label: e.target.value } })} /></Field><Field label={flowText("流程标识（custom:英文名称）")}><input value={custom.id} onChange={e => setDraft({ ...draft, flow: e.target.value, custom: { ...custom, id: e.target.value } })} /></Field><span style={styles.hint}>{flowText("当前版本 v")}{custom.version}{flowText("· 保存变更时递增")}</span></div>}
      <div className="te-flow-layout">
        <aside><h3>{flowText("阶段顺序")}</h3><div className="te-flow-stage-list" style={{ display: 'grid', gap: 8 }}>{config.stages.map((s, i) => <button key={i} className="te-flow-stage" aria-current={index === i} onClick={() => setSelected(i)}>{i + 1}. {s || flowText("未命名")} <small>{i === 0 ? flowText("起点") : i === config.stages.length - 1 ? flowText("终点") : ''}</small></button>)}</div>{custom && <div style={{ marginTop: 12 }}><Button disabled={config.stages.length >= 30} onClick={addStage}>{flowText("添加阶段")}</Button></div>}</aside>
        <div style={{ ...styles.flowCard, overflowX: 'visible', display: 'grid', gap: 18, minWidth: 0 }}>
          <div><h3>{custom ? flowText("阶段设置") : stage}</h3>{custom && <Field label={flowText("阶段名称")}><input value={stage} onChange={e => rename(e.target.value)} /></Field>}</div>
          {custom && <div style={styles.actions}><Button disabled={index === 0 || index === config.stages.length - 1} onClick={() => move(-1)}>{flowText("上移")}</Button><Button disabled={index >= config.stages.length - 2} onClick={() => move(1)}>{flowText("下移")}</Button><Button disabled={config.stages.length <= 2 || index === config.stages.length - 1} onClick={removeStage}>{flowText("删除阶段")}</Button></div>}
          <div><h3>{flowText("退出条件")}</h3>{edge ? <div style={{ display: 'grid', gap: 8 }}>{GUARDS.map(([key, label]) => <label key={key}><input type="checkbox" disabled={!custom} checked={edge.requires?.includes(key) ?? false} onChange={e => update({ ...config, transitions: config.transitions.map(t => t !== edge ? t : { ...t, requires: e.target.checked ? [...(t.requires ?? []), key] : (t.requires ?? []).filter(g => g !== key) }) })} /> {label}</label>)}</div> : <p style={styles.hint}>{flowText("这是完成阶段，没有下一步。验收条件请设置在前一个阶段。")}</p>}</div>
          <div><h3>{flowText("阶段产物")}</h3>{config.artifacts.map((a, i) => a.stage !== stage ? null : <div key={i} style={{ ...styles.section, marginBottom: 14 }}>
            <Field label={flowText("产物名称")}><input disabled={!custom} value={a.name} onChange={e => update({ ...config, artifacts: config.artifacts.map((v, j) => i === j ? { ...v, name: e.target.value } : v) })} /></Field>
            <Field label={flowText("产物标识（全流程唯一）")}><input disabled={!custom} value={a.id} onChange={e => update({ ...config, artifacts: config.artifacts.map((v, j) => i === j ? { ...v, id: e.target.value } : v) })} /></Field>
            <Field label={flowText("必填字段（逗号分隔）")}><ListInput disabled={!custom} values={a.fields} onChange={fields => update({ ...config, artifacts: config.artifacts.map((v, j) => i === j ? { ...v, fields } : v) })} /></Field>
            {custom && <Button onClick={() => update({ ...config, artifacts: config.artifacts.filter((_, j) => i !== j) })}>{flowText("移除产物")}</Button>}
          </div>)}{custom && edge && <Button onClick={() => { let n = 1; while (config.artifacts.some(a => a.id === `artifact-${n}`)) n++; update({ ...config, artifacts: [...config.artifacts, { stage, id: `artifact-${n}`, name: flowText("阶段记录"), fields: ['summary'] }], transitions: config.transitions.map(t => t === edge ? { ...t, requires: [...new Set([...(t.requires ?? []), 'artifacts_present' as const])] } : t) }) }}>{flowText("添加必填产物")}</Button>}</div>
          {(['skills', 'rules'] as const).map(kind => <div key={kind}><h3>{kind === 'skills' ? flowText("技能") : flowText("规则")}</h3><div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>{[...new Set([...(kind === 'skills' ? skills : rules).map(x => x.name), ...(binding[kind] ?? [])])].map(name => {
            const core = !custom && (FLOW_PRESETS[draft.flow]?.config.stage_bindings?.[stage]?.[kind] ?? []).includes(name)
            return <label key={name}><input type="checkbox" checked={binding[kind]?.includes(name) ?? false} disabled={core} onChange={e => bind(kind, e.target.checked ? [...(binding[kind] ?? []), name] : (binding[kind] ?? []).filter(v => v !== name))} /> {name}{core ? flowText(" · 预设绑定") : ''}</label>
          })}</div></div>)}
        </div>
      </div>
      <div style={styles.flowCard}><h3>{flowText("提交设置")}</h3><p style={styles.hint}>{flowText("按任务：在选定阶段提交；按实施项：完成实施项后也可提交；手动：工具请求人工批准；不选检查点表示任意阶段可申请。")}</p><div style={styles.row}>
        <Field label={flowText("提交方式")}><select disabled={!custom} value={config.commit.policy} onChange={e => update({ ...config, commit: { ...config.commit, policy: e.target.value as WorkflowConfig['commit']['policy'] } })}><option value="task">{flowText("按任务")}</option><option value="item">{flowText("按实施项")}</option><option value="manual">{flowText("手动")}</option></select></Field>
        <label><input disabled={!custom} type="checkbox" checked={config.commit.file_scope} onChange={e => update({ ...config, commit: { ...config.commit, file_scope: e.target.checked } })} />{flowText("限制为任务声明的文件范围")}</label>
      </div><div style={{ ...styles.chips, margin: '12px 0' }}>{config.stages.map(s => <label key={s}><input disabled={!custom} type="checkbox" checked={config.commit.checkpoints.includes(s)} onChange={e => update({ ...config, commit: { ...config.commit, checkpoints: e.target.checked ? [...config.commit.checkpoints, s] : config.commit.checkpoints.filter(v => v !== s) } })} /> {s}</label>)}</div>
      <Field label={flowText("提交消息正则（留空不限制；第一个捕获组表示任务 ID）")}><input disabled={!custom} value={config.commit.message_pattern} onChange={e => update({ ...config, commit: { ...config.commit, message_pattern: e.target.value } })} /></Field><Field label={flowText("消息格式说明")}><input disabled={!custom} value={config.commit.message_hint} onChange={e => update({ ...config, commit: { ...config.commit, message_hint: e.target.value } })} /></Field></div>
      <div style={styles.flowCard}><h3>{flowText("流程预览")}</h3><p style={{ overflowWrap: 'anywhere' }}>{config.stages.join(' → ')}</p><ol>{config.transitions.map((t, i) => <li key={i}>{t.from} → {t.to}：{(t.requires ?? []).map(g => GUARDS.find(([id]) => id === g)?.[1] ?? g).join('、') || flowText("无退出条件")}</li>)}</ol><p style={styles.hint}>{flowText("进入阶段会提供技能和规则指引，不会自动运行脚本。自定义流程的人工确认、验证与审核按阶段记录。")}</p></div>
      {(problems.length > 0 || missing.length > 0 || catalogError) && <div style={styles.problems} role="alert"><strong>{flowText("保存前请检查")}</strong><ul>{[...problems, ...(catalogError ? [catalogError] : missing)].map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
      <div style={styles.actions}><Button variant="primary" disabled={saving || problems.length > 0 || !dirty} onClick={() => void save()}>{saving ? flowText("正在保存…") : flowText("保存流程")}</Button><Button onClick={() => withDiscard(() => setAttempt(n => n + 1))}>{flowText("重新读取")}</Button><span style={styles.hint}>{dirty ? flowText("有未保存的修改") : flowText("与项目配置一致")}</span></div>
    </fieldset>
    {dialog}
    {message && <p role="status" style={{ ...styles.muted, overflowWrap: 'anywhere' }}>{message}</p>}
  </div>
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label style={{ display: 'grid', gap: 6, margin: '6px 0', flexGrow: 1, minWidth: 0 }}>{label}{children}</label> }

/** Keep delimiters while typing and publish parsed names immediately for unsaved-change protection. */
function ListInput({ values, onChange, disabled }: { values: string[]; onChange: (v: string[]) => void; disabled: boolean }) {
  const [text, setText] = useState(values.join(', '))
  useEffect(() => { if (JSON.stringify(values) !== JSON.stringify(textList(text))) setText(values.join(', ')) }, [values])
  return <input value={text} disabled={disabled} onChange={e => { setText(e.target.value); onChange(textList(e.target.value)) }} />
}
