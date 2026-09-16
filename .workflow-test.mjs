import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { registerDevTask } from './lib/dev-task.js'
import { newTask } from './lib/engine.js'
import { resolveFlow } from './lib/workflows.js'
import Controller from './lib/controller.js'
import { registerShippedSkills } from './lib/shipped-skills.js'

function fixture(stage = '开发', extra = {}) {
  const cwd = resolve('test-project')
  const config = resolveFlow('standard', { stage_bindings: { 完成: { skills: ['software-testing'] } } }).config
  const state = newTask({ id: 'LIVE-1', title: 'EAM regression', branch: 'test', work_size: 'standard', risk_level: 'standard', flow: { flow: 'standard', version: 2, config }, root: cwd })
  Object.assign(state, { stage, execution_version: 1, files: ['app.js'], requirement_confirmed: true, solution_confirmed: true, ...extra })
  const records = new Map([[join(cwd, '.dsh/task-LIVE-1.json'), JSON.stringify(state)], [join(cwd, 'app.js'), 'source']])
  const events = [], runs = []
  const session = { id: 'test-session', header: { cwd }, snapshotEvents: () => events }
  const policy = { mode: 'workspace-write', workspaceRoot: cwd, sessionId: session.id }
  const abort = new AbortController()
  let execute
  const key = (path, options) => join(options?.cwd ?? cwd, path)
  const fs = {
    resolve: async (path, options) => ({ targetKey: key(path, options) }),
    readText: async target => records.get(target.targetKey),
    listDir: async () => [...records.keys()].filter(path => /task-.+\.json$/.test(path)).map(path => ({ name: path.split(/[\\/]/).at(-1) })),
    lstat: async (path, options) => records.has(key(path, options)) ? { version: 'v' } : undefined,
    writeText: async (target, content) => { records.set(target.targetKey, content) },
  }
  const ctx = { fs, tools: { register(tool) { execute = tool.execute; return () => {} } }, get(name) {
    if (name === 'sandboxPolicy') return { resolve(request) { assert.equal(request.session, session); return policy } }
    if (name === 'shell') return { resolve(request) { runs.push(request); return request }, async run(request) {
      const fail = request.command === 'fail'
      return { exitCode: fail ? 1 : 0, timedOut: false, aborted: false, sandbox: { mode: 'workspace-write', denied: false }, stdout: { text: request.command.startsWith('git -c core.quotepath=false log') ? 'abcdef1234567890\n【LIVE-1】【TASK】done\n\napp.js\n' : 'checks passed' }, stderr: { text: '' } }
    } }
    return undefined
  } }
  registerDevTask(ctx)
  const exec = { agent: { session }, signal: abort.signal }
  function load(name, success = true) {
    const callId = `call-${events.length}`
    events.push({ type: 'tool/call', data: { name: 'skill', callId, arguments: JSON.stringify({ name }) } })
    events.push({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: callId, isError: !success }] } } })
  }
  return { call: args => execute(JSON.parse(JSON.stringify({ task_id: 'LIVE-1', ...args })), exec), load, runs, policy, exec, records, cwd,
    state: () => JSON.parse(records.get(join(cwd, '.dsh/task-LIVE-1.json'))) }
}

test('审查通过后更新状态并激活下一项，保留已完成项的审计', async () => {
  const f = fixture()
  await f.call({ operation: 'items', items: [{ id: 'A', title: 'first', status: 'doing' }, { id: 'B', title: 'second' }] })
  await f.call({ operation: 'dispatch', item_id: 'A', description: 'implemented by worker' })
  await f.call({ operation: 'review_item', item_id: 'A', spec_outcome: 'pass', quality_outcome: 'pass' })
  await f.call({ operation: 'items', items: [{ id: 'A', title: 'first', status: 'done' }, { id: 'B', title: 'second', status: 'doing' }] })
  assert.equal(f.state().items[0].review.spec.outcome, 'pass')
  assert.equal(f.state().items[0].dispatch.description, 'implemented by worker')
  await f.call({ operation: 'items', items: [{ id: 'A', title: 'changed', status: 'doing' }, { id: 'B', title: 'second', status: 'todo' }] })
  assert.equal(f.state().items[0].review, undefined)
  await assert.rejects(f.call({ operation: 'items', items: [{ id: 'A', title: 'x' }, { id: 'A', title: 'y' }] }), /unique/)
})

test('无任务 id 的 status 发现当前工作区任务并支持分支过滤', async () => {
  const f = fixture()
  assert.equal(JSON.parse(await f.call({ operation: 'status', task_id: undefined })).tasks[0].id, 'LIVE-1')
  assert.equal(JSON.parse(await f.call({ operation: 'status', task_id: undefined, branch: 'other' })).tasks.length, 0)
})

test('验证使用会话策略与取消信号，并明确返回失败及沙箱信息', async () => {
  const f = fixture('交付')
  const result = JSON.parse(await f.call({ operation: 'verify', command: 'fail' }))
  assert.equal(result.ok, false)
  assert.equal(f.runs[0].sandboxPolicy, f.policy)
  assert.equal(f.runs[0].signal, f.exec.signal)
  assert.equal(result.verification.receipt.sandbox.mode, 'workspace-write')
})

test('只声明已测试、或加载失败，均不能冒充执行绑定技能', async () => {
  const f = fixture('代码审核')
  f.load('code-review'); f.load('code-commit'); f.load('software-testing', false)
  await assert.rejects(f.call({ operation: 'skill_result', target_stage: '完成', skill_name: 'software-testing', command: 'check', evidence: ['tested'] }), /load skill/)
  await assert.rejects(f.call({ operation: 'advance', target_stage: '完成' }), /software-testing/)
  f.load('software-testing')
  await assert.rejects(f.call({ operation: 'skill_result', target_stage: '完成', skill_name: 'software-testing', evidence: ['claimed pass'] }), /real validation command/)
})

test('绑定技能失败阻止完成；成功后仍须提交真实 Git 回执', async () => {
  const f = fixture('代码审核', { review: { outcome: 'pass' }, artifacts: { review: { conclusion: 'pass', issues: 'none' } }, verification: { passed: true, evidence: ['checks'] } })
  f.load('code-review'); f.load('code-commit'); f.load('software-testing')
  await f.call({ operation: 'verify', command: 'check', evidence: ['real checks'] })
  await f.call({ operation: 'skill_result', target_stage: '完成', skill_name: 'software-testing', command: 'fail', evidence: ['scenario failed'] })
  await assert.rejects(f.call({ operation: 'advance', target_stage: '完成' }), /skill_result/)
  await f.call({ operation: 'skill_result', target_stage: '完成', skill_name: 'software-testing', command: 'check', evidence: ['scenario passed'] })
  await assert.rejects(f.call({ operation: 'advance', target_stage: '完成' }), /commit required/)
  await f.call({ operation: 'commit', files: ['app.js'], message: '【LIVE-1】【TASK】done' })
  await assert.rejects(f.call({ operation: 'commit', files: ['app.js'], message: '【LIVE-1】【TASK】done', hash: 'bbbbbbb' }), /does not match/)
  await f.call({ operation: 'commit', files: ['app.js'], message: '【LIVE-1】【TASK】done', hash: 'abcdef1' })
  await f.call({ operation: 'advance', target_stage: '完成' })
  assert.equal(f.state().stage, '完成')
  assert.equal(f.state().skill_results.完成['software-testing'].load_call_id.startsWith('call-'), true)
})

test('验证后修改代码会使旧回执失效，必须重新验证', async () => {
  const f = fixture('交付')
  f.load('code-verify')
  await f.call({ operation: 'verify', command: 'check' })
  f.records.set(join(f.cwd, 'app.js'), 'modified source')
  await assert.rejects(f.call({ operation: 'advance', target_stage: '代码审核' }), /stale/)
  await f.call({ operation: 'verify', command: 'check' })
  await f.call({ operation: 'advance', target_stage: '代码审核' })
  assert.equal(f.state().stage, '代码审核')
})

test('同名技能与规则在项目和个人目录各自保留管理入口', async t => {
  const root = mkdtempSync(join(tmpdir(), 'engine-catalog-'))
  const original = process.env.DSH_HOME
  t.after(() => { if (original === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = original; assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }) })
  process.env.DSH_HOME = join(root, 'user')
  const project = join(root, 'project')
  for (const base of [join(project, '.dsh'), process.env.DSH_HOME]) {
    mkdirSync(join(base, 'skills/software-testing'), { recursive: true })
    mkdirSync(join(base, 'rules'), { recursive: true })
    writeFileSync(join(base, 'skills/software-testing/SKILL.md'), '\uFEFF---\r\nname: software-testing\r\ndescription: tests\r\n---\r\nRun tests.\r\n')
    writeFileSync(join(base, 'rules/test-rule.md'), 'Test rule\n')
  }
  const receiver = { authorizedPath: async path => path }
  const skills = await Controller.prototype.listSkills.call(receiver, project)
  const rules = await Controller.prototype.listRules.call(receiver, project)
  assert.deepEqual(skills.skills.filter(x => x.name === 'software-testing').map(x => x.source), ['project', 'user'])
  assert.deepEqual(rules.rules.filter(x => x.name === 'test-rule').map(x => x.source), ['project', 'user'])
  const read = await Controller.prototype.readSkill.call(receiver, { path: project, level: 'project', name: 'software-testing' })
  assert.equal(read.ok, true)
  assert.match(read.content, /Run tests/)
})

test('安装包的七个内置技能实际注册且可在资源目录发现', async () => {
  const registered = []
  registerShippedSkills({ get: name => name === 'skills' ? { register: skill => { registered.push(skill); return () => {} } } : undefined })
  const expected = ['code-commit', 'code-implement', 'code-review', 'code-verify', 'eng-delivery', 'requirement-analysis', 'solution-design']
  assert.deepEqual(registered.map(skill => skill.name).sort(), expected)
  assert.ok(registered.every(skill => skill.content.trim().length > 0))
  const catalog = await Controller.prototype.listSkills.call({ authorizedPath: async path => path }, '')
  assert.deepEqual(catalog.skills.filter(skill => skill.source === 'bundled').map(skill => skill.name).sort(), expected)
})
