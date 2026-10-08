import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { adaptiveWorkflow, COMPLEXITY_OPTIONS } from './lib/adaptive.js'
import { validateWorkflow } from './lib/engine.js'
import { plannedItemIds, registerDevTask } from './lib/dev-task.js'
import { assertLocalSonarReady, inspectSonar, validLocalScanCommand } from './lib/sonar.js'
import Controller from './lib/controller.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-adaptive-'))
process.env.DSH_HOME = home
process.on('exit', () => rmSync(home, { recursive: true, force: true }))

function fixture(extra = {}, services = {}) {
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
    if (name in services) return services[name]
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
  const projectMap = inventory.suggestions.find(entry => entry.name === 'adaptive-project-project-map')
  assert.ok(projectMap)
  assert.ok(inventory.suggestions.some(entry => entry.name === 'adaptive-project-business-capabilities'))
  assert.match(projectMap.why, /entire repository/)
  assert.match(projectMap.why, /current feature request/)
  assert.match(inventory.caution, /repository-wide/)
  assert.ok(inventory.manifests.some(entry => entry.facts.includes('vue=^2.7.0')))
  const resources = [
    { kind: 'rule', name: 'component-boundary', content: 'Keep component boundary calls behind the existing service interface.' },
    { kind: 'skill', name: 'adaptive-project-project-map', description: 'Project structure and entry points',
      content: 'The root package.json declares Vue 2.7; inspect src for the actual component layout.',
      meta_skills: ['requirements-analysis', 'code-development'], rules: ['component-boundary'] },
  ]
  const proposed = JSON.parse(await f.call({ operation: 'init_project', phase: 'propose', resources }))
  assert.match(proposed.instruction, /whole repository/)
  assert.match(proposed.instruction, /current-feature details/)
  assert.equal(f.files.has(join(f.cwd, '.dsh/meta.json')), false)
  await f.call({ operation: 'init_project', phase: 'apply', resources, expected_hash: proposed.expected_hash,
    existing_hash: proposed.existing_hash })
  const meta = JSON.parse(f.files.get(join(f.cwd, '.dsh/meta.json')))
  assert.deepEqual(meta.meta_bindings['code-development'], ['adaptive-project-project-map'])
  assert.ok(f.files.has(join(f.cwd, '.dsh/skills/adaptive-project-project-map/profile.json')))
})

test('task-plan item headings preserve the full implementation sequence', async () => {
  assert.deepEqual(plannedItemIds('## Steps\n- I1 data model\n- I2 service\n### I3 UI\n- I2 service'), ['I1', 'I2', 'I3'])
  const f = fixture()
  await f.call({ operation: 'create', task_id: 'PLAN-1', title: 'Cross-module change', branch: 'feature',
    complexity: 'high', complexity_reason: 'Backend then frontend dependency' })
  const state = f.state('PLAN-1')
  state.stage = '任务编排'
  state.artifacts['task-plan'] = { steps: '- I1 model\n- I2 service', dependencies: 'I2 after I1', handoffs: 'Model to service' }
  state.items = [{ id: 'I2', title: 'service', status: 'todo' }]
  f.files.set(join(f.cwd, '.dsh/task-PLAN-1.json'), JSON.stringify(state))
  const status = JSON.parse(await f.call({ operation: 'status', task_id: 'PLAN-1' }))
  assert.match(status.task_plan_item_blockers[0], /I1/)
  await assert.rejects(f.call({ operation: 'advance', task_id: 'PLAN-1', target_stage: '代码开发' }), /I1/)
})

test('init_project rejects a feature-only project map that omits discovered modules', async () => {
  const f = fixture({
    'backend/pom.xml': '<project><properties><java.version>8</java.version></properties></project>',
    'frontend/package.json': '{"dependencies":{"vue":"^2.7.0"}}',
  })
  const draft = [{ kind: 'skill', name: 'adaptive-project-project-map',
    description: 'Reusable repository map', meta_skills: ['requirements-analysis', 'code-development'],
    content: '# Feature implementation\nThe root package.json and backend contain the feature API.' }]
  await assert.rejects(f.call({ operation: 'init_project', phase: 'propose', resources: draft }), /frontend/)
  draft[0].content = '# Repository map\nRoot package.json, backend/pom.xml and frontend/package.json define separate modules.'
  const proposed = JSON.parse(await f.call({ operation: 'init_project', phase: 'propose', resources: draft }))
  assert.deepEqual(proposed.project_map_coverage, ['backend', 'frontend', 'package.json'])
  await f.call({ operation: 'init_project', phase: 'apply', resources: draft,
    expected_hash: proposed.expected_hash, existing_hash: proposed.existing_hash })
  assert.ok(f.files.has(join(f.cwd, '.dsh/skills/adaptive-project-project-map/SKILL.md')))
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

test('IDE-style local Sonar settings save and move only that task commit after review', async () => {
  const sonar = { enabled: true, host_url: 'http://sonar.example', project_key: 'project',
    mode: 'branch', source: 'ide-local', reference_branch: 'main', token_env: 'SONAR_TOKEN' }
  const f = fixture()
  const receiver = { authorizedPath: async path => path, fs: () => f.fs,
    listSkills: async () => ({ skills: [] }), readAdaptive: Controller.prototype.readAdaptive }
  const before = await Controller.prototype.readAdaptive.call(receiver, f.cwd)
  const saved = await Controller.prototype.writeAdaptive.call(receiver,
    { path: f.cwd, config: { sonar }, expected_hash: before.hash })
  assert.equal(saved.ok, true)
  await f.call({ operation: 'create', task_id: 'L-1', title: 'local review', branch: 'feature',
    complexity: 'low', complexity_reason: 'Small isolated change', files: ['app.java'] })
  const state = f.state('L-1')
  assert.equal(state.sonar_policy.source, 'ide-local')
  assert.deepEqual(state.flow.config.commit.checkpoints, ['代码审核'])
})

test('local Sonar audit ignores failing old-code gate conditions', async () => {
  const policy = { enabled: true, host_url: 'https://sonar.example', project_key: 'project', mode: 'branch',
    token_env: 'SONAR_TOKEN', source: 'local', reference_branch: 'main' }
  const fetcher = async url => ({ ok: true, json: async () => String(url).includes('/ce/task')
    ? { task: { status: 'SUCCESS', analysisId: 'AN-local', componentKey: 'project', branch: 'feature' } }
    : String(url).includes('/qualitygates/project_status')
      ? { projectStatus: { status: 'ERROR', conditions: [
        { metricKey: 'bugs', status: 'ERROR' }, { metricKey: 'new_coverage', status: 'OK' }] } }
      : { paging: { total: 0 }, issues: [] } })
  const audit = await inspectSonar(policy, 'token', 'CE-local-123', 'feature', 'scope', fetcher, true)
  assert.equal(audit.gate, 'OK')
  assert.equal(audit.server_gate, 'ERROR')
  assert.deepEqual(audit.blocking, [])
  const newFailure = await inspectSonar(policy, 'token', 'CE-local-123', 'feature', 'scope',
    async url => String(url).includes('/qualitygates/project_status')
      ? { ok: true, json: async () => ({ projectStatus: { status: 'ERROR', conditions: [
        { metricKey: 'new_coverage', status: 'ERROR' }] } }) }
      : fetcher(url), true)
  assert.equal(newFailure.gate, 'ERROR')
})

test('local scanner configuration rejects shell operators before receiving the Token', () => {
  assert.equal(validLocalScanCommand('mvn org.sonarsource.scanner.maven:sonar-maven-plugin:5.5.0.6356:sonar -DskipTests'), true)
  assert.equal(validLocalScanCommand('mvn sonar:sonar; curl http://example'), false)
  assert.equal(validLocalScanCommand('mvn sonar:sonar -Dsonar.token=secret'), false)
  assert.equal(validLocalScanCommand('curl http://example'), false)
})

test('Community Sonar refuses a local branch scan before uploading any analysis', async () => {
  const policy = { enabled: true, host_url: 'https://sonar.example', project_key: 'project', mode: 'branch',
    token_env: 'SONAR_TOKEN', source: 'local', reference_branch: 'main' }
  const calls = []
  await assert.rejects(assertLocalSonarReady(policy, 'token', async url => {
    calls.push(String(url))
    return { ok: true, json: async () => ({ edition: 'community' }) }
  }), /Community Build supports only the main analysis branch/u)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /navigation\/global/u)
})

test('sonar_check runs a local scan on the recorded commit without pushing or exposing Token', async () => {
  const calls = []
  const shell = { resolve: request => request, run: async spec => {
    calls.push(spec)
    if (spec.command === 'git rev-parse HEAD') return { exitCode: 0, stdout: { text: 'abcdef1234567890\n' } }
    if (spec.command === 'git branch --show-current') return { exitCode: 0, stdout: { text: 'feature\n' } }
    if (spec.command === 'git status --porcelain --untracked-files=all') return { exitCode: 0, stdout: { text: '' } }
    const metadata = /-Dsonar\.scanner\.metadataFilePath='([^']+)'/u.exec(spec.command)?.[1]
    assert.ok(metadata)
    writeFileSync(metadata, 'ceTaskId=CE-local-456\n')
    return { exitCode: 0 }
  } }
  const f = fixture({ '.dsh/meta.json': JSON.stringify({ sonar: { enabled: true, host_url: 'https://sonar.example',
    project_key: 'project', mode: 'branch', source: 'local', reference_branch: 'main' } }) }, { shell })
  await f.call({ operation: 'create', task_id: 'LOCAL-1', title: 'change', branch: 'feature', complexity: 'low',
    complexity_reason: 'One local change', files: ['app.js'], items: [{ id: 'one', title: 'change', status: 'done' }] })
  const state = f.state('LOCAL-1')
  state.stage = '代码审核'
  state.verification = { passed: true, evidence: ['verified'] }
  state.commits = [{ label: 'TASK', hash: 'abcdef1234567890' }]
  f.files.set(join(f.cwd, '.dsh/task-LOCAL-1.json'), JSON.stringify(state))
  const oldFetch = globalThis.fetch
  const oldToken = process.env.SONAR_TOKEN
  const oldHost = process.env.DSH_SONAR_TRUSTED_HOST
  const oldKey = process.env.DSH_SONAR_TRUSTED_PROJECT_KEY
  process.env.SONAR_TOKEN = 'private-token'
  process.env.DSH_SONAR_TRUSTED_HOST = 'https://sonar.example'
  process.env.DSH_SONAR_TRUSTED_PROJECT_KEY = 'project'
  globalThis.fetch = async url => ({ ok: true, json: async () => String(url).includes('/navigation/global')
    ? { edition: 'developer' }
    : String(url).includes('/project_branches/list') ? { branches: [{ name: 'main' }] }
      : String(url).includes('/ce/task')
    ? { task: { status: 'SUCCESS', analysisId: 'AN-local', componentKey: 'project', branch: 'feature' } }
    : String(url).includes('/qualitygates/project_status')
      ? { projectStatus: { status: 'ERROR', conditions: [{ metricKey: 'bugs', status: 'ERROR' }] } }
      : { paging: { total: 0 }, issues: [] } })
  try {
    const result = JSON.parse(await f.call({ operation: 'sonar_check', task_id: 'LOCAL-1' }))
    assert.equal(result.gate, 'OK')
    assert.equal(result.server_gate, 'ERROR')
    assert.equal(calls.length, 4)
    assert.equal(calls[3].env.SONAR_TOKEN, 'private-token')
    assert.equal(calls[3].command.includes('private-token'), false)
    assert.match(calls[3].command, /sonar\.newCode\.referenceBranch='main'/u)
    assert.equal(JSON.stringify(f.state('LOCAL-1')).includes('private-token'), false)
    assert.equal(calls.some(call => /git push/u.test(call.command)), false)
  } finally {
    globalThis.fetch = oldFetch
    if (oldToken === undefined) delete process.env.SONAR_TOKEN
    else process.env.SONAR_TOKEN = oldToken
    if (oldHost === undefined) delete process.env.DSH_SONAR_TRUSTED_HOST
    else process.env.DSH_SONAR_TRUSTED_HOST = oldHost
    if (oldKey === undefined) delete process.env.DSH_SONAR_TRUSTED_PROJECT_KEY
    else process.env.DSH_SONAR_TRUSTED_PROJECT_KEY = oldKey
  }
})

test('review-only Sonar gate blocks pass until the task records CI analysis of new code', async () => {
  const f = fixture({ '.dsh/meta.json': JSON.stringify({ sonar: { enabled: true, host_url: 'https://sonar.example',
    project_key: 'project', mode: 'branch', source: 'ci', token_env: 'SONAR_TOKEN' } }) })
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
  const oldHost = process.env.DSH_SONAR_TRUSTED_HOST
  const oldKey = process.env.DSH_SONAR_TRUSTED_PROJECT_KEY
  process.env.SONAR_TOKEN = 'secret-token'
  process.env.DSH_SONAR_TRUSTED_HOST = 'https://sonar.example'
  process.env.DSH_SONAR_TRUSTED_PROJECT_KEY = 'project'
  globalThis.fetch = async url => ({ ok: true, json: async () => String(url).includes('/ce/task')
    ? { task: { status: 'SUCCESS', analysisId: 'AN-2', componentKey: 'project' } }
    : String(url).includes('/qualitygates/project_status') ? { projectStatus: { status: 'ERROR',
      conditions: [{ metricKey: 'bugs', status: 'ERROR' }, { metricKey: 'new_coverage', status: 'OK' }] } }
      : { paging: { total: 0 }, issues: [] } })
  try {
    const check = JSON.parse(await f.call({ operation: 'sonar_check', task_id: 'S-1', ce_task_id: 'CE-123456' }))
    assert.equal(check.gate, 'OK')
    assert.equal(check.server_gate, 'ERROR')
    assert.match(check.report_path, /^\.dsh\/reviews\/S-1\//)
    assert.match(f.files.get(join(f.cwd, check.report_path)), /SonarQube 代码审核/)
    assert.equal(f.state('S-1').sonar_audit.report_path, check.report_path)
    await f.call({ operation: 'review', task_id: 'S-1', outcome: 'pass' })
    assert.equal(f.state('S-1').review.outcome, 'pass')
  } finally {
    globalThis.fetch = oldFetch
    if (oldToken === undefined) delete process.env.SONAR_TOKEN
    else process.env.SONAR_TOKEN = oldToken
    if (oldHost === undefined) delete process.env.DSH_SONAR_TRUSTED_HOST
    else process.env.DSH_SONAR_TRUSTED_HOST = oldHost
    if (oldKey === undefined) delete process.env.DSH_SONAR_TRUSTED_PROJECT_KEY
    else process.env.DSH_SONAR_TRUSTED_PROJECT_KEY = oldKey
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
  assert.equal(JSON.parse(await f.call({ operation: 'status', task_id: 'L-1' })).rule_learning_candidates[0].rule, 'java:S999')
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
  assert.deepEqual(JSON.parse(await f.call({ operation: 'status', task_id: 'L-1' })).rule_learning_candidates, [])
})

test('new Sonar projects default to pre-commit review against HEAD', async () => {
  const f = fixture({ '.dsh/meta.json': JSON.stringify({ sonar: { enabled: true,
    host_url: 'https://sonar.example', project_key: 'project' } }) })
  await f.call({ operation: 'create', task_id: 'PRE-1', title: 'new code', branch: 'feature',
    complexity: 'low', complexity_reason: 'Small change', files: ['app.java'] })
  assert.equal(f.state('PRE-1').sonar_policy.source, 'ide-local')
  assert.equal(f.state('PRE-1').sonar_policy.reference_branch, 'HEAD')
})

test('workbench initializes reviewed project resources directly and preserves Sonar settings', async () => {
  const f = fixture({
    'backend/pom.xml': '<project><properties><java.version>8</java.version></properties></project>',
    'frontend/package.json': '{"dependencies":{"vue":"^2.7.0"}}',
    '.dsh/meta.json': JSON.stringify({ sonar: { enabled: false, project_key: 'keep-me' } }),
  })
  const resources = [
    { kind: 'rule', name: 'backend-convention', content: 'Use the backend module Maven Java 8 build for backend changes.' },
    { kind: 'skill', name: 'adaptive-project-project-map', description: 'Reusable repository map',
      content: 'Root package.json, backend/pom.xml and frontend/package.json define the backend and frontend modules.',
      meta_skills: ['requirements-analysis', 'code-development'], rules: ['backend-convention'] },
  ]
  const receiver = {
    authorizedPath: async path => path, fs: () => f.fs, listSkills: async () => ({ skills: [] }),
    projectInitRoot: Controller.prototype.projectInitRoot,
    previewProjectInit: Controller.prototype.previewProjectInit,
    ctx: { get(name) {
      if (name === 'llm') return { async *stream() { yield { type: 'text-delta', text: JSON.stringify({ resources }) } } }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test' }) }
    } },
  }
  const draft = await Controller.prototype.generateProjectInit.call(receiver, { path: f.cwd })
  assert.deepEqual(draft.project_map_coverage, ['backend', 'frontend', 'package.json'])
  assert.equal(f.files.has(join(f.cwd, '.dsh/rules/backend-convention.md')), false)
  await assert.rejects(Controller.prototype.applyProjectInit.call(receiver,
    { path: f.cwd, resources: draft.resources, expected_hash: 'stale', existing_hash: draft.existing_hash }), /改变/)
  const applied = await Controller.prototype.applyProjectInit.call(receiver,
    { path: f.cwd, resources: draft.resources, expected_hash: draft.expected_hash, existing_hash: draft.existing_hash })
  assert.equal(applied.ok, true)
  assert.equal(f.files.get(join(f.cwd, '.dsh/meta.json')).includes('keep-me'), true)
  assert.equal(JSON.parse(f.files.get(join(f.cwd, '.dsh/meta.json'))).meta_bindings['code-development'][0],
    'adaptive-project-project-map')
  assert.ok(f.files.has(join(f.cwd, '.dsh/skills/adaptive-project-project-map/SKILL.md')))
  await assert.rejects(Controller.prototype.previewProjectInit.call(receiver,
    { path: f.cwd, resources }), /不能覆盖/)
})

test('a local false positive needs human approval, keeps the raw gate, and expires after code changes', async () => {
  let allow = false
  const approvals = []
  const shell = { resolve: request => request, execute: async () => ({ result: async () => ({
    exitCode: 0, timedOut: false, aborted: false, stdout: { text: 'checks passed' }, stderr: { text: '' },
  }) }) }
  const f = fixture({ '.dsh/meta.json': JSON.stringify({ sonar: { enabled: true,
    host_url: 'https://sonar.example', project_key: 'project', mode: 'branch', source: 'ide-local',
    reference_branch: 'main' } }) }, { shell,
    approval: { request: async request => { approvals.push(request); return allow ? 'allowed-once' : 'rejected' } } })
  await f.call({ operation: 'create', task_id: 'FP-1', title: 'one local finding', branch: 'feature',
    complexity: 'low', complexity_reason: 'Local correction', files: ['app.js'] })
  await f.call({ operation: 'verify', task_id: 'FP-1', command: 'check' })
  const state = f.state('FP-1')
  state.stage = '代码审核'
  const finding = { key: 'local-fp-1', rule: 'mycompany-java:AvoidObjectCreationInLoop',
    message: 'Avoid allocation', severity: 'MAJOR', file: 'app.js', line: 3 }
  state.sonar_audit = { ce_task_id: 'local', analysis_id: 'LOCAL-1', gate: 'ERROR',
    checked_at: '2026-10-05T00:00:00.000Z', scope_hash: state.verification.receipt.scope_hash,
    findings: [finding], blocking: [finding], target: 'main', scanned_files: ['app.js'],
    report_path: '.dsh/reviews/FP-1/local.md' }
  f.files.set(join(f.cwd, '.dsh/reviews/FP-1/local.md'), 'original report')
  f.files.set(join(f.cwd, '.dsh/task-FP-1.json'), JSON.stringify(state))
  const args = { operation: 'sonar_disposition', task_id: 'FP-1', issue_key: finding.key,
    disposition_reason: '每次循环需要独立实体对象，复用同一个实例会让多条授权记录互相覆盖，属于规则误报。',
    evidence: ['授权实体逐行添加到集合，复用对象会导致所有行指向末次值'] }
  await assert.rejects(f.call(args), /not approved/)
  assert.equal(f.state('FP-1').sonar_audit.dispositions, undefined)
  allow = true
  const result = JSON.parse(await f.call(args))
  assert.equal(result.raw_gate, 'ERROR')
  assert.equal(result.review_gate, 'OK')
  assert.equal(f.state('FP-1').sonar_audit.dispositions.length, 1)
  assert.deepEqual(JSON.parse(await f.call({ operation: 'status', task_id: 'FP-1' })).rule_learning_candidates, [])
  assert.match(approvals.at(-1).reason, /local-fp-1/)
  assert.match(f.files.get(join(f.cwd, state.sonar_audit.report_path)), /逐项误报复核/)
  await f.call({ operation: 'review', task_id: 'FP-1', outcome: 'pass' })
  await assert.rejects(f.call({ operation: 'learn_rule', task_id: 'FP-1', issue_key: finding.key }), /blocking issue_key/)
  f.files.set(join(f.cwd, 'app.js'), 'new source')
  await assert.rejects(f.call({ operation: 'review', task_id: 'FP-1', outcome: 'pass' }), /stale/)
})
