import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { customFromTemplate, parseCustomFlow } from './lib/custom-flow.js'
import { FLOW_PRESETS, resolveFlow, flowSatisfies, HIGH_RISK_REQUIRED_CAPABILITIES } from './lib/workflows.js'
import { newTask, assertAdvance, commitCheckpoint } from './lib/engine.js'
import { hashConfig } from './lib/snapshot.js'
import { registerDevTask } from './lib/dev-task.js'
import Controller from './lib/controller.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-custom-flow-'))
  t.after(() => { const target = resolve(root); assert.ok(target.startsWith(resolve(tmpdir()) + sep)); rmSync(target, { recursive: true, force: true }) })
  return root
}
function custom(stages = ['确认一', '确认二', '测试一', '测试二', '审核一', '审核二', '完成']) {
  const flow = customFromTemplate(FLOW_PRESETS.minimal.config)
  flow.config.stages = stages; flow.config.start_stage = stages[0]
  flow.config.transitions = stages.slice(0, -1).map((from, i) => ({ from, to: stages[i + 1], requires: [from.startsWith('确认') ? 'confirmation' : from.startsWith('测试') ? 'verified' : 'review_passed'] }))
  flow.config.stage_bindings = {}; flow.config.commit.checkpoints = [stages.at(-1)]
  return flow
}
function memory(initial = {}) {
  const files = new Map(Object.entries(initial)), versions = new Map()
  const key = (name, opts) => opts?.cwd ? join(opts.cwd, name).replaceAll('\\', '/') : name
  return {
    files,
    async resolve(name, opts) { return { targetKey: key(name, opts), displayPath: key(name, opts) } },
    async readText(target) { return files.get(target.targetKey) },
    async listDir(target) { return [...files.keys()].filter(k => k.startsWith(target.targetKey + '/')).map(k => ({ name: k.slice(target.targetKey.length + 1) })) },
    async lstat(name, opts) { const k = key(name, opts); return files.has(k) ? { version: String(versions.get(k) ?? 0) } : undefined },
    async writeText(target, content, intent) {
      const k = target.targetKey
      if ((intent?.kind === 'createIfAbsent' && files.has(k)) || (intent?.kind === 'replaceIfVersion' && String(versions.get(k) ?? 0) !== intent.version)) throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
      files.set(k, content); versions.set(k, (versions.get(k) ?? 0) + 1)
    },
  }
}
function tool(flow, options = {}) {
  const fs = memory({ '.dsh/eng.json': JSON.stringify({ flow: flow.id, custom_flow: flow }) })
  let execute, approvals = 0
  registerDevTask({ fs, tools: { register(t) { execute = t.execute; return () => {} } }, get(name) {
    if (name === 'approval') return { request: async () => { approvals++; return options.approval ?? 'allowed-once' } }
    if (name === 'shell') return { resolve: r => ({ ...r, workdir: r.workdir ?? '' }), run: async () => ({ exitCode: options.exitCode ?? 0, timedOut: false, aborted: false }) }
  } })
  return { fs, execute: args => execute(args, { agent: { session: { header: { cwd: '' } } } }), approvals: () => approvals }
}
const create = (execute, id = 'CUSTOM-1', extra = {}) => execute({ operation: 'create', task_id: id, title: '自定义闭环', branch: 'main', ...extra })

test('built browser Remote codecs retain custom config, stage evidence mode and save revision', async () => {
  let registration, contribution
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  globalThis.window = { __ModuleLoader__: { load(value) { registration = value } } }
  try {
    await import('./lib/client.js')
    // Rendering is exercised in Harness; this harness captures the shipped codecs at mount time.
    const client = registration.factory(name => name === '@deepseek-ai/dsh-client-store' ? { defineStore: value => value } : {})
    await client.apply({ remote: { async $mount(value) { contribution = value; return async () => {} } }, get: () => ({}), slots: { inject() {}, register() {} } })
    const descriptor = contribution.descriptors.find(d => d.name === 'write' || d.method === 'write' || d.key === 'write')
    assert.ok(descriptor, JSON.stringify(contribution.descriptors.map(d => Object.keys(d))))
    const request = { path: 'D:/test', flow: 'custom:my-workflow', custom_flow: custom(), expected_revision: 'revision-1' }
    const encoded = descriptor.parameters[0].codec.schema.parse(request)
    assert.equal(encoded.custom_flow.id, request.flow); assert.equal(encoded.expected_revision, 'revision-1')
    const response = descriptor.result.schema.parse({ ok: true, source: 'project', flow: request.flow, config: request.custom_flow.config, custom_flow: request.custom_flow, revision: 'revision-2', problems: [] })
    assert.equal(response.config.evidence_scope, 'stage'); assert.equal(response.custom_flow.version, 1); assert.equal(response.revision, 'revision-2')
  } finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window }
})

test('manual custom commits require explicit approval and still enforce outgoing conditions', async () => {
  const flow = custom(['审核一', '完成']); flow.config.commit.policy = 'manual'; flow.config.commit.checkpoints = []
  const { execute, approvals } = tool(flow); await create(execute)
  await assert.rejects(execute({ operation: 'commit', task_id: 'CUSTOM-1', message: 'manual' }), /guards are unmet/)
  await execute({ operation: 'review', task_id: 'CUSTOM-1', outcome: 'pass' })
  assert.match(await execute({ operation: 'commit', task_id: 'CUSTOM-1', message: 'manual' }), /approved/)
  assert.equal(approvals(), 1)
  const denied = tool(flow, { approval: 'rejected' }); await create(denied.execute)
  await denied.execute({ operation: 'review', task_id: 'CUSTOM-1', outcome: 'pass' })
  await assert.rejects(denied.execute({ operation: 'commit', task_id: 'CUSTOM-1', message: 'manual' }), /未获人工批准/)
})

test('copy preset isolates editable config and permits removal of default resources', () => {
  const flow = customFromTemplate(FLOW_PRESETS.standard.config)
  flow.config.stage_bindings['开发'] = { skills: [], rules: [] }
  const result = resolveFlow(flow.id, { custom_flow: flow })
  assert.equal(result.ok, true); assert.deepEqual(result.config.stage_bindings['开发'], { skills: [], rules: [] })
  assert.ok(FLOW_PRESETS.standard.config.stage_bindings['开发'].skills.includes('code-implement'))
  assert.equal(flowSatisfies(result.config, HIGH_RISK_REQUIRED_CAPABILITIES), true)
})

const mutations = [
  ['unsupported schema', f => f.schema = 2], ['missing config', f => delete f.config],
  ['duplicate stage', f => f.config.stages[1] = f.config.stages[0]], ['empty stage', f => f.config.stages[0] = ' '],
  ['branch', f => f.config.transitions.push({ from: f.config.stages[0], to: f.config.stages[3] })],
  ['cycle', f => f.config.transitions[0].to = f.config.stages[0]],
  ['unreachable start', f => f.config.start_stage = f.config.stages[1]],
  ['unknown guard', f => f.config.transitions[0].requires = ['unknown']],
  ['artifact requirement without definition', f => f.config.transitions[0].requires = ['artifacts_present']],
  ['duplicate artifact IDs', f => f.config.artifacts = [0, 1].map(i => ({ stage: f.config.stages[i], id: 'same', name: 'record', fields: ['result'] }))],
  ['empty artifact fields', f => f.config.artifacts = [{ stage: f.config.stages[0], id: 'a', name: 'a', fields: [] }]],
  ['invalid regex', f => f.config.commit.message_pattern = '['],
  ['missing checkpoints', f => f.config.commit.checkpoints = []],
  ['unknown binding stage', f => f.config.stage_bindings.ghost = { skills: [] }],
  ['legacy evidence mode', f => delete f.config.evidence_scope],
  ['weakened high risk receipt', f => f.config.high_risk_requires_verification = false],
  ['unsafe name', f => f.config.artifacts = [{ stage: f.config.stages[0], id: '__proto__', name: 'a', fields: ['result'] }]],
]
for (const [label, mutate] of mutations) test(`invalid definition rejected: ${label}`, () => { const flow = custom(); mutate(flow); assert.equal(parseCustomFlow(flow).ok, false) })
test('wrong ID and missing custom definition fail explicitly instead of using standard', () => {
  assert.equal(resolveFlow('custom:absent').code, 'INVALID_FLOW')
  assert.equal(resolveFlow('custom:other', { custom_flow: custom() }).ok, false)
})
test('tool completes repeated confirmation, verification and review stages using fresh evidence', async () => {
  const { execute, fs, approvals } = tool(custom())
  await create(execute)
  const call = (operation, extra = {}) => execute({ operation, task_id: 'CUSTOM-1', ...extra })
  await call('advance', { target_stage: '确认二' }); assert.equal(approvals(), 1)
  await call('advance', { target_stage: '测试一' }); assert.equal(approvals(), 2)
  await assert.rejects(call('advance', { target_stage: '测试二' }), /verified/)
  await call('verify', { command: 'test-command' }); await call('advance', { target_stage: '测试二' })
  await assert.rejects(call('advance', { target_stage: '审核一' }), /verified/)
  await call('verify', { command: 'test-command' }); await call('advance', { target_stage: '审核一' })
  await call('review', { outcome: 'pass' }); await call('advance', { target_stage: '审核二' })
  await assert.rejects(call('advance', { target_stage: '完成' }), /review_passed/)
  await call('review', { outcome: 'pass' }); await call('advance', { target_stage: '完成' })
  const state = JSON.parse(fs.files.get('.dsh/task-CUSTOM-1.json'))
  assert.equal(state.stage, '完成'); assert.equal(state.verification.stage, '测试二'); assert.equal(state.review.stage, '审核二')
  assert.deepEqual(Object.keys(state.stage_confirmations), ['确认一', '确认二'])
})
test('rejected approval and failed verification leave current stage unchanged', async () => {
  const { execute, fs } = tool(custom(), { approval: 'rejected' })
  await create(execute)
  await assert.rejects(execute({ operation: 'advance', task_id: 'CUSTOM-1', target_stage: '确认二' }), /驳回/)
  assert.equal(JSON.parse(fs.files.get('.dsh/task-CUSTOM-1.json')).stage, '确认一')
  const other = tool(custom(['测试一', '完成']), { exitCode: 1 })
  await create(other.execute); await other.execute({ operation: 'verify', task_id: 'CUSTOM-1', command: 'failed-command' })
  await assert.rejects(other.execute({ operation: 'advance', task_id: 'CUSTOM-1', target_stage: '完成' }), /verified/)
})
test('frozen custom task keeps version and stages after current project config is changed or corrupt', async () => {
  const { execute, fs } = tool(custom())
  await create(execute)
  fs.files.set('.dsh/eng.json', '{broken')
  const status = JSON.parse(await execute({ operation: 'status', task_id: 'CUSTOM-1' }))
  assert.equal(status.flow.version, 1); assert.deepEqual(status.legal_next, ['确认二'])
  await execute({ operation: 'advance', task_id: 'CUSTOM-1', target_stage: '确认二' })
  await assert.rejects(create(execute, 'NEW'), /invalid JSON/)
})
test('high risk derives from actual custom guards and demands a real receipt', async () => {
  const flow = customFromTemplate(FLOW_PRESETS.standard.config)
  const t = tool(flow); await create(t.execute, 'RISK', { risk_level: 'high_risk' })
  const weak = tool(customFromTemplate(FLOW_PRESETS.minimal.config))
  await assert.rejects(create(weak.execute, 'WEAK', { risk_level: 'high_risk' }), /high_risk/)
  const state = newTask({ id: 'R', title: 'r', branch: 'main', work_size: 'standard', risk_level: 'high_risk', flow: { flow: flow.id, version: 1, config: flow.config } })
  state.stage = '交付'; state.verification = { passed: true, evidence: ['claim'], stage: '交付' }
  assert.equal(assertAdvance(state, '代码审核', flow.config).ok, false)
})
test('artifact values must be recorded at their owning custom stage', async () => {
  const flow = custom(['准备', '完成'])
  flow.config.transitions[0].requires = ['artifacts_present']; flow.config.artifacts = [{ stage: '准备', id: 'evidence', name: '交付说明', fields: ['result'] }]
  const { execute } = tool(flow); await create(execute)
  const status = JSON.parse(await execute({ operation: 'status', task_id: 'CUSTOM-1' }))
  assert.deepEqual(status.stage_requirements, [{ target: '完成', requires: ['artifacts_present'], unmet: ['artifacts_present'] }])
  assert.deepEqual(status.required_artifacts, [{ stage: '准备', id: 'evidence', name: '交付说明', fields: ['result'] }])
  await assert.rejects(execute({ operation: 'advance', task_id: 'CUSTOM-1', target_stage: '完成' }), /artifacts_present/)
  await execute({ operation: 'record', task_id: 'CUSTOM-1', artifact: 'evidence', fields: { result: 'done' } })
  await execute({ operation: 'advance', task_id: 'CUSTOM-1', target_stage: '完成' })
  await assert.rejects(execute({ operation: 'record', task_id: 'CUSTOM-1', artifact: 'evidence', fields: { result: 'changed' } }), /belongs to stage/)
})

function controller(root, fs) {
  const c = Object.create(Controller.prototype)
  c.authorizedPath = async p => { assert.equal(p, root); return p }
  c.fs = () => fs
  c.listSkills = async () => ({ skills: [] }); c.listRules = async () => ({ rules: [] })
  return c
}
test('Remote saves, reads and versions custom definitions while preserving other project settings', async t => {
  const root = fixture(t), key = join(root, '.dsh/eng.json').replaceAll('\\', '/')
  const fs = memory({ [key]: JSON.stringify({ flow: 'minimal', verify_command: 'custom-test', extension: { keep: true } }) }), c = controller(root, fs)
  const initial = await c.read(root), flow = custom()
  const result = await c.write({ path: root, flow: flow.id, custom_flow: flow, expected_revision: initial.revision })
  assert.equal(result.ok, true); assert.equal(result.custom_flow.version, 1)
  const saved = JSON.parse(fs.files.get(key)); assert.equal(saved.verify_command, 'custom-test'); assert.deepEqual(saved.extension, { keep: true })
  assert.equal((await c.read(root)).custom_flow.label, flow.label)
  flow.label = '新版'; const changed = await c.write({ path: root, flow: flow.id, custom_flow: flow, expected_revision: result.revision })
  assert.equal(changed.custom_flow.version, 2)
  const stale = await c.write({ path: root, flow: 'minimal', expected_revision: initial.revision })
  assert.equal(stale.ok, false); assert.match(stale.problems.join(), /已被修改/)
  const preset = await c.write({ path: root, flow: 'minimal', expected_revision: changed.revision }); assert.equal(preset.ok, true)
  assert.equal(JSON.parse(fs.files.get(key)).verify_command, 'custom-test')
})
test('Remote rejects missing resources and malformed input without overwriting settings', async t => {
  const root = fixture(t), fs = memory(), c = controller(root, fs), flow = custom()
  flow.config.stage_bindings['确认一'] = { skills: ['uninstalled'] }
  const result = await c.write({ path: root, flow: flow.id, custom_flow: flow })
  assert.equal(result.ok, false); assert.match(result.problems.join(), /uninstalled/); assert.equal(fs.files.size, 0)
  const bad = await c.write({ path: root, flow: flow.id, custom_flow: { ...flow, schema: 5 } })
  assert.equal(bad.ok, false); assert.equal(fs.files.size, 0)
})
test('task ledger reports the frozen custom workflow ID and version', async t => {
  const root = fixture(t), flow = custom(), key = join(root, '.dsh/task-LEDGER.json').replaceAll('\\', '/')
  mkdirSync(join(root, '.dsh'))
  const state = newTask({ id: 'LEDGER', title: 'ledger', branch: 'main', work_size: 'standard', risk_level: 'standard', flow: { flow: flow.id, version: 4, config: flow.config } })
  const raw = JSON.stringify(state); writeFileSync(key, raw)
  const c = controller(root, memory({ [key]: raw })), result = await c.readTasks(root)
  assert.equal(result.tasks[0].flow_id, flow.id); assert.equal(result.tasks[0].flow_version, 4)
})
test('Remote atomic write refuses a concurrent change after it read the configuration', async t => {
  const root = fixture(t), key = join(root, '.dsh/eng.json').replaceAll('\\', '/')
  const fs = memory({ [key]: JSON.stringify({ flow: 'minimal' }) }), c = controller(root, fs)
  const read = fs.readText.bind(fs); let inject = true
  fs.readText = async target => { const content = await read(target); if (inject) { inject = false; await fs.writeText(target, JSON.stringify({ flow: 'agile', verify_command: 'keep' })) } return content }
  await assert.rejects(c.write({ path: root, flow: 'minimal' }), /stale/)
  assert.equal(JSON.parse(fs.files.get(key)).verify_command, 'keep')
})
test('standalone hook uses frozen custom regex and stage evidence even with broken live config', t => {
  const root = fixture(t)
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr) }
  git('init', '-b', 'main'); mkdirSync(join(root, '.dsh'))
  const flow = custom(['测试一', '测试二', '完成']); flow.config.commit.checkpoints = ['测试二']; flow.config.commit.message_pattern = '^TASK-([A-Z0-9]+): .+'; flow.config.commit.message_hint = 'TASK-ID: summary'
  const state = newTask({ id: 'R1', title: 'test', branch: 'main', work_size: 'standard', risk_level: 'standard', flow: { flow: flow.id, version: 1, config: flow.config, hash: hashConfig(flow.config) } })
  state.stage = '测试二'; state.verification = { passed: true, evidence: ['pass'], stage: '测试一' }
  writeFileSync(join(root, '.dsh/eng.json'), '{broken')
  writeFileSync(join(root, 'message'), 'TASK-R1: result')
  const hook = join(root, '.git/hooks/commit-msg'), task = join(root, '.dsh/task-R1.json')
  writeFileSync(hook, readFileSync(resolve('hooks/commit-msg')))
  writeFileSync(join(root, '.git/hooks/package.json'), '{"type":"commonjs"}')
  writeFileSync(task, JSON.stringify(state))
  let run = spawnSync(process.execPath, [hook, join(root, 'message')], { cwd: root, encoding: 'utf8' })
  assert.equal(run.status, 1); assert.match(run.stderr, /guards are unmet/)
  state.verification.stage = '测试二'; writeFileSync(task, JSON.stringify(state))
  run = spawnSync(process.execPath, [hook, join(root, 'message')], { cwd: root, encoding: 'utf8' }); assert.equal(run.status, 0, run.stderr)
  assert.equal(commitCheckpoint(state, flow.config).allowed, true)
  writeFileSync(join(root, 'message'), 'TASK-WRONG: result')
  run = spawnSync(process.execPath, [hook, join(root, 'message')], { cwd: root, encoding: 'utf8' }); assert.equal(run.status, 1); assert.match(run.stderr, /不一致/)
})
