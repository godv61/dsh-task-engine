/** Correlate successful skill calls with the trusted session log, never model claims. */
import type { TaskState, WorkflowConfig } from './engine.ts'

export interface SkillSession {
  id?: string
  snapshotEvents(): readonly { type: string; data: unknown }[]
}

const CORE_SKILLS = new Set(['eng-delivery', 'requirement-analysis', 'solution-design', 'code-implement', 'code-verify', 'code-review', 'code-commit'])

/** Return successful loader call ids in the calling session, including resumed history. */
export function loadedSkills(session?: SkillSession): Map<string, string> {
  const calls = new Map<string, string>()
  const loaded = new Map<string, string>()
  for (const event of session?.snapshotEvents?.() ?? []) {
    if (event.type === 'tool/call') {
      const data = event.data as { name?: string; callId?: string; arguments?: string }
      if (data.name !== 'skill' || !data.callId) continue
      try {
        const args = JSON.parse(data.arguments ?? '{}') as { name?: unknown }
        if (typeof args.name === 'string') calls.set(data.callId, args.name)
      } catch { /* Failed or malformed loader requests are not loading evidence. */ }
    } else if (event.type === 'tool/result') {
      const data = event.data as { error?: unknown; message?: { content?: { type?: string; toolCallId?: string; isError?: boolean }[] } }
      if (data.error) continue
      for (const block of data.message?.content ?? []) {
        if (block.type !== 'tool-result' || block.isError || !block.toolCallId) continue
        const name = calls.get(block.toolCallId)
        if (name) loaded.set(name, block.toolCallId)
      }
    }
  }
  return loaded
}

/** Terminal bindings run before entering the terminal state, not after reporting completion. */
export function obligationStages(state: TaskState, workflow: WorkflowConfig): string[] {
  const terminalTargets = workflow.transitions.filter(t => t.from === state.stage
    && !workflow.transitions.some(edge => edge.from === t.to)).map(t => t.to)
  return [...new Set([state.stage, ...terminalTargets])]
}

/** Core skills use their native artifact/verification/commit gates; additions require a command receipt. */
export function needsSkillReceipt(name: string): boolean {
  return !CORE_SKILLS.has(name)
}

export function skillBlockers(state: TaskState, workflow: WorkflowConfig, session?: SkillSession): string[] {
  if (state.execution_version !== 1) return []
  const loaded = loadedSkills(session)
  return obligationStages(state, workflow).flatMap(stage => (workflow.stage_bindings?.[stage]?.skills ?? []).flatMap(name => {
    if (!loaded.has(name)) return [`${stage}: load skill "${name}" with the skill tool before leaving this stage`]
    if (!needsSkillReceipt(name)) return []
    const result = state.skill_results?.[stage]?.[name]
    if (!result || !result.receipt || result.receipt.exit_code !== 0 || result.receipt.aborted || result.receipt.timed_out
      || result.receipt.sandbox?.denied || result.receipt.sandbox?.runnerFailed) {
      return [`${stage}: execute "${name}" and record skill_result with skill_name, target_stage, evidence and a real validation command`]
    }
    return []
  }))
}
