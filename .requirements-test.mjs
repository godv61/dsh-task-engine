import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve, sep } from 'node:path'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { registerDevTask } from './lib/dev-task.js'
import { requirementConfirmed } from './lib/requirements.js'
import { assertAdvance, checkFileScope, commitCheckpoint, completionBlockers } from './lib/engine.js'
import Controller from './lib/controller.js'

const fields = { goal: '让用户按相关人员查找记录', scope: '本期增加一个查询条件', non_goals: '不调整审批流程',
  rules: '主管、经理、总监任一匹配即可命中', exceptions: '空条件保持原查询结果',
  acceptance: '三种角色分别命中；无匹配返回空', dependencies: '复用既有接口；真实环境联调由用户后续完成' }
function fixture() {
  const cwd = resolve('requirement-project'), files = new Map([[join(cwd, 'package.json'), '{"name":"requirement-project"}']])
  const events = [], guards = [], listeners = new Map(), asked = []
  let execute, revision = 0, answer = request => ({ answers: request.questions.map(q => ({ id: q.id, selected: ['确认无误，继续'] })) })
  const key = (path, opts) => join(opts?.cwd ?? cwd, path)
  const fs = { resolve: async (path, opts) => ({ path: key(path, opts) }), readText: async target => files.get(target.path),
    lstat: async (path, opts) => files.has(key(path, opts)) ? { type: 'file', version: String(revision) } : undefined,
    writeText: async (target, content, intent) => { if (intent?.kind === 'createIfAbsent' && files.has(target.path)) throw Error('exists'); revision++; files.set(target.path, content) },
    listDir: async target => [...new Set([...files.keys()].filter(path => path.startsWith(target.path + sep)).map(path => path.slice(target.path.length + 1).split(sep)[0]))].map(name => ({ name })) }
  let permissionCalls = 0
  const ctx = { fs, tools: { register(t) { execute = t.execute }, guard(fn) { guards.push(fn) } },
    on(name, fn) { listeners.set(name, fn) },
    get: name => name === 'userQuestions' ? { ask: async request => { asked.push(request); return answer(request) } }
      : name === 'approval' ? { request: async () => { permissionCalls++; return 'allowed-once' } }
        : name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd }) } : undefined }
  registerDevTask(ctx)
  const agent = { id: 'main', session: { id: 'main', header: { cwd }, snapshotEvents: () => events } }
  const call = async args => {
    const callId = `call-${events.length}`, input = { task_id: 'REQ-1', ...args }
    events.push({ type: 'tool/call', data: { name: 'dev_task', callId, arguments: JSON.stringify(input) } })
    try { const text = await execute(input, { agent, callId, signal: new AbortController().signal });
      events.push({ type: 'tool/result', data: { message: { toolCallId: callId, content: [{ type: 'text', text }] } } }); return text
    } catch (error) { events.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError: true } } }); throw error }
  }
  return { cwd, files, fs, ctx, asked, agent, guards, listeners, call,
    set answer(fn) { answer = fn }, get permissionCalls() { return permissionCalls },
    state: () => JSON.parse(files.get(join(cwd, '.dsh/task-REQ-1.json'))),
    create: (complexity = 'medium', legacy = false) => call({ operation: 'create', title: '人员搜索', branch: 'test', complexity,
      complexity_reason: '需求与查询规则需要明确', ...(!legacy ? { intent: 'implementation', intent_reason: '用户要求实现' } : {}) }),
    record: (value = fields) => call({ operation: 'record', artifact: 'requirement', fields: value }),
    prepare: args => call({ operation: 'prepare_requirement', ...args }).then(JSON.parse),
    confirm: hash => call({ operation: 'confirm_requirement', expected_hash: hash }).then(JSON.parse),
    load: name => call({ operation: 'load_skill', skill_name: `bundled:${name}` }),
  }
}
async function draft(f) { await f.create(); await f.load('requirements-analysis'); await f.record(); return f.prepare() }

test('new explicit grades require a real version-bound confirmation; low keeps a short summary without an extra stage', async () => {
  for (const grade of ['low','medium','high','ultra']) {
    const f = fixture(); await f.create(grade)
    const state = f.state(), policy = state.flow.config.requirement_review
    assert.equal(state.flow.version, 2); assert.equal(policy.version, 1)
    const def = state.flow.config.artifacts.find(a => a.id === policy.artifact)
    assert.equal(def.fields.length, grade === 'low' ? 3 : 7)
    assert.equal(state.stage, grade === 'low' ? '代码开发' : '需求分析')
    await assert.rejects(f.call({ operation: 'plan', plans: [] }), /需求尚未由用户确认/)
    assert.match(f.guards[0]({ agent: f.agent, name: 'write' }), /需求尚未由用户确认/)
  }
})
test('recording a complete requirement cannot advance, run commands or start an implementation by itself', async () => {
  const f = fixture(); await f.create(); await f.load('requirements-analysis'); await f.record()
  await assert.rejects(f.call({ operation: 'advance', target_stage: '代码开发' }), /requirement_confirmation/)
  assert.equal(f.permissionCalls, 0)
  for (const name of ['pwsh','write','edit','run_code','task']) assert.ok(f.guards[0]({ agent: f.agent, name }))
  const state = f.state(); state.requirement_confirmed = true
  assert.equal(requirementConfirmed(state, state.flow.config), false)
  assert.equal(assertAdvance(state, '代码开发', state.flow.config).ok, false)
})
test('prepare creates a readable document from the artifact and preserves accepted pending integration boundaries', async () => {
  const f = fixture(), d = await draft(f)
  assert.equal(d.requirement.path, 'docs/requirements/REQ-1.md')
  assert.match(d.content, /业务流程与规则/); assert.match(d.content, /真实环境联调由用户后续完成/)
  assert.equal(f.files.get(join(f.cwd, d.requirement.path)), d.content)
  assert.equal(f.state().requirement_confirmed, false)
  assert.deepEqual(f.state().files, [])
  await assert.rejects(f.confirm('model claims user approved'), /需求版本/)
})
test('host question shows the exact current summary; tool auto-approval cannot supply business consent', async () => {
  const f = fixture(), d = await draft(f)
  const done = await f.confirm(d.requirement.hash)
  assert.equal(f.asked[0].questions[0].detail, d.content)
  assert.equal(f.permissionCalls, 0)
  assert.equal(done.requirement.status, 'confirmed')
  assert.equal(f.state().requirements.document.confirmation.hash, d.requirement.hash)
  assert.equal(f.guards[0]({ agent: f.agent, name: 'write' }), undefined)
  await f.call({ operation: 'advance', target_stage: '代码开发' })
  assert.equal(f.state().stage, '代码开发')
})
test('user requests changes: preserve feedback, remain in requirements and refuse an unchanged repeat prompt', async () => {
  const f = fixture(), d = await draft(f)
  f.answer = request => ({ answers: [{ id: request.questions[0].id, selected: ['需要修改'], custom: '先明确模糊匹配规则' }] })
  const result = await f.confirm(d.requirement.hash)
  assert.equal(result.requirement.status, 'changes_requested'); assert.match(result.requirement.feedback, /模糊匹配/)
  assert.equal(f.state().stage, '需求分析'); assert.equal(f.state().requirement_confirmed, false)
  await assert.rejects(f.confirm(d.requirement.hash), /不能原样重复/)
  assert.equal(f.asked.length, 1)
})
test('empty or cancelled human replies never confirm; errors leave a resumable pending document', async () => {
  const f = fixture(), d = await draft(f)
  f.answer = () => ({ answers: [] }); await f.confirm(d.requirement.hash)
  assert.equal(f.state().requirement_confirmed, false)
  f.answer = () => { throw new Error('user cancelled') }
  await assert.rejects(f.confirm(d.requirement.hash), /未取得用户答复/)
  assert.equal(f.state().requirements.document.status, 'awaiting_confirmation')
  assert.ok(f.guards[0]({ agent: f.agent, name: 'pwsh' }))
})
test('clarification stores actual human answers; unanswered questions block document preparation', async () => {
  const f = fixture(); await f.create(); await f.record()
  f.answer = () => ({ answers: [] })
  const args = { operation: 'clarify_requirement', clarification_questions: [{ id: 'match', question: '使用精确还是模糊匹配？' }] }
  await f.call(args)
  await assert.rejects(f.prepare(), /未回答/)
  assert.equal(f.state().requirements.clarifications[0].answer, undefined)
  f.answer = req => ({ answers: [{ id: req.questions[0].id, selected: [], custom: '使用模糊匹配，不改权限' }] })
  await f.call(args)
  const d = await f.prepare(); assert.match(d.content, /用户答复：使用模糊匹配，不改权限/)
})
test('a scope revision while the user is reviewing rejects that old answer without locking record/status', async () => {
  const f = fixture(), d = await draft(f)
  let reply, entered
  const ready = new Promise(resolve => { entered = resolve })
  f.answer = request => new Promise(resolve => { reply = () => resolve({ answers: [{ id: request.questions[0].id, selected: ['确认无误，继续'] }] }); entered() })
  const pending = f.confirm(d.requirement.hash)
  await ready
  await f.call({ operation: 'status' })
  await f.record({ scope: '新增导出功能' })
  reply(); await assert.rejects(pending, /审阅期间.*变化/)
  assert.equal(f.state().requirement_confirmed, false)
  const next = await f.prepare(); assert.equal(next.requirement.version, 2)
  await assert.rejects(f.confirm(d.requirement.hash), /需求版本/)
})
test('human edits to a generated document are protected and cannot reuse its previous confirmation', async () => {
  const f = fixture(), d = await draft(f)
  await f.confirm(d.requirement.hash)
  const path = join(f.cwd, d.requirement.path)
  f.files.set(path, '# 用户手动修改的需求\n')
  await assert.rejects(f.call({ operation: 'advance', target_stage: '代码开发' }), /需求文档已变更/)
  await assert.rejects(f.prepare(), /人工修改/)
  const next = await f.prepare({ document_path: 'docs/requirements/REQ-1-revised.md' })
  assert.equal(f.files.get(path), '# 用户手动修改的需求\n'); assert.equal(next.requirement.version, 2)
})
test('native mutation preflight rechecks approved documents even after the tool catalog was unlocked', async () => {
  const f = fixture(), d = await draft(f); await f.confirm(d.requirement.hash)
  f.files.set(join(f.cwd, d.requirement.path), 'changed')
  const result = await f.listeners.get('tools/pre-execute')({ agent: f.agent, name: 'pwsh' }, async () => ({ kind: 'allow' }))
  assert.equal(result.kind, 'deny'); assert.match(result.reason, /需求文档已变更/)
  assert.match(f.guards[0]({ agent: f.agent, name: 'write' }), /需求尚未由用户确认/)
})
test('recording identical content keeps confirmation; actual requirement edits invalidate it', async () => {
  const f = fixture(), d = await draft(f); await f.confirm(d.requirement.hash)
  await f.record(fields); assert.equal(requirementConfirmed(f.state(), f.state().flow.config), true)
  await f.record({ acceptance: '增加分页与空结果验收' })
  assert.equal(requirementConfirmed(f.state(), f.state().flow.config), false)
  assert.equal(f.state().requirements.document.confirmation, undefined)
})
test('paths cannot escape the workspace or overwrite unrelated existing documents', async () => {
  const f = fixture(); await f.create(); await f.record()
  for (const path of ['../requirements.md','docs/../a.md','C:/a.md','.dsh/meta.md','docs/a.txt']) await assert.rejects(f.prepare({ document_path: path }))
  f.files.set(join(f.cwd, 'docs/custom.md'), '# Existing team document')
  await assert.rejects(f.prepare({ document_path: 'docs/custom.md' }), /人工修改/)
  assert.equal(f.files.get(join(f.cwd, 'docs/custom.md')), '# Existing team document')
})
test('unsupported active tasks are readable but cannot mutate, approve, dispatch, verify or complete', async () => {
  const f = fixture(), d = await draft(f); await f.confirm(d.requirement.hash)
  const old = f.state(); delete old.flow.config.requirement_review
  const { hashConfig } = await import('./lib/snapshot.js'); old.flow.hash = hashConfig(old.flow.config)
  const path = join(f.cwd,'.dsh/task-REQ-1.json'); f.files.set(path,JSON.stringify(old)); const original = f.files.get(path)
  const status = JSON.parse(await f.call({ operation: 'status' }))
  assert.match(status.execution_blocker, /仅可查看.*重新创建/)
  for (const operation of ['record','confirm_requirement','dispatch','verify','complete','revise','scope','advance'])
    await assert.rejects(f.call({ operation }), /仅可查看.*重新创建/)
  assert.equal(f.files.get(path), original)
  assert.match(f.guards[0]({agent:f.agent,name:'write'}), /需求尚未由用户确认/)
  const ledger = await Controller.prototype.readTasks.call({authorizedPath:async p=>p,fs:()=>f.fs},f.cwd)
  assert.match(ledger.tasks[0].next_action, /重新创建/)
})

test('archived historical records remain readable without being migrated', async () => {
  const f = fixture(); await f.create()
  const old = f.state(); delete old.flow.config.requirement_review
  const { hashConfig } = await import('./lib/snapshot.js'); old.flow.hash = hashConfig(old.flow.config)
  old.completed = { at:'2026-10-30T00:00:00Z' }
  const path = join(f.cwd,'.dsh/task-REQ-1.json'); f.files.set(path,JSON.stringify(old)); const original = f.files.get(path)
  const status=JSON.parse(await f.call({operation:'status'}));assert.equal(status.lifecycle,'archived')
  assert.equal(f.files.get(path), original)
  await assert.rejects(f.call({operation:'record'}), /archived and read-only/)
  assert.match(f.guards[0]({agent:f.agent,name:'write'}), /历史记录，仅可查看/)
  assert.equal(f.guards[0]({agent:f.agent,name:'read'}), undefined)
})

test('snapshot-less records stay readable even when the live old project config is invalid', async () => {
  const f = fixture(); await f.create()
  const old = f.state(); delete old.flow
  const path=join(f.cwd,'.dsh/task-REQ-1.json'); f.files.set(path,JSON.stringify(old)); const original=f.files.get(path)
  f.files.set(join(f.cwd,'.dsh/eng.json'),'{invalid')
  const status=JSON.parse(await f.call({operation:'status'}))
  assert.match(status.execution_blocker,/重新创建/)
  assert.equal(status.flow,null)
  await assert.rejects(f.call({operation:'verify',command:'npm test'}),/仅可查看/)
  assert.equal(f.files.get(path),original)
})

test('a missing human question provider never falls back to automatic permission approval', async () => {
  const f = fixture(), d = await draft(f), get = f.ctx.get
  f.ctx.get = name => name === 'userQuestions' ? undefined : get(name)
  await assert.rejects(f.confirm(d.requirement.hash), /人工答复服务/)
  assert.equal(f.permissionCalls, 0); assert.equal(f.state().requirement_confirmed, false)
})
test('plain explicit confirmation inside the human answer is accepted; conditional consent requests revision', async () => {
  for (const [custom, expected] of [['已确认', true], ['确认，但要增加导出', false]]) {
    const f = fixture(), d = await draft(f)
    f.answer = req => ({ answers: [{ id: req.questions[0].id, selected: [], custom }] })
    await f.confirm(d.requirement.hash)
    assert.equal(f.state().requirement_confirmed, expected)
  }
})
test('requirement rework invalidates approval and reopens native write restrictions', async () => {
  const f = fixture(), d = await draft(f); await f.confirm(d.requirement.hash)
  await f.call({ operation: 'advance', target_stage: '代码开发' })
  await f.call({ operation: 'revise', revision_kind: 'requirement', revision_reason: '用户新增导出验收', target_stage: '需求分析' })
  assert.equal(f.state().requirement_confirmed, false)
  assert.match(f.guards[0]({ agent: f.agent, name: 'write' }), /需求尚未由用户确认/)
  await f.record({ acceptance: '原条件检索通过，且可导出同样结果' })
  const next = await f.prepare(); assert.equal(next.requirement.version, 2)
  await f.confirm(next.requirement.hash); assert.equal(f.state().requirement_confirmed, true)
})
test('ledger and shipped strict browser codec retain document version, user feedback and stale status', async () => {
  const f = fixture(), d = await draft(f)
  f.answer = req => ({ answers: [{ id: req.questions[0].id, selected: ['需要修改'], custom: '补充权限范围' }] })
  await f.confirm(d.requirement.hash)
  const receiver = { authorizedPath: async path => path, fs: () => f.fs }
  let view = await Controller.prototype.readTasks.call(receiver, f.cwd)
  assert.equal(view.tasks[0].requirements.feedback, '补充权限范围')
  assert.match(view.tasks[0].requirements.content, /业务目标与当前问题/)
  assert.match(view.tasks[0].next_action, /需求/)
  f.files.set(join(f.cwd, d.requirement.path), 'changed')
  view = await Controller.prototype.readTasks.call(receiver, f.cwd)
  assert.equal(view.tasks[0].requirements.status, 'stale')
  let registration, contribution
  runInNewContext(readFileSync('lib/client.js', 'utf8'), { window: { __ModuleLoader__: { load(value) { registration = value } } } })
  const client = registration.factory(() => ({})), stop = new Error('captured')
  await assert.rejects(client.apply({ remote: { $mount: async value => { contribution = value; throw stop } } }), error => error === stop)
  const remote = contribution.descriptors.find(d => d.method === 'readTasks')
  const decoded = remote.result.create().parse(view)
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), JSON.parse(JSON.stringify(view)))
})
test('low-grade scope changes can reopen their initial stage, while commits retain the confirmation requirement', async () => {
  const f = fixture(); await f.create('low'); await f.record({ goal: 'local change', scope: 'one field', acceptance: 'field preserved' })
  const d = await f.prepare(); await f.confirm(d.requirement.hash)
  await f.call({ operation: 'revise', revision_kind: 'requirement', revision_reason: '用户改变本期范围', target_stage: '代码开发' })
  const state = f.state()
  assert.equal(requirementConfirmed(state, state.flow.config), false)
  assert.match(commitCheckpoint(state, state.flow.config).reason, /需求版本/)
  assert.ok(completionBlockers(state, state.flow.config).some(p => p.includes('需求版本')))
})
test('the generated requirement can be committed as an artifact without declaring it as a code test input', async () => {
  const f = fixture(), d = await draft(f); await f.confirm(d.requirement.hash)
  const state = f.state(); state.files = ['app.js']
  assert.equal(checkFileScope(state, ['app.js', d.requirement.path], state.flow.config).ok, true)
  assert.deepEqual(checkFileScope(state, ['unrelated.md'], state.flow.config).outside, ['unrelated.md'])
  assert.deepEqual(state.files, ['app.js'])
})
test('new tasks cannot fall back to an unconfirmed flow by omitting intent or complexity', async () => {
  const f = fixture()
  await assert.rejects(f.create('medium', true), /requires explicit intent/)
  await assert.rejects(f.call({ operation: 'create', title: 'missing grade', intent: 'implementation', intent_reason: 'implement' }), /requires complexity/)
  await assert.rejects(f.call({ operation: 'create', title: 'fake caller opt-out', intent: 'implementation', intent_reason: 'implement', requirement_confirmation: 'legacy' }), /requires complexity/)
  assert.equal(f.files.has(join(f.cwd, '.dsh/task-REQ-1.json')), false)
  await f.create(); assert.ok(f.state().flow.config.requirement_review)
  assert.match(f.guards[0]({ agent: f.agent, name: 'write' }), /需求尚未由用户确认/)
})
test('repeating an unchanged approved version is idempotent, including after advancing and without a question provider', async () => {
  const f = fixture(), d = await draft(f); await f.confirm(d.requirement.hash)
  const confirmed = f.state().requirements.document.confirmation, count = f.asked.length
  let response = await f.confirm(d.requirement.hash)
  assert.equal(response.reused, true)
  await f.call({ operation: 'advance', target_stage: '代码开发' })
  const get = f.ctx.get; f.ctx.get = name => name === 'userQuestions' ? undefined : get(name)
  response = await f.confirm(d.requirement.hash)
  assert.equal(response.reused, true); assert.equal(f.asked.length, count)
  assert.deepEqual(f.state().requirements.document.confirmation, confirmed)
})
test('restoring the exact approved document synchronizes both permission checks without asking again', async () => {
  const f = fixture(), d = await draft(f); await f.confirm(d.requirement.hash)
  const preflight = f.listeners.get('tools/pre-execute'), count = f.asked.length
  f.files.set(join(f.cwd, d.requirement.path), 'changed')
  assert.equal((await preflight({ agent: f.agent, name: 'write' }, async () => ({ kind: 'allow' }))).kind, 'deny')
  f.files.set(join(f.cwd, d.requirement.path), d.content)
  assert.equal((await preflight({ agent: f.agent, name: 'read' }, async () => ({ kind: 'allow' }))).kind, 'allow')
  assert.equal(f.guards[0]({ agent: f.agent, name: 'write' }), undefined)
  assert.equal((await preflight({ agent: f.agent, name: 'write' }, async () => ({ kind: 'allow' }))).kind, 'allow')
  assert.equal(f.asked.length, count)
})
test('removed compatibility settings cannot be saved or used to create an old task', async () => {
  const f = fixture(), receiver={authorizedPath:async p=>p,fs:()=>f.fs,listSkills:async()=>({skills:[]})}
  const before = await Controller.prototype.readAdaptive.call(receiver,f.cwd)
  for (const value of ['legacy','required',null,false,'auto',0]) {
    const invalid=await Controller.prototype.writeAdaptive.call(receiver,{path:f.cwd,expected_hash:before.hash,config:{requirement_confirmation:value}})
    assert.equal(invalid.ok,false);assert.match(invalid.problems.join(';'),/配置已移除/)
    f.files.set(join(f.cwd,'.dsh/meta.json'),JSON.stringify({requirement_confirmation:value}))
    await assert.rejects(f.create(),/配置已移除/)
    f.files.delete(join(f.cwd,'.dsh/meta.json'))
  }
  await f.create();assert.ok(f.state().flow.config.requirement_review)
  assert.equal(f.state().flow.version,2)
})

test('read-only analysis creation does not require an implementation grade or business approval', async () => {
  const f = fixture()
  await f.call({ operation: 'create', title: '查明原因并给出方案', intent: 'analysis', intent_reason: '用户只要求分析' })
  assert.equal(f.state().delivery.intent, 'analysis')
  assert.equal(f.state().flow.config.requirement_review, undefined)
  assert.equal(f.asked.length, 0)
  assert.equal(f.guards[0]({ agent: f.agent, name: 'read' }), undefined)
  assert.match(f.guards[0]({ agent: f.agent, name: 'write' }), /analysis-only/)
})

test('a failed fallback create cannot unlock another task awaiting requirement confirmation', async () => {
  const f = fixture(); await f.create()
  const original = f.state()
  await assert.rejects(f.call({ operation: 'create', task_id: 'BYPASS', title: 'missing grade', intent: 'implementation', intent_reason: 'implement' }), /requires complexity/)
  assert.equal(f.files.has(join(f.cwd, '.dsh/task-BYPASS.json')), false)
  assert.deepEqual(f.state(), original)
  assert.match(f.guards[0]({ agent: f.agent, name: 'write' }), /需求尚未由用户确认/)
})
