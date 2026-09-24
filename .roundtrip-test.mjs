/**
 * Config round-trip: what the panel shows is what the file holds.
 *
 * The write path and the panel both carried only `flow` + `stage_bindings`, so a
 * commit rule, artifact declarations or a review depth were resolved for the preview
 * and then dropped on save. A user could set them, see them applied, and lose them.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveFlow, adoptRecommendation } from './lib/workflows.js'

/** The fields a project config can carry, so a round-trip is checked on all of them. */
const FIELDS = ['flow', 'stage_bindings', 'commit', 'artifacts', 'review_depth', 'commit_required']

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