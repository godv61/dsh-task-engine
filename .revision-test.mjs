/**
 * Rework semantics: going backwards must invalidate exactly the superseded
 * conclusions, no more and no less.
 *
 * The graph has only forward edges while the work does not, and before this the
 * only way back was hand-editing the record — which left a confirmation,
 * verification receipt or review verdict describing a superseded tree still
 * reading as passing. The two halves of that are both tested: what must fall, and
 * what must survive so work is not redone for no reason.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRevision, invalidatedBy, completionBlockers } from './lib/engine.js'
import { adoptRecommendation, resolveFlow } from './lib/workflows.js'

/**
 * The preset as a project would actually run it: the skeleton plus the shipped
 * recommendation, adopted exactly the way a user adopts it. A test that asserts
 * on bindings, commit rules or artifacts wants this, because those no longer come
 * from the preset itself.
 * @param {string} id - preset id.
 * @returns {import('./lib/engine.js').WorkflowConfig} the adopted config.
 */
function adoptedFlow(id, extra) {
  const base = adoptRecommendation(id)
  if (base === undefined) throw new Error('unknown preset: ' + id)
  return resolveFlow(id, { ...base, ...extra }).config
}


/** A task carrying every conclusion, so a rework has something to invalidate. */
function loadedTask() {
  return {
    schema: 1,
    id: 'R-1',
    title: 'rework',
    branch: 'main',
    work_size: 'standard',
    risk_level: 'standard',
    stage: '代码审核',
    executed: undefined,
    requirement_confirmed: true,
    solution_confirmed: true,
    items: [{ id: 'A', title: 'a', status: 'done', review: { spec: { outcome: 'pass' }, quality: { outcome: 'pass' } } }],
    verification: { passed: true, evidence: ['checks'], receipt: { exit_code: 0, timed_out: false, aborted: false } },
    review: { outcome: 'pass' },
    artifacts: {},
    files: ['a.js'],
    commits: [{ label: 'TASK', hash: 'abc1234' }],
    execution_version: 1,
  }
}

const rework = (kind, to) => ({ kind, reason: 'why', to, from: '代码审核', at: '2026-09-23T00:00:00.000Z', invalidated: invalidatedBy(kind) })

test('rework: the three kinds declare distinct scopes rather than one blanket rule', () => {
  const requirement = invalidatedBy('requirement')
  const solution = invalidatedBy('solution')
  const defect = invalidatedBy('defect')
  assert.ok(requirement.includes('requirement_confirmation'),
    'a changed requirement must invalidate its own confirmation')
  assert.ok(!solution.includes('requirement_confirmation'),
    'a changed approach leaves the agreed requirement standing')
  assert.ok(!defect.includes('requirement_confirmation') && !defect.includes('solution_confirmation'),
    'a defect in the work does not un-agree what was agreed')
  assert.ok(defect.includes('verification') && defect.includes('review'),
    'a defect invalidates the evidence that the old implementation was correct')
})

test('rework: a changed requirement clears confirmations and downstream evidence', () => {
  const state = loadedTask()
  const outcome = applyRevision(state, rework('requirement', '需求评审'))
  assert.equal(state.stage, '需求评审')
  assert.equal(state.requirement_confirmed, false)
  assert.equal(state.solution_confirmed, false)
  assert.equal(state.verification.passed, false)
  assert.equal(state.review.outcome, 'pending')
  assert.equal(state.items[0].review, undefined)
  assert.deepEqual(state.commits, [])
  assert.equal(state.completed, undefined)
  assert.ok(outcome.invalidated.includes('requirement_confirmation'))
})

test('rework: fixing a defect keeps the agreed requirement and solution', () => {
  // The point of distinguishing kinds: a defect must not force the requirement to
  // be re-agreed, which would make the lightest flows unusable for ordinary fixes.
  const state = loadedTask()
  applyRevision(state, rework('defect', '开发'))
  assert.equal(state.requirement_confirmed, true, 'a defect does not un-agree the requirement')
  assert.equal(state.solution_confirmed, true, 'nor the approach')
  assert.equal(state.verification.passed, false, 'the evidence about the old implementation falls')
  assert.deepEqual(state.commits, [], 'the commit described a superseded tree')
})

test('rework: clearing evidence returns an item to unfinished, not to done-without-audit', () => {
  // A cleared review means the item is no longer proven done. Leaving it `done`
  // would let todos_done pass on work whose audit had just been discarded.
  const state = loadedTask()
  applyRevision(state, rework('defect', '开发'))
  assert.equal(state.items[0].status, 'doing')
  const config = adoptedFlow('standard')
  assert.ok(completionBlockers({ ...state, stage: '完成' }, config).length > 0,
    'a task with an unproven item must not be completable')
})

test('rework: history records what was invalidated, for audit', () => {
  const state = loadedTask()
  applyRevision(state, rework('solution', '设计'))
  assert.equal(state.revisions.length, 1)
  assert.equal(state.revisions[0].kind, 'solution')
  assert.equal(state.revisions[0].from, '代码审核')
  assert.equal(state.revisions[0].to, '设计')
  assert.deepEqual(state.revisions[0].invalidated, invalidatedBy('solution'))
})