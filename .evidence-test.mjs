/**
 * Evidence kinds: a skill is judged against the proof it actually declares.
 *
 * Demanding a "real validation command" from every non-core skill forced an
 * irrelevant command from a requirement or design skill, whose output is a
 * document. The evidence existed — in another form.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { needsSkillReceipt, skillBlockers } from './lib/skill-audit.js'
import { adoptRecommendation, resolveFlow } from './lib/workflows.js'

/** A session that has loaded the named skills. */
function sessionWith(names) {
  const events = []
  for (const name of names) {
    const callId = 'c' + events.length
    events.push({ type: 'tool/call', data: { name: 'skill', callId, arguments: JSON.stringify({ name }) } })
    events.push({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: callId, isError: false }] } } })
  }
  return { id: 's', snapshotEvents: () => events }
}

/** A standard-flow config with one extra skill on 开发 carrying the given evidence. */
function withEvidence(evidence) {
  const adopted = adoptRecommendation('standard')
  const skills = [{ skill: { source: 'project', name: 'doc-skill' }, rules: [], ...(evidence !== undefined ? { evidence } : {}) }]
  return resolveFlow('standard', { ...adopted, stage_bindings: { ...adopted.stage_bindings, '开发': { skills } } }).config
}

/** A task at 开发 with everything else satisfied. */
function state(extra = {}) {
  return {
    schema: 1, id: 'E-1', title: 't', branch: 'main', work_size: 'standard', risk_level: 'standard',
    stage: '开发', execution_version: 1,
    requirement_confirmed: true, solution_confirmed: true,
    items: [], artifacts: {}, files: [], commits: [],
    verification: { passed: false, evidence: [] },
    review: { outcome: 'pending' },
    ...extra,
  }
}

test('evidence: needsSkillReceipt honours a declared non-command kind', () => {
  // No name-based exemption remains; a declared kind overrides the default.
  assert.equal(needsSkillReceipt('code-implement'), true, 'skill names do not exempt command evidence')
  assert.equal(needsSkillReceipt('doc-skill'), true, 'an undeclared extra skill defaults to a command receipt')
  assert.equal(needsSkillReceipt('doc-skill', 'command'), true)
  assert.equal(needsSkillReceipt('doc-skill', 'artifact'), false)
  assert.equal(needsSkillReceipt('doc-skill', 'review'), false)
  assert.equal(needsSkillReceipt('doc-skill', 'manual'), false)
  assert.equal(needsSkillReceipt('doc-skill', 'none'), false)
})

test('evidence: a document-producing skill is satisfied by a recorded artifact', () => {
  // The blocker is the point: without an artifact it blocks, and with one it does
  // not — so the declared kind is genuinely enforced rather than merely accepted.
  //
  // Mounted on 设计, which the adopted setup declares an artifact for. Missing
  // declarations and incomplete fields must both remain blockers.
  const adopted = adoptRecommendation('standard')
  const config = resolveFlow('standard', {
    ...adopted,
    stage_bindings: {
      ...adopted.stage_bindings,
      '设计': { skills: [{ skill: { source: 'project', name: 'doc-skill' }, rules: [], evidence: 'artifact' }] },
    },
  }).config
  const session = sessionWith(['doc-skill'])
  const atDesign = extra => ({ ...state({ stage: '设计', ...extra }) })

  const missing = skillBlockers(atDesign(), config, session)
  assert.ok(missing.some(b => b.includes('artifact evidence')),
    `an artifact-evidence skill must ask for an artifact; got ${JSON.stringify(missing)}`)
  assert.ok(!missing.some(b => b.includes('validation command')),
    'it must NOT ask for a shell command')

  // Record what the stage declares and the blocker clears.
  const declared = config.artifacts.find(artifact => artifact.stage === '设计')
  assert.ok(declared !== undefined, 'the standard flow declares an artifact at 设计')
  const cleared = skillBlockers(atDesign({ artifacts: { [declared.id]: Object.fromEntries(declared.fields.map(field => [field, 'checked'])) } }), config, session)
  assert.deepEqual(cleared.filter(b => b.includes('doc-skill')), [],
    'a recorded artifact satisfies artifact evidence')
})

test('evidence: a judging skill is satisfied by a passing review', () => {
  const config = withEvidence('review')
  const session = sessionWith(['code-implement', 'doc-skill'])
  assert.ok(skillBlockers(state(), config, session).some(b => b.includes('review evidence')),
    'no review recorded means the review evidence is absent')
  assert.deepEqual(
    skillBlockers(state({ review: { outcome: 'pass' } }), config, session).filter(b => b.includes('doc-skill')), [],
    'a passing review satisfies it')
})

test('evidence: manual evidence needs an explicit statement, none needs nothing', () => {
  const manual = withEvidence('manual')
  const session = sessionWith(['code-implement', 'doc-skill'])
  assert.ok(skillBlockers(state(), manual, session).some(b => b.includes('manual evidence')),
    'manual evidence is absent until something is recorded')
  const recorded = state({ skill_results: { '开发': { 'doc-skill': { evidence: ['reviewed by the lead'], approved: true } } } })
  assert.deepEqual(skillBlockers(recorded, manual, session).filter(b => b.includes('doc-skill')), [],
    'a recorded statement satisfies manual evidence')

  const none = withEvidence('none')
  assert.deepEqual(skillBlockers(state(), none, session).filter(b => b.includes('doc-skill')), [],
    'an advisory skill needs no proof beyond being loaded')
})

test('evidence: an undeclared extra skill still owes a command receipt', () => {
  // The historical behaviour must survive: a config that says nothing keeps getting
  // the command requirement, so existing setups are unaffected.
  const config = withEvidence(undefined)
  const session = sessionWith(['code-implement', 'doc-skill'])
  const blockers = skillBlockers(state(), config, session)
  assert.ok(blockers.some(b => b.includes('validation command')),
    `an undeclared skill must still owe a command receipt; got ${JSON.stringify(blockers)}`)
})
