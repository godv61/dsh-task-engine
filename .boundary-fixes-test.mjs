// Public-tool regressions: real Git/FS/test processes, controlled child/HTTP transports.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { registerDevTask } from './lib/dev-task.js'
import { requiredReviewPaths, validateDeliveryChanges } from './lib/delivery-changes.js'
import { scanProject, projectMapCoverageGaps } from './lib/project-init.js'
import { inspectSonar, sonarCommitBlockers } from './lib/sonar.js'

const command = 'node --test --experimental-test-isolation=none --test-reporter=tap check.test.mjs'
const basePlan = { item_id: 'I1', task_boundary: 'independent', execution_reason: 'One bounded delivery with a real regression',
  files: ['old file.mjs', 'check.test.mjs'], acceptance: ['requested behavior and regression pass'] }
async function fixture({ complexity = 'low', risk = 'standard', policy = 'auto', rename = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'task-engine-boundary-'))
  const old = 'old file.mjs', target = "nested/new 'file.mjs"
  writeFileSync(join(root, old), 'export const obsolete = true\n')
  writeFileSync(join(root, 'check.test.mjs'), `import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';test('delivery',()=>{assert.equal(existsSync(${JSON.stringify(old)}),false);${rename ? `assert.equal(existsSync(${JSON.stringify(target)}),true);` : ''}})\n`)
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', 'fixture'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  git('add', '--', old, 'check.test.mjs'); git('-c', 'core.hooksPath=NUL', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline')
  const fs = {
    resolve: async (path, opts) => ({ key: join(opts?.cwd ?? root, path) }),
    readText: async target => { try { return readFileSync(target.key, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e } },
    lstat: async (path, opts) => { try { const info = lstatSync(join(opts?.cwd ?? root, path)); return { type: info.isFile() ? 'file' : 'directory', version: `${info.mtimeMs}:${info.size}` } } catch (e) { if (e.code !== 'ENOENT') throw e } },
    listDir: async target => readdirSync(target.key, { withFileTypes: true }).map(entry => ({ name: entry.name, type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other' })),
    writeText: async (target, content) => { mkdirSync(dirname(target.key), { recursive: true }); writeFileSync(target.key, content) },
  }
  let execute, runtime, omitReads = [], implementation = () => { unlinkSync(join(root, old)); if (rename) { mkdirSync(dirname(join(root, target)), { recursive: true }); writeFileSync(join(root, target), 'export const obsolete = true\n') } }
  const statePath = join(root, '.dsh/task-BOUNDARY.json')
  const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
  const save = value => writeFileSync(statePath, JSON.stringify(value))
  const starts = [], commands = []
  runtime = { getProvider: name => ({ inheritsParentContext: name === 'fork', capabilities: { depthLimit: true, toolFilter: true } }),
    start: async (provider, request) => {
      starts.push(request)
      const reviewer = request.label.endsWith('/review')
      if (!reviewer) implementation()
      const events = reviewer ? requiredReviewPaths(state().items[0].execution_plan).filter(file => !omitReads.includes(file) && existsSync(join(root, file))).flatMap((file, index) => {
        const lines = readFileSync(join(root, file), 'utf8').split('\n').map(line => line.replace(/\r$/u, '')); if (lines.at(-1) === '') lines.pop()
        return [{ type: 'tool/call', data: { name: 'read', callId: `r-${index}`, arguments: JSON.stringify({ file_path: file }) } },
          { type: 'tool/result', data: { message: { toolCallId: `r-${index}`, isError: false, content: [{ type: 'text', text:
            `<path>${join(root, file)}</path>\n<type>file</type>\n<content>\n${lines.map((line, n) => `${n + 1}: ${line}`).join('\n')}${lines.length ? '\n\n' : ''}(End of file - total ${lines.length} lines)\n</content>` }] } } }]
      }) : []
      return { id: `${reviewer ? 'review' : 'implementation'}-${starts.length}`, localAgent: { session: { snapshotEvents: () => events } },
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: reviewer ? JSON.stringify({ spec: 'pass', quality: 'pass', notes: ['Controlled review transport; required reads independently checked.'] }) : 'delivered' }] }), dispose: async () => {} }
    } }
  const shell = { resolve: spec => spec, run: async spec => {
    commands.push(spec.command)
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
    const run = spawnSync(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', spec.command] : ['-c', spec.command], { cwd: spec.workdir, encoding: 'utf8', env, timeout: 30_000 })
    return { exitCode: run.status, timedOut: !!run.error, aborted: false, stdout: { text: run.stdout ?? '' }, stderr: { text: run.stderr ?? '' } }
  } }
  const ctx = { fs, tools: { register(tool) { execute = tool.execute } }, get: name => name === 'subagents' ? runtime : name === 'shell' ? shell
    : name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) } : undefined }
  registerDevTask(ctx)
  const events = [], session = { id: 'parent', header: { cwd: root }, snapshotEvents: () => events }
  const call = args => execute({ task_id: 'BOUNDARY', ...args }, { agent: { session }, signal: new AbortController().signal })
  const files = [old, 'check.test.mjs', ...(rename ? [target] : [])]
  await call({ operation: 'create', title: 'Boundary regression', branch: 'fixture', files, complexity, complexity_reason: 'Boundary fixture', risk_level: risk, execution_policy: policy, items: [{ id: 'I1', title: 'deliver change' }] })
  await call({ operation: 'plan_verification', verification_group: 'unit', item_ids: ['I1'], command, files })
  return { root, old, target, files, fs, ctx, call, state, save, git, starts, commands,
    implement: () => implementation(),
    set implementation(value) { implementation = value }, set omitReads(value) { omitReads = value }, set runtime(value) { runtime = value },
    plan: changes => call({ operation: 'plan_execution', ...basePlan, files, ...(changes ? { changes } : {}) }),
    verify: async () => { await call({ operation: 'plan_verification', verification_group: 'unit', item_ids: ['I1'], command, files }); return call({ operation: 'verify', verification_group: 'unit' }) } }
}

test('all four adaptive grades can raise risk against their effective frozen workflow', async () => {
  for (const complexity of ['low', 'medium', 'high', 'ultra']) {
    const f = await fixture({ complexity })
    await f.call({ operation: 'set_risk', risk_level: 'high_risk' })
    assert.equal(f.state().risk_level, 'high_risk'); assert.equal(f.state().risk_changes.length, 1)
    assert.deepEqual(f.state().risk_downgrades ?? [], [])
    await assert.rejects(f.call({ operation: 'set_risk', risk_level: 'standard' }), /human approval/)
    assert.equal(f.state().risk_level, 'high_risk')
  }
})
test('risk escalation refreshes review strategy, reopens done work and retains actual tests/dispatch', async () => {
  const f = await fixture()
  await f.call({ operation: 'plan_execution', ...basePlan, task_boundary: 'local', changes: [{ path: f.old, kind: 'delete' }] }); await f.call({ operation: 'dispatch', item_id: 'I1' }); f.implement(); await f.verify()
  await f.call({ operation: 'review_item', item_id: 'I1', spec_outcome: 'pass', quality_outcome: 'pass' })
  await f.call({ operation: 'items', items: [{ id: 'I1', status: 'done' }] })
  const before = f.state(); before.stage = '测试'; f.save(before) // isolated late-stage boundary
  assert.ok(before.verification_runs?.some(run => run.receipt.exit_code === 0))
  await f.call({ operation: 'set_risk', risk_level: 'high_risk' })
  const after = f.state()
  assert.equal(after.stage, '代码开发'); assert.equal(after.items[0].status, 'todo'); assert.equal(after.items[0].review, undefined)
  assert.equal(after.items[0].execution_plan.review, 'independent')
  assert.deepEqual(after.items[0].dispatch, before.items[0].dispatch); assert.deepEqual(after.verification_runs, before.verification_runs)
  assert.equal(after.review.outcome, 'pending')
  await f.call({ operation: 'review_dispatch', item_id: 'I1' })
  assert.equal(f.state().items[0].independent_review.status, 'completed')
  await f.call({ operation: 'review_item', item_id: 'I1', spec_outcome: 'pass', quality_outcome: 'pass' })
  await f.call({ operation: 'items', items: [{ id: 'I1', status: 'done' }] })
  assert.equal(f.state().items[0].status, 'done')
  assert.deepEqual(f.state().verification_runs, before.verification_runs)
})
test('risk escalation respects main_only and accurately records unavailable readonly review', async () => {
  for (const policy of ['main_only', 'auto']) {
    const f = await fixture({ policy }); await f.plan()
    if (policy === 'auto') f.runtime = undefined
    await f.call({ operation: 'set_risk', risk_level: 'high_risk' })
    assert.equal(f.state().items[0].execution_plan.review, 'main')
    if (policy === 'auto') assert.match(f.state().items[0].execution_plan.review_reason, /缺少/)
  }
})

for (const rename of [false, true]) test(`planned ${rename ? 'rename' : 'deletion'} reviews verified old content and actual delivery`, async () => {
  const f = await fixture({ risk: 'high_risk', rename })
  await f.plan([{ path: f.old, kind: rename ? 'rename' : 'delete', ...(rename ? { to: f.target } : {}) }])
  const plan = f.state().items[0].execution_plan
  assert.equal(plan.changes[0].baseline.commit, f.git('rev-parse', 'HEAD'))
  await f.call({ operation: 'dispatch', item_id: 'I1' }); const verification = JSON.parse(await f.verify())
  assert.equal(verification.task_verified, true)
  await f.call({ operation: 'review_dispatch', item_id: 'I1' })
  assert.equal(f.state().items[0].independent_review.status, 'completed')
  assert.match(f.starts.at(-1).prompt[0].text, /Current task risk: high_risk/)
  assert.match(f.starts.at(-1).prompt[0].text, /baseline.git.path/)
  assert.deepEqual(f.starts.at(-1).toolFilter, { allow: ['read'] })
  await f.call({ operation: 'review_item', item_id: 'I1', spec_outcome: 'pass', quality_outcome: 'pass' })
  await f.call({ operation: 'items', items: [{ id: 'I1', status: 'done' }] })
  assert.equal(f.state().items[0].status, 'done')
  f.git('add', '--', ...f.files)
  const state = f.state(); state.stage = '测试'; f.save(state)
  const hook = join(f.root, '.git/hooks/commit-msg'), message = join(f.root, '.git/COMMIT_EDITMSG')
  writeFileSync(hook, readFileSync(new URL('./hooks/commit-msg', import.meta.url)))
  writeFileSync(join(f.root, '.git/hooks/package.json'), '{"type":"commonjs"}\n')
  writeFileSync(message, '【BOUNDARY】 fixture\n')
  const runHook = () => spawnSync(process.execPath, [hook, message], { cwd: f.root, encoding: 'utf8', env: { ...process.env, DSH_TASK_ROOT: f.root } })
  const accepted = runHook(); assert.equal(accepted.status, 0, accepted.stderr)
  state.stage = '代码开发'; f.save(state)
  writeFileSync(join(f.root, f.old), 'resurrected\n')
  await assert.rejects(f.call({ operation: 'review_item', item_id: 'I1', spec_outcome: 'pass', quality_outcome: 'pass' }), /old path still exists/)
  assert.notEqual(runHook().status, 0)
})
test('unexpected missing file remains rejected instead of being treated as an intentional deletion', async () => {
  const f = await fixture({ risk: 'high_risk' }); await f.plan(); await f.call({ operation: 'dispatch', item_id: 'I1' }); await f.verify()
  await f.call({ operation: 'review_dispatch', item_id: 'I1' })
  assert.equal(f.state().items[0].independent_review.status, 'failed')
  assert.match(f.state().items[0].independent_review.error, /delivery is missing/)
})
test('pre-existing worktree edits are preserved in an additional review snapshot; missing reads/tampering block acceptance', async () => {
  const f = await fixture({ risk: 'high_risk' })
  writeFileSync(join(f.root, f.old), 'export const preexisting = 42\n')
  await f.plan([{ path: f.old, kind: 'delete' }])
  const baseline = f.state().items[0].execution_plan.changes[0].baseline
  assert.equal(readFileSync(join(f.root, baseline.before.path), 'utf8'), 'export const preexisting = 42\n')
  assert.equal(readFileSync(join(f.root, f.old), 'utf8'), 'export const preexisting = 42\n')
  await f.call({ operation: 'dispatch', item_id: 'I1' }); await f.verify()
  f.omitReads = [baseline.before.path]
  await f.call({ operation: 'review_dispatch', item_id: 'I1' })
  assert.match(f.state().items[0].independent_review.error, /every planned delivery file in full/)
  f.omitReads = []; await f.call({ operation: 'review_dispatch', item_id: 'I1' })
  assert.equal(f.state().items[0].independent_review.status, 'completed')
  writeFileSync(join(f.root, baseline.before.path), 'tampered\n')
  await assert.rejects(f.call({ operation: 'review_item', item_id: 'I1', spec_outcome: 'pass', quality_outcome: 'pass' }), /baseline is missing or changed/)
})
test('deletion plans reject untracked old content, directories and invalid rename ownership', async () => {
  const f = await fixture()
  f.git('rm', '--cached', '--', f.old); f.git('-c', 'core.hooksPath=NUL', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'untrack')
  await assert.rejects(f.plan([{ path: f.old, kind: 'delete' }]), /tracked regular-file baseline/)
  assert.throws(() => validateDeliveryChanges([{ path: 'a', kind: 'rename', to: 'b' }], ['a']), /both rename paths/)
  assert.throws(() => validateDeliveryChanges([{ path: 'a', kind: 'delete' }, { path: 'a', kind: 'delete' }], ['a']), /unique old paths/)
  const directory = await fixture(); unlinkSync(join(directory.root, directory.old)); mkdirSync(join(directory.root, directory.old))
  await assert.rejects(directory.plan([{ path: directory.old, kind: 'delete' }]), /not a regular file/)
})
test('baseline capture preserves UTF-8 text and rejects binary snapshots', async () => {
  for (const body of ['export const 名称 = "旧实现，包含中文"\n', 'binary\0content']) {
    const f = await fixture()
    writeFileSync(join(f.root, f.old), body)
    f.git('add', '--', f.old); f.git('-c', 'core.hooksPath=NUL', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline content')
    if (body.includes('\0')) await assert.rejects(f.plan([{ path: f.old, kind: 'delete' }]), /complete text baseline/)
    else {
      await f.plan([{ path: f.old, kind: 'delete' }])
      const baseline = f.state().items[0].execution_plan.changes[0].baseline
      assert.equal(readFileSync(join(f.root, baseline.git.path), 'utf8').replace(/\r\n/gu, '\n'), body)
    }
  }
})

function diskProbe() {
  return { read: async (root, path) => { try { return readFileSync(join(root, path), 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e } },
    list: async (root, path) => readdirSync(join(root, path)),
    directories: async (root, path) => readdirSync(join(root, path), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) }
}
test('inventory finds nested multi-stack modules and excludes generated/cache directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-engine-inventory-'))
  for (const [path, content] of Object.entries({ 'apps/api/package.json': '{"name":"api"}', 'apps/web/package.json': '{"dependencies":{"vue":"3"}}',
    'services/java/nested/pom.xml': '<project/>', 'platform/jvm/build.gradle.kts': 'plugins {}', 'node_modules/ignored/package.json': '{}', '.dsh/private/package.json': '{}' })) {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content)
  }
  const inventory = await scanProject(diskProbe(), root)
  assert.equal(inventory.discovery.status, 'complete')
  assert.deepEqual(inventory.manifests.map(m => m.path), ['apps/api/package.json', 'apps/web/package.json', 'platform/jvm/build.gradle.kts', 'services/java/nested/pom.xml'])
  assert.deepEqual(projectMapCoverageGaps('feature-only map', inventory), ['apps/api', 'apps/web', 'platform/jvm', 'services/java/nested'])
  assert.deepEqual(projectMapCoverageGaps('apps/api apps/web platform/jvm services/java/nested', inventory), [])
})
test('inventory budgets, denied listing, unavailable listing and empty evidence never imply full coverage', async () => {
  const f = await fixture(), probe = diskProbe()
  mkdirSync(join(f.root, 'apps/api'), { recursive: true }); writeFileSync(join(f.root, 'apps/api/package.json'), '{}')
  for (const limits of [{ directories: 1, depth: 16, entries: 1000 }, { directories: 1000, depth: 0, entries: 1000 }, { directories: 1000, depth: 16, entries: 1 }]) {
    const inventory = await scanProject(probe, f.root, limits)
    assert.equal(inventory.discovery.status, 'partial'); assert.ok(projectMapCoverageGaps('apps/api', inventory).some(g => g.includes('inventory partial')))
  }
  const denied = await scanProject({ ...probe, list: async () => { throw new Error('permission denied') } }, f.root)
  assert.equal(denied.discovery.status, 'partial'); assert.match(denied.discovery.warnings.join(), /permission denied/)
  const unavailable = await scanProject({ read: async () => undefined }, f.root)
  assert.equal(unavailable.discovery.status, 'unavailable'); assert.ok(projectMapCoverageGaps('', unavailable).length)
  const empty = await scanProject({ read: async () => undefined, list: async () => [] }, f.root)
  assert.match(projectMapCoverageGaps('', empty).join(), /coverage is unproven/)
})
test('Sonar accepts only the complete canonical commit identity, including SHA-256 repos', async () => {
  for (const length of [40, 64]) {
    const commit = 'ab'.repeat(length / 2), policy = { enabled: true, source: 'ci', host_url: 'https://sonar.example.invalid', project_key: 'fixture', mode: 'branch', token_env: 'FIXTURE' }
    const fetcher = async url => new Response(JSON.stringify(url.pathname.endsWith('/ce/task') ? { task: { status: 'SUCCESS', analysisId: 'analysis', componentKey: 'fixture', branch: 'fixture' } }
      : url.pathname.endsWith('/project_analyses/search') ? { analyses: [{ key: 'analysis', revision: commit }] }
      : url.pathname.endsWith('/qualitygates/project_status') ? { projectStatus: { status: 'OK' } } : { issues: [], paging: { total: 0 } }))
    const audit = await inspectSonar(policy, 'controlled', 'fixture-task', 'fixture', 'scope', fetcher, false, commit)
    assert.deepEqual(sonarCommitBlockers(policy, audit, 'scope', commit), [])
    await assert.rejects(inspectSonar(policy, 'controlled', 'fixture-task', 'fixture', 'scope', fetcher, false, commit.slice(0, 7)), /SCM revision/)
    await assert.rejects(inspectSonar(policy, 'controlled', 'fixture-task', 'fixture', 'scope', fetcher, false, 'c'.repeat(length)), /SCM revision/)
  }
})
