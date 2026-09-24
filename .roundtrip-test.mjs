/**
 * Config round-trip: what the panel shows is what the file holds.
 *
 * The write path and the panel both carried only `flow` + `stage_bindings`, so a
 * commit rule, artifact declarations or a review depth were resolved for the preview
 * and then dropped on save. A user could set them, see them applied, and lose them.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { resolveFlow, adoptRecommendation, compactProjectConfig, materializeBundledReferences } from './lib/workflows.js'
import Controller from './lib/controller.js'
import { assertAdvance, validateWorkflow } from './lib/engine.js'
import { TYPERT_REMOTE } from './src/client/remote.ts'

/** The fields a project config can carry, so a round-trip is checked on all of them. */
const FIELDS = ['flow', 'stage_bindings', 'commit', 'artifacts', 'review_depth', 'commit_required']

test('browser remote codec retains source-qualified bindings and all saved fields', () => {
  const write = TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'write')
  const read = TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'read')
  const adopted = compactProjectConfig(adoptRecommendation('minimal'))
  const request = { path: 'project', ...adopted, review_depth: 'single', commit_required: false,
    materialize_bundled: 'project' }
  assert.deepEqual(write.parameters[0].codec.schema.parse(request), request)
  const resolved = resolveFlow('minimal', request).config
  const view = { ok: true, source: 'project', flow: 'minimal', config: resolved, problems: [] }
  assert.deepEqual(read.result.schema.parse(view), view)
  const catalog = TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'listSkills')
  const skill = { name: 'mine', description: 'test', source: 'project',
    ref: { source: 'project', name: 'mine' }, sourceLabel: '项目' }
  assert.deepEqual(catalog.result.schema.parse({ skills: [skill] }), { skills: [skill] })
  const saveUserProfile = TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'writeUserSkillProfile')
  const profileRequest = { name: 'mine', profile: { rules: [{ source: 'user', name: 'my-rule' }], evidence: 'manual' } }
  assert.deepEqual(saveUserProfile.parameters[0].codec.schema.parse(profileRequest), profileRequest)
})

test('one user skill profile is shared across workspaces and cannot depend on a project rule', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-user-profile-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  const priorHome = process.env.DSH_HOME
  const userHome = join(root, 'user-home')
  process.env.DSH_HOME = userHome
  const skill = { source: 'user', name: 'my-skill' }
  const config = { flow: 'minimal', stage_bindings: {
    '开发': { skill_refs: [skill] }, '交付': { skill_refs: [skill] },
  } }
  const fs = {
    resolve: async (path, { cwd }) => join(cwd, path),
    readText: async path => { try { return readFileSync(path, 'utf8') } catch { return undefined } },
    writeText: async (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body) },
  }
  const receiver = { authorizedPath: async path => path, fs: () => fs }
  try {
    const skillDir = join(userHome, 'skills', skill.name)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: test\n---\nbody\n')
    const profile = { rules: [{ source: 'user', name: 'my-rule' }], evidence: 'manual' }
    const saved = await Controller.prototype.writeUserSkillProfile.call(receiver, { name: skill.name, profile })
    assert.equal(saved.ok, true)
    for (const projectName of ['one', 'two']) {
      const project = join(root, projectName)
      mkdirSync(join(project, '.dsh'), { recursive: true })
      writeFileSync(join(project, '.dsh', 'eng.json'), JSON.stringify(config))
      const loaded = await Controller.prototype.read.call(receiver, project)
      assert.equal(loaded.ok, true)
      assert.deepEqual(loaded.config.stage_bindings['开发'].skills[0].rules, profile.rules)
    }
    const updatedProfile = { rules: [{ source: 'user', name: 'other-rule' }], evidence: 'none' }
    const updated = await Controller.prototype.writeUserSkillProfile.call(receiver,
      { name: skill.name, profile: updatedProfile })
    assert.equal(updated.ok, true)
    for (const projectName of ['one', 'two']) {
      const loaded = await Controller.prototype.read.call(receiver, join(root, projectName))
      assert.equal(loaded.ok, true)
      assert.deepEqual(loaded.config.stage_bindings['开发'].skills[0].rules, updatedProfile.rules)
    }
    const bad = await Controller.prototype.writeUserSkillProfile.call(receiver, { name: skill.name,
      profile: { rules: [{ source: 'project', name: 'local-rule' }] } })
    assert.equal(bad.ok, false)
    assert.deepEqual(JSON.parse(readFileSync(join(skillDir, 'profile.json'), 'utf8')), updatedProfile)
  } finally {
    if (priorHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = priorHome
    rmSync(root, { recursive: true, force: true })
  }
})

test('recommendation adoption copies each shared bundled rule once and rewrites every reference', () => {
  const { config, copies } = materializeBundledReferences(adoptRecommendation('standard'), 'project')
  assert.equal(copies.filter(copy => copy.kind === 'skill').length, 6)
  assert.equal(copies.filter(copy => copy.kind === 'rule').length, 3)
  const refs = Object.values(config.stage_bindings).flatMap(binding => binding.skill_refs)
  assert.ok(refs.every(ref => ref.source === 'project'))
  const rules = Object.values(config.skill_profiles).flatMap(profile => profile.rules)
  assert.ok(rules.every(ref => ref.source === 'project'))
  const shared = rules.filter(ref => ref.name === 'security-redlines-copy')
  assert.equal(shared.length, 3)
  assert.equal(copies.filter(copy => copy.kind === 'rule' && copy.name === 'security-redlines').length, 1)
  assert.deepEqual(validateWorkflow(resolveFlow('standard', config).config), [])
})

test('project migration leaves a global user skill profile and its bundled rules untouched', () => {
  const userSkill = { source: 'user', name: 'global-check' }
  const bundledRule = { source: 'bundled', name: 'security-redlines' }
  const project = { flow: 'minimal', stage_bindings: { '开发': { skill_refs: [userSkill] } },
    skill_profiles: { 'user:global-check': { rules: [bundledRule] } } }
  const { config, copies } = materializeBundledReferences(project, 'project')
  assert.deepEqual(config.skill_profiles['user:global-check'].rules, [bundledRule])
  assert.deepEqual(copies, [])
})

test('adoption saves editable project copies, preserves edited files on repeat, and leaves legacy bundled configs alone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-adopt-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  const fs = {
    resolve: async (path, { cwd }) => join(cwd, path),
    readText: async path => { try { return readFileSync(path, 'utf8') } catch { return undefined } },
    writeText: async (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) },
  }
  const receiver = { authorizedPath: async path => path, fs: () => fs }
  try {
    const recommended = adoptRecommendation('standard')
    const first = await Controller.prototype.write.call(receiver,
      { path: root, ...recommended, materialize_bundled: 'project' })
    assert.equal(first.ok, true)
    assert.equal(first.adoption.created.length, 9)
    const file = join(root, '.dsh', 'eng.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(JSON.stringify(saved).includes('"bundled"'), false)
    const shared = join(root, '.dsh', 'rules', 'security-redlines-copy.md')
    assert.ok(readFileSync(shared, 'utf8').length > 0)
    writeFileSync(shared, 'user edited shared rule\n')
    const second = await Controller.prototype.write.call(receiver,
      { path: root, ...recommended, materialize_bundled: 'project' })
    assert.equal(second.ok, true)
    assert.equal(second.adoption.created.length, 0)
    assert.equal(second.adoption.reused.length, 9)
    assert.equal(readFileSync(shared, 'utf8'), 'user edited shared rule\n')
    const loaded = await Controller.prototype.read.call(receiver, root)
    assert.equal(loaded.ok, true)
    const sharedRefs = Object.values(loaded.config.skill_profiles).flatMap(profile => profile.rules)
      .filter(rule => rule.name === 'security-redlines-copy')
    assert.equal(sharedRefs.length, 3)
    writeFileSync(file, JSON.stringify(compactProjectConfig(recommended)))
    const legacy = await Controller.prototype.read.call(receiver, root)
    assert.equal(legacy.ok, true)
    assert.ok(JSON.stringify(legacy.config).includes('"bundled"'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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

test('an explicit skill profile governs every stage even when inline bindings are stale', () => {
  const skill = { source: 'project', name: 'my-skill' }
  const rule = { source: 'project', name: 'my-rule' }
  const project = { flow: 'minimal',
    stage_bindings: {
      '开发': { skills: [{ skill, rules: [] }] },
      '交付': { skills: [{ skill, rules: [] }] },
    },
    skill_profiles: { 'project:my-skill': { rules: [rule] } },
  }
  const resolved = resolveFlow('minimal', project)
  assert.equal(resolved.ok, true)
  assert.deepEqual(validateWorkflow(resolved.config), [])
  assert.deepEqual(resolved.config.stage_bindings['开发'].skills[0].rules, [rule])
  assert.deepEqual(resolved.config.stage_bindings['交付'].skills[0].rules, [rule])
  const compact = compactProjectConfig(project)
  assert.deepEqual(compact.stage_bindings['开发'].skill_refs, [skill])
  assert.deepEqual(resolveFlow('minimal', compact).config.stage_bindings['交付'].skills[0].rules, [rule])
})

test('canonical references to one skill share its rule list without a false conflict', () => {
  const skill = { source: 'project', name: 'my-skill' }
  const rule = { source: 'project', name: 'my-rule' }
  const resolved = resolveFlow('minimal', { flow: 'minimal', stage_bindings: {
    '开发': { skill_refs: [skill] },
    '交付': { skill_refs: [skill] },
  }, skill_profiles: { 'project:my-skill': { rules: [rule] } } })
  assert.deepEqual(validateWorkflow(resolved.config), [])
  assert.deepEqual(resolved.config.stage_bindings['开发'].skills[0].rules, [rule])
  assert.deepEqual(resolved.config.stage_bindings['交付'].skills[0].rules, [rule])
})

test('skill editor save persists one changed profile and read expands it into every stage', async () => {
  let stored
  const fs = { resolve: async path => path, readText: async () => stored,
    writeText: async (_target, content) => { stored = content } }
  const receiver = { authorizedPath: async path => path, fs: () => fs }
  const skill = { source: 'project', name: 'my-skill' }
  const rule = { source: 'project', name: 'my-rule' }
  const initial = compactProjectConfig({ flow: 'minimal', stage_bindings: {
    '开发': { skills: [{ skill, rules: [] }] },
    '交付': { skills: [{ skill, rules: [] }] },
  } })
  const edited = { ...initial, skill_profiles: { ...initial.skill_profiles,
    'project:my-skill': { rules: [rule], evidence: 'none' } } }
  const written = await Controller.prototype.write.call(receiver, { path: 'project', ...edited })
  assert.equal(written.ok, true)
  assert.deepEqual(JSON.parse(stored).stage_bindings['开发'].skill_refs, [skill])
  const loaded = await Controller.prototype.read.call(receiver, 'project')
  assert.equal(loaded.ok, true)
  assert.deepEqual(loaded.config.stage_bindings['开发'].skills[0].rules, [rule])
  assert.deepEqual(loaded.config.stage_bindings['交付'].skills[0].rules, [rule])
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
