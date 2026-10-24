import test from 'node:test'
import assert from 'node:assert/strict'
import { firstPendingStep, initGenerationQueue, preserveInitGenerationId, restoreInitProgress } from './lib/init-progress.js'

const steps = ['map', 'stack', 'business', 'backend', 'frontend'].map(name => ({ name, required: false }))
const resource = name => ({ kind: 'skill', name, description: 'fixture', content: '# fixture', meta_skills: ['requirements-analysis'] })
const restore = value => restoreInitProgress(JSON.stringify(value), 'current', steps)

test('pending job identity survives navigation, while changed inputs and explicit resets start a new attempt', () => {
  const progress = { fingerprint: 'current', schema_version: 3, index: 0, completed: [], selected: 'business', resources: [], errors: {} }
  const prior = JSON.stringify({ ...progress, generation_id: 'pending-job' })
  assert.equal(preserveInitGenerationId(prior, progress).generation_id, 'pending-job')
  assert.equal(preserveInitGenerationId(prior, { ...progress, generation_id: 'new-attempt' }).generation_id, 'new-attempt')
  assert.equal(preserveInitGenerationId(prior, { ...progress, fingerprint: 'changed' }).generation_id, undefined)
  for (const corrupt of ['null', '{broken', null]) assert.deepEqual(preserveInitGenerationId(corrupt, progress), progress)
})

test('legacy prefix migrates generated and skipped steps without losing resources or the durable job nonce', () => {
  const result = restore({ schema_version: 2, fingerprint: 'current', index: 2, resources: [resource('map')], generation_id: 'running-job' })
  assert.deepEqual(result.completed, ['map', 'stack'])
  assert.equal(result.selected, 'business')
  assert.deepEqual(result.resources, [resource('map')])
  assert.equal(result.generation_id, 'running-job')
})

test('selecting and generating a later step does not complete or skip earlier steps', () => {
  const result = restore({ schema_version: 3, fingerprint: 'current', index: 0,
    completed: ['business'], selected: 'business', resources: [resource('business')], errors: {} })
  assert.equal(result.selected, 'business')
  assert.equal(result.index, 0)
  assert.deepEqual(result.completed, ['business'])
  assert.equal(firstPendingStep(steps, result.completed), 0)
  const switched = restore({ ...result, selected: 'frontend' })
  assert.deepEqual(switched.completed, ['business'])
  assert.deepEqual(switched.resources, result.resources)
})

test('continuous generation includes pending steps before selection and skips only explicitly processed steps', () => {
  assert.deepEqual(initGenerationQueue(steps, ['business', 'backend'], 'frontend', false), ['map', 'stack', 'frontend'])
  assert.deepEqual(initGenerationQueue(steps, ['business'], 'business', true), ['business'])
  assert.deepEqual(initGenerationQueue(steps, [], 'unknown', true), [])
  assert.deepEqual(initGenerationQueue(steps, steps.map(step => step.name), 'frontend', false), [])
  assert.equal(firstPendingStep(steps, steps.map(step => step.name)), 5)
})

test('a failed regeneration retains the old draft while its step remains pending and resumable', () => {
  const result = restore({ schema_version: 3, fingerprint: 'current', index: 0, completed: ['stack'],
    selected: 'business', resources: [resource('business'), resource('stack')],
    errors: { business: 'temporary timeout' }, generation_id: 'regeneration-attempt' })
  assert.equal(result.errors.business, 'temporary timeout')
  assert.equal(result.generation_id, 'regeneration-attempt')
  assert.ok(result.resources.some(item => item.name === 'business'))
  assert.ok(!result.completed.includes('business'))
  assert.ok(initGenerationQueue(steps, result.completed, result.selected, false).includes('business'))
})

test('invalid or incompatible progress is rejected without inferring completed steps from selection', () => {
  for (const value of [null, {}, { index: -1, resources: [] }, { index: 9, resources: [] },
    { schema_version: 4, fingerprint: 'current', index: 0, resources: [] },
    { schema_version: 2, fingerprint: 'other', index: 2, resources: [] },
    { schema_version: 3, fingerprint: 'current', index: 0, completed: ['unknown'], resources: [] },
    { schema_version: 3, fingerprint: 'current', index: 0, completed: [], resources: [resource('unknown')] }]) {
    assert.equal(restore(value), null, JSON.stringify(value))
  }
  assert.equal(restoreInitProgress('{invalid', 'current', steps), null)
  assert.equal(restoreInitProgress(JSON.stringify({ index: 1, resources: [] }), 'current', [{ name: 'required', required: true }]), null)
})
