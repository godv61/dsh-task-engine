/** Readable task content; the JSON ledger remains the only mutable state. */
import type { TaskState } from './engine.ts'
import { REQUIREMENT_FIELDS } from './requirements.ts'
import { taskArtifactDirectory } from './task-paths.ts'
import { groupInputs } from './verification-state.ts'

export interface TaskLedgerContent {
  directory: string
  ledger_path: string
  stages: string[]
  files: string[]
  artifacts: { id: string; name: string; stage: string; fields: { key: string; label: string; value: string }[] }[]
  verification_inputs: { group_id: string; files: string[]; item_ids: string[] }[]
}

const FIELD_LABELS: Record<string, string> = {
  ...REQUIREMENT_FIELDS,
  approach: '实现方案',
  impact: '影响范围',
  tradeoffs: '取舍与风险',
  steps: '实施步骤',
  handoffs: '交接与交付',
}

export function taskLedgerContent(state: TaskState): TaskLedgerContent {
  const definitions = state.flow?.config.artifacts ?? []
  return {
    directory: taskArtifactDirectory(state.id, state.task_directory),
    ledger_path: `${taskArtifactDirectory(state.id, state.task_directory)}/task.json`,
    stages: [...(state.flow?.config.stages ?? [])],
    files: [...(state.files ?? [])],
    artifacts: Object.entries(state.artifacts ?? {}).map(([id, values]) => {
      const definition = definitions.find((item) => item.id === id)
      return {
        id,
        name: definition?.name ?? id,
        stage: definition?.stage ?? '',
        fields: Object.entries(values)
          .filter(([, value]) => typeof value === 'string' && value.trim())
          .map(([key, value]) => ({
            key,
            label:
              id === 'task-plan' && key === 'dependencies'
                ? '实施依赖'
                : Object.prototype.hasOwnProperty.call(FIELD_LABELS, key)
                  ? FIELD_LABELS[key]!
                  : key,
            value,
          })),
      }
    }),
    verification_inputs: Object.values(state.verification_groups ?? {}).map((group) => ({
      group_id: group.id,
      files: groupInputs(state, group),
      item_ids: [...group.item_ids],
    })),
  }
}
