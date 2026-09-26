/**
 * Catalog filtering: search and filters must narrow the list without ever hiding
 * something that is currently in force.
 *
 * The panel shows the configuration; a filter that hid a bound skill would make the
 * panel disagree with the config it is displaying, which is worse than a long list.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bindingsForStage, formatResourceRef } from './lib/engine.js'
import { adoptRecommendation, resolveFlow } from './lib/workflows.js'

/**
 * The filter the panel applies, lifted so it can be tested without a DOM.
 *
 * Mirrors `visibleSkills` in TaskEngineSection: an entry that is bound or shipped
 * always matches; otherwise the query must appear in its name, description or layer.
 */
function visibleSkills(catalog, binding, presetSkills, query, onlySelected) {
  const boundKeys = new Set((binding?.skills ?? []).map(entry => formatResourceRef(entry.skill)))
  const presetKeys = new Set(presetSkills.map(entry => formatResourceRef(entry.skill)))
  const needle = query.trim().toLowerCase()
  return catalog.filter(entry => {
    const raw = formatResourceRef(entry.ref)
    const inForce = boundKeys.has(raw) || presetKeys.has(raw)
    if (onlySelected && !inForce) return false
    if (needle === '') return true
    return inForce
      || entry.name.toLowerCase().includes(needle)
      || entry.description.toLowerCase().includes(needle)
      || entry.sourceLabel.toLowerCase().includes(needle)
  })
}

const catalog = [
  { ref: { source: 'bundled', name: 'code-implement' }, name: 'code-implement', description: '实现', sourceLabel: '内置' },
  { ref: { source: 'bundled', name: 'code-review' }, name: 'code-review', description: '评审变更', sourceLabel: '内置' },
  { ref: { source: 'project', name: 'api-audit' }, name: 'api-audit', description: '审计接口契约', sourceLabel: '项目' },
  { ref: { source: 'user', name: 'doc-writer' }, name: 'doc-writer', description: '写文档', sourceLabel: '用户' },
]
const binding = { skills: [{ skill: { source: 'project', name: 'api-audit' }, rules: [] }] }

test('filter: no query shows everything', () => {
  assert.equal(visibleSkills(catalog, binding, [], '', false).length, 4)
})

test('filter: the query narrows by name, description and layer', () => {
  // `api-audit` is bound in this fixture, so it stays visible whatever the query —
  // that rule is asserted separately, and these expectations include it.
  const names = (...args) => visibleSkills(...args).map(e => e.name).sort()
  assert.deepEqual(names(catalog, binding, [], 'writer', false), ['api-audit', 'doc-writer'],
    'name matches')
  assert.deepEqual(names(catalog, binding, [], '写文档', false), ['api-audit', 'doc-writer'],
    'description matches')
  assert.deepEqual(names(catalog, binding, [], '用户', false), ['api-audit', 'doc-writer'],
    'the layer label matches, so a user can list one layer')
  assert.deepEqual(names(catalog, binding, [], '审计', false), ['api-audit'],
    'a bound skill matching by its own description is shown')
  assert.deepEqual(names(catalog, binding, [], 'nothing-matches-this', false), ['api-audit'],
    'a query matching nothing still shows the skill that is in force')
})

test('filter: a BOUND skill is never hidden by the query', () => {
  // The panel shows the configuration. A search that hid a skill currently in force
  // would make the panel disagree with the config it is displaying.
  const shown = visibleSkills(catalog, binding, [], 'doc', false)
  assert.ok(shown.some(e => e.name === 'api-audit'),
    'the bound skill stays visible even though it does not match the query')
  assert.ok(shown.some(e => e.name === 'doc-writer'), 'and the matching one is shown too')
})

test('filter: only-selected keeps bound and preset skills, drops the rest', () => {
  const shown = visibleSkills(catalog, binding, [{ skill: { source: 'bundled', name: 'code-review' } }], '', true)
  const names = shown.map(e => e.name).sort()
  assert.deepEqual(names, ['api-audit', 'code-review'],
    'a bound skill and a preset-shipped one are both in force; the other two are not')
})

test('filter: only-selected combined with a query still keeps what is in force', () => {
  const shown = visibleSkills(catalog, binding, [], 'doc', true)
  assert.ok(shown.some(e => e.name === 'api-audit'),
    'the filter must not drop a bound skill even when a query is active')
  assert.ok(!shown.some(e => e.name === 'code-implement'), 'an unbound non-matching skill is dropped')
})

test('filter: a fresh project has no prebound business skill', () => {
  const adopted = adoptRecommendation('standard')
  const resolved = resolveFlow('standard', adopted).config
  const binding = bindingsForStage('开发', resolved)
  assert.equal(binding, undefined)
})
