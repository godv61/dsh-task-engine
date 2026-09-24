/** Correlate successful skill calls with the trusted session log, never model claims. */
import type { EvidenceKind, TaskState, WorkflowConfig } from './engine.ts'

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

/**
 * Whether a skill must supply a command receipt, given what it declared.
 *
 * A binding may declare how it proves execution. A requirement or design skill
 * produces a document, and demanding a "real validation command" from it forced an
 * irrelevant command to satisfy a gate — the evidence existed, just in another
 * form. Core skills keep their exemption because their native artifact,
 * verification, review and commit gates already carry the proof.
 * @param name - the bound skill's name.
 * @param evidence - the declared evidence kind, if the binding named one.
 * @returns true when a command receipt is what this binding owes.
 */
export function needsSkillReceipt(name: string, evidence?: EvidenceKind): boolean {
  if (evidence === 'none' || evidence === 'artifact' || evidence === 'review' || evidence === 'manual') return false
  if (evidence === 'command') return true
  return !CORE_SKILLS.has(name)
}

/**
 * Whether a skill's declared evidence is present for this stage.
 *
 * Each kind is satisfied by the record that actually carries that proof, so a
 * document-producing skill is checked against a recorded artifact and a judging
 * skill against a review verdict, rather than all of them against a shell receipt.
 * @param kind - the declared evidence kind.
 * @param state - the task state.
 * @param stage - the stage being checked.
 * @param name - the skill name, which keys `skill_results`.
 * @param workflow - the effective workflow, for artifact declarations.
 * @returns the blocker text when the evidence is absent, or an empty array.
 */
function evidenceBlockers(
  kind: EvidenceKind,
  state: TaskState,
  stage: string,
  name: string,
  workflow: WorkflowConfig,
): string[] {
  switch (kind) {
    case 'none':
      return []
    case 'artifact': {
      // Any artifact recorded at this stage proves the skill produced its document.
      // Requiring a specific id would guess which one, and the workflow already
      // declares what each stage must record.
      const declared = workflow.artifacts.filter(artifact => artifact.stage === stage)
      if (declared.length === 0) return []
      const recorded = state.artifacts ?? {}
      const present = declared.some(artifact => recorded[artifact.id] !== undefined)
      return present ? [] : [`${stage}: "${name}" declares artifact evidence, but no artifact is recorded at this stage`]
    }
    case 'review':
      return state.review?.outcome === 'pass'
        ? []
        : [`${stage}: "${name}" declares review evidence, but no passing review is recorded`]
    case 'manual':
      // A human statement is recorded as evidence text on the skill_result; the
      // engine cannot verify the judgement itself, only that it was made explicitly.
      return (state.skill_results?.[stage]?.[name]?.evidence ?? []).some(value => value.trim() !== '')
        ? []
        : [`${stage}: "${name}" declares manual evidence and needs an explicit recorded statement`]
    case 'command':
      return []
  }
}

export function skillBlockers(state: TaskState, workflow: WorkflowConfig, session?: SkillSession): string[] {
  if (state.execution_version !== 1) return []
  const loaded = loadedSkills(session)
  return obligationStages(state, workflow).flatMap(stage => (workflow.stage_bindings?.[stage]?.skills ?? []).flatMap(entry => {
    // A binding names its skill with a source layer; the loaded set and the
    // skill_result keys are keyed by name, because DSH's skill tool is addressed
    // by name. The source decides which layer to resolve, not which key to use.
    const name = entry.skill.name
    if (!loaded.has(name)) return [`${stage}: load skill "${name}" with the skill tool before leaving this stage`]
    // A declared non-command kind is checked against its own record rather than
    // falling through to the command requirement, which would demand evidence of a
    // kind this binding never asked for.
    if (entry.evidence !== undefined && entry.evidence !== 'command') {
      return evidenceBlockers(entry.evidence, state, stage, name, workflow)
    }
    if (!needsSkillReceipt(name, entry.evidence)) return []
    const result = state.skill_results?.[stage]?.[name]
    if (!result || !result.receipt || result.receipt.exit_code !== 0 || result.receipt.aborted || result.receipt.timed_out
      || result.receipt.sandbox?.denied || result.receipt.sandbox?.runnerFailed) {
      return [`${stage}: execute "${name}" and record skill_result with skill_name, target_stage, evidence and a real validation command`]
    }
    return []
  }))
}
