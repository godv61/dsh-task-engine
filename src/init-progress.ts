/** Browser-safe initialization progress: selected step and completed steps are independent. */
import { validateInitResources, type InitResource } from './project-init.ts'

export interface InitProgress {
  fingerprint: string
  schema_version: 3
  /** First pending step, retained for migration from the older prefix-based draft. */
  index: number
  completed: string[]
  selected: string
  resources: InitResource[]
  errors: Record<string, string>
  generation_id?: string
}

type Step = { name: string; required: boolean }

/** Preserve a pending job across navigation/edits, but never across changed input or an explicit new attempt. */
export function preserveInitGenerationId(raw: string | null, progress: InitProgress): InitProgress {
  try {
    const prior = JSON.parse(raw ?? '{}') as Partial<InitProgress> | null
    if (!progress.generation_id && prior?.fingerprint === progress.fingerprint && typeof prior.generation_id === 'string') {
      return { ...progress, generation_id: prior.generation_id }
    }
  } catch { /* A corrupt prior checkpoint must not prevent saving a fresh one. */ }
  return progress
}

export function firstPendingStep(steps: readonly Step[], completed: readonly string[]): number {
  const index = steps.findIndex(step => !completed.includes(step.name))
  return index < 0 ? steps.length : index
}

/** Continuous generation visits every pending step in plan order, including those before the selection. */
export function initGenerationQueue(steps: readonly Step[], completed: readonly string[], selected: string,
  oneStep: boolean): string[] {
  return oneStep ? steps.filter(step => step.name === selected).map(step => step.name)
    : steps.filter(step => !completed.includes(step.name)).map(step => step.name)
}

/** Accept only known steps and migrate old sequential progress without treating navigation as completion. */
export function restoreInitProgress(raw: string, fingerprint: string, steps: readonly Step[]): InitProgress | null {
  try {
    const value = JSON.parse(raw) as Partial<InitProgress>
    if (value.schema_version !== undefined && ![2, 3].includes(value.schema_version)) return null
    const resources = validateInitResources(value.resources)
    if (!Number.isInteger(value.index) || value.index! < 0 || value.index! > steps.length) return null
    if (value.fingerprint !== fingerprint && value.schema_version !== undefined) return null
    if (resources.some(resource => !steps.some(step => step.name === resource.name))) return null
    const completed = value.schema_version === 3 ? value.completed : steps.slice(0, value.index).map(step => step.name)
    if (!Array.isArray(completed) || completed.some(name => typeof name !== 'string' || !steps.some(step => step.name === name))) return null
    if ((value.schema_version !== 3 && resources.some(resource => !completed.includes(resource.name)))
      || steps.some(step => step.required && completed.includes(step.name) && !resources.some(resource => resource.name === step.name))) return null
    const errors: Record<string, string> = {}
    if (value.errors && typeof value.errors === 'object' && !Array.isArray(value.errors)) {
      for (const step of steps) if (typeof value.errors[step.name] === 'string') errors[step.name] = value.errors[step.name]!
    }
    const next = firstPendingStep(steps, completed)
    const selected = steps.find(step => step.name === value.selected)?.name ?? steps[next]?.name ?? steps[0]?.name ?? ''
    return { fingerprint, schema_version: 3, index: next, completed: [...new Set(completed)], selected, resources, errors,
      ...(typeof value.generation_id === 'string' ? { generation_id: value.generation_id } : {}) }
  } catch { return null }
}
