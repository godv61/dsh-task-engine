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
import type { CodeGraphState, ProjectInitPreview, ProjectInitPromptView } from './TaskEngineSection.tsx'
import { projectInitSteps, projectMetaSkillTargets, type InitGraphQueryRecord, type InitReadRecord, type InitResource } from '../project-init.ts'
import { firstPendingStep, initGenerationQueue, preserveInitGenerationId, restoreInitProgress, type InitProgress } from '../init-progress.ts'
import { META_STAGES } from '../adaptive.ts'
import { DEFAULT_INIT_TIMEOUT_MINUTES, initTimeBudget } from '../init-timeout.ts'
import { externalInitPrompt } from '../init-external-prompt.ts'

/** Stable localized chrome for the Markdown body. */
const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

/** Frontend mirror of the Host generate timeout, for the elapsed counter. */
const INIT_TIMEOUT_S = DEFAULT_INIT_TIMEOUT_MINUTES * 60
const TIMEOUT_CHOICES = [5, 10, 20, 30]

const card: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12,
  border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '12px 14px',
}

interface InitPromptDraft { baseline: string; system: string; user: string; step: string }
interface StepEvidence { target: string; prompt: string; paths: string[]; edited?: boolean; reads?: InitReadRecord[]; graph_queries?: InitGraphQueryRecord[]; refresh_prompt?: boolean }

function progressKey(workspace: string): string { return `dsh-task-engine:init-draft:${workspace}` }
function promptKey(workspace: string): string { return `dsh-task-engine:init-prompts:${workspace}` }
function evidenceKey(workspace: string): string { return `dsh-task-engine:init-evidence:${workspace}` }
function progressFingerprint(plan: ProjectInitPromptView, system: string, user: string, step: string): string {
  const text = JSON.stringify([plan.inventory, plan.existing, system, user, step])
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  return `${text.length}:${hash >>> 0}`
}
function readProgress(workspace: string, fingerprint: string,
  steps: readonly { name: string; required: boolean }[]): InitProgress | null {
  try {
    const raw = window.localStorage.getItem(progressKey(workspace))
    if (!raw) return null
    return restoreInitProgress(raw, fingerprint, steps)
  } catch { return null }
}
function writeProgress(workspace: string, progress: InitProgress): void {
  try {
    // Edits and navigation must not discard the nonce used to find a live server job.
    window.localStorage.setItem(progressKey(workspace), JSON.stringify(
      preserveInitGenerationId(window.localStorage.getItem(progressKey(workspace)), progress)))
  } catch { /* optional browser checkpoint */ }
}
function readEvidenceDrafts(workspace: string, plan: ProjectInitPromptView): Record<string, StepEvidence> {
  try {
    const saved = JSON.parse(window.localStorage.getItem(evidenceKey(workspace)) ?? '{}') as {
      baseline?: string; format_version?: number; entries?: Record<string, StepEvidence>
    }
    if (saved.baseline !== progressFingerprint(plan, plan.system_prompt, plan.user_prompt, plan.step_prompt)) return {}
    const entries: Record<string, StepEvidence> = {}
    for (const step of plan.inventory.suggestions) {
      const entry = saved.entries?.[step.name]
      // Refresh old automatic excerpts, preserving any deliberate user edits and all resource drafts.
      if (saved.format_version !== 4 && !entry?.edited) {
        if (entry?.reads?.length) entries[step.name] = { ...entry, refresh_prompt: true }
        continue
      }
      if (entry?.target === step.name && typeof entry.prompt === 'string' && Array.isArray(entry.paths)
        && entry.paths.every(path => typeof path === 'string')) entries[step.name] = entry
    }
    return entries
  } catch { return {} }
}
function writeEvidenceDrafts(workspace: string, plan: ProjectInitPromptView, entries: Record<string, StepEvidence>): void {
  try { window.localStorage.setItem(evidenceKey(workspace), JSON.stringify({
    baseline: progressFingerprint(plan, plan.system_prompt, plan.user_prompt, plan.step_prompt), format_version: 4, entries,
  })) } catch { /* optional browser checkpoint */ }
}
function readPromptDraft(workspace: string, plan: ProjectInitPromptView): InitPromptDraft | null {
  try {
    const raw = window.localStorage.getItem(promptKey(workspace))
    if (!raw) return null
    const draft = JSON.parse(raw) as InitPromptDraft
    const baseline = progressFingerprint(plan, plan.system_prompt, plan.user_prompt, plan.step_prompt)
    return draft.baseline === baseline && [draft.system, draft.user, draft.step].every(value => typeof value === 'string')
      ? draft : null
  } catch { return null }
}
function writePromptDraft(workspace: string, plan: ProjectInitPromptView,
  system: string, user: string, step: string): void {
  const baseline = progressFingerprint(plan, plan.system_prompt, plan.user_prompt, plan.step_prompt)
  try { window.localStorage.setItem(promptKey(workspace), JSON.stringify({ baseline, system, user, step })) }
  catch { /* optional browser checkpoint */ }
}

export function InitPanel({ workspace, remote, onBusyChange }: {
  workspace: string
  remote: TaskEngineRemote
  onBusyChange: (busy: boolean) => void
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
  const [regenerationTarget, setRegenerationTarget] = useState<{ workspace: string; name: string } | null>(null)
  const [timeoutMinutes, setTimeoutMinutes] = useState(DEFAULT_INIT_TIMEOUT_MINUTES)
  const [projectDraft, setProjectDraft] = useState<ProjectInitPreview | null>(null)
  const [projectResources, setProjectResources] = useState<InitResource[]>([])
  const [projectStepIndex, setProjectStepIndex] = useState(0)
  const [completedSteps, setCompletedSteps] = useState<string[]>([])
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({})
  const [activeStep, setActiveStep] = useState('')
  const [projectPlan, setProjectPlan] = useState<ProjectInitPromptView | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [planMessage, setPlanMessage] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [userPrompt, setUserPrompt] = useState('')
  const [stepPrompt, setStepPrompt] = useState('')
  const [evidenceDrafts, setEvidenceDrafts] = useState<Record<string, StepEvidence>>({})
  const [stepEvidenceMessage, setStepEvidenceMessage] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)
  const [graphState, setGraphState] = useState<CodeGraphState | null>(null)
  const [graphBusy, setGraphBusy] = useState(false)
  const [graphMessage, setGraphMessage] = useState('')

  const saveProgress = (resources = projectResources, completed = completedSteps, selectedIndex = projectStepIndex,
    errors = stepErrors, generationId?: string, prompts = [systemPrompt, userPrompt, stepPrompt]): void => {
    if (!projectPlan) return
    const steps = projectInitSteps(projectPlan.inventory,
      new Set(projectPlan.existing.filter(item => item.exists).map(item => item.name)))
    writeProgress(workspace, { fingerprint: progressFingerprint(projectPlan, prompts[0]!, prompts[1]!, prompts[2]!),
      schema_version: 3, index: firstPendingStep(steps, completed), completed,
      selected: steps[selectedIndex]?.name ?? steps[0]?.name ?? '', resources, errors,
      ...(generationId ? { generation_id: generationId } : {}) })
  }

  useEffect(() => { onBusyChange(generating || projectBusy || planBusy || graphBusy) },
    [onBusyChange, generating, projectBusy, planBusy, graphBusy])
  useEffect(() => () => { onBusyChange(false) }, [onBusyChange])

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
    setGraphState(null)
    void remote.readCodeGraphStatus({ path: workspace }).then(result => {
      if (result.ok) setGraphState(result.value)
      else setGraphMessage(`CodeGraph 状态读取失败：${describeError(result.error)}`)
    }, error => { setGraphMessage(`CodeGraph 状态读取失败：${error instanceof Error ? error.message : String(error)}`) })
  }, [workspace, remote])

  useEffect(() => {
    setRegenerationTarget(null)
    try {
      const saved = Number(window.localStorage.getItem(`dsh-task-engine:init-timeout:${workspace}`))
      setTimeoutMinutes(TIMEOUT_CHOICES.includes(saved) ? saved : DEFAULT_INIT_TIMEOUT_MINUTES)
    } catch { setTimeoutMinutes(DEFAULT_INIT_TIMEOUT_MINUTES) }
    setProjectDraft(null)
    setProjectResources([])
    setProjectStepIndex(0)
    setCompletedSteps([])
    setStepErrors({})
    setProjectInitMsg('')
    setProjectPlan(null)
    setSystemPrompt('')
    setUserPrompt('')
    setStepPrompt('')
    setEvidenceDrafts({})
    setPromptDirty(false)
    setPlanBusy(true)
    let active = true
    void remote.inspectProjectInit({ path: workspace }).then(result => {
      if (!active) return
      setPlanBusy(false)
      if (!result.ok) { setPlanMessage(`读取初始化计划失败：${describeError(result.error)}`); return }
      setProjectPlan(result.value)
      const prompts = readPromptDraft(workspace, result.value)
      const system = prompts?.system ?? result.value.system_prompt
      const user = prompts?.user ?? result.value.user_prompt
      const step = prompts?.step ?? result.value.step_prompt
      setSystemPrompt(system)
      setUserPrompt(user)
      setStepPrompt(step)
      setEvidenceDrafts(readEvidenceDrafts(workspace, result.value))
      setPromptDirty(prompts !== null)
      const steps = projectInitSteps(result.value.inventory, new Set(result.value.existing.filter(item => item.exists).map(item => item.name)))
      const saved = readProgress(workspace, progressFingerprint(result.value, system, user, step), steps)
      if (saved) {
        setProjectResources(saved.resources)
        setProjectStepIndex(Math.max(0, steps.findIndex(step => step.name === saved.selected)))
        setCompletedSteps(saved.completed)
        setStepErrors(saved.errors)
        setProjectInitMsg(`已恢复初始化草案：已处理 ${saved.completed.length}/${steps.length} 步。可选择任一步骤查看、生成或重试。`)
      }
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
      try { window.localStorage.removeItem(promptKey(workspace)) } catch { /* optional browser checkpoint */ }
      setProjectPlan(result.value)
      setSystemPrompt(result.value.system_prompt)
      setUserPrompt(result.value.user_prompt)
      setStepPrompt(result.value.step_prompt)
      setEvidenceDrafts(readEvidenceDrafts(workspace, result.value))
      setPromptDirty(false)
      setProjectDraft(null)
      const steps = projectInitSteps(result.value.inventory, new Set(result.value.existing.filter(item => item.exists).map(item => item.name)))
      const saved = readProgress(workspace, progressFingerprint(result.value, result.value.system_prompt, result.value.user_prompt, result.value.step_prompt), steps)
      setProjectResources(saved?.resources ?? [])
      setProjectStepIndex(Math.max(0, steps.findIndex(step => step.name === saved?.selected)))
      setCompletedSteps(saved?.completed ?? [])
      setStepErrors(saved?.errors ?? {})
      setProjectInitMsg(saved ? `扫描完成，已恢复 ${saved.completed.length}/${steps.length} 步。` : '')
    } catch (error) {
      setPlanMessage(`重新扫描失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setPlanBusy(false) }
  }

  const prepareGraph = async (): Promise<void> => {
    const installing = graphState?.installed !== true
    if (!window.confirm(installing
      ? '将在运行 DSH 的机器上通过 npm 全局安装 CodeGraph，并在当前项目建立索引。确认继续？'
      : `将在 ${workspace} 建立或更新 CodeGraph 索引。确认继续？`)) return
    setGraphBusy(true)
    setGraphMessage('')
    try {
      const result = await remote.prepareCodeGraph({ path: workspace, install: installing })
      if (!result.ok) throw new Error(describeError(result.error))
      setGraphState(result.value)
      setGraphMessage('项目索引已就绪。各步骤可用 init_query_codegraph 按需查询；可重新读取本步证据更新提示词，手动编辑不会自动覆盖。')
    } catch (error) {
      setGraphMessage(`CodeGraph 准备失败：${error instanceof Error ? error.message : String(error)}`)
    } finally { setGraphBusy(false) }
  }

  useEffect(() => {
    if (projectBusy || projectPlan === null) return
    const steps = projectInitSteps(projectPlan.inventory,
      new Set(projectPlan.existing.filter(item => item.exists).map(item => item.name)))
    const target = steps[projectStepIndex]?.name
    if (!target) return
    if (evidenceDrafts[target] && !evidenceDrafts[target].refresh_prompt) { setStepEvidenceMessage(''); return }
    let active = true
    setStepEvidenceMessage('正在读取当前资源的专属证据…')
    void remote.inspectProjectInitStep({ path: workspace, target }).then(result => {
      if (!active) return
      if (result.ok) {
        setEvidenceDrafts(previous => ({ ...previous, [target]: {
          target, prompt: result.value.evidence_prompt, paths: result.value.evidence_paths,
          ...(previous[target]?.reads ? { reads: previous[target].reads } : {}),
          ...(previous[target]?.graph_queries ? { graph_queries: previous[target].graph_queries } : {}),
        } }))
        setStepEvidenceMessage('')
      } else setStepEvidenceMessage(`读取 ${target} 证据失败：${describeError(result.error)}`)
    }, error => { if (active) setStepEvidenceMessage(`读取 ${target} 证据失败：${error instanceof Error ? error.message : String(error)}`) })
    return () => { active = false }
  }, [workspace, remote, projectPlan, projectStepIndex, projectBusy, evidenceDrafts])

  const generateProject = async (oneStep: boolean, confirmedTarget?: string): Promise<void> => {
    if (projectPlan === null || projectBusy) return
    const selected = initSteps[projectStepIndex]
    if (oneStep && !selected) return
    if (oneStep && projectResources.some(resource => resource.name === selected!.name)
      && confirmedTarget !== selected!.name) {
      setRegenerationTarget({ workspace, name: selected!.name })
      return
    }
    setRegenerationTarget(null)
    setProjectBusy(true)
    setProjectDraft(null)
    setProjectInitMsg('')
    let resources = [...projectResources]
    let evidenceEntries = { ...evidenceDrafts }
    let completed = [...completedSteps]
    let errors = { ...stepErrors }
    let failedTarget = ''
    let currentIndex = projectStepIndex
    try {
      const steps = initSteps
      const saved = readProgress(workspace, progressFingerprint(projectPlan, systemPrompt, userPrompt, stepPrompt), steps)
      // A successful explicit regeneration is a new attempt; pending jobs retain their nonce on resume.
      const generationId = oneStep && completed.includes(selected!.name) ? `${Date.now()}-${Math.random().toString(36).slice(2)}`
        : saved?.generation_id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      if (oneStep) completed = completed.filter(name => name !== selected!.name)
      setCompletedSteps(completed)
      saveProgress(resources, completed, currentIndex, errors, generationId)
      for (const name of initGenerationQueue(steps, completed, selected?.name ?? '', oneStep)) {
        const index = steps.findIndex(step => step.name === name)
        const step = steps[index]!
        currentIndex = index
        failedTarget = step.name
        setProjectStepIndex(index)
        setActiveStep(`${index + 1}/${steps.length} · ${step.name}`)
        let evidence = evidenceEntries[step.name] ?? null
        if (evidence === null || evidence.refresh_prompt) {
          const inspected = await remote.inspectProjectInitStep({ path: workspace, target: step.name })
          if (!inspected.ok) throw new Error(`读取 ${step.name} 专属证据失败：${describeError(inspected.error)}`)
          evidence = { ...evidence, target: step.name, prompt: inspected.value.evidence_prompt, paths: inspected.value.evidence_paths, refresh_prompt: false }
        }
        evidenceEntries = { ...evidenceEntries, [step.name]: evidence }
        setEvidenceDrafts(evidenceEntries)
        let result: Awaited<ReturnType<TaskEngineRemote['generateProjectInitStep']>> | undefined
        let failure = ''
        try {
          let job = await remote.projectInitJob({ path: workspace, generation: { target: step.name,
            prior_resources: resources.filter(resource => resource.name !== step.name), system_prompt: systemPrompt, user_prompt: userPrompt,
            step_prompt: stepPrompt, evidence_prompt: evidence.prompt, generation_id: generationId, timeout_minutes: timeoutMinutes } })
          const deadline = Date.now() + initTimeBudget(timeoutMinutes).pollMs
          while (job.ok && job.value.status === 'running') {
            setActiveStep(`${index + 1}/${steps.length} · ${step.name} · 作业 ${job.value.job_id.slice(0, 8)}`)
            if (Date.now() > deadline) throw new Error('作业仍未结束；DSH 保持运行时可稍后从当前步骤继续查询')
            await new Promise(resolve => setTimeout(resolve, 1500))
            job = await remote.projectInitJob({ path: workspace, job_id: job.value.job_id })
          }
          if (!job.ok) failure = describeError(job.error)
          else if (job.value.status === 'failed') failure = job.value.error ?? '服务器生成作业失败，可重试当前步骤'
          else if (job.value.result) result = { ok: true, value: job.value.result }
          else failure = '服务器作业缺少生成结果'
        } catch (error) { failure = error instanceof Error ? error.message : String(error) }
        if (!result?.ok) throw new Error(`${step.name} 生成失败：${failure}`)
        if (result.value.resource === null && resources.some(resource => resource.name === step.name)) {
          throw new Error('本次未生成有效草案，原有草案已保留，可审阅后决定是否重试')
        }
        evidenceEntries = { ...evidenceEntries, [step.name]: { ...evidence, reads: result.value.reads ?? [], graph_queries: result.value.graph_queries ?? [] } }
        setEvidenceDrafts(evidenceEntries)
        writeEvidenceDrafts(workspace, projectPlan, evidenceEntries)
        resources = resources.filter(resource => resource.name !== step.name)
        if (result.value.resource) resources.push(result.value.resource)
        completed = [...new Set([...completed, step.name])]
        errors = { ...errors }
        delete errors[step.name]
        failedTarget = ''
        saveProgress(resources, completed, index, errors, generationId)
        setProjectResources(resources)
        setCompletedSteps(completed)
        setStepErrors(errors)
      }
      if (firstPendingStep(steps, completed) < steps.length) {
        setProjectInitMsg(`当前项已处理，进度 ${completed.length}/${steps.length}。其他步骤未自动跳过，可直接选择查看或生成。`)
        return
      }
      if (!resources.length) {
        setProjectInitMsg('全部候选已处理，未生成项目资源；内置元技能仍可直接使用。')
        return
      }
      const preview = await remote.previewProjectInit({ path: workspace, resources })
      if (!preview.ok) throw new Error(describeError(preview.error))
      if (!preview.value.ok) throw new Error(preview.value.error ?? '项目初始化提案无效')
      setProjectDraft(preview.value)
      setProjectInitMsg('所有步骤已处理，草案检查通过。请逐项审阅内容与挂载关系，确认后再写入。')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (failedTarget) errors = { ...errors, [failedTarget]: message }
      setStepErrors(errors)
      saveProgress(resources, completed, currentIndex, errors)
      setProjectInitMsg(`${oneStep ? '生成暂停' : '连续生成暂停'}：${message}。其他草案已保留；可选择失败步骤重试。`)
    } finally { setProjectBusy(false); setActiveStep('') }
  }

  const updateProjectResource = (index: number, change: Partial<InitResource>): void => {
    const resources = projectResources.map((resource, at) => at === index ? { ...resource, ...change } : resource)
    setProjectResources(resources)
    saveProgress(resources)
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
      setProjectStepIndex(0)
      setCompletedSteps([])
      setStepErrors({})
      try { window.localStorage.removeItem(progressKey(workspace)) } catch { /* optional browser checkpoint */ }
      try { window.localStorage.removeItem(promptKey(workspace)) } catch { /* optional browser checkpoint */ }
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
  const initSteps = projectPlan === null ? [] : projectInitSteps(projectPlan.inventory, existingSkillNames)
  const selectedStep = initSteps[projectStepIndex]
  const stepEvidence = selectedStep ? evidenceDrafts[selectedStep.name] ?? null : null
  const processedCount = initSteps.filter(step => completedSteps.includes(step.name)).length
  const allProcessed = processedCount === initSteps.length
  const stepStatus = (name: string): string => stepErrors[name] ? '生成失败'
    : !completedSteps.includes(name) ? '待生成'
      : projectResources.some(resource => resource.name === name) ? '已生成草案' : '已跳过'

  const selectStep = (index: number): void => {
    if (projectBusy || planBusy || index < 0 || index >= initSteps.length) return
    setProjectStepIndex(index)
    setStepEvidenceMessage('')
    saveProgress(projectResources, completedSteps, index)
  }

  const editEvidence = (prompt: string): void => {
    if (!stepEvidence || !projectPlan) return
    const entries = { ...evidenceDrafts, [stepEvidence.target]: { ...stepEvidence, prompt, edited: true } }
    setEvidenceDrafts(entries)
    writeEvidenceDrafts(workspace, projectPlan, entries)
    setProjectDraft(null)
  }

  const reloadEvidence = (): void => {
    if (!selectedStep || projectBusy || planBusy || !projectPlan) return
    if (stepEvidence?.edited && !window.confirm('重新读取将替换当前步骤已编辑的证据提示词，其他步骤的编辑会保留。确认继续？')) return
    const entries = { ...evidenceDrafts }
    delete entries[selectedStep.name]
    setEvidenceDrafts(entries)
    writeEvidenceDrafts(workspace, projectPlan, entries)
  }

  const skipCurrentStep = async (): Promise<void> => {
    const step = initSteps[projectStepIndex]
    if (!projectPlan || !step || step.required || projectBusy || completedSteps.includes(step.name)
      || projectResources.some(resource => resource.name === step.name)) return
    const completed = [...new Set([...completedSteps, step.name])]
    const next = firstPendingStep(initSteps, completed)
    const selectedIndex = next < initSteps.length ? next : projectStepIndex
    const errors = { ...stepErrors }
    delete errors[step.name]
    saveProgress(projectResources, completed, selectedIndex, errors)
    setCompletedSteps(completed)
    setStepErrors(errors)
    setProjectStepIndex(selectedIndex)
    setProjectDraft(null)
    if (completed.length < initSteps.length) {
      setProjectInitMsg(`已跳过 ${step.name}；可继续生成下一项。`)
      return
    }
    if (projectResources.length === 0) {
      setProjectInitMsg('全部候选已跳过；内置元技能仍可直接使用，无需写入项目文件。')
      return
    }
    setProjectBusy(true)
    try {
      const preview = await remote.previewProjectInit({ path: workspace, resources: projectResources })
      if (!preview.ok) throw new Error(describeError(preview.error))
      if (!preview.value.ok) throw new Error(preview.value.error ?? '项目初始化提案无效')
      setProjectDraft(preview.value)
      setProjectInitMsg(`已跳过 ${step.name}；其余草案已校验，请审阅后写入。`)
    } catch (error) {
      setProjectInitMsg(`已跳过 ${step.name}；提案检查失败：${error instanceof Error ? error.message : String(error)}。可点击“检查修改”重试。`)
    } finally { setProjectBusy(false) }
  }

  return createElement('div', { style: styles.section },
    createElement('div', { style: card },
      createElement('h2', { style: { margin: 0, fontSize: 17 } }, '项目 Skill 初始化（可选）'),
      createElement('p', { style: styles.muted },
        '内置元技能已具备六阶段基础能力，不生成任何项目 Skill 或 Rule 也可运行。初始化只建议有证据且可跨需求复用的项目知识；项目地图、技术栈、业务能力和领域编码 Skill 都可跳过。Rule 应依据团队明确规范或真实审核案例单独建立。连续生成遇到失败会自动重试，草案可从失败处继续。'),
      createElement('p', { style: styles.muted },
        '团队共享时，请将生成的 .dsh/skills、.dsh/rules 和 .dsh/meta.json 纳入 Git；审核报告可保留在本地。'),
      createElement('p', { style: styles.muted },
        '初始化先提供仓库路径，由模型通过只读工具列目录、搜索并按需读取源码；生成后可核对实际读取的文件与行号。CodeGraph 可选，具体调用关系仍须核对源码。'),
      createElement('div', { style: card },
        createElement('strong', null, 'CodeGraph 项目索引（可选）'),
        createElement('p', { style: styles.muted }, graphState?.indexed
          ? '项目索引已就绪，各步骤可通过 init_query_codegraph 查询目录与符号线索，并读取源码核对。'
          : graphState?.summary ?? '正在检查 CodeGraph 是否可用…'),
        graphState?.indexed ? createElement('details', null,
          createElement('summary', null, '查看索引统计'),
          createElement('pre', { style: { ...styles.muted, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflowY: 'auto' } },
            graphState.summary)) : null,
        createElement('div', { style: styles.row },
          createElement(Button, { variant: 'outline', size: 'sm', disabled: graphBusy || projectBusy,
            onClick: () => { void prepareGraph() } }, graphBusy ? '准备索引中…'
              : !graphState?.installed ? '安装 CodeGraph 并建立索引' : graphState.indexed ? '更新项目索引' : '建立项目索引'),
          createElement('a', { href: 'https://github.com/colbymchenry/codegraph', target: '_blank', rel: 'noreferrer' }, 'CodeGraph 官方项目')),
        graphMessage ? createElement('p', { role: 'status', style: styles.status }, graphMessage) : null),
      createElement('div', { style: card },
        createElement('div', { style: styles.row },
          createElement('strong', null, '初始化依据与预期资源'),
          createElement(Button, { variant: 'outline', size: 'sm', disabled: planBusy || projectBusy,
            onClick: () => { void reloadProjectPlan() } }, planBusy ? '扫描中…' : '重新扫描仓库输入')),
        planMessage ? createElement('p', { role: 'status', style: styles.status }, planMessage) : null,
        projectPlan ? createElement('div', { style: styles.section },
          createElement('p', { style: styles.muted },
            `已发现 ${projectPlan.inventory.modules.length} 个目录/模块、${projectPlan.inventory.manifests.length} 份构建清单。下列都是可选的项目 Skill 候选；没有可靠证据时可以不生成。已有阶段 Skill 会保留并挂载。`),
          projectPlan.inventory.discovery ? createElement('div', { style: styles.muted },
            `目录发现：${({ complete: '已完成限定范围扫描', partial: '扫描不完整，不能确认项目地图覆盖', unavailable: '无法列目录，不能确认项目地图覆盖' })[projectPlan.inventory.discovery.status]}；扫描 ${projectPlan.inventory.discovery.directories} 个目录。排除：${projectPlan.inventory.discovery.exclusions.join('、')}。${projectPlan.inventory.discovery.warnings.join('；')}`) : null,
          ...projectMetaSkillTargets(projectPlan.inventory.project_name).filter(({ name }) => existingSkillNames.has(name)).map(({ meta, name }) => createElement('div',
            { key: `stage-${meta}`, style: { ...styles.muted, marginBottom: 4 } },
            `${META_STAGES[meta]}：已有 ${name}，确认时继续挂载`)),
          ...[...plannedSkills, ...plannedRules].map(item => createElement('div', { key: `${item.kind}-${item.name}`, style: { ...styles.muted, marginBottom: 4 } },
            `${item.kind === 'skill' ? 'Skill' : 'Rule'} · ${item.name} · ${projectPlan.existing.find(existing => existing.name === item.name)?.exists ? '已存在' : '待生成候选'} · 关联阶段：${item.meta_skills.map(meta => META_STAGES[meta as keyof typeof META_STAGES] ?? meta).join('、') || '由生成结果决定'}。${item.why}`)),
          plannedRules.length === 0 ? createElement('p', { style: styles.muted }, '初始化不凭语言或依赖自动生成 Rule。请在“规则”页建立有明确来源的项目约束，再到“项目流程与审核”中挂载到相应 Skill。') : null,
          createElement('details', null,
            createElement('summary', null, '通用规则与单项生成模板（可编辑）'),
            createElement('p', { style: styles.muted }, '这里保留适用于全部资源的约束和简短项目概况。修改后会用于后续生成；已有草案会保留，需要时选择对应步骤重新生成。'),
            createElement('label', null, '系统提示词', createElement('textarea', { style: { ...styles.textarea, minHeight: 130 }, value: systemPrompt, disabled: projectBusy,
              onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
                const next = event.target.value
                setSystemPrompt(next); setPromptDirty(true)
                if (projectPlan) writePromptDraft(workspace, projectPlan, next, userPrompt, stepPrompt)
                saveProgress(projectResources, completedSteps, projectStepIndex, stepErrors, undefined, [next, userPrompt, stepPrompt])
                setProjectDraft(null)
              } })),
            createElement('label', null, '通用项目概况与要求', createElement('textarea', { style: { ...styles.textarea, minHeight: 130 }, value: userPrompt, disabled: projectBusy,
              onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
                const next = event.target.value
                setUserPrompt(next); setPromptDirty(true)
                if (projectPlan) writePromptDraft(workspace, projectPlan, systemPrompt, next, stepPrompt)
                saveProgress(projectResources, completedSteps, projectStepIndex, stepErrors, undefined, [systemPrompt, next, stepPrompt])
                setProjectDraft(null)
              } })),
            createElement('label', null, '单项生成模板（可编辑；保留 {{target}}、{{previous}}、{{meta_skills}}、{{limit}} 占位符）',
              createElement('textarea', { style: { ...styles.textarea, minHeight: 145 }, value: stepPrompt, disabled: projectBusy,
                onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
                  const next = event.target.value
                  setStepPrompt(next); setPromptDirty(true)
                  if (projectPlan) writePromptDraft(workspace, projectPlan, systemPrompt, userPrompt, next)
                  saveProgress(projectResources, completedSteps, projectStepIndex, stepErrors, undefined, [systemPrompt, userPrompt, next])
                  setProjectDraft(null)
                } })),
          ),
        ) : null),
      createElement('label', { style: styles.section }, '单项生成时间预算（含查阅、思考、整理和重试）',
        createElement('select', { style: styles.input, value: timeoutMinutes, disabled: projectBusy,
          onChange: (event: ChangeEvent<HTMLSelectElement>) => {
            const value = Number(event.target.value)
            setTimeoutMinutes(value)
            try { window.localStorage.setItem(`dsh-task-engine:init-timeout:${workspace}`, String(value)) } catch { /* optional preference */ }
          } }, ...TIMEOUT_CHOICES.map(value => createElement('option', { key: value, value }, `${value} 分钟`)))),
      createElement('p', { style: styles.muted }, '大型项目的文件查阅与模型思考可能耗时较长，可调整时间预算；也可复制当前项提示词，交给能读取项目源码的模型自行生成，审阅后通过技能页新建、安装及挂载。普通网页模型需要你另行提供相关文件。'),
      initSteps.length ? createElement('label', { style: styles.section }, '选择初始化步骤',
        createElement('select', { style: styles.input, 'aria-label': '初始化步骤', value: selectedStep?.name ?? '',
          disabled: projectBusy || planBusy,
          onChange: (event: ChangeEvent<HTMLSelectElement>) => { selectStep(initSteps.findIndex(step => step.name === event.target.value)) } },
          ...initSteps.map((step, index) => createElement('option', { key: step.name, value: step.name },
            `${index + 1}. ${step.name} · ${stepStatus(step.name)}`))),
        createElement('span', { style: styles.muted }, '选择只切换查看项，不会跳过步骤或改变完成进度。')) : null,
      initSteps[projectStepIndex] ? createElement('div', { style: card },
        createElement('strong', null, `当前步骤专属证据 · ${initSteps[projectStepIndex]!.name}`),
        createElement(Button, { variant: 'outline', size: 'sm', disabled: projectBusy || planBusy,
          onClick: reloadEvidence }, '重新读取本步证据'),
        createElement(Button, { variant: 'outline', size: 'sm', disabled: !selectedStep || !stepEvidence || stepEvidence.target !== selectedStep.name,
          onClick: () => {
            if (!selectedStep || !stepEvidence || stepEvidence.target !== selectedStep.name) return
            if (!navigator.clipboard?.writeText) { setProjectInitMsg('剪贴板不可用，请从提示词编辑区手动复制。'); return }
            const text = externalInitPrompt({ root: workspace, target: selectedStep, system: systemPrompt,
              user: userPrompt, step: stepPrompt, evidence: stepEvidence.prompt, prior: projectResources })
            void navigator.clipboard.writeText(text).then(() => setProjectInitMsg('已复制当前项完整提示词，可交给能访问源码的模型生成草案。'),
              () => setProjectInitMsg('剪贴板不可用，请从提示词编辑区手动复制。'))
          } }, '复制当前项提示词（外部生成）'),
        createElement('p', { style: styles.muted },
          `本步查阅入口（尚非读取记录）：${stepEvidence?.target === initSteps[projectStepIndex]!.name
            ? (stepEvidence.paths.join('、') || '无预设入口，可从项目根目录查阅') : '加载中'}。`),
        stepEvidence?.target === initSteps[projectStepIndex]!.name
          ? createElement('details', null,
            createElement('summary', null, '查看或修改本步证据提示词'),
            createElement('p', { style: styles.muted }, '下方提供当前步骤的路径与查阅要求，不预先拼接源码。生成时模型使用只读工具按需读取。编辑按步骤保存；通用提示词与生成模板见上方。'),
            createElement('textarea', { style: { ...styles.textarea, minHeight: 180 }, value: stepEvidence.prompt, 'aria-label': '本步证据提示词',
              disabled: projectBusy,
              onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { editEvidence(event.target.value) } })) : null,
        stepEvidence?.reads?.length ? createElement('details', null,
          createElement('summary', null, `查看本步实际读取记录（${stepEvidence.reads.length} 段）`),
          createElement('p', { style: styles.muted }, '记录对应上次生成时的文件版本，表示这些行已返回给模型；不代表整个文件或整个仓库已被审阅。'),
          ...stepEvidence.reads.map((read, index) => createElement('div', { key: index, style: { ...styles.muted, overflowWrap: 'anywhere' } },
            `${read.path}:${read.start_line}-${read.end_line} · SHA256 ${read.sha256}`))) : null,
        stepEvidence?.graph_queries?.length ? createElement('details', null,
          createElement('summary', null, `查看本步 CodeGraph 查询记录（${stepEvidence.graph_queries.length} 次）`),
          ...stepEvidence.graph_queries.map((query, index) => createElement('div', { key: index, style: styles.muted },
            `${query.mode}${query.query ? ` · ${query.query}` : ''} · ${query.ok ? '已返回结果（仍须核对源码）' : '查询失败，不能作为证据'}`))) : null,
        selectedStep && stepErrors[selectedStep.name] ? createElement('p', { role: 'status', style: styles.status }, `上次生成失败：${stepErrors[selectedStep.name]}`) : null,
        stepEvidenceMessage ? createElement('p', { role: 'status', style: styles.status }, stepEvidenceMessage) : null)
        : null,
      createElement('div', { style: styles.row },
        createElement(Button, { variant: 'primary', size: 'md', disabled: projectBusy || planBusy || projectPlan === null || !selectedStep || !systemPrompt.trim() || !userPrompt.trim() || !stepPrompt.trim(),
          onClick: () => { void generateProject(true) } }, projectBusy ? `生成 ${activeStep}…`
            : selectedStep && projectResources.some(resource => resource.name === selectedStep.name) ? '重新生成当前项' : '生成当前项'),
        createElement(Button, { variant: 'outline', size: 'sm', disabled: projectBusy || planBusy || projectPlan === null || allProcessed || !systemPrompt.trim() || !userPrompt.trim() || !stepPrompt.trim(),
          onClick: () => { void generateProject(false) } }, '连续生成剩余项'),
        selectedStep && !selectedStep.required && !completedSteps.includes(selectedStep.name)
          && !projectResources.some(resource => resource.name === selectedStep.name)
          ? createElement(Button, { variant: 'outline', size: 'sm', disabled: projectBusy || planBusy,
            onClick: () => { void skipCurrentStep() } }, '跳过当前候选') : null,
        processedCount > 0 || Object.keys(stepErrors).length ? createElement(Button, { variant: 'outline', size: 'sm', disabled: projectBusy,
          onClick: () => {
            if (!window.confirm('清除当前浏览器保存的初始化草案、步骤进度和各步证据编辑并从第一步重来？')) return
            try { window.localStorage.removeItem(progressKey(workspace)) } catch { /* optional browser checkpoint */ }
            try { window.localStorage.removeItem(evidenceKey(workspace)) } catch { /* optional browser checkpoint */ }
            setProjectStepIndex(0); setProjectResources([]); setCompletedSteps([]); setStepErrors({}); setEvidenceDrafts({})
            setProjectDraft(null); setProjectInitMsg('已清除草案，可从第一步生成。')
          } }, '从头开始') : null,
        createElement('span', { style: styles.muted }, `已处理 ${processedCount}/${initSteps.length} · 草案 ${projectResources.length} · 已跳过 ${completedSteps.filter(name => !projectResources.some(resource => resource.name === name)).length}`),
        projectBusy ? createElement('span', { style: styles.status }, `本轮累计已耗时 ${elapsed} 秒`) : null),
      regenerationTarget && regenerationTarget.workspace === workspace && regenerationTarget.name === selectedStep?.name
        ? createElement('div', { style: card, role: 'group', 'aria-label': '重新生成确认' },
          createElement('p', { role: 'status' }, `重新生成 ${regenerationTarget.name} 将在生成有效草案后替换该项内容（包括手动修改）；其他草案会保留。`),
          createElement('div', { style: styles.row },
            createElement(Button, { variant: 'outline', size: 'sm', onClick: () => setRegenerationTarget(null) }, '取消重新生成'),
            createElement(Button, { variant: 'primary', size: 'sm', onClick: () => {
              if (regenerationTarget.workspace !== workspace || regenerationTarget.name !== selectedStep?.name) return
              void generateProject(true, regenerationTarget.name)
            } }, `确认重新生成 ${regenerationTarget.name}`))) : null,
      createElement('p', { style: styles.muted }, `本项模型生成预算 ${timeoutMinutes} 分钟，读取、思考和重试共用此预算；后台与页面等待额外留出收尾时间。仅网络中断等情况最多重试一次，其他已完成草案保留。`),
      initSteps.length > 0 ? createElement('div', { style: { ...styles.section, gap: 4 } },
        ...initSteps.map((step, index) => createElement('button', { key: `init-step-${step.name}`, type: 'button',
          disabled: projectBusy || planBusy, 'aria-pressed': index === projectStepIndex,
          style: { ...styles.muted, textAlign: 'left', cursor: 'pointer', border: 'none', padding: '4px 0', background: 'transparent' },
          onClick: () => { selectStep(index) } },
          `${index === projectStepIndex ? '→' : '·'} ${index + 1}. ${step.name} · ${stepStatus(step.name)}`))) : null,
      projectDraft !== null || projectResources.length > 0
        ? createElement('div', { style: styles.section },
          createElement('p', { style: styles.muted },
            `项目：${workspace}。提案包含 ${proposedSkills.length} 个 Skill、${proposedRules.length} 个 Rule。${proposedSkills.some(item => item.name === `${projectPlan?.inventory.project_name}-project-map`) ? `项目地图需覆盖：${projectDraft?.project_map_coverage.join('、') ?? '检查修改后显示'}。` : '项目地图未生成；内置元技能仍可运行。'}`),
          createElement('p', { style: styles.muted },
            Object.entries(META_STAGES).map(([id, title]) => {
              const proposed = proposedSkills.filter(item => item.meta_skills?.includes(id as keyof typeof META_STAGES)).map(item => item.name)
              const existing = projectPlan === null ? [] : projectMetaSkillTargets(projectPlan.inventory.project_name)
                .filter(item => item.meta === id && existingSkillNames.has(item.name)).map(item => item.name)
              return `${title}：${[...existing, ...proposed].join('、') || '使用内置元技能'}`
            }).join('；')),
          ...projectResources.map((resource, index) => createElement('div', { key: `${resource.kind}-${resource.name}`, style: card },
            createElement('div', { style: styles.row },
              createElement('strong', null, `${resource.kind === 'skill' ? 'Skill' : 'Rule'} · ${resource.name}`),
              createElement(Button, { variant: 'ghost', size: 'sm', disabled: projectBusy,
                onClick: () => {
                  const resources = projectResources.filter((_, at) => at !== index)
                  const removed = projectResources[index]!.name
                  const completed = completedSteps.filter(name => name !== removed)
                  setProjectResources(resources); setProjectDraft(null); setProjectInitMsg('已移除建议。请重新检查提案。')
                  setCompletedSteps(completed)
                  saveProgress(resources, completed)
                } }, '移除建议')),
            resource.kind === 'skill'
              ? createElement('div', { style: styles.section },
                createElement('label', null, '简介', createElement('input', { style: styles.input, value: resource.description ?? '', disabled: projectBusy,
                  onChange: (event: ChangeEvent<HTMLInputElement>) => { updateProjectResource(index, { description: event.target.value }) } })),
                createElement('label', null, '使用时机（可选）', createElement('input', { style: styles.input, value: resource.whenToUse ?? '', disabled: projectBusy,
                  placeholder: '例如：涉及页面、组件或前端接口调用时',
                  onChange: (event: ChangeEvent<HTMLInputElement>) => { updateProjectResource(index, { whenToUse: event.target.value }) } })),
                createElement('small', { style: styles.muted }, '按需加载时供模型判断相关性；未填写可参考简介。此字段不会把挂载改成强制或按需。'),
                createElement('small', { style: styles.muted }, '初始化新增的项目挂载默认按需，已有挂载保留原方式；写入后可在“项目流程与审核”切换强制或按需。核心 Skill 始终强制。'),
                createElement('label', null, '挂载元技能（逗号分隔）', createElement('input', { style: styles.input, disabled: projectBusy,
                  value: (resource.meta_skills ?? []).join(', '),
                  onChange: (event: ChangeEvent<HTMLInputElement>) => { updateProjectResource(index, { meta_skills: event.target.value.split(',').map(item => item.trim()).filter(Boolean) as InitResource['meta_skills'] }) } })),
                createElement('label', null, '关联 Rule（逗号分隔）', createElement('input', { style: styles.input, disabled: projectBusy,
                  value: (resource.rules ?? []).join(', '),
                  onChange: (event: ChangeEvent<HTMLInputElement>) => { updateProjectResource(index, { rules: event.target.value.split(',').map(item => item.trim()).filter(Boolean) }) } })))
              : null,
            createElement('label', null, '内容', createElement('textarea', { style: { ...styles.textarea, minHeight: 180 }, disabled: projectBusy,
              value: resource.content,
              onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { updateProjectResource(index, { content: event.target.value }) } })))),
          createElement('div', { style: styles.row },
            createElement(Button, { variant: 'outline', size: 'md', disabled: projectBusy || !allProcessed,
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
