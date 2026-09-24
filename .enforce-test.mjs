/**
 * The three enforcement gaps the assessment found, tested as behaviour.
 *
 * Each of these was previously DISCLOSED but not enforced, which is the same as not
 * being enforced: status reported the problem and the task proceeded anyway.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { registerDevTask } from './lib/dev-task.js'
import { adoptRecommendation, resolveFlow } from './lib/workflows.js'
import { completionBlockers, terminalRequirements, resourceBlockers } from './lib/engine.js'

/** A project on the standard flow, one skill carrying a project rule, at 开发. */
async function project() {
  const cwd = resolve('enforce-project')
  const adopted = adoptRecommendation('standard')
  const skills = adopted.stage_bindings['开发'].skills.map(entry => ({
    ...entry,
    rules: [...entry.rules, { source: 'project', name: 'mine' }],
  }))
  const stage_bindings = { ...adopted.stage_bindings, '开发': { skills } }
  const records = new Map([
    [join(cwd, '.dsh/eng.json'), JSON.stringify({ ...adopted, stage_bindings })],
    [join(cwd, '.dsh/rules/mine.md'), 'RULE'],
    [join(cwd, 'a.js'), 'source'],
  ])
  const events = []
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
      ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd, sessionId: 'e' }) }
      : undefined,
  }
  registerDevTask(ctx)
  const exec = { agent: { session: { id: 'e', header: { cwd }, snapshotEvents: () => events } }, signal: new AbortController().signal }
  const call = async args => execute(JSON.parse(JSON.stringify({ task_id: 'E-1', ...args })), exec)
  await call({ operation: 'create', title: 't', branch: 'main', files: ['a.js'] })
  const state = JSON.parse(records.get(join(cwd, '.dsh/task-E-1.json')))
  state.stage = '开发'
  state.requirement_confirmed = true
  state.solution_confirmed = true
  records.set(join(cwd, '.dsh/task-E-1.json'), JSON.stringify(state))
  const load = name => {
    const callId = 'c' + events.length
    events.push({ type: 'tool/call', data: { name: 'skill', callId, arguments: JSON.stringify({ name }) } })
    events.push({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: callId, isError: false }] } } })
  }
  const current = () => JSON.parse(records.get(join(cwd, '.dsh/task-E-1.json')))
  return { call, records, cwd, load, current, rule: () => join(cwd, '.dsh/rules/mine.md') }
}

/** Satisfy everything 开发 → 交付 needs except the resource question. */
async function satistfyDevelopment(f) {
  await f.call({ operation: 'items', items: [{ id: 'A', title: 'a', status: 'doing' }] })
  await f.call({ operation: 'dispatch', item_id: 'A', description: 'd' })
  await f.call({ operation: 'review_item', item_id: 'A', spec_outcome: 'pass', quality_outcome: 'pass' })
  await f.call({ operation: 'items', items: [{ id: 'A', status: 'done' }] })
  for (const entry of f.current().flow.config.stage_bindings['开发'].skills) f.load(entry.skill.name)
}

test('enforce: a task WITHOUT a snapshot cannot advance while a bound rule is unresolvable', async () => {
  // The disclosed-but-unenforced case: status said the rule was missing and advance
  // still succeeded, so the stage completed without the constraint.
  const f = await project()
  const state = f.current()
  delete state.flow.resources
  f.records.set(join(f.cwd, '.dsh/task-E-1.json'), JSON.stringify(state))
  await satistfyDevelopment(f)

  f.records.delete(f.rule())
  await assert.rejects(
    () => f.call({ operation: 'advance', target_stage: '交付' }),
    /resolves nowhere/u,
    'a stage whose rules cannot be resolved must not be passable',
  )
})

test('enforce: a task WITH a snapshot blocks when its live source rule is deleted', async () => {
  const f = await project()
  await satistfyDevelopment(f)
  f.records.delete(f.rule())
  await assert.rejects(() => f.call({ operation: 'advance', target_stage: '交付' }), /resolves nowhere/u)
  assert.equal(f.current().stage, '开发')
})

test('enforce: completion requires the review and verification the flow declared', async () => {
  // Arriving at the last stage used to be enough. The agile flow declares a review
  // on the way into 审查, so a blocked review must now prevent completion —
  // without hardcoding review into flows that never asked for it.
  const agile = resolveFlow('agile', adoptRecommendation('agile')).config
  assert.ok(terminalRequirements(agile).length >= 0)
  const base = {
    stage: '审查', execution_version: 1,
    items: [{ id: 'A', status: 'done', review: { spec: { outcome: 'pass' }, quality: { outcome: 'pass' } } }],
    verification: { passed: true, evidence: [] },
    commits: [{ label: 'TASK', hash: 'abc1234' }],
  }
  assert.deepEqual(completionBlockers({ ...base, review: { outcome: 'pass' } }, agile), [],
    'a passing review completes')
  const blocked = completionBlockers({ ...base, review: { outcome: 'blocked' } }, agile)
  assert.ok(blocked.some(b => b.includes('passing review')),
    `a blocked review must prevent completion; got ${JSON.stringify(blocked)}`)

  // And a flow that declares no verification gate is not made to demand one.
  const minimal = resolveFlow('minimal', adoptRecommendation('minimal')).config
  const minState = {
    stage: '交付', execution_version: 1,
    items: [{ id: 'A', status: 'done', review: { spec: { outcome: 'pass' } } }],
    verification: { passed: false, evidence: [] },
    commits: [{ label: 'TASK', hash: 'abc1234' }],
  }
  assert.deepEqual(completionBlockers(minState, minimal), [],
    'minimal declares no verification gate, so a non-passing verification must not block it')
})

test('enforce: the resource blocker names the stage, the reference and the fix', () => {
  const blockers = resourceBlockers(['project:mine'], '开发')
  assert.equal(blockers.length, 1)
  assert.match(blockers[0], /开发/u)
  assert.match(blockers[0], /project:mine/u)
  assert.match(blockers[0], /Restore the file|remove the binding/u,
    'a blocker must say what to do, not only what is wrong')
  assert.deepEqual(resourceBlockers([], '开发'), [], 'a resolvable stage has no blocker')
})
