/**
 * The model-facing `dev_task` tool: the hard engineering-delivery gate.
 *
 * This module owns the tool definition and every filesystem-adjacent helper it
 * needs, so the registration can run on the AGENT plane (inside a preset's
 * scope) rather than the host plane. Registering through a scoped context files
 * the tool in that scope's layer — a session on another preset never sees it —
 * while the pure state machine in {@link ../engine} and the config-facing
 * `task-engine` Remote stay shared.
 *
 * @module dsh-task-engine/dev-task
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
// Type-only: pulls the `Context.fs` augmentation into this module.
import type {} from '@deepseek-ai/dsh-fs'
import {
  assertAdvance,
  bindingsForStage,
  checkFileScope,
  commitCheckpoint,
  legalTargets,
  newTask,
  unmetGuards,
  validateCommitMessage,
  validateWorkflow,
  type FlowSnapshot,
  type GuardName,
  type Result,
  type StageBinding,
  type TaskItem,
  type TaskState,
  type WorkflowConfig,
} from './engine.ts'
import {
  HIGH_RISK_REQUIRED_CAPABILITIES,
  flowSatisfies,
  resolveFlow,
} from './workflows.ts'

/** Bundled commit-msg hook, copied into `.git/hooks/` by the `install_hook` operation. */
const HOOK_TEMPLATE = readFileSync(
  fileURLToPath(new URL('../hooks/commit-msg', import.meta.url)), 'utf8',
)

/** Pins the hook directory to CommonJS so the extensionless hook runs under any repo `type`. */
const HOOK_PACKAGE_JSON = '{\n  "type": "commonjs"\n}\n'

type Fs = Context['fs']

/**
 * Read a workspace-relative file through the sandboxed filesystem. `cwd` is the
 * calling session's workspace (`exec.agent.session.header.cwd`); without it the
 * backend falls back to its own base, which is NOT the session workspace.
 */
async function readText(fs: Fs, relPath: string, cwd?: string): Promise<string | undefined> {
  try {
    const target = await fs.resolve(relPath, cwd !== undefined ? { cwd } : undefined)
    return await (fs as unknown as { readText(target: unknown): Promise<string> }).readText(target)
  } catch {
    return undefined
  }
}

async function writeText(fs: Fs, relPath: string, content: string, cwd?: string): Promise<void> {
  const target = await fs.resolve(relPath, cwd !== undefined ? { cwd } : undefined)
  await (fs as unknown as { writeText(target: unknown, content: string): Promise<unknown> }).writeText(target, content)
}

function sanitize(id: string): string {
  return id.replace(/[^0-9a-zA-Z_-]/g, '-')
}

const taskPath = (id: string): string => `.dsh/task-${sanitize(id)}.json`

/** Hard line cap for the `init`-generated `AGENTS.md` (injected into every session). */
const INIT_MAX_LINES = 200

/** Count physical lines after CRLF normalization; an empty string counts as one. */
function lineCount(text: string): number {
  return text.replace(/\r\n/g, '\n').split('\n').length
}

interface ResolvedWorkflow {
  flow: string
  version: number
  config: WorkflowConfig
  problems: string[]
  source: 'default' | 'project' | 'invalid'
}

/** The standard preset's identity and config; the built-in id always resolves. */
function standardWorkflow(): { flow: string; version: number; config: WorkflowConfig } {
  const standard = resolveFlow('standard')
  if (!standard.ok) throw new Error('built-in "standard" preset is missing')
  return { flow: standard.preset.id, version: standard.preset.version, config: standard.config }
}

/**
 * Resolve the effective workflow, distinguishing a missing config from a bad one.
 *
 * `default` means no `.dsh/eng.json`. `project` means the file names a known
 * flow and a sound binding addition. `invalid` means the file is unparsable,
 * missing a `flow` field, names an unknown flow, or its override fails
 * {@link validateWorkflow}; its problems are surfaced so a misconfigured gate
 * fails closed instead of silently degrading to the standard preset.
 */
async function resolveWorkflow(fs: Fs, cwd?: string): Promise<ResolvedWorkflow> {
  const raw = await readText(fs, '.dsh/eng.json', cwd)
  if (raw === undefined) {
    const standard = standardWorkflow()
    return { ...standard, problems: [], source: 'default' }
  }
  let parsed: { flow?: string; stage_bindings?: Record<string, StageBinding> }
  try {
    parsed = JSON.parse(raw) as { flow?: string; stage_bindings?: Record<string, StageBinding> }
  } catch (error) {
    const standard = standardWorkflow()
    return {
      ...standard,
      problems: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
      source: 'invalid',
    }
  }
  if (parsed.flow === undefined || parsed.flow.trim() === '') {
    const standard = standardWorkflow()
    return {
      ...standard,
      problems: ['eng.json exists but is missing a "flow" field — set it to standard|agile|minimal, or delete the file'],
      source: 'invalid',
    }
  }
  const resolved = resolveFlow(
    parsed.flow,
    parsed.stage_bindings !== undefined ? { stage_bindings: parsed.stage_bindings } : undefined,
  )
  if (!resolved.ok) {
    const standard = standardWorkflow()
    return {
      flow: resolved.flow,
      version: 0,
      config: standard.config,
      problems: [`unknown flow "${resolved.flow}" (known: ${resolved.knownFlows.join(', ')})`],
      source: 'invalid',
    }
  }
  const problems = validateWorkflow(resolved.config)
  return {
    flow: resolved.preset.id,
    version: resolved.preset.version,
    config: resolved.config,
    problems,
    source: problems.length === 0 ? 'project' : 'invalid',
  }
}

/** Write the bundled notch gate into `.git/hooks/` so `git commit` is mechanically gated. */
async function installCommitHook(fs: Fs, cwd?: string): Promise<void> {
  await writeText(fs, '.git/hooks/commit-msg', HOOK_TEMPLATE, cwd)
  await writeText(fs, '.git/hooks/package.json', HOOK_PACKAGE_JSON, cwd)
}

async function loadTask(fs: Fs, id: string, cwd?: string): Promise<TaskState> {
  const raw = await readText(fs, taskPath(id), cwd)
  if (raw === undefined) throw new Error(`no task "${id}" under ${taskPath(id)}`)
  const state = JSON.parse(raw) as TaskState
  // Tasks recorded before these features lack the fields; treat them as empty.
  state.artifacts = state.artifacts ?? {}
  state.files = state.files ?? []
  return state
}

async function writeTask(fs: Fs, state: TaskState, cwd?: string): Promise<void> {
  await writeText(fs, taskPath(state.id), JSON.stringify(state, null, 2), cwd)
}

/**
 * The workflow a task runs under: its frozen snapshot when present (created
 * 0.18+), otherwise the project's current config re-resolved on demand for
 * pre-snapshot records. A missing snapshot never silently widens a gate — the
 * live config must still resolve cleanly.
 */
async function workflowFor(state: TaskState, fs: Fs, cwd?: string): Promise<WorkflowConfig> {
  if (state.flow !== undefined) return state.flow.config
  const resolved = await resolveWorkflow(fs, cwd)
  if (resolved.problems.length > 0) {
    throw new Error(`invalid .dsh/eng.json — fix the project config first:\n- ${resolved.problems.join('\n- ')}`)
  }
  return resolved.config
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Read a rule file with a hard path, or undefined. */
function readAbsRule(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Resolve rule contents by name: bundled first, then user home, then project.
 * Bundled (core) rules win over user and project files of the same name, so a
 * project cannot shadow a shipped rule like `security-redlines` with a weaker
 * local copy; local additions use distinct names instead.
 * @param names - rule names from the current stage binding.
 * @param fs - sandboxed filesystem for the project-level lookup.
 * @returns the rules that resolved, in name order, with their bodies.
 */
async function resolveRules(names: string[], fs: Fs, cwd?: string): Promise<{ name: string; content: string }[]> {
  const result: { name: string; content: string }[] = []
  for (const rawName of names) {
    const name = sanitize(rawName)
    if (name === '') continue
    const bundled = readAbsRule(fileURLToPath(new URL(`../rules/${name}.md`, import.meta.url)))
    if (bundled !== undefined) {
      result.push({ name: rawName, content: bundled })
      continue
    }
    const user = readAbsRule(join(dshHome(), 'rules', `${name}.md`))
    if (user !== undefined) {
      result.push({ name: rawName, content: user })
      continue
    }
    const project = await readText(fs, `.dsh/rules/${name}.md`, cwd)
    if (project !== undefined) result.push({ name: rawName, content: project })
  }
  return result
}

/**
 * Render a stage's progressive-disclosure payload: skill names to load via the
 * `skill` tool, plus the resolved rule bodies to follow. Empty text means the
 * stage declares no bindings.
 * @param stage - current stage.
 * @param workflow - effective workflow.
 * @param fs - host filesystem for project-rule resolution.
 * @returns the disclosure text, or an empty string.
 */
async function renderBindings(stage: string, workflow: WorkflowConfig, fs: Fs, cwd?: string): Promise<string> {
  const binding = bindingsForStage(stage, workflow)
  const skills = binding?.skills ?? []
  const ruleNames = binding?.rules ?? []
  if (binding === undefined || (skills.length === 0 && ruleNames.length === 0)) return ''
  const rules = await resolveRules(ruleNames, fs, cwd)
  const skillPart = skills.length > 0
    ? `skills to load: ${skills.join(', ')}  (use the skill tool by name)`
    : 'skills to load: none'
  const rulePart = rules.length > 0
    ? `rules for this stage:\n${rules.map(r => `### ${r.name}\n${r.content}`).join('\n\n')}`
    : ''
  return [skillPart, rulePart].filter(Boolean).join('\n')
}

/** Narrowed view of `defineTool` args (the raw args are a JsonValue record). */
interface OpArgs {
  operation: string
  task_id?: string
  branch?: string
  title?: string
  work_size?: 'tiny' | 'standard' | 'complex'
  risk_level?: 'standard' | 'high_risk'
  items?: { id?: string; title?: string; status?: 'todo' | 'doing' | 'done' }[]
  item_id?: string
  description?: string
  spec_outcome?: 'pass' | 'fail'
  quality_outcome?: 'pass' | 'fail'
  notes?: string[]
  target_stage?: string
  passed?: boolean
  evidence?: string[]
  outcome?: 'pass' | 'blocked'
  artifact?: string
  fields?: Record<string, string>
  files?: string[]
  message?: string
  hash?: string
  content?: string
  overwrite?: boolean
  phase?: 'inspect' | 'propose' | 'apply'
}

/** Normalize the tool's `items` argument into complete TaskItem records. */
function normalizeItems(items: { id?: string; title?: string; status?: 'todo' | 'doing' | 'done' }[] | undefined): TaskItem[] {
  return (items ?? []).map(item => ({
    id: String(item.id ?? ''),
    title: String(item.title ?? ''),
    status: item.status ?? 'todo',
  }))
}

/** Resolve one item by id for the item-scoped audit operations. */
function requireItem(state: TaskState, id: string | undefined): TaskItem {
  if (id === undefined || id === '') throw new Error('dispatch/review_item requires item_id')
  const item = state.items.find(candidate => candidate.id === id)
  if (item === undefined) {
    throw new Error(`unknown item "${id}"; items: ${state.items.map(candidate => candidate.id).join(', ') || 'none'}`)
  }
  return item
}

/** Confirmation gates satisfied by a human approval, never by the task record. */
const CONFIRMATION_GUARDS: readonly GuardName[] = ['requirement_confirmation', 'solution_confirmation']

/** Narrow runtime view of the shared `approval` service (read optionally). */
interface ApprovalAsk {
  request(input: {
    agent: unknown
    toolName: string
    callId?: string
    reason?: string
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/** Human-readable label for a confirmation gate, used in the approval reason. */
function confirmationLabel(guard: GuardName): string {
  return guard === 'requirement_confirmation' ? '需求' : '方案'
}

/**
 * Ask a human to approve the pending confirmation gates, then re-run the
 * transition check. `'allowed-once'` satisfies the gates; every other outcome
 * (`rejected`/`cancelled`/`unavailable`) leaves them unmet and the advance
 * rejected. The approval audit pair lands on the agent's session log.
 */
export async function approveAdvance(
  ctx: Context,
  state: TaskState,
  target: string,
  workflow: WorkflowConfig,
  confirmations: GuardName[],
  exec: ToolRunContext,
): Promise<Result> {
  const approval = ctx.get('approval') as ApprovalAsk | undefined
  const labels = [...new Set(confirmations.map(confirmationLabel))].join('、')
  if (approval === undefined) {
    return { ok: false, errors: [`${labels}确认需人工批准，但审批服务不可用`] }
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: 'dev_task',
    callId: exec.callId,
    reason: `${labels}确认：请确认「${state.title}」的${labels}已达成，批准后流转到下一阶段。`,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    const verb = outcome === 'rejected' ? '被驳回' : outcome === 'cancelled' ? '已取消' : '无人批准'
    return { ok: false, errors: [`${labels}确认${verb}，流转被拒绝`] }
  }
  if (confirmations.includes('requirement_confirmation')) state.requirement_confirmed = true
  if (confirmations.includes('solution_confirmation')) state.solution_confirmed = true
  return assertAdvance(state, target, workflow)
}

const OPERATIONS = ['status', 'create', 'record', 'items', 'scope', 'dispatch', 'review_item', 'advance', 'verify', 'review', 'commit', 'config', 'install_hook', 'init'] as const

const TOOL_DESCRIPTION =
  'Own the engineering delivery workflow as hard state. Read or create the task record, record a ' +
  'stage artifact, record each implementation item\'s subagent dispatch and two-stage (spec + quality) ' +
  'review audit, advance one stage (rejected unless every configured guard already holds, including ' +
  'the stage artifacts; a requirement/solution confirmation guard asks a human to approve instead of ' +
  'being satisfied by the model), record verification or review, and gate a commit on ' +
  'stage/scope/message. The init operation manages the protected AGENTS.md in three phases ' +
  '(inspect → propose → apply; overwriting an existing file requires human approval) because DSH ' +
  'injects that file into every session. The tool refuses illegal moves ' +
  'instead of degrading — treat a rejection as a fact to fix, not a prompt to retry another way.'

/**
 * Register the `dev_task` tool on the calling scope. Call from an agent-plane
 * plugin (a row in `agent.cordis.yml`) so the tool is filed in that preset's
 * scope layer and only sessions on that preset see it.
 * @param ctx - a scoped context whose `tools` and `fs` resolve to the host registries.
 */
export function registerDevTask(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'dev_task',
    description: TOOL_DESCRIPTION,
    parameters: {
      operation: { type: 'string', enum: [...OPERATIONS], required: true, description: 'Which task-record action to perform.' },
      task_id: { type: 'string', description: 'Task id (short stable id like GREET-001); required on create and every other operation.' },
      branch: { type: 'string', description: 'Current git branch (recorded on create).' },
      title: { type: 'string', description: 'Task title (create).' },
      work_size: { type: 'string', enum: ['tiny', 'standard', 'complex'], description: 'Workload tier (create).' },
      risk_level: { type: 'string', enum: ['standard', 'high_risk'], description: 'Risk tier (create).' },
      items: {
        type: 'array',
        description: 'Implementation items (create/update).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string', enum: ['todo', 'doing', 'done'] },
          },
        },
      },
      item_id: { type: 'string', description: 'Item id to attach the dispatch/review audit to (dispatch/review_item).' },
      description: { type: 'string', description: 'Dispatched subagent task description (dispatch).' },
      spec_outcome: { type: 'string', enum: ['pass', 'fail'], description: 'Specification-conformance verdict (review_item).' },
      quality_outcome: { type: 'string', enum: ['pass', 'fail'], description: 'Code-quality verdict (review_item).' },
      notes: { type: 'array', items: { type: 'string' }, description: 'Findings or defects (review_item).' },
      target_stage: { type: 'string', description: 'Stage to advance to (advance).' },
      passed: { type: 'boolean', description: 'Verification passed (verify).' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Verification evidence (verify).' },
      outcome: { type: 'string', enum: ['pass', 'blocked'], description: 'Review outcome (review).' },
      artifact: { type: 'string', description: 'Artifact id to record fields for (record).' },
      fields: {
        type: 'object',
        description: 'Field values for the artifact (record).',
        additionalProperties: true,
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Repo-relative paths in scope (create/scope) or being committed (commit).',
      },
      message: { type: 'string', description: 'Commit summary to validate (commit).' },
      hash: { type: 'string', description: 'Commit hash to record after the git commit (commit).' },
      content: { type: 'string', description: 'Full AGENTS.md body (init propose/apply). Inspect the existing file first via init phase=inspect.' },
      overwrite: { type: 'boolean', description: 'Allow replacing an existing AGENTS.md (init apply); triggers human approval.' },
      phase: { type: 'string', enum: ['inspect', 'propose', 'apply'], description: 'init phase: inspect (read-only), propose (preview draft, no write), apply (write; overwriting an existing file requires human approval).' },
    },
    output: {
      schema: { type: 'string' },
      render(_args: unknown, value: string) {
        return [{ type: 'text', text: value }]
      },
    },
    async execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<string> {
      const a = args as unknown as OpArgs
      const fs = ctx.fs
      // The session workspace drives every relative path; the backend's own base
      // (its config.cwd) is the harness process directory, never the workspace.
      const cwd = exec.agent?.session.header.cwd

      if (a.operation === 'config') {
        const resolved = await resolveWorkflow(fs, cwd)
        return JSON.stringify({
          source: resolved.source,
          valid: resolved.problems.length === 0,
          problems: resolved.problems,
          workflow: resolved.config,
        }, null, 2)
      }

      if (a.operation === 'install_hook') {
        await installCommitHook(fs, cwd)
        return 'installed commit-msg hook at .git/hooks/commit-msg — git commit is now gated by the task state'
      }

      if (a.operation === 'init') {
        const phase = a.phase ?? 'inspect'
        const existing = await readText(fs, 'AGENTS.md', cwd)

        if (phase === 'inspect') {
          if (existing === undefined) {
            return `no AGENTS.md yet — scan the project (structure, stack, build/run, conventions, redlines) and call init phase=propose with content: a Markdown body of at most ${INIT_MAX_LINES} lines.`
          }
          return `existing AGENTS.md (${lineCount(existing)} lines, cap ${INIT_MAX_LINES}) is already injected into every session in this workspace. Reuse it as-is, or rewrite it via init phase=propose then phase=apply (overwriting requires human approval):\n---\n${existing}\n---`
        }

        const content = a.content
        if (content === undefined || content.trim() === '') {
          throw new Error(`init phase=${phase} requires non-empty content`)
        }
        const lines = lineCount(content)
        if (lines > INIT_MAX_LINES) {
          throw new Error(`AGENTS.md is ${lines} lines; the cap is ${INIT_MAX_LINES}. Trim to the essentials (what the project is, how to run/build it, structure, conventions, redlines) and retry.`)
        }

        if (phase === 'propose') {
          const action = existing === undefined ? 'create' : 'overwrite'
          return `proposed ${action} ./AGENTS.md (${lines} lines, cap ${INIT_MAX_LINES}). No file was written — review the draft, then call init phase=apply${existing !== undefined ? ' (overwriting requires human approval)' : ''} with the same content:\n---\n${content}\n---`
        }

        if (phase === 'apply') {
          if (existing !== undefined && a.overwrite !== true) {
            throw new Error(`AGENTS.md already exists (${lineCount(existing)} lines) and is protected. Inspect via init phase=inspect, merge, then resubmit with phase=apply plus overwrite: true (human approval).`)
          }
          if (existing !== undefined) {
            const approval = ctx.get('approval') as ApprovalAsk | undefined
            if (approval === undefined) {
              throw new Error('overwriting the protected AGENTS.md requires human approval, but the approval service is unavailable')
            }
            const outcome = await approval.request({
              agent: exec.agent,
              toolName: 'dev_task',
              callId: exec.callId,
              reason: `init 覆盖：请确认允许覆盖工作区已有 AGENTS.md（${lineCount(existing)} 行）`,
              signal: exec.signal,
            })
            if (outcome !== 'allowed-once') {
              throw new Error(`overwriting AGENTS.md was not approved (${outcome}); nothing was written`)
            }
          }
          await writeText(fs, 'AGENTS.md', content, cwd)
          return `wrote ./AGENTS.md (${lines} lines, cap ${INIT_MAX_LINES}). DSH injects it into every session in this workspace from now on.`
        }

        throw new Error(`unknown init phase "${phase}" (expected inspect|propose|apply)`)
      }

      if (a.operation === 'create') {
        if (!a.task_id || !a.title || !a.branch) {
          throw new Error('create requires task_id, title, and branch')
        }
        const resolved = await resolveWorkflow(fs, cwd)
        if (resolved.problems.length > 0) {
          throw new Error(`invalid .dsh/eng.json — fix the project config first:\n- ${resolved.problems.join('\n- ')}`)
        }
        const risk = a.risk_level ?? 'standard'
        if (risk === 'high_risk' && !flowSatisfies(resolved.flow, HIGH_RISK_REQUIRED_CAPABILITIES)) {
          throw new Error(
            `high_risk task cannot run on flow "${resolved.flow}" — it lacks the required capabilities ` +
            `(${HIGH_RISK_REQUIRED_CAPABILITIES.join(', ')}). Use the standard flow or lower the task risk.`,
          )
        }
        const flow: FlowSnapshot = { flow: resolved.flow, version: resolved.version, config: resolved.config }
        const state = newTask({
          id: a.task_id,
          title: a.title,
          branch: a.branch,
          work_size: a.work_size ?? 'standard',
          risk_level: risk,
          flow,
        })
        state.items = normalizeItems(a.items)
        state.files = a.files ?? []
        await writeTask(fs, state, cwd)
        return `created ${state.id} at stage ${state.stage}; legal next: ${legalTargets(state.stage, flow.config).join(', ') || 'none'}`
      }

      if (!a.task_id) throw new Error('task_id is required for this operation')
      const state = await loadTask(fs, a.task_id, cwd)
      const workflow = await workflowFor(state, fs, cwd)

      if (a.operation === 'status') {
        const binding = bindingsForStage(state.stage, workflow)
        const rules = await resolveRules(binding?.rules ?? [], fs, cwd)
        return JSON.stringify({
          id: state.id,
          stage: state.stage,
          flow: state.flow !== undefined ? { flow: state.flow.flow, version: state.flow.version } : null,
          risk_level: state.risk_level,
          work_size: state.work_size,
          requirement_confirmed: state.requirement_confirmed,
          solution_confirmed: state.solution_confirmed,
          items_done: `${state.items.filter(i => i.status === 'done').length}/${state.items.length}`,
          verification: state.verification,
          review: state.review,
          artifacts: state.artifacts,
          files: state.files,
          legal_next: legalTargets(state.stage, workflow),
          commit: commitCheckpoint(state, workflow),
          bindings: {
            skills: binding?.skills ?? [],
            rules: rules.map(r => ({ name: r.name, content: r.content })),
          },
        }, null, 2)
      }

      if (a.operation === 'commit') {
        const checkpoint = commitCheckpoint(state, workflow)
        if (!checkpoint.allowed) throw new Error(checkpoint.reason ?? 'no commit is due')
        if (workflow.commit.file_scope) {
          if (!a.files || a.files.length === 0) {
            throw new Error('commit requires files (the repo-relative paths being committed) when file_scope is on')
          }
          const scope = checkFileScope(state, a.files, workflow)
          if (!scope.ok) {
            throw new Error(scope.noScope
              ? 'task declares no file scope; record files first (create files=... or scope files=...)'
              : `commit touches files outside the task scope: ${scope.outside.join(', ')}`)
          }
        }
        const message = validateCommitMessage(a.message ?? '', workflow)
        if (!message.ok) throw new Error(message.errors!.join('; '))
        if (a.hash) state.commits.push({ label: checkpoint.label!, hash: a.hash })
        await writeTask(fs, state, cwd)
        return `commit approved (${checkpoint.label ?? ''}) — git add ${(a.files ?? []).join(' ')}; git commit -m "${a.message ?? ''}"`
      }

      let note: string | undefined
      switch (a.operation) {
        case 'record': {
          if (!a.artifact) throw new Error('record requires artifact (the artifact id)')
          const def = workflow.artifacts.find(artifact => artifact.id === a.artifact)
          if (!def) {
            throw new Error(`unknown artifact "${a.artifact}"; declared: ${workflow.artifacts.map(x => x.id).join(', ') || 'none'}`)
          }
          const merged = { ...(state.artifacts[def.id] ?? {}) }
          for (const [field, value] of Object.entries(a.fields ?? {})) {
            if (!def.fields.includes(field)) {
              throw new Error(`artifact "${def.id}" has no field "${field}"; fields: ${def.fields.join(', ')}`)
            }
            merged[field] = value === undefined || value === null ? '' : String(value)
          }
          state.artifacts[def.id] = merged
          const missing = def.fields.filter(field => !merged[field] || merged[field].trim() === '')
          note = missing.length === 0
            ? `recorded ${def.name} ("${def.id}") — all required fields present`
            : `recorded ${def.name} ("${def.id}"); still missing: ${missing.join(', ')}`
          break
        }
        case 'scope':
          state.files = a.files ?? []
          note = `file scope set to ${state.files.length} files${state.files.length > 0 ? ': ' + state.files.join(', ') : ' (empty — commits are blocked until files are declared)'}`
          break
        case 'items':
          state.items = normalizeItems(a.items)
          note = `items set: ${state.items.map(i => `${i.id}:${i.status}`).join(', ') || 'none'}`
          break
        case 'dispatch': {
          const item = requireItem(state, a.item_id)
          item.dispatch = { description: a.description ?? '', at: new Date().toISOString() }
          note = `dispatched item "${item.id}" to a subagent: ${item.dispatch.description || '(no description)'}`
          break
        }
        case 'review_item': {
          const item = requireItem(state, a.item_id)
          if (a.spec_outcome !== 'pass' && a.spec_outcome !== 'fail') throw new Error('review_item requires spec_outcome: pass|fail')
          if (a.quality_outcome !== 'pass' && a.quality_outcome !== 'fail') throw new Error('review_item requires quality_outcome: pass|fail')
          const auditNotes = a.notes === undefined ? {} : { notes: a.notes }
          item.review = {
            spec: { outcome: a.spec_outcome, ...auditNotes },
            quality: { outcome: a.quality_outcome, ...auditNotes },
          }
          note = `reviewed item "${item.id}": spec=${a.spec_outcome}, quality=${a.quality_outcome}`
          break
        }
        case 'advance': {
          const target = a.target_stage ?? ''
          let result = assertAdvance(state, target, workflow)
          if (!result.ok) {
            const unmet = unmetGuards(state, target, workflow)
            const confirmations = unmet.filter(guard => CONFIRMATION_GUARDS.includes(guard))
            const others = unmet.filter(guard => !CONFIRMATION_GUARDS.includes(guard))
            // Confirmation gates are satisfied by a human approval, not the record.
            if (confirmations.length > 0 && others.length === 0 && exec.agent !== undefined) {
              result = await approveAdvance(ctx, state, target, workflow, confirmations, exec)
            }
          }
          if (!result.ok) throw new Error(result.errors!.join('; '))
          state.stage = target
          const disclosure = await renderBindings(state.stage, workflow, fs, cwd)
          note = disclosure === '' ? `advanced to ${state.stage}` : `advanced to ${state.stage}\n${disclosure}`
          break
        }
        case 'verify':
          state.verification = { passed: a.passed === true, evidence: a.evidence ?? [] }
          break
        case 'review':
          if (a.outcome !== 'pass' && a.outcome !== 'blocked') throw new Error('review requires outcome: pass|blocked')
          state.review.outcome = a.outcome
          break
        default:
          throw new Error(`unknown operation ${a.operation}`)
      }

      await writeTask(fs, state, cwd)
      return note ?? `ok (stage ${state.stage})`
    },
  }))
}