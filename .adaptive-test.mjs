import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { adaptiveWorkflow, COMPLEXITY_OPTIONS } from './lib/adaptive.js'
import { validateWorkflow } from './lib/engine.js'
import { registerDevTask } from './lib/dev-task.js'
import { inspectSonar } from './lib/sonar.js'
import Controller from './lib/controller.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-adaptive-'))
process.env.DSH_HOME = home
process.on('exit', () => rmSync(home, { recursive: true, force: true }))

function fixture(extra = {}) {
  const cwd = resolve('adaptive-project')
  const files = new Map([[join(cwd, 'package.json'), '{"name":"adaptive-project","dependencies":{"vue":"^2.7.0"}}'],
    [join(cwd, '.git/HEAD'), 'ref: refs/heads/feature'] , ...Object.entries(extra).map(([p, content]) => [join(cwd, p), content])])
  const events = []
  const session = { id: 'adaptive', header: { cwd }, snapshotEvents: () => events }
  const key = (path, options) => join(options?.cwd ?? cwd, path)
  let execute
  const fs = {
    resolve: async (path, options) => ({ path: key(path, options) }),
    readText: async target => files.get(target.path),
    lstat: async (path, options) => files.has(key(path, options)) ? { version: 'v1' } : undefined,
    writeText: async (target, content, intent) => {
      if (intent?.kind === 'createIfAbsent' && files.has(target.path)) throw new Error('already exists')
      files.set(target.path, content)
    },
    listDir: async target => [...new Set([...files.keys()].filter(path => path.startsWith(target.path + '\\'))
      .map(path => path.slice(target.path.length + 1).split('\\')[0]))].map(name => ({ name })),
  }
  const ctx = { fs, tools: { register(tool) { execute = tool.execute; return () => {} } }, get(name) {
    if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd, sessionId: session.id }) }
    return undefined
  } }
  registerDevTask(ctx)
  const exec = { agent: { session }, signal: new AbortController().signal }
  return { cwd, files, fs, events, call: args => execute(args, exec), state: id => JSON.parse(files.get(join(cwd, `.dsh/task-${id}.json`))) }
}

test('each task grade has a valid and increasing meta-skill sequence', () => {
  assert.deepEqual(COMPLEXITY_OPTIONS.map(option => option.id), ['low', 'medium', 'high', 'ultra'])
  const configs = COMPLEXITY_OPTIONS.map(option => adaptiveWorkflow(option.id))
  for (const config of configs) assert.deepEqual(validateWorkflow(config), [])
  assert.deepEqual(configs.map(config => config.stages.length), [4, 5, 6, 7])
  assert.ok(configs[2].stages.includes('任务编排'))
  assert.ok(configs[3].stages.includes('架构设计'))
  assert.ok(configs.every(config => config.transitions.some(edge => edge.requires?.includes('verified'))))
  assert.ok(configs.every(config => config.commit.checkpoints.includes('测试')))
})

test('adaptive task freezes a project override and its own Rules, not the bundled same-name Skill', async () => {
  const f = fixture({
    '.dsh/skills/requirements-analysis/SKILL.md': '# Project requirement method',
    '.dsh/skills/requirements-analysis/profile.json': JSON.stringify({ rules: [{ source: 'project', name: 'team-scope' }], evidence: 'artifact' }),
    '.dsh/rules/team-scope.md': '# Team scope rule',
    '.dsh/meta.json': JSON.stringify({ meta_bindings: { 'code-development': ['adaptive-project-project-map'] } }),
    '.dsh/skills/adaptive-project-project-map/SKILL.md': '# Project map',
    '.dsh/skills/adaptive-project-project-map/profile.json': JSON.stringify({ rules: [], evidence: 'none' }),
  })
  const preview = JSON.parse(await f.call({ operation: 'assess', complexity: 'high' }))
  assert.equal(preview.meta_skills['需求分析'][0].effective_source, 'project')
  assert.ok(preview.meta_skills['代码开发'].some(skill => skill.logical_name === 'adaptive-project-project-map'))
  await f.call({ operation: 'create', task_id: 'A-1', title: 'cross-module change', branch: 'feature',
    complexity: 'high', complexity_reason: 'Several implementation steps depend on earlier interfaces', files: ['app.js'] })
  const state = f.state('A-1')
  assert.equal(state.flow.flow, 'adaptive-high')
  assert.equal(state.flow.config.stage_bindings['需求分析'].skills[0].skill.source, 'project')
  assert.ok(state.flow.resources.some(entry => entry.ref.name === 'team-scope' && entry.ref.source === 'project'))
  assert.match(await f.call({ operation: 'load_skill', task_id: 'A-1', skill_name: 'project:requirements-analysis' }), /Project requirement method/)
  await assert.rejects(f.call({ operation: 'load_skill', task_id: 'A-1', skill_name: 'bundled:requirements-analysis' }), /exact source:name/)
})

test('init_project proposes project-specific Skills and binds reviewed resources', async () => {
  const f = fixture()
  const inventory = JSON.parse(await f.call({ operation: 'init_project', phase: 'inspect' }))
  assert.ok(inventory.suggestions.some(entry => entry.name === 'adaptive-project-project-map'))
  assert.ok(inventory.manifests.some(entry => entry.facts.includes('vue=^2.7.0')))
  const resources = [
    { kind: 'rule', name: 'component-boundary', content: 'Keep component boundary calls behind the existing service interface.' },
    { kind: 'skill', name: 'adaptive-project-project-map', description: 'Project structure and entry points',
      content: 'The root package.json declares Vue 2.7; inspect src for the actual component layout.',
      meta_skills: ['requirements-analysis', 'code-development'], rules: ['component-boundary'] },
  ]
  const proposed = JSON.parse(await f.call({ operation: 'init_project', phase: 'propose', resources }))
  assert.equal(f.files.has(join(f.cwd, '.dsh/meta.json')), false)
  await f.call({ operation: 'init_project', phase: 'apply', resources, expected_hash: proposed.expected_hash,
    existing_hash: proposed.existing_hash })
  const meta = JSON.parse(f.files.get(join(f.cwd, '.dsh/meta.json')))
  assert.deepEqual(meta.meta_bindings['code-development'], ['adaptive-project-project-map'])
  assert.ok(f.files.has(join(f.cwd, '.dsh/skills/adaptive-project-project-map/profile.json')))
})

test('workbench adaptive settings persist meta bindings with a version check', async () => {
  const f = fixture()
  const receiver = { authorizedPath: async path => path, fs: () => f.fs,
    listSkills: async () => ({ skills: [{ name: 'adaptive-project-project-map', source: 'project' }] }),
    readAdaptive: Controller.prototype.readAdaptive }
  const before = await Controller.prototype.readAdaptive.call(receiver, f.cwd)
  assert.equal(before.source, 'default')
  const config = { meta_bindings: { 'code-development': ['adaptive-project-project-map'] }, sonar: { enabled: false } }
  const after = await Controller.prototype.writeAdaptive.call(receiver,
    { path: f.cwd, config, expected_hash: before.hash })
  assert.equal(after.ok, true)
  assert.deepEqual(after.config.meta_bindings['code-development'], ['adaptive-project-project-map'])
  await assert.rejects(Controller.prototype.writeAdaptive.call(receiver,
    { path: f.cwd, config, expected_hash: before.hash }), /已被其他会话修改/)
})

test('Sonar audit reads the exact CI analysis gate and filters new-code medium/high findings', async () => {
  const calls = []
  const fetcher = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.Authorization })
    const body = String(url).includes('/ce/task')
      ? { task: { status: 'SUCCESS', analysisId: 'AN-1', componentKey: 'project' } }
      : String(url).includes('/qualitygates/project_status')
        ? { projectStatus: { status: 'ERROR' } }
        : { paging: { total: 2 }, issues: [
          { key: 'ISSUE-1', rule: 'java:S111', message: 'problem', severity: 'MAJOR', component: 'project:src/A.java', line: 3 },
          { key: 'ISSUE-2', rule: 'java:S222', message: 'minor', severity: 'MINOR', component: 'project:src/B.java' },
        ] }
    return { ok: true, json: async () => body }
  }
  const policy = { enabled: true, host_url: 'https://sonar.example', project_key: 'project', mode: 'branch', token_env: 'SONAR_TOKEN' }
  const audit = await inspectSonar(policy, 'secret-token', 'CE-TASK-123', 'feature', 'scope-hash', fetcher)
  assert.equal(audit.analysis_id, 'AN-1')
  assert.equal(audit.gate, 'ERROR')
  assert.deepEqual(audit.blocking.map(issue => issue.key), ['ISSUE-1'])
  assert.ok(calls[2].url.includes('inNewCodePeriod=true'))
  assert.ok(calls.every(call => call.authorization === 'Bearer secret-token'))
  assert.equal(JSON.stringify(audit).includes('secret-token'), false)
})

test('review-only Sonar gate blocks pass until the task records a passing CI analysis', async () => {
  const f = fixture({ '.dsh/meta.json': JSON.stringify({ sonar: { enabled: true, host_url: 'https://sonar.example',
    project_key: 'project', mode: 'branch', token_env: 'SONAR_TOKEN' } }) })
  await f.call({ operation: 'create', task_id: 'S-1', title: 'change', branch: 'feature', complexity: 'low',
    complexity_reason: 'One local change', files: ['app.js'], items: [{ id: 'one', title: 'change', status: 'done' }] })
  const state = f.state('S-1')
  state.stage = '代码审核'
  state.verification = { passed: true, evidence: ['verified'] }
  state.commits = [{ label: 'TASK', hash: 'abcdef1234567890' }]
  f.files.set(join(f.cwd, '.dsh/task-S-1.json'), JSON.stringify(state))
  await assert.rejects(f.call({ operation: 'review', task_id: 'S-1', outcome: 'pass' }), /SonarQube audit is enabled/)
  const oldFetch = globalThis.fetch
  const oldToken = process.env.SONAR_TOKEN
  process.env.SONAR_TOKEN = 'secret-token'
  globalThis.fetch = async url => ({ ok: true, json: async () => String(url).includes('/ce/task')
    ? { task: { status: 'SUCCESS', analysisId: 'AN-2', componentKey: 'project' } }
    : String(url).includes('/qualitygates/project_status') ? { projectStatus: { status: 'OK' } }
      : { paging: { total: 0 }, issues: [] } })
  try {
    await f.call({ operation: 'sonar_check', task_id: 'S-1', ce_task_id: 'CE-123456' })
    await f.call({ operation: 'review', task_id: 'S-1', outcome: 'pass' })
    assert.equal(f.state('S-1').review.outcome, 'pass')
  } finally {
    globalThis.fetch = oldFetch
    if (oldToken === undefined) delete process.env.SONAR_TOKEN
    else process.env.SONAR_TOKEN = oldToken
  }
})

test('a failed Sonar finding becomes a reviewed project Rule attached to the coding Skill', async () => {
  const f = fixture()
  await f.call({ operation: 'create', task_id: 'L-1', title: 'change', branch: 'feature', complexity: 'low',
    complexity_reason: 'One local change', files: ['app.js'] })
  const state = f.state('L-1')
  const finding = { key: 'ISSUE-9', rule: 'java:S999', message: 'Handle null', severity: 'MAJOR', file: 'A.java' }
  state.stage = '代码审核'
  state.sonar_audit = { ce_task_id: 'CE-123456', analysis_id: 'AN-9', gate: 'ERROR', checked_at: 'now',
    scope_hash: 'old', findings: [finding], blocking: [finding], target: 'feature' }
  f.files.set(join(f.cwd, '.dsh/task-L-1.json'), JSON.stringify(state))
  await f.call({ operation: 'revise', task_id: 'L-1', target_stage: '代码开发',
    revision_kind: 'defect', revision_reason: 'Fix the SonarQube issue' })
  assert.equal(f.state('L-1').sonar_history[0].blocking[0].key, 'ISSUE-9')
  const args = { operation: 'learn_rule', task_id: 'L-1', issue_key: 'ISSUE-9', skill_name: 'bundled:code-development',
    rule_name: 'handle-null-boundary', learning_reason: 'This boundary appears in several service methods',
    content: 'At a service boundary, check for null before dereferencing. Show the failing call and a guarded call in the review example.' }
  const proposal = JSON.parse(await f.call({ ...args, phase: 'propose' }))
  assert.equal(f.files.has(join(f.cwd, '.dsh/rules/handle-null-boundary.md')), false)
  await f.call({ ...args, phase: 'apply', expected_hash: proposal.expected_hash })
  assert.match(f.files.get(join(f.cwd, '.dsh/rules/handle-null-boundary.md')), /java:S999/)
  assert.ok(f.files.has(join(f.cwd, '.dsh/skills/code-development/SKILL.md')))
  assert.deepEqual(JSON.parse(f.files.get(join(f.cwd, '.dsh/skills/code-development/profile.json'))).rules,
    [{ source: 'project', name: 'handle-null-boundary' }])
})
