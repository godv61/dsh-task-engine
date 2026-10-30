/** Host-owned requirement documents and human questions; no model-supplied approval flag. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { TaskState } from './engine.ts'
import { acquireTaskMutation } from './execution-plan.ts'
import { hashText } from './snapshot.ts'
import { assertInsideRoot } from './path-guard.ts'
import { isSensitivePath } from './project.ts'
import { loadTask, readText, writeTask, writeText, type WriteFs } from './task-store.ts'
import { invalidateRequirement, requirementConfirmed, requirementSource, requirementsView, REQUIREMENT_FIELDS, type ClarificationQuestion } from './requirements.ts'

interface UserQuestions {
  ask(input: { agent: unknown; signal?: AbortSignal; wait?: { callId: unknown };
    questions: (ClarificationQuestion & { header?: string; detail?: string })[] }):
    Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>
}
export const REQUIREMENT_OPERATIONS = ['clarify_requirement', 'prepare_requirement', 'confirm_requirement'] as const
const APPROVE = '确认无误，继续'

export async function requirementDocumentProblem(fs: Context['fs'], state: TaskState, cwd?: string): Promise<string | undefined> {
  const doc = state.requirements?.document
  if (!state.flow?.config.requirement_review || !doc) return undefined
  assertInsideRoot(state.root ?? cwd ?? '', state.root ?? cwd ?? '', doc.path)
  const raw = await readText(fs, doc.path, state.root ?? cwd)
  return raw === undefined || hashText(raw) !== doc.hash ? '需求文档已变更或丢失；请核对并重新 prepare_requirement，再确认当前版本' : undefined
}

interface Environment {
  ctx: Context; exec: ToolRunContext; state: TaskState; cwd: string | undefined; mutationPath: string
  writeMode(): Promise<'workspace-write' | 'danger-full-access'>
}
export async function executeRequirementCommand(args: {
  operation: string; document_path?: string; expected_hash?: string; clarification_questions?: ClarificationQuestion[]
}, env: Environment): Promise<string> {
  const { ctx, exec, state, cwd, mutationPath } = env, fs = ctx.fs
  const policy = state.flow?.config.requirement_review
  if (!policy) throw new Error('此任务缺少新版需求确认结构；请重新创建 intent=implementation 任务后整理并确认需求')
  if (args.operation === 'confirm_requirement' && args.expected_hash === state.requirements?.document?.hash
    && requirementConfirmed(state, state.flow!.config) && !await requirementDocumentProblem(fs, state, cwd)) {
    return JSON.stringify({ requirement: requirementsView(state), reused: true, next_action: '当前版本已确认，复用原回执；无需再次询问用户。' })
  }
  if (state.stage !== policy.stage) throw new Error(`需求修订请先 revise revision_kind=requirement 返回 ${policy.stage}`)
  const root = state.root ?? cwd
  const mode = await env.writeMode()
  if (args.operation === 'prepare_requirement') {
    const def = state.flow!.config.artifacts.find(item => item.id === policy.artifact)!
    const fields = state.artifacts[policy.artifact] ?? {}
    const missing = def.fields.filter(key => !fields[key]?.trim())
    if (missing.length) throw new Error(`需求总结尚缺字段：${missing.join(', ')}；先 record requirement`)
    if (state.requirements?.clarifications.some(question => !question.answer)) throw new Error('仍有未回答的澄清问题；先通过 clarify_requirement 获取用户答复')
    const previous = state.requirements?.document
    const path = args.document_path ?? previous?.path ?? `docs/requirements/${state.id}.md`
    if (!/^(?![./])[^\r\n\\:*?"<>|]+\.md$/u.test(path) || path.split('/').some(part => !part || part === '..')
      || path.startsWith('.dsh/') || isSensitivePath(path)) throw new Error('document_path 必须是工作区内的普通 Markdown 路径，例如 docs/requirements/TASK-1.md')
    assertInsideRoot(root ?? '', root ?? '', path)
    const source = requirementSource(state, policy)
    const version = previous ? previous.source === source && previous.path === path ? previous.version : previous.version + 1 : 1
    const content = renderRequirement(state, version)
    const info = await (fs as unknown as WriteFs).lstat(path, root === undefined ? undefined : { cwd: root })
    const existing = await readText(fs, path, root)
    if (existing !== undefined && existing !== content && (!previous || previous.path !== path || hashText(existing) !== previous.hash))
      throw new Error('需求文档存在未纳入草案的人工修改；先读取并合并到 requirement，使用新的 document_path 保留原文件。不会覆盖现有修改')
    if (existing !== content) {
      await writeText(fs, path, content, root, mode, info ? { kind: 'replaceIfVersion', version: info.version } : { kind: 'createIfAbsent' })
    }
    const unchanged = previous?.source === source && previous.path === path && previous.hash === hashText(content)
    state.requirements ??= { clarifications: [] }
    state.requirements.document = unchanged ? previous! : { version, path, source, content, hash: hashText(content), status: 'awaiting_confirmation' }
    if (!unchanged) state.requirement_confirmed = false
    await writeTask(fs, state, cwd, mode)
    return JSON.stringify({ requirement: requirementsView(state), content,
      next_action: '把本版需求总结展示给用户；调用 confirm_requirement expected_hash=本次hash，由宿主询问用户。存在疑问先 clarify_requirement，不能将模型建议视为用户决定。' })
  }
  const questionService = ctx.get('userQuestions') as UserQuestions | undefined
  if (!exec.agent || !questionService?.ask) throw new Error('需求确认需要宿主 userQuestions 人工答复服务；不会用自动执行权限或模型自述代替确认')
  const nonce = randomUUID()
  const questions: (ClarificationQuestion & { header?: string; detail?: string })[] = []
  if (args.operation === 'clarify_requirement') {
    const incoming = args.clarification_questions
    if (!incoming?.length || incoming.length > 3 || incoming.some(q => !/^[A-Za-z0-9_-]{1,40}$/u.test(q.id) || !q.question?.trim()
      || q.options && (q.options.length < 2 || q.options.length > 4 || q.options.some(o => !o.label?.trim())))
      || new Set(incoming.map(q => q.id)).size !== incoming.length) throw new Error('clarification_questions 每批需要 1–3 个不同 id 的关键问题；选项可省略或提供 2–4 个非空选项')
    state.requirements ??= { clarifications: [] }
    for (const question of incoming) {
      const old = state.requirements.clarifications.findIndex(q => q.id === question.id)
      const entry = { ...question, request_id: nonce }
      if (old < 0) state.requirements.clarifications.push(entry)
      else state.requirements.clarifications[old] = entry
      questions.push({ ...question, header: '需求澄清' })
    }
    invalidateRequirement(state)
  } else {
    const doc = state.requirements?.document
    if (!doc || args.expected_hash !== doc.hash || doc.source !== requirementSource(state, policy)) throw new Error('需求版本已变化或未生成；先 prepare_requirement，再提交返回的 expected_hash')
    if (doc.status === 'changes_requested') throw new Error('用户已要求修改；先根据意见修订或澄清，再生成新版本，不能原样重复请求确认')
    if (state.requirements!.clarifications.some(question => !question.answer)) throw new Error('仍有未回答的需求问题，不能确认')
    const problem = await requirementDocumentProblem(fs, state, cwd)
    if (problem) throw new Error(problem)
    doc.question_id = nonce
    doc.status = 'awaiting_confirmation'
    delete doc.confirmation
    state.requirement_confirmed = false
    questions.push({ id: nonce, header: '确认需求范围', question: `请审阅「${state.title}」需求总结 v${doc.version}，确认无误后才进入后续开发。`,
      detail: doc.content, options: [{ label: APPROVE, description: '确认本版范围、业务规则、验收条件和列明的待联调事项。' },
        { label: '需要修改', description: '保持需求阶段，请填写需要调整或补充的内容。' }] })
  }
  await writeTask(fs, state, cwd, mode)
  // Never hold a task mutation lock while a human reads and answers.
  let response: Awaited<ReturnType<UserQuestions['ask']>> | undefined, failure: unknown
  try { response = await questionService.ask({ agent: exec.agent, signal: exec.signal,
    ...(exec.callId ? { wait: { callId: exec.callId } } : {}), questions }) }
  catch (error) { failure = error }
  const release = acquireTaskMutation(mutationPath)
  try {
    const fresh = await loadTask(fs, state.id, cwd)
    if (fresh.completed || fresh.stage !== policy.stage) throw new Error('等待期间任务已改变；本次答复不会放行旧需求')
    if (args.operation === 'clarify_requirement') {
      for (const question of fresh.requirements?.clarifications ?? []) {
        if (question.request_id !== nonce) continue
        const answer = response?.answers.find(item => item.id === question.id)
        if (answer && (answer.selected?.length || answer.custom?.trim())) question.answer = {
          selected: answer.selected ?? [], ...(answer.custom ? { custom: answer.custom } : {}), at: new Date().toISOString() }
      }
    } else {
      const doc = fresh.requirements?.document
      if (!doc || doc.question_id !== nonce || doc.hash !== args.expected_hash || doc.source !== requirementSource(fresh, policy)
        || await requirementDocumentProblem(fs, fresh, cwd)) throw new Error('用户审阅期间需求或文档已变化；旧版本答复不能放行，请重新生成并确认')
      const answer = response?.answers.find(item => item.id === nonce)
      const custom = answer?.custom?.trim() ?? ''
      const approved = !failure && !!answer && (answer.selected?.length === 1 && answer.selected[0] === APPROVE && !custom
        || !answer.selected?.length && /^(?:确认|确认继续|确认无误|已确认|同意继续)[。！!]?$/u.test(custom))
      doc.status = approved ? 'confirmed' : answer ? 'changes_requested' : 'awaiting_confirmation'
      doc.feedback = custom || (answer?.selected ?? []).join('；')
      delete doc.question_id
      if (approved) { doc.confirmation = { hash: doc.hash, version: doc.version, at: new Date().toISOString(), session_id: exec.agent.session.id }; fresh.requirement_confirmed = true }
    }
    await writeTask(fs, fresh, cwd, mode)
    if (failure) throw new Error(`未取得用户答复，保持需求阶段：${failure instanceof Error ? failure.message : String(failure)}`)
    return JSON.stringify({ requirement: requirementsView(fresh), clarifications: fresh.requirements?.clarifications,
      next_action: fresh.requirement_confirmed ? '本版已由用户确认，可以 advance；后续范围或验收变化须 revise requirement 后重新确认。'
        : '先根据用户意见补充或澄清 requirement；尚不能改业务代码或推进。' })
  } finally { release() }
}

function renderRequirement(state: TaskState, version: number): string {
  const policy = state.flow!.config.requirement_review!
  const fields = state.artifacts[policy.artifact] ?? {}
  const sections = Object.entries(REQUIREMENT_FIELDS).filter(([key]) => fields[key]?.trim())
    .map(([key, title]) => `## ${title}\n\n${fields[key]!.trim()}`)
  const answers = (state.requirements?.clarifications ?? []).map(q => `- 问：${q.question}\n  用户答复：${[...(q.answer?.selected ?? []), q.answer?.custom].filter(Boolean).join('；')}`)
  return [`# 需求总结：${state.title}`, `任务：${state.id} · 版本：${version}`, ...sections,
    ...(answers.length ? ['## 澄清记录\n\n' + answers.join('\n')] : []),
    '## 确认说明\n\n此文件是待审阅的需求版本；实际确认状态与本版本指纹记录在任务台账。列明的待联调事项不代表已完成联调。'].join('\n\n') + '\n'
}
