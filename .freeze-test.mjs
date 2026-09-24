/**
 * Resource freezing: an in-flight task must not change because the library did.
 *
 * Names alone cannot keep a task stable. Before this, editing a rule that a
 * running task used silently changed what that task was doing, and deleting one
 * made a configured constraint disappear without the task recording anything.
 */
import { adoptRecommendation } from './lib/workflows.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { registerDevTask } from './lib/dev-task.js'
import { hashText } from './lib/snapshot.js'

/** Create one task through the real tool and return its frozen snapshot. */
async function created(flow) {
  const cwd = resolve('freeze-project')
  const records = new Map([
    // A project that adopted the shipped recommendation, which is what gives it
    // skills and rules to freeze. `{flow}` alone adopts nothing and therefore has
    // nothing to freeze — a legitimate state, but not the one under test.
    [join(cwd, '.dsh/eng.json'), JSON.stringify(adoptRecommendation(flow))],
    [join(cwd, 'a.js'), 'source'],
  ])
  const events = []
  const session = { id: 'f', header: { cwd }, snapshotEvents: () => events }
  let execute
  const key = (p, options) => join(options?.cwd ?? cwd, p)
  const fs = {
    resolve: async (p, options) => ({ targetKey: key(p, options) }),
    readText: async target => records.get(target.targetKey),
    listDir: async () => [],
    lstat: async (p, options) => records.has(key(p, options)) ? { version: 'v' } : undefined,
    writeText: async (target, content) => { records.set(target.targetKey, content) },
  }
  const ctx = {
    fs,
    tools: { register(tool) { execute = tool.execute; return () => {} } },
    get: name => name === 'sandboxPolicy'
      ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd, sessionId: 'f' }) }
      : undefined,
  }
  registerDevTask(ctx)
  const exec = { agent: { session }, signal: new AbortController().signal }
  await execute({ task_id: 'FZ-1', operation: 'create', title: 'freeze', branch: 'main', files: ['a.js'] }, exec)
  return JSON.parse(records.get(join(cwd, '.dsh/task-FZ-1.json')))
}

test('freeze: task creation captures every skill and rule body it will use', async () => {
  const state = await created('standard')
  const resources = state.flow.resources ?? []
  assert.ok(resources.length > 0, 'creation must freeze the resolved resources')

  // Every binding in the frozen config must be covered by a frozen body.
  const frozen = new Set(resources.map(r => `${r.ref.source}:${r.ref.name}`))
  for (const [stage, binding] of Object.entries(state.flow.config.stage_bindings ?? {})) {
    for (const entry of binding.skills ?? []) {
      assert.ok(frozen.has(`${entry.skill.source}:${entry.skill.name}`),
        `${entry.skill.name} on ${stage} must be frozen`)
      for (const rule of entry.rules) {
        assert.ok(frozen.has(`${rule.source}:${rule.name}`),
          `rule ${rule.name} for ${entry.skill.name} must be frozen`)
      }
    }
  }
})

test('freeze: a frozen body carries its content and a hash of that content', async () => {
  const state = await created('standard')
  for (const resource of state.flow.resources ?? []) {
    assert.ok(resource.content.length > 0, `${resource.ref.name} must carry its body`)
    assert.equal(resource.hash, hashText(resource.content),
      `${resource.ref.name} hash must describe the frozen body, so a later edit is detectable`)
  }
})

test('freeze: shared resources are stored once, not duplicated per reference', async () => {
  // security-redlines is referenced by two skills; the body must not be copied twice.
  const state = await created('standard')
  const resources = state.flow.resources ?? []
  const hashes = resources.map(r => r.hash)
  assert.equal(new Set(hashes).size, hashes.length,
    'identical bodies must not be stored more than once')
  assert.ok(resources.some(r => r.ref.name === 'security-redlines'),
    'the shared rule must be present')
})

test('freeze: every preset freezes a complete, non-empty set', async () => {
  for (const flow of ['standard', 'agile', 'minimal']) {
    const state = await created(flow)
    assert.ok((state.flow.resources ?? []).length >= 3,
      `${flow} must freeze its resources; saw ${(state.flow.resources ?? []).length}`)
  }
})

/**
 * A task carrying one project rule on a skill, parked at the stage that uses it.
 *
 * Built from the adopted recommendation so the binding is one the resolver really
 * accepts, then given a project rule of its own — exactly what the workbench
 * writes when a user edits a skill's rule list.
 */
async function atDevelopmentWithProjectRule() {
  const cwd = resolve('freeze-live')
  const adopted = adoptRecommendation('standard')
  const skills = adopted.stage_bindings['开发'].skills.map(entry => ({
    ...entry,
    rules: [...entry.rules, { source: 'project', name: 'mine' }],
  }))
  const project = { ...adopted, stage_bindings: { ...adopted.stage_bindings, '开发': { skills } } }
  const records = new Map([
    [join(cwd, '.dsh/eng.json'), JSON.stringify(project)],
    [join(cwd, '.dsh/rules/mine.md'), 'ORIGINAL RULE'],
    [join(cwd, 'a.js'), 'source'],
  ])
  let execute
  const key = (p, options) => join(options?.cwd ?? cwd, p)
  const fs = {
    resolve: async (p, options) => ({ targetKey: key(p, options) }),
    readText: async target => records.get(target.targetKey),
    listDir: async () => [],
    lstat: async (p, options) => records.has(key(p, options)) ? { version: 'v' } : undefined,
    writeText: async (target, content) => { records.set(target.targetKey, content) },
  }
  const ctx = {
    fs,
    tools: { register(tool) { execute = tool.execute; return () => {} } },
    get: name => name === 'sandboxPolicy'
      ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd, sessionId: 'f' }) }
      : undefined,
  }
  registerDevTask(ctx)
  const exec = { agent: { session: { id: 'f', header: { cwd }, snapshotEvents: () => [] } }, signal: new AbortController().signal }
  const call = async args => execute(JSON.parse(JSON.stringify({ task_id: 'FZ-2', ...args })), exec)
  await call({ operation: 'create', title: 'freeze', branch: 'main', files: ['a.js'] })
  const state = JSON.parse(records.get(join(cwd, '.dsh/task-FZ-2.json')))
  state.stage = '开发'
  state.requirement_confirmed = true
  state.solution_confirmed = true
  records.set(join(cwd, '.dsh/task-FZ-2.json'), JSON.stringify(state))
  return {
    call,
    records,
    cwd,
    rule: () => join(cwd, '.dsh/rules/mine.md'),
    disclosed: async () => {
      const status = JSON.parse(await call({ operation: 'status' }))
      return { status, mine: status.bindings.rules.find(r => r.name === 'mine') }
    },
  }
}

test('freeze: a running task follows the FROZEN body after its source is edited', async () => {
  // Freezing that only archives the content is not freezing: status and the stage
  // disclosure used to read the live files, so editing a rule silently changed what
  // a running task was told to follow — the instability the snapshot exists to stop.
  const f = await atDevelopmentWithProjectRule()
  const before = await f.disclosed()
  assert.equal(before.mine?.content, 'ORIGINAL RULE', 'the frozen body is what gets disclosed')

  f.records.set(f.rule(), 'CHANGED RULE')
  const after = await f.disclosed()
  assert.equal(after.mine?.content, 'ORIGINAL RULE',
    'an edit to the source must not change what the running task is told to follow')
  assert.ok((after.status.stale_source_rules ?? []).some(r => r.includes('edited')),
    'the drift is reported so it is visible rather than silently authoritative')
})

test('freeze: a running task survives its source rule being deleted', async () => {
  // The frozen copy exists precisely so a deleted file is not a missing
  // constraint. Reporting it as missing would be wrong: the task has the body.
  const f = await atDevelopmentWithProjectRule()
  f.records.delete(f.rule())
  const { status, mine } = await f.disclosed()
  assert.equal(mine?.content, 'ORIGINAL RULE', 'the frozen body is still in force')
  assert.deepEqual(status.missing_rules, [],
    'a frozen rule is not missing; the task already holds its content')
  assert.ok((status.stale_source_rules ?? []).some(r => r.includes('deleted')),
    'the deletion is reported as drift')
})

test('freeze: an unfrozen task falls back to live resolution and reports a missing file', async () => {
  // Tasks created before freezing have no snapshot. They must keep working, and a
  // deleted rule must be reported as missing rather than silently unbound — the
  // two paths are distinguishable and neither silently degrades into the other.
  const f = await atDevelopmentWithProjectRule()
  const state = JSON.parse(f.records.get(join(f.cwd, '.dsh/task-FZ-2.json')))
  delete state.flow.resources
  f.records.set(join(f.cwd, '.dsh/task-FZ-2.json'), JSON.stringify(state))

  const live = await f.disclosed()
  assert.equal(live.mine?.content, 'ORIGINAL RULE', 'an unfrozen task reads the live file')

  f.records.delete(f.rule())
  const { status, mine } = await f.disclosed()
  assert.equal(mine, undefined, 'with no snapshot and no file, the rule cannot resolve')
  assert.ok((status.missing_rules ?? []).includes('project:mine'),
    'it is reported as missing so the gate can block on it')
})