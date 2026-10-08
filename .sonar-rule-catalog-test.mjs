import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listSonarProjectRules, parseAnalyzedLanguages } from './lib/sonar-rule-catalog.js'

test('project rule browser selects analyzed languages and pages only the selected effective profile', async () => {
  const requests = []
  const fetcher = async (url, options) => {
    requests.push({ url: new URL(url), authorization: options.headers.Authorization })
    const path = new URL(url).pathname
    const body = path.endsWith('/qualityprofiles/search') ? { profiles: [
      { key: 'other-js', name: 'Sonar way', language: 'js', activeRuleCount: 382 },
      { key: 'project-java', name: 'Routine Rule', language: 'java', activeRuleCount: 2 },
    ] } : path.endsWith('/measures/component') ? { component: { measures: [
      { metric: 'ncloc_language_distribution', value: 'java=100;xml=5' },
    ] } } : Number(new URL(url).searchParams.get('p')) === 1
      ? { total: 2, rules: [{ key: 'java:S100', name: 'One', severity: 'MAJOR' }] }
      : { total: 2, rules: [{ key: 'mycompany-java:Custom', name: 'Two', severity: 'MINOR' }] }
    return { ok: true, json: async () => body }
  }
  const view = await listSonarProjectRules('https://sonar.example', 'qms-key', 'secret', undefined, fetcher)
  assert.equal(view.selected_language, 'JAVA')
  assert.deepEqual(view.analyzed_languages, ['JAVA', 'XML'])
  assert.equal(view.rules.length, 2)
  assert.deepEqual(view.profiles.map(profile => [profile.language, profile.analyzed]), [['JAVA', true], ['JS', false]])
  assert.ok(requests.every(request => request.authorization === 'Bearer secret'))
  assert.equal(requests.find(request => request.url.pathname.endsWith('/qualityprofiles/search')).url.searchParams.get('project'), 'qms-key')
  assert.ok(requests.filter(request => request.url.pathname.endsWith('/rules/search'))
    .every(request => request.url.searchParams.get('qprofile') === 'project-java'
      && request.url.searchParams.get('activation') === 'true'))
  assert.equal(JSON.stringify(view).includes('secret'), false)
})

test('invalid project language cannot trigger a query for another profile', async () => {
  const fetcher = async url => ({ ok: true, json: async () => new URL(url).pathname.endsWith('/qualityprofiles/search')
    ? { profiles: [{ key: 'project-java', name: 'Routine Rule', language: 'java', activeRuleCount: 1 }] }
    : { component: { measures: [] } } })
  await assert.rejects(() => listSonarProjectRules('https://sonar.example', 'qms-key', 'secret', 'GO', fetcher),
    /没有 GO 的 Quality Profile/)
  assert.deepEqual(parseAnalyzedLanguages('java=120;xml=8;java=120'), ['JAVA', 'XML'])
})
