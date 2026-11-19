// Public SDK fixture. The adapter supplies deterministic tool calls and failures.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LlmAdapter, ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { executeTool } from './tool-runtime.mjs'

export const name = 'task-engine-keyless-team-probe'
export const inject = ['llm', 'agentPresets', 'subagents', 'agentTeams', 'tools']

const route = { provider: 'team-fixture', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }

function tool(id, name, args) {
  const callId = ToolCallId(id), json = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: json } },
    { type: 'finish', reason: { kind: 'tool-calls' } }]
}

function response(text) {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

export function apply(ctx) {
  let scriptedCalls = 0
  let callNumber = 0
  const running = new Map()
  const turnsAtMax = new Map()
  const releaseParallel = Promise.withResolvers()
  const cancelStarted = Promise.withResolvers()
  const endListeners = new Map()
  const ended = new Map()
  ctx.on('subagent/end', event => {
    ended.set(event.id, event)
    endListeners.get(event.id)?.resolve(event)
  })
  const settled = id => {
    if (ended.has(id)) return Promise.resolve(ended.get(id))
    const deferred = Promise.withResolvers()
    endListeners.set(id, deferred)
    const timer = setTimeout(() => deferred.reject(new Error('No native settlement for ' + id)), 12000)
    timer.unref()
    return deferred.promise.finally(() => { clearTimeout(timer); endListeners.delete(id) })
  }
  class TeamAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model,
        reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } }
    }
    async *stream(options) {
      scriptedCalls++
      const history = JSON.stringify(options.messages)
      const marker = ['TEAM_RESUME', 'TEAM_CANCEL', 'TEAM_A', 'TEAM_B', 'STANDARD_NATIVE']
        .find(value => history.includes(value))
      assert.deepEqual({ provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort }, route)
      turnsAtMax.set(marker, (turnsAtMax.get(marker) ?? 0) + 1)
      if (marker === 'STANDARD_NATIVE') { yield* response('Standard member completed'); return }
      if (marker === 'TEAM_CANCEL') {
        cancelStarted.resolve()
        await new Promise((_, reject) => {
          if (options.signal.aborted) reject(options.signal.reason)
          else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        })
        return
      }
      assert.ok(marker, history.slice(-1200))
      const step = running.get(marker) ?? 0
      running.set(marker, step + 1)
      if (step === 0 && marker !== 'TEAM_RESUME') await releaseParallel.promise
      if (marker === 'TEAM_B') throw new Error('scripted B failure')
      if (step === 0) {
        yield* tool(marker + '-denied', 'write', { file_path: 'forbidden-team.txt', content: 'forbidden' })
      } else if (step === 1) {
        const denied = options.messages.findLast(message => message.role === 'tool')
        assert.ok(denied?.content?.some(block => block.type === 'text' && block.text.includes('登记的普通文件')), JSON.stringify(denied))
        yield* tool(marker + '-write', 'write', { file_path: 'team-a.txt', content: marker + '\n' })
      } else {
        yield* response(marker + ' changed team-a.txt')
      }
    }
  }
  ctx.llm.registerAdapter(['team-fixture'], new TeamAdapter())
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.id !== 'preset-team-fixture') return
    const cwd = agent.session.header.cwd
    writeFileSync(join(cwd, 'team-verification.test.mjs'),
      "import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; test('team fixture output', () => assert.match(readFileSync('team-a.txt', 'utf8'), /TEAM_RESUME/));\n")
    agent.model.select(route)
    await ctx.agentPresets.select(agent, 'eng')
    await ctx.agentTeams.setEnabled(agent, true)
    assert.deepEqual(agent.model.current(), route)
    const presentation = await agent.ctx.systemPrompt.assemble({ agent, scope: agent })
    assert.match(JSON.stringify(presentation.sections), /team_collect/)
    assert.ok(!JSON.stringify(presentation.sections).includes('Task readiness never starts an owner'))
    const taskId = 'TEAM-SDK'
    const invoke = async (name, args) => {
      const callId = ToolCallId('team-fixture-' + callNumber++)
      const logged = name === 'dev_task' && args.operation === 'load_skill'
      const call = logged ? agent.session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) }) : undefined
      const signal = AbortSignal.timeout(15000)
      const toolSet = await agent.ctx.tools.resolve({ agent, signal, modelSelection: agent.model.current() })
      let result
      try { result = await executeTool(agent.ctx, { name, arguments: args, agent, signal, callId, toolSet }) }
      finally { toolSet.dispose() }
      if (call) agent.session.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId, content: result.content, isError: result.isError }) },
      { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      return { isError: result.isError, text: result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') }
    }
    const action = async (operation, args = {}, problem) => {
      const result = await invoke('dev_task', { task_id: taskId, operation, ...args })
      if (problem) {
        assert.equal(result.isError, true, result.text)
        assert.match(result.text, problem)
      } else assert.equal(result.isError, false, operation + ': ' + result.text)
      return result.text
    }
    const record = () => JSON.parse(readFileSync(join(cwd, '.dsh/tasks', taskId, 'task.json'), 'utf8'))
    await action('create', { title: 'Native Team SDK fixture', intent: 'implementation', intent_reason: 'fixture', complexity: 'low',
      complexity_reason: 'Three scoped fixture items', files: ['team-a.txt', 'team-b.txt'],
      items: [{ id: 'A', title: 'File A' }, { id: 'B', title: 'File B' }, { id: 'C', title: 'Conflicts with A' }] })
    await action('dispatch', { item_id: 'A' }, /需求尚未/)
    for (const name of ['subagent', 'subagent_fork', 'send_message', 'team_task_create', 'team_task_update'])
      assert.equal((await invoke(name, {})).isError, true, 'raw entry ' + name)
    await action('record', { artifact: 'requirement', fields: { goal: 'exercise Team integration', scope: 'two fixture paths', acceptance: 'worker lifecycle and real command' } })
    const summary = JSON.parse(await action('prepare_requirement'))
    await action('confirm_requirement', { expected_hash: summary.requirement.hash })
    if (!['开发', '代码开发'].includes(record().stage)) {
      for (const binding of record().flow.config.stage_bindings[record().stage]?.skills ?? []) {
        if (binding.loading !== 'on-demand') await action('load_skill', { skill_name: binding.skill.source + ':' + binding.skill.name })
      }
      await action('advance', { target_stage: record().flow.config.stages[1] })
    }
    for (const [id, file] of [['A', 'team-a.txt'], ['B', 'team-b.txt'], ['C', 'team-a.txt']]) {
      await action('plan_execution', { item_id: id, execution: 'spawn', task_boundary: 'independent',
        delegation_benefit: 'parallel', execution_reason: 'independent output with fixture overlap case',
        acceptance: ['return changed files to the lead'], files: [file] })
    }
    await action('plan_verification', { verification_group: 'scope-a', command: 'node --test --test-isolation=none --test-reporter=tap team-verification.test.mjs',
      item_ids: ['A', 'C'], files: ['team-a.txt', 'team-verification.test.mjs'] })
    await action('plan_verification', { verification_group: 'scope-b', command: 'node --test --test-isolation=none --test-reporter=tap team-verification.test.mjs',
      item_ids: ['B'], files: ['team-b.txt', 'team-verification.test.mjs'] })
    await action('dispatch', { item_id: 'A', description: 'TEAM_A' }, /强制 Skill/)
    for (const binding of record().flow.config.stage_bindings[record().stage]?.skills ?? []) {
      if (binding.loading === 'on-demand') continue
      await action('load_skill', { skill_name: binding.skill.source + ':' + binding.skill.name })
    }
    const a = JSON.parse(await action('dispatch', { item_id: 'A', description: 'TEAM_A' })).dispatch
    const b = JSON.parse(await action('dispatch', { item_id: 'B', description: 'TEAM_B' })).dispatch
    assert.notEqual(a.run_id, b.run_id)
    assert.equal(ctx.agentTeams.getTask(agent, a.team.board_id).ownerId, a.run_id)
    assert.equal(ctx.agentTeams.getTask(agent, a.team.board_id).status, 'in_progress')
    assert.equal((await invoke('team_task_list', {})).isError, false)
    assert.equal((await invoke('team_task_get', { task_id: a.team.board_id })).isError, false)
    await action('dispatch', { item_id: 'A' }, /already in progress/)
    await action('dispatch', { item_id: 'C' }, /重叠/)
    await action('revise', { revision_kind: 'requirement', revision_reason: 'blocked while active' }, /锁定父任务/)
    await action('verify', { verification_group: 'scope-a' }, /锁定父任务/)
    assert.equal((await invoke('write', { file_path: 'team-a.txt', content: 'parent race' })).isError, true)
    releaseParallel.resolve()
    await Promise.all([settled(a.run_id), settled(b.run_id)])
    assert.equal((await invoke('wait_agent', { timeout_ms: 10000 })).isError, false)
    await action('team_collect', { item_id: 'A' })
    await action('team_collect', { item_id: 'B' })
    assert.equal(record().items[0].status, 'doing', JSON.stringify(record().items[0].dispatch))
    assert.equal(record().items[1].dispatch.status, 'failed')
    assert.equal(ctx.agentTeams.getTask(agent, a.team.board_id).status, 'completed')
    assert.equal(ctx.agentTeams.getTask(agent, b.team.board_id).status, 'pending')
    assert.equal(existsSync(join(cwd, 'forbidden-team.txt')), false)
    assert.equal(readFileSync(join(cwd, 'team-a.txt'), 'utf8'), 'TEAM_A\n')
    await action('accept_item', { item_id: 'A', spec_outcome: 'pass', quality_outcome: 'pass' }, /verification|receipt|test/iu)
    ended.delete(a.run_id)
    const resumed = JSON.parse(await action('team_resume', { item_id: 'A', team_message: 'TEAM_RESUME' })).dispatch
    assert.equal(resumed.run_id, a.run_id)
    assert.equal(resumed.team.board_id, a.team.board_id)
    assert.notEqual(resumed.team.message_id, a.team.message_id)
    assert.notEqual(resumed.team.activation_id, a.team.activation_id)
    await settled(a.run_id)
    await ctx.agentTeams.setEnabled(agent, false)
    await action('team_collect', { item_id: 'A' })
    assert.match(record().items[0].dispatch.team.board_problem, /开关已关闭/)
    await action('team_resume', { item_id: 'A', team_message: 'TEAM_RESUME' }, /开启团队/)
    await ctx.agentTeams.setEnabled(agent, true)
    await action('team_collect', { item_id: 'A' })
    assert.equal(record().items[0].dispatch.team.board_problem, undefined)
    assert.equal(readFileSync(join(cwd, 'team-a.txt'), 'utf8'), 'TEAM_RESUME\n')
    ended.delete(b.run_id)
    const cancel = JSON.parse(await action('team_resume', { item_id: 'B', team_message: 'TEAM_CANCEL' })).dispatch
    assert.equal(cancel.run_id, b.run_id)
    await Promise.race([cancelStarted.promise, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Cancellation fixture did not start')), 10000)
      timer.unref()
    })])
    await action('team_cancel', { item_id: 'B' })
    await settled(b.run_id)
    await action('team_collect', { item_id: 'B' })
    assert.equal(record().items[1].dispatch.team.cancelled, true)
    assert.equal(record().items[1].status, 'todo')
    // Simulate a persisted running row whose in-process receipt is lost after
    // restart, keeping the real host's durable child and inactive catalog.
    const interrupted = record()
    interrupted.items[1].dispatch.status = 'running'
    interrupted.items[1].status = 'doing'
    writeFileSync(join(cwd, '.dsh/tasks', taskId, 'task.json'), JSON.stringify(interrupted))
    await action('team_collect', { item_id: 'B' }, /缺少该轮执行证明/)
    await action('recover_dispatch', { item_id: 'B' })
    assert.equal(record().items[1].dispatch.status, 'failed')
    assert.equal(record().items[1].status, 'todo')
    await action('verify', { verification_group: 'scope-a', timeout_ms: 10000 })
    assert.equal(record().verification_runs.at(-1).receipt.test_summary.count, 1)
    await action('accept_item', { item_id: 'A', spec_outcome: 'pass', quality_outcome: 'pass' })
    assert.equal(record().items[0].status, 'done')
    await action('team_resume', { item_id: 'A', team_message: 'already accepted' }, /已经执行完成/)
    await ctx.agentPresets.select(agent, 'standard')
    assert.deepEqual(agent.model.current(), route)
    for (const marker of ['TEAM_A', 'TEAM_B', 'TEAM_RESUME', 'TEAM_CANCEL']) assert.ok(turnsAtMax.has(marker), marker)
    const standard = await agent.ctx.systemPrompt.assemble({ agent, scope: agent })
    assert.match(JSON.stringify(standard.sections), /Task readiness never starts an owner/)
    agent.ctx.tools.setExecutor(new NativeToolExecutor(agent.ctx))
    const native = await invoke('team_task_create', { subject: 'Standard Team fixture', description: 'Native board mutation in standard' })
    assert.equal(native.isError, false, native.text)
    writeFileSync(process.env.TASK_ENGINE_TEAM_PROBE_RESULT, JSON.stringify({ external_model_calls: 0, scripted_calls: scriptedCalls,
      model: route.model, reasoning_effort: route.reasoningEffort, requests_at_max: Object.fromEntries(turnsAtMax),
      parallel: true, overlap_denied: true, duplicate_denied: true, requirement_and_skill_gates: true, worker_scope_enforced: true,
      resume_same_member: true, switch_off_collection: true, cancelled: true, failed_run_reusable: true, interrupted_receipt_recovery: true,
      board_does_not_accept: true, real_tests: 1, standard_native_board: true }, null, 2))
  })
}
