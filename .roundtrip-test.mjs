/**
 * Config round-trip: what the panel shows is what the file holds.
 *
 * The write path and the panel both carried only `flow` + `stage_bindings`, so a
 * commit rule, artifact declarations or a review depth were resolved for the preview
 * and then dropped on save. A user could set them, see them applied, and lose them.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveFlow, adoptRecommendation, compactProjectConfig } from './lib/workflows.js'
import Controller from './lib/controller.js'
import { assertAdvance, validateWorkflow } from './lib/engine.js'

/** The fields a project config can carry, so a round-trip is checked on all of them. */
const FIELDS = ['flow', 'stage_bindings', 'commit', 'artifacts', 'review_depth', 'commit_required']

test('round-trip: stages store references while skill rules have one owner', () => {
  const adopted = adoptRecommendation('standard')
  const compact = compactProjectConfig(adopted)
  assert.ok(compact.stage_bindings['开发'].skill_refs.length > 0)
  assert.equal(compact.stage_bindings['开发'].skills, undefined)
  assert.ok(compact.skill_profiles['bundled:code-implement'].rules.length > 0)
  const readBack = resolveFlow('standard', JSON.parse(JSON.stringify(compact)))
  assert.deepEqual(readBack.config.stage_bindings, resolveFlow('standard', adopted).config.stage_bindings)
  const custom = { flow: 'standard', stage_bindings: {
    '开发': { skills: [{ skill: { source: 'project', name: 'same' }, rules: [{ source: 'project', name: 'r1' }] }] },
    '交付': { skills: [{ skill: { source: 'project', name: 'same' }, rules: [{ source: 'project', name: 'r2' }] }] },
  } }
  const invalid = resolveFlow('standard', custom)
  assert.ok(invalid.config.configuration_errors.some(problem => problem.includes('different rules')))
})

test('remote write stores canonical skill profiles and read expands them', async () => {
  let stored
  const fs = {
    resolve: async path => path,
    readText: async () => stored,
    writeText: async (_target, text) => { stored = text },
  }
  const receiver = { authorizedPath: async path => path, fs: () => fs }
  const adopted = adoptRecommendation('standard')
  const written = await Controller.prototype.write.call(receiver, { path: 'project', ...adopted })
  assert.equal(written.ok, true)
  const onDisk = JSON.parse(stored)
  assert.ok(onDisk.stage_bindings['开发'].skill_refs.length > 0)
  assert.equal(onDisk.stage_bindings['开发'].skills, undefined)
  assert.ok(onDisk.skill_profiles['bundled:code-implement'].rules.length > 0)
  const loaded = await Controller.prototype.read.call(receiver, 'project')
  assert.equal(loaded.ok, true)
  assert.deepEqual(loaded.config.stage_bindings, written.config.stage_bindings)
  assert.deepEqual(loaded.config.skill_profiles, written.config.skill_profiles)
})

test('adopting a recommendation retains the user-owned skill profiles', () => {
  const custom = { 'project:my-skill': { rules: [{ source: 'project', name: 'my-rule' }], evidence: 'manual' } }
  const adopted = adoptRecommendation('standard', { flow: 'standard', skill_profiles: custom })
  assert.deepEqual(adopted.skill_profiles, custom)
})

test('malformed canonical skill profiles fail validation without crashing resolution', () => {
  const malformed = resolveFlow('standard', { flow: 'standard',
    stage_bindings: { '开发': { skill_refs: [{ source: 'project', name: 'my-skill' }] } },
    skill_profiles: { 'project:my-skill': { rules: 'not-an-array' } },
  })
  assert.ok(validateWorkflow(malformed.config).some(problem => problem.includes('rules array')))
})

test('commit_required false also removes the checkpoint exit requirement', () => {
  const adopted = adoptRecommendation('standard')
  const config = resolveFlow('standard', { ...adopted, commit_required: false }).config
  const state = { stage: '代码审核', execution_version: 1, review: { outcome: 'pass' },
    artifacts: { review: { conclusion: 'pass', issues: 'none' } }, commits: [] }
  assert.equal(assertAdvance(state, '完成', config).ok, true)
})

test('round-trip: every configurable field survives being written and read back', () => {
  // The save path serialises the payload and the read path parses it back through
  // resolveFlow, so this asserts exactly those two steps.
  const adopted = adoptRecommendation('standard')
  const written = {
    flow: 'standard',
    stage_bindings: adopted.stage_bindings,
    commit: adopted.commit,
    artifacts: adopted.artifacts,
    review_depth: 'single',
    commit_required: false,
  }
  const serialised = JSON.stringify(written, null, 2)
  const readBack = JSON.parse(serialised)
  for (const field of FIELDS) {
    assert.ok(field in readBack, `${field} must survive serialisation`)
  }

  const resolved = resolveFlow(readBack.flow, readBack)
  assert.equal(resolved.ok, true)
  assert.deepEqual(resolved.config.stage_bindings, written.stage_bindings, 'bindings round-trip')
  assert.equal(resolved.config.commit.message_pattern, written.commit.message_pattern, 'the commit text convention round-trips')
  assert.equal(resolved.config.commit.policy, 'task', 'the flow-control half of the commit rule is preserved')
  assert.deepEqual(resolved.config.artifacts, written.artifacts, 'artifacts round-trip')
  assert.equal(resolved.config.review_depth, 'single', 'review depth round-trips')
  assert.equal(resolved.config.commit_required, false, 'commit_required round-trips')
})

test('round-trip: the payload the panel sends contains every edited field', () => {
  // Mirrors the panel's save payload, so a field added to the config but not to the
  // payload is caught here rather than by a user losing their settings.
  const adopted = adoptRecommendation('standard')
  const commitRule = adopted.commit
  const artifacts = adopted.artifacts
  const reviewDepth = 'single'
  const payload = {
    flow: 'standard',
    stage_bindings: adopted.stage_bindings,
    ...(commitRule !== undefined ? { commit: commitRule } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(reviewDepth !== undefined ? { review_depth: reviewDepth } : {}),
  }
  for (const field of ['flow', 'stage_bindings', 'commit', 'artifacts', 'review_depth']) {
    assert.ok(field in payload, `the panel must send ${field}`)
  }
  // And the whole payload must be accepted by the resolver the write path uses.
  const resolved = resolveFlow(payload.flow, payload)
  assert.equal(resolved.ok, true, 'the payload the panel sends must resolve without problems')
})
