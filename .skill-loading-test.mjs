import { confirmedRequirement } from './scripts/fixtures/confirmed-requirement.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve, sep } from 'node:path'
import { registerDevTask } from './lib/dev-task.js'
import Controller from './lib/controller.js'
import { compactProjectConfig, materializeBundledReferences, resolveFlow } from './lib/workflows.js'
import { validateWorkflow } from './lib/engine.js'
import { hashText } from './lib/snapshot.js'

const skill = (name, description, when, body) => `---\nname: ${name}\ndescription: ${description}\nwhenToUse: ${when}\n---\n${body}`
const mapBody = skill('map', 'Repository entry points', 'Locate modules before a change', 'MAP_FULL_BODY')
const frontendBody = skill('frontend', 'Frontend implementation', 'Only for UI changes', 'FRONTEND_FULL_BODY')
function fixture(meta, mapEvidence = 'none') {
  const cwd = resolve('skill-loading-project')
  const files = new Map()
  const put = (path, text) => files.set(join(cwd, path), text)
  put('app.js', 'export const x = 1')
  put('.dsh/meta.json', JSON.stringify({ meta_bindings: meta }))
  put('.dsh/skills/map/SKILL.md', mapBody)
  put('.dsh/skills/map/profile.json', JSON.stringify({ rules: [{ source: 'project', name: 'map-rule' }], evidence: mapEvidence }))
  put('.dsh/rules/map-rule.md', 'MAP_RULE_FULL_BODY')
  put('.dsh/skills/frontend/SKILL.md', frontendBody)
  put('.dsh/skills/frontend/profile.json', JSON.stringify({ rules: [{ source: 'project', name: 'ui-rule' }], evidence: 'artifact' }))
  put('.dsh/rules/ui-rule.md', 'UI_RULE_FULL_BODY')
  const key = (path, options) => join(options?.cwd ?? cwd, path)
  const fs = {
    resolve: async (path, options) => ({ path: key(path, options) }),
    readText: async target => files.get(target.path),
    lstat: async (path, options) => files.has(key(path, options)) ? { version: 'v1' } : undefined,
    writeText: async (target, text) => files.set(target.path, text),
    listDir: async target => [...new Set([...files.keys()].filter(path => path.startsWith(target.path + sep))
      .map(path => path.slice(target.path.length + 1).split(sep)[0]))].map(name => ({ name })),
  }
  let execute
  const logs = new Map()
  const getSession = id => {
    if (!logs.has(id)) logs.set(id, [])
    return { id, header: { cwd }, snapshotEvents: () => logs.get(id) }
  }
  const ctx = { fs, tools: { register(tool) { execute = tool.execute } }, get: name => name === 'sandboxPolicy'
    ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd }) } : undefined }
  registerDevTask(ctx)
  const call = async (args, sessionId = 'main') => {
    const session = getSession(sessionId), events = logs.get(sessionId), callId = `call-${events.length}`
    const input = { task_id: 'LOAD-1', ...args }
    events.push({ type: 'tool/call', data: { name: 'dev_task', callId, arguments: JSON.stringify(input) } })
    try {
      const text = await execute(input, { agent: { session }, callId, signal: new AbortController().signal })
      events.push({ type: 'tool/result', data: { message: { toolCallId: callId, content: [{ type: 'text', text }] } } })
      if (input.operation === 'create' || input.operation === 'record' && input.artifact === 'requirement') { const p = join(cwd, `.dsh/task-${input.task_id}.json`); const state = JSON.parse(files.get(p)); confirmedRequirement(state, (p,c) => files.set(join(cwd,p),c)); files.set(p,JSON.stringify(state)) }
      return text
    } catch (error) {
      events.push({ type: 'tool/result', data: { message: { toolCallId: callId, isError: true } } })
      throw error
    }
  }
  return { cwd, fs, files, put, call, logs,
    state: (id = 'LOAD-1') => JSON.parse(files.get(join(cwd, `.dsh/task-${id}.json`))),
    create: (grade = 'medium', id = 'LOAD-1') => call({ operation: 'create', task_id: id, title: 'Backend-only change',
      intent: 'implementation', intent_reason: 'Fixture implementation', branch: 'test', complexity: grade, complexity_reason: 'A bounded backend change', files: ['app.js'] }),
    load: name => call({ operation: 'load_skill', skill_name: name }),
    recordRequirement: () => call({ operation: 'record', artifact: 'requirement', fields: { goal: 'Fix backend', scope: 'Backend only', acceptance: 'Existing behavior preserved' } }),
  }
}

test('optional frontend metadata is visible without injecting its body, Rules or evidence obligations', async () => {
  const f = fixture({ 'code-development': [{ name: 'frontend', loading: 'on-demand' }] })
  const created = await f.create('low')
  assert.match(created, /Only for UI changes/)
  assert.doesNotMatch(created, /FRONTEND_FULL_BODY|UI_RULE_FULL_BODY/)
  const before = JSON.parse(await f.call({ operation: 'status' }))
  assert.ok(before.skill_blockers.some(text => text.includes('code-development')))
  assert.ok(before.skill_blockers.every(text => !text.includes('frontend')))
  assert.ok(before.skill_obligations.every(stage => !stage.skills.includes('project:frontend')))
  const entry = before.bindings.skill_index.find(skill => skill.name === 'frontend')
  assert.equal(entry.loading, 'on-demand'); assert.equal(entry.whenToUse, 'Only for UI changes')
  assert.deepEqual(entry.rule_paths, ['.dsh/rules/ui-rule.md'])
  await f.load('bundled:code-development')
  const after = JSON.parse(await f.call({ operation: 'status' }))
  assert.deepEqual(after.skill_blockers, [])
  assert.deepEqual(after.evidence_blockers, [])
  const selected = await f.load('project:frontend')
  assert.match(selected, /FRONTEND_FULL_BODY/); assert.match(selected, /UI_RULE_FULL_BODY/)
  assert.deepEqual(JSON.parse(await f.call({ operation: 'status' })).skill_blockers, [])
})

test('unavailable optional Skills and Rules do not block an unrelated task', async () => {
  const f = fixture({ 'code-development': [{ name: 'frontend', loading: 'on-demand' }, { name: 'missing', loading: 'on-demand' }] })
  f.files.delete(join(f.cwd, '.dsh/rules/ui-rule.md'))
  await f.create('low'); await f.load('bundled:code-development')
  const status = JSON.parse(await f.call({ operation: 'status' }))
  assert.deepEqual(status.missing_skills, []); assert.deepEqual(status.missing_rules, [])
  assert.deepEqual(status.skill_blockers, []); assert.deepEqual(status.evidence_blockers, [])
  assert.equal(status.bindings.skill_index.find(skill => skill.name === 'missing').available, false)
  await assert.rejects(f.load('project:frontend'), /bound rule.*cannot be read/)
  await assert.rejects(f.load('project:missing'), /cannot be read/)
})

test('a required phase can advance without reading or recording evidence for its optional Skill', async () => {
  const f = fixture({ 'requirements-analysis': [{ name: 'frontend', loading: 'on-demand' }] })
  await f.create(); await f.load('bundled:requirements-analysis'); await f.recordRequirement()
  await f.call({ operation: 'advance', target_stage: '代码开发' })
  assert.equal(f.state().stage, '代码开发')
  assert.equal(f.state().skill_loads['需求分析']['project:frontend'], undefined)
})

test('a frozen task policy cannot be weakened by hand-editing its snapshot', async () => {
  const f = fixture({ 'code-development': ['map'] }); await f.create('low')
  const state = f.state()
  state.flow.config.stage_bindings['代码开发'].skills.find(entry => entry.skill.name === 'map').loading = 'on-demand'
  f.put('.dsh/task-LOAD-1.json', JSON.stringify(state))
  await assert.rejects(f.call({ operation: 'status' }), /hash|tamper|snapshot/)
})

test('required unread Skill blocks advance; prior load is reused across stages with full attached Rules read once', async () => {
  const f = fixture({ 'requirements-analysis': ['map'], 'code-development': ['map'] })
  await f.create()
  await f.load('bundled:requirements-analysis'); await f.recordRequirement()
  await assert.rejects(f.call({ operation: 'advance', target_stage: '代码开发' }), /load skill.*map/)
  const first = await f.load('project:map')
  assert.match(first, /MAP_FULL_BODY/); assert.match(first, /MAP_RULE_FULL_BODY/)
  const advanced = await f.call({ operation: 'advance', target_stage: '代码开发' })
  assert.doesNotMatch(advanced, /MAP_FULL_BODY|MAP_RULE_FULL_BODY/)
  const second = await f.load('project:map')
  assert.match(second, /reused: true/); assert.doesNotMatch(second, /MAP_FULL_BODY|MAP_RULE_FULL_BODY/)
  await f.load('bundled:code-development')
  const status = JSON.parse(await f.call({ operation: 'status' }))
  assert.deepEqual(status.skill_blockers, []); assert.deepEqual(status.evidence_blockers, [])
  assert.equal(status.bindings.skill_index.find(skill => skill.name === 'map').loaded_at_stage, '需求分析')
  assert.match(await f.call({ operation: 'load_skill', skill_name: 'project:map', detail: true }), /MAP_FULL_BODY/)
})

test('reuse cannot cross a session or task, and failed loader calls do not count', async () => {
  const f = fixture({ 'code-development': ['map'] })
  await f.create('low'); await f.load('bundled:code-development'); await f.load('project:map')
  const other = JSON.parse(await f.call({ operation: 'status' }, 'other-session'))
  assert.ok(other.skill_blockers.some(text => text.includes('map')))
  assert.match(await f.call({ operation: 'load_skill', skill_name: 'project:map' }, 'other-session'), /MAP_FULL_BODY/)
  await f.create('low', 'LOAD-2')
  assert.match(await f.call({ operation: 'load_skill', task_id: 'LOAD-2', skill_name: 'project:map' }), /MAP_FULL_BODY/)
  await assert.rejects(f.load('project:not-bound'), /exact source:name/)
  const broken = fixture({ 'code-development': ['map'] }); await broken.create('low')
  broken.files.delete(join(broken.cwd, '.dsh/rules/map-rule.md'))
  await assert.rejects(broken.load('project:map'), /bound rule/)
  assert.ok(JSON.parse(await broken.call({ operation: 'status' })).skill_blockers.some(text => text.includes('map')))
})

test('reused loading does not satisfy a different stage artifact obligation', async () => {
  const f = fixture({ 'requirements-analysis': ['map'], 'architecture-design': ['map'] }, 'artifact')
  await f.create('ultra'); await f.load('bundled:requirements-analysis'); await f.load('project:map'); await f.recordRequirement()
  await f.call({ operation: 'advance', target_stage: '架构设计' }); await f.load('bundled:architecture-design')
  const status = JSON.parse(await f.call({ operation: 'status' }))
  assert.ok(status.skill_blockers.some(text => text.includes('map') && text.includes('artifact')))
  await f.call({ operation: 'record', artifact: 'architecture', fields: { approach: 'Preserve API', impact: 'One service', tradeoffs: 'No schema change' } })
  assert.deepEqual(JSON.parse(await f.call({ operation: 'status' })).skill_blockers, [])
})

test('old name arrays remain required; malformed policy and optional core are rejected', async () => {
  const old = fixture({ 'code-development': ['map'] }); await old.create('low')
  assert.ok(JSON.parse(await old.call({ operation: 'status' })).skill_blockers.some(text => text.includes('map')))
  await assert.rejects(fixture({ 'code-development': [{ name: 'map', loading: 'maybe' }] }).create('low'), /loading/)
  await assert.rejects(fixture({ 'code-development': [{ name: 'code-development', loading: 'on-demand' }] }).create('low'), /core Skill/)
  await assert.rejects(fixture({ 'code-development': ['map', { name: 'map', loading: 'on-demand' }] }).create('low'), /duplicate/)
})

test('mount policy survives compact config, profile normalization and adoption without becoming a global Skill property', () => {
  const stages = resolveFlow('minimal').config.stages
  const ref = { source: 'project', name: 'map' }, profile = { rules: [], evidence: 'none' }
  const config = compactProjectConfig({ flow: 'minimal', stage_bindings: {
    [stages[0]]: { skills: [{ skill: ref, ...profile, loading: 'required' }] },
    [stages[1]]: { skills: [{ skill: ref, ...profile, loading: 'on-demand' }] },
  } })
  assert.equal(config.stage_bindings[stages[0]].skill_refs[0].loading, 'required')
  assert.equal(config.stage_bindings[stages[1]].skill_refs[0].loading, 'on-demand')
  assert.equal(config.skill_profiles['project:map'].loading, undefined)
  const resolved = resolveFlow('minimal', config).config
  assert.deepEqual(validateWorkflow(resolved), [])
  assert.equal(resolved.stage_bindings[stages[1]].skills[0].loading, 'on-demand')
  const adopted = materializeBundledReferences({ flow: 'minimal', stage_bindings: {
    [stages[0]]: { skills: [{ skill: { source: 'bundled', name: 'code-development' }, rules: [], evidence: 'none', loading: 'required' }] },
  } }, 'project')
  assert.equal(adopted.config.stage_bindings[stages[0]].skill_refs[0].loading, 'required')
})

test('controller saves mixed old/new mounts; rejects invalid policies without overwriting', async () => {
  const f = fixture({ 'code-development': ['map'] })
  const receiver = { authorizedPath: async path => path, fs: () => f.fs,
    listSkills: async () => ({ skills: [{ name: 'map' }, { name: 'frontend' }] }),
    readAdaptive: path => Controller.prototype.readAdaptive.call(receiver, path) }
  const old = await receiver.readAdaptive(f.cwd)
  const config = { meta_bindings: { 'code-development': ['map', { name: 'frontend', loading: 'on-demand' }] } }
  const result = await Controller.prototype.writeAdaptive.call(receiver, { path: f.cwd, config, expected_hash: old.hash })
  assert.equal(result.ok, true); assert.deepEqual(result.config, config)
  const raw = f.files.get(join(f.cwd, '.dsh/meta.json'))
  const invalid = await Controller.prototype.writeAdaptive.call(receiver, { path: f.cwd,
    config: { meta_bindings: { 'code-development': [{ name: 'map', loading: 'invalid' }] } }, expected_hash: hashText(raw) })
  assert.equal(invalid.ok, false); assert.equal(f.files.get(join(f.cwd, '.dsh/meta.json')), raw)
})
