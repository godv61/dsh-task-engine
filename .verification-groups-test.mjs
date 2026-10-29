import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { registerDevTask, verificationInputHashes } from './lib/dev-task.js'
import { groupEvidenceBlockers, latestGroupRun, receiptProblems, verificationKey } from './lib/verification-state.js'
import { hashConfig, hashText } from './lib/snapshot.js'

const command = side => `node --test --experimental-test-isolation=none --test-reporter=tap ${side}.test.mjs`

test('shipped browser strict codec preserves grouped evidence and environment-blocked ledger states', async () => {
  let registration, contribution
  runInNewContext(readFileSync('lib/client.js', 'utf8'), { window: { __ModuleLoader__: { load(value) { registration = value } } } })
  const require = createRequire(import.meta.url)
  const client = registration.factory(name => name === 'react' || name === 'react/jsx-runtime' ? require(name) : {})
  const captured = new Error('remote captured before mounting UI')
  await assert.rejects(client.apply({ remote: { $mount: async value => { contribution = value; throw captured } } }), error => error === captured)
  const remote = contribution.descriptors.find(method => method.method === 'readTasks')
  const task = { task_id: 'BLOCKED', title: 'Grouped check', stage: '代码开发', branch: 'fixture', items: [],
    evidence_status: 'blocked', lifecycle: 'active', complexity: 'medium', items_done: 0, next_action: 'Inspect command access',
    verification_groups: [{ id: 'be', command: command('be'), status: 'blocked', test_count: 0,
      checked_at: '2026-10-24T09:00:00.000Z', problems: ['ENVIRONMENT_BLOCKED: spawn EPERM'] }] }
  const parsed = remote.result.create().parse({ tasks: [task] })
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), { tasks: [task] })
  task.evidence_status = 'valid'; task.verification_groups[0].status = 'passed'; task.verification_groups[0].test_count = 2; task.verification_groups[0].problems = []
  assert.deepEqual(JSON.parse(JSON.stringify(remote.result.create().parse({ tasks: [task] }))), { tasks: [task] })
})
async function fixture({ dependencies = [], shared = false, planned = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'task-verification-groups-'))
  for (const side of ['be', 'fe']) {
    writeFileSync(join(root, `${side}.mjs`), 'export const value = 2\n')
    writeFileSync(join(root, `${side}.json`), '{"setting":true}\n')
    writeFileSync(join(root, `${side}.test.mjs`), `import{test}from'node:test';import assert from'node:assert/strict';import{value}from'./${side}.mjs';test('${side} acceptance',()=>{assert.equal(value,2);assert.equal(process.env.FORCE_TEST_FAILURE??'0','0')})\n`)
  }
  writeFileSync(join(root, 'shared.json'), '{}\n')
  const fs = {
    resolve: async (file, opts) => ({ key: join(opts?.cwd ?? root, file) }),
    readText: async target => { try { return readFileSync(target.key, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error } },
    lstat: async (file, opts) => { try { const info = lstatSync(join(opts?.cwd ?? root, file)); return { type: info.isFile() ? 'file' : 'directory', version: `${info.mtimeMs}:${info.size}` } } catch (error) { if (error.code !== 'ENOENT') throw error } },
    writeText: async (target, content) => { mkdirSync(dirname(target.key), { recursive: true }); writeFileSync(target.key, content) },
  }
  let execute, failNext = false
  const commands = [], events = []
  const ctx = { fs, tools: { register(tool) { execute = tool.execute } }, get(name) {
    if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) }
    if (name === 'shell') return { resolve: input => input, run: async spec => {
      commands.push(spec.command)
      const env = { ...process.env, FORCE_TEST_FAILURE: failNext ? '1' : '0' }; failNext = false; delete env.NODE_TEST_CONTEXT
      const result = spawnSync(process.execPath, spec.command.split(' ').slice(1), { cwd: spec.workdir, encoding: 'utf8', env })
      return { exitCode: result.status, timedOut: false, aborted: false, stdout: { text: result.stdout }, stderr: { text: result.stderr }, sandbox: { mode: 'workspace-write', denied: false } }
    } }
  } }
  registerDevTask(ctx)
  const session = { id: 'group-fixture', header: { cwd: root }, snapshotEvents: () => events }
  const call = args => execute({ task_id: 'GROUPS', ...args }, { agent: { session }, signal: new AbortController().signal })
  const path = join(root, '.dsh/task-GROUPS.json')
  const state = () => JSON.parse(readFileSync(path, 'utf8'))
  const save = value => writeFileSync(path, JSON.stringify(value))
  await call({ operation: 'create', title: 'two complete units', branch: 'fixture', complexity: 'medium', complexity_reason: 'two local units',
    files: ['be.mjs', 'be.test.mjs', 'fe.mjs', 'fe.test.mjs'], items: [{ id: 'BE', title: 'backend + tests' }, { id: 'FE', title: 'frontend + tests' }] })
  const initial = state(); initial.stage = '代码开发'; save(initial)
  for (const [id, side] of [['BE', 'be'], ['FE', 'fe']]) {
    await call({ operation: 'plan_execution', item_id: id, task_boundary: 'local', execution_reason: 'complete local implementation and its test',
      files: [`${side}.mjs`, `${side}.test.mjs`], acceptance: ['value is 2 and real test passes'], depends_on: id === 'FE' ? dependencies : [] })
    if (planned) await call({ operation: 'plan_verification', verification_group: side, item_ids: [id], command: command(side),
      files: [`${side}.mjs`, `${side}.test.mjs`, `${side}.json`, ...(shared ? ['shared.json'] : [])] })
  }
  const verify = side => call({ operation: 'verify', verification_group: side })
  const finish = async id => {
    await call({ operation: 'dispatch', item_id: id })
    await call({ operation: 'review_item', item_id: id, spec_outcome: 'pass', quality_outcome: 'pass' })
    await call({ operation: 'items', items: [{ id, status: 'done' }] })
  }
  const hashes = () => verificationInputHashes(fs, state(), root)
  return { root, call, state, save, verify, finish, hashes, commands, failNext() { failNext = true },
    edit(file, content) { writeFileSync(join(root, file), content) } }
}

test('complete units require declared test groups before dispatch and verification', async () => {
  const f = await fixture({ planned: false })
  await assert.rejects(f.call({ operation: 'dispatch', item_id: 'BE' }), /plan_verification/)
  await assert.rejects(f.call({ operation: 'verify', command: command('be') }), /plan_verification/)
  assert.equal(f.commands.length, 0)
})

test('a known Maven compile-only or skip-tests plan fails before any command or plan mutation', async () => {
  const f = await fixture(), key = f.state().verification_groups.be.key
  for (const command of ['mvn -o -pl app -am -DskipTests compile', 'mvn test -DskipTests=true', 'mvnw.cmd verify -Dmaven.test.skip=true']) {
    await assert.rejects(f.call({ operation: 'plan_verification', verification_group: 'be', item_ids: ['BE'],
      files: ['be.mjs', 'be.test.mjs'], command }), /TEST_PLAN_REQUIRES_TESTS/)
  }
  assert.equal(f.commands.length, 0)
  assert.equal(f.state().verification_groups.be.key, key)
})

test('required checks cannot wait on a test delivery whose item depends on the current unit being done', async () => {
  const f = await fixture({ dependencies: ['BE'] })
  await f.call({ operation: 'plan_verification', verification_group: 'be', command: command('be'), item_ids: ['BE'], files: ['be.mjs', 'be.test.mjs', 'fe.test.mjs'] })
  await assert.rejects(f.call({ operation: 'dispatch', item_id: 'BE' }), /waits for downstream delivery/)
  assert.equal(f.commands.length, 0)
})

test('two real suites retain separate receipts and permit local acceptance before the other suite runs', async () => {
  const f = await fixture()
  const result = JSON.parse(await f.verify('be'))
  assert.equal(result.ok, false)
  assert.equal(result.task_verified, false)
  assert.equal(result.group_result.id, 'be')
  assert.equal(result.group_result.status, 'passed')
  assert.match(result.next_action, /Group be passed.*Review/)
  assert.ok(result.diagnostics.some(entry => entry.group_id === 'fe' && entry.code === 'VERIFICATION_MISSING'))
  assert.equal(f.state().verification.passed, false)
  await f.finish('BE')
  const backend = structuredClone(latestGroupRun(f.state(), 'be'))
  await f.verify('fe'); await f.finish('FE')
  assert.equal(f.state().verification.passed, true)
  assert.deepEqual(latestGroupRun(f.state(), 'be'), backend)
  assert.equal(f.state().verification_runs.length, 2)
  assert.deepEqual(groupEvidenceBlockers(f.state(), await f.hashes()), [])
})

test('latest failed suite cannot be hidden by an earlier pass on the same source hash or another passing suite', async () => {
  const f = await fixture(); await f.verify('be'); await f.verify('fe')
  const old = latestGroupRun(f.state(), 'be')
  f.failNext(); await f.verify('be')
  const failed = latestGroupRun(f.state(), 'be')
  assert.equal(failed.receipt.scope_hash, old.receipt.scope_hash)
  assert.equal(failed.passed, false)
  assert.equal(f.state().verification.passed, false)
  assert.ok(groupEvidenceBlockers(f.state(), await f.hashes()).some(message => message.includes('latest run did not pass')))
  await f.verify('fe')
  assert.equal(f.state().verification.passed, false)
  assert.equal(f.state().verification_runs.length, 4)
})

test('frontend defect preserves backend acceptance, real receipt and unchanged instruction read record', async () => {
  const f = await fixture(); await f.verify('be'); await f.finish('BE'); await f.verify('fe'); await f.finish('FE')
  const before = f.state(), backend = structuredClone(latestGroupRun(before, 'be'))
  before.stage = '代码审核'; before.skill_loads = { '代码开发': { example: { session_id: 'group-fixture', input_hash: 'stable', at: 'now' } } }; f.save(before)
  f.edit('fe.mjs', 'export const value = 2 // frontend-only fix\n')
  await f.call({ operation: 'revise', revision_kind: 'defect', revision_reason: 'frontend defect', target_stage: '代码开发', affected_items: ['FE'] })
  assert.equal(f.state().items[0].status, 'done')
  assert.deepEqual(f.state().items[0].review, before.items[0].review)
  assert.equal(f.state().items[1].status, 'todo')
  assert.deepEqual(latestGroupRun(f.state(), 'be'), backend)
  assert.equal(f.state().skill_loads['代码开发'].example.input_hash, 'stable')
  await f.verify('fe'); await f.finish('FE')
  assert.equal(f.state().verification.passed, true)
  assert.equal(f.commands.filter(value => value === command('be')).length, 1)
})

test('shared input change expands a declared frontend-only defect to both affected units', async () => {
  const f = await fixture({ shared: true }); await f.verify('be'); await f.finish('BE'); await f.verify('fe'); await f.finish('FE')
  const before = f.state(); before.stage = '代码审核'; f.save(before)
  f.edit('shared.json', '{"changed":true}\n')
  await f.call({ operation: 'revise', revision_kind: 'defect', revision_reason: 'shared configuration', target_stage: '代码开发', affected_items: ['FE'] })
  assert.ok(f.state().items.every(item => item.status === 'todo' && !item.review))
  assert.ok(groupEvidenceBlockers(f.state(), await f.hashes()).length >= 2)
})

test('backend input change invalidates dependent frontend checks and reopens downstream consumers', async () => {
  const f = await fixture({ dependencies: ['BE'] }); await f.verify('be'); await f.finish('BE'); await f.verify('fe'); await f.finish('FE')
  const before = f.state(); before.stage = '代码审核'; f.save(before)
  f.edit('be.json', '{"setting":false}\n')
  const stale = groupEvidenceBlockers(f.state(), await f.hashes())
  assert.equal(stale.filter(message => message.includes('inputs changed')).length, 2)
  await f.call({ operation: 'revise', revision_kind: 'defect', revision_reason: 'backend input changed', target_stage: '代码开发', affected_items: ['BE'] })
  assert.ok(f.state().items.every(item => item.status === 'todo'))
})

test('unknown impact remains task-wide and requirements changes invalidate all groups', async () => {
  for (const kind of ['defect', 'requirement']) {
    const f = await fixture(); await f.verify('be'); await f.finish('BE'); await f.verify('fe'); await f.finish('FE')
    const before = f.state(); before.stage = '代码审核'; f.save(before)
    await f.call({ operation: 'revise', revision_kind: kind, revision_reason: 'unknown or requirement impact', target_stage: '代码开发', ...(kind === 'requirement' ? { affected_items: ['FE'] } : {}) })
    assert.ok(f.state().items.every(item => item.status === 'todo'))
    assert.ok(f.state().verification_runs.every(run => run.invalidated_reason))
  }
})

test('changing a check plan preserves historical receipts but demands a new matching run', async () => {
  const f = await fixture(); await f.verify('be'); await f.verify('fe')
  const key = verificationKey(f.state(), 'BE')
  await assert.rejects(f.call({ operation: 'verify', verification_group: 'be', command: command('fe') }), /command differs/)
  await f.call({ operation: 'plan_verification', verification_group: 'be', command: command('be'), item_ids: ['BE'], files: ['be.mjs', 'be.test.mjs', 'shared.json'] })
  assert.equal(f.state().verification_runs.length, 2)
  assert.notEqual(verificationKey(f.state(), 'BE'), key)
  assert.equal(f.state().verification.passed, false)
  assert.ok(groupEvidenceBlockers(f.state(), await f.hashes()).some(message => message.includes('plan changed')))
})

test('successful command without real test summary returns an actionable diagnostic', async () => {
  const f = await fixture()
  await f.call({ operation: 'plan_verification', verification_group: 'be', command: 'node be.mjs', item_ids: ['BE'], files: ['be.mjs', 'be.test.mjs', 'be.json'] })
  const result = JSON.parse(await f.verify('be'))
  assert.equal(result.verification.receipt.exit_code, 0)
  assert.equal(result.ok, false)
  assert.ok(result.diagnostics.some(entry => entry.group_id === 'be' && entry.code === 'NO_TEST_SUMMARY'))
  assert.match(result.next_action, /real runner/)
})

test('an accepted implementation can register a same-stage defect without losing an unrelated unit', async () => {
  const f = await fixture({ shared: true }); await f.verify('be'); await f.finish('BE'); await f.verify('fe'); await f.finish('FE')
  const before = f.state(), backend = structuredClone(latestGroupRun(before, 'be'))
  const outcome = await f.call({ operation: 'revise', revision_kind: 'defect', revision_reason: 'frontend test coverage', target_stage: '代码开发', affected_items: ['FE'] })
  assert.match(outcome, /affected_items: FE; preserved_items: BE/)
  assert.equal(f.state().stage, '代码开发')
  assert.equal(f.state().items[0].status, 'done')
  assert.deepEqual(f.state().items[0].review, before.items[0].review)
  assert.deepEqual(latestGroupRun(f.state(), 'be'), backend)
  assert.equal(f.state().items[1].status, 'todo')
  await assert.rejects(f.call({ operation: 'revise', revision_kind: 'requirement', revision_reason: 'changed requirement', target_stage: '代码开发' }), /same-stage/)
  const response = JSON.parse(await f.verify('be'))
  assert.ok(!response.diagnostics.some(entry => entry.group_id === 'fe' && entry.code === 'VERIFICATION_STALE'))
  assert.equal(f.state().items[1].review, undefined, 'fresh test reuse never preserves the affected review')
})

test('selective defect recovery reuses the latest passing current-input receipt after the fix was already tested', async () => {
  const f = await fixture(); await f.verify('be'); await f.finish('BE'); await f.verify('fe'); await f.finish('FE')
  f.edit('fe.mjs', 'export const value = 2\n// repaired implementation\n')
  await f.verify('fe')
  const before = f.state(), fresh = structuredClone(latestGroupRun(before, 'fe'))
  before.stage = '代码审核'; f.save(before)
  const commands = f.commands.length
  const result = await f.call({ operation: 'revise', revision_kind: 'defect', revision_reason: 'Sonar repair already tested', target_stage: '代码开发', affected_items: ['FE'] })
  assert.deepEqual(latestGroupRun(f.state(), 'fe'), fresh)
  assert.equal(f.commands.length, commands)
  assert.equal(f.state().verification.passed, true)
  assert.equal(f.state().items[1].review, undefined)
  assert.match(result, /valid_verification_groups: be, fe/)
  await f.finish('FE')
})

test('selective defect recovery never falls back to an older passing run after the latest run failed', async () => {
  const f = await fixture(); await f.verify('be'); await f.verify('fe')
  f.failNext(); await f.verify('fe')
  const before = f.state(); before.stage = '代码审核'; f.save(before)
  await f.call({ operation: 'revise', revision_kind: 'defect', revision_reason: 'latest run failed', target_stage: '代码开发', affected_items: ['FE'] })
  assert.equal(f.state().verification.passed, false)
  assert.ok(groupEvidenceBlockers(f.state(), await f.hashes()).some(message => message.includes('fe')))
  assert.ok(latestGroupRun(f.state(), 'fe').invalidated_reason)
})

test('a changed bound Rule prevents same-input receipt reuse and reopens every affected implementation', async () => {
  const f = await fixture(), initial = f.state()
  mkdirSync(join(f.root, '.dsh/rules'), { recursive: true })
  f.edit('.dsh/rules/guard.md', 'original required rule')
  const ref = { source: 'project', name: 'guard' }
  initial.flow.config.stage_bindings['代码开发'].skills[0].rules.push(ref)
  initial.flow.hash = hashConfig(initial.flow.config)
  initial.flow.resources.push({ kind: 'rule', ref, content: 'original required rule', hash: hashText('original required rule') })
  f.save(initial)
  await f.verify('be'); await f.finish('BE'); await f.verify('fe'); await f.finish('FE')
  f.edit('.dsh/rules/guard.md', 'changed required rule')
  const before = f.state(); before.stage = '代码审核'; f.save(before)
  await f.call({ operation: 'revise', revision_kind: 'defect', revision_reason: 'Rule changed', target_stage: '代码开发', affected_items: ['FE'] })
  assert.ok(f.state().items.every(item => item.status === 'todo'))
  assert.ok(f.state().verification_runs.every(run => run.invalidated_reason))
  assert.equal(f.state().verification.passed, false)
})

test('negative-path test names do not turn a passing suite into an environment blocker', () => {
  assert.deepEqual(receiptProblems({ command: 'node --test checks.mjs', exit_code: 0, timed_out: false, aborted: false,
    started_at: 'now', finished_at: 'now', stdout: '# Subtest: handles access denied and spawn EPERM\n# tests 1\n# pass 1\n# fail 0', stderr: '' }), [])
})

test('opting an old task into grouped checks keeps its legacy run without retroactive coverage', async () => {
  const f = await fixture({ planned: false })
  const legacy = f.state(); delete legacy.verification_version; f.save(legacy)
  await f.call({ operation: 'verify', command: command('be') })
  assert.equal(f.state().verification.passed, true)
  await f.call({ operation: 'plan_verification', verification_group: 'be', command: command('be'), item_ids: ['BE'], files: ['be.mjs', 'be.test.mjs'] })
  assert.equal(f.state().verification_runs.length, 1)
  assert.equal(f.state().verification_runs[0].group_id, undefined)
  assert.equal(f.state().verification.passed, false)
  assert.equal(latestGroupRun(f.state(), 'be'), undefined)
  const archived = f.state(); archived.completed = { at: new Date().toISOString() }; f.save(archived)
  await assert.rejects(f.call({ operation: 'plan_verification', verification_group: 'fe', command: command('fe'), item_ids: ['FE'], files: ['fe.mjs', 'fe.test.mjs'] }), /archived/)
  assert.equal(f.state().verification_runs.length, 1)
})

test('packaged commit hook validates group configuration inputs outside the staged delivery files', async () => {
  const f = await fixture(); await f.verify('be'); await f.finish('BE'); await f.verify('fe'); await f.finish('FE')
  const initialized = spawnSync('git', ['init', '-b', 'fixture', f.root], { encoding: 'utf8' })
  assert.equal(initialized.status, 0, initialized.stderr)
  const staged = spawnSync('git', ['-C', f.root, 'add', '--', 'be.mjs', 'be.test.mjs', 'fe.mjs', 'fe.test.mjs'], { encoding: 'utf8' })
  assert.equal(staged.status, 0, staged.stderr)
  const state = f.state(); state.stage = '测试'; f.save(state)
  const message = join(f.root, '.git/COMMIT_EDITMSG'); writeFileSync(message, '【GROUPS】 fixture\n')
  const hook = join(f.root, '.git/hooks/commit-msg')
  writeFileSync(hook, readFileSync(resolve('hooks/commit-msg')))
  writeFileSync(join(f.root, '.git/hooks/package.json'), '{"type":"commonjs"}\n')
  const runHook = () => spawnSync(process.execPath, [hook, message], { cwd: f.root, encoding: 'utf8', env: { ...process.env, DSH_TASK_ROOT: f.root } })
  const passing = runHook(); assert.equal(passing.status, 0, passing.stderr)
  f.edit('be.json', '{"changed":true}\n')
  const stale = runHook(); assert.notEqual(stale.status, 0); assert.match(stale.stderr, /verification group be.*stale/)
})
