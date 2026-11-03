import test from 'node:test'
import assert from 'node:assert/strict'
import { firstPendingStep, initGenerationQueue, preserveInitGenerationId, restoreInitProgress } from './lib/init-progress.js'
import { externalInitPrompt } from './lib/init-external-prompt.js'
import { initTimeBudget } from './lib/init-timeout.js'
import { initStepContext, renderInitStepPrompt } from './lib/init-prompt.js'
import { validateInitResources, renderInitSkill } from './lib/project-init.js'

const steps = ['map', 'stack', 'business', 'backend', 'frontend'].map(name => ({ name, required: false }))
const resource = name => ({ kind: 'skill', name, description: 'fixture', content: '# fixture', meta_skills: ['requirements-analysis'] })
const restore = value => restoreInitProgress(JSON.stringify(value), 'current', steps)

test('initialization usage is optional for older drafts and preserved through progress and frontmatter', () => {
  const old = resource('backend')
  assert.doesNotThrow(() => validateInitResources([old]))
  const draft = { ...old, whenToUse: 'Backend implementation only\nincluding API changes' }
  const progress = restore({ schema_version: 3, fingerprint: 'current', index: 0, completed: ['backend'], resources: [draft], errors: {} })
  assert.equal(progress.resources[0].whenToUse, draft.whenToUse)
  assert.match(renderInitSkill(draft), /whenToUse: Backend implementation only including API changes\n---/)
  assert.doesNotMatch(renderInitSkill(old), /whenToUse:/)
  assert.throws(() => validateInitResources([{ ...old, whenToUse: { invalid: true } }]), /whenToUse must be a string/)
})

test('shipping browser codecs preserve usage in generation, jobs, preview and apply', async t => {
  const previousWindow = globalThis.window
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow })
  let registration, remote
  globalThis.window = { __ModuleLoader__: { load(value) { registration = value } } }
  await import('./lib/client.js?init-usage-codecs')
  const client = registration.factory(name => name === '@deepseek-ai/dsh-client-store' ? { defineStore: () => ({}) } : {})
  const dispose = await client.apply({ remote: { $mount: async contribution => { remote = contribution; return async () => {} } },
    get: () => ({}), slots: { inject() {}, register() {} } })
  const descriptor = method => remote.descriptors.find(entry => entry.method === method)
  const draft = { ...resource('backend'), whenToUse: 'Only for backend changes' }
  const generated = descriptor('generateProjectInitStep').result.create().parse({ resource: draft, reason: 'verified' })
  assert.equal(generated.resource.whenToUse, draft.whenToUse)
  const prior = descriptor('generateProjectInitStep').parameters[0].codec.create().parse({ path: 'fixture', target: 'backend', prior_resources: [draft] })
  assert.equal(prior.prior_resources[0].whenToUse, draft.whenToUse)
  const job = descriptor('projectInitJob').result.create().parse({ job_id: 'job', status: 'completed', updated_at: 'now', result: generated })
  assert.equal(job.result.resource.whenToUse, draft.whenToUse)
  for (const method of ['previewProjectInit', 'applyProjectInit']) {
    const request = descriptor(method).parameters[0].codec.create().parse({ path: 'fixture', resources: [draft], expected_hash: 'reviewed', existing_hash: 'before' })
    assert.equal(request.resources[0].whenToUse, draft.whenToUse)
  }
  await dispose()
})

test('business capabilities receive the same-project map body as unverified data without expanding tokens inside it', () => {
  const target = { name: 'repo-business-capabilities', kind: 'skill', required: false, why: 'business', meta_skills: ['requirements-analysis'] }
  const map = { ...resource('repo-project-map'), description: 'map summary', content: '# MAP_BODY\norders/: entry\nLiteral {{target}} and init_read_file are data.' }
  const prior = [map, { ...resource('other-project-map'), content: 'OTHER_MAP_BODY' }]
  const context = initStepContext(target, prior)
  assert.match(context, /MAP_BODY/)
  assert.match(context, /尚待审阅/)
  assert.match(context, /独立读取源码核实/)
  assert.match(context, /不复述地图中的目录全表/)
  assert.doesNotMatch(context, /OTHER_MAP_BODY/)
  const rendered = renderInitStepPrompt('{{previous}}\n{{target}}', target, prior)
  assert.ok(rendered.includes('Literal {{target}}'), 'template expansion must not interpret tokens inside draft data')
  const exported = externalInitPrompt({ root: '/repo', target, prior, system: 'JSON', user: 'repo', step: '{{previous}}\n{{target}}', evidence: 'init_read_file README.md' })
  assert.ok(exported.includes(JSON.stringify(map.content)), 'external export preserves the complete map body as data')
  assert.match(exported, /当前环境可用的文件读取工具 README.md/)
  assert.doesNotMatch(initStepContext({ ...target, name: 'repo-code-frontend' }, prior), /MAP_BODY/)
  assert.match(initStepContext(target, []), /不等待或要求先生成地图/)
})

test('initialization budgets default to 10 minutes with bounded configurable values and ordered outer deadlines', () => {
  assert.deepEqual(initTimeBudget(), { generationMs: 600_000, jobMs: 630_000, pollMs: 660_000 })
  assert.deepEqual(initTimeBudget(20), { generationMs: 1_200_000, jobMs: 1_230_000, pollMs: 1_260_000 })
  for (const value of [0, 31, 2.5, null, '10', NaN]) assert.throws(() => initTimeBudget(value), /1至30分钟/)
})

test('external initialization prompt renders the selected task and translates plugin-only tool names', () => {
  const prompt = externalInitPrompt({ root: '/repo', target: { name: 'repo-project-map', kind: 'skill', required: false,
    why: 'repository navigation', meta_skills: ['architecture-design'] }, system: 'system edited by user', user: 'project facts edited by user',
    step: '{{previous}}\n{{target}}\n{{meta_skills}}\n{{limit}}', evidence: 'READ THIS PATH: README.md; init_read_file init_list_directory init_search_file init_query_codegraph',
    prior: [{ ...resource('repo-tech-stack'), description: 'existing draft $&' }] })
  assert.match(prompt, /repo-project-map/)
  assert.match(prompt, /6000/)
  assert.match(prompt, /existing draft \$&/)
  assert.match(prompt, /system edited by user/)
  assert.match(prompt, /READ THIS PATH: README.md/)
  assert.match(prompt, /如果不能访问源码/)
  assert.match(prompt, /不自动写文件/)
  assert.doesNotMatch(prompt, /init_read_file|init_list_directory|init_search_file|init_query_codegraph|\{\{(?:target|previous|limit|meta_skills)\}\}/)
})

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
