// Repair regressions: exercise production modules with explicit FS/session/HTTP adapters.
// Delivery checks additionally use real Git, real files and real node:test processes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, lstatSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerDevTask } from './lib/dev-task.js'
import { resolveFlow } from './lib/workflows.js'
import { skillBlockers } from './lib/skill-audit.js'
import { inspectSonar } from './lib/sonar.js'
import Controller from './lib/controller.js'
import { hashText } from './lib/snapshot.js'

const smokeRoot = mkdtempSync(join(tmpdir(), 'task-engine-validator-'))
const smokeFile = join(smokeRoot, 'smoke.test.mjs')
const workflowsUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'lib/workflows.js')).href
writeFileSync(smokeFile, `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {resolveFlow} from ${JSON.stringify(workflowsUrl)}; test('production workflow',()=>{const result=resolveFlow('standard',{flow:'standard'}); assert.equal(result.ok,true); assert.ok(result.config.stages.includes('代码审核'));});`)
const smokeCommand = `node --test --test-reporter=tap '${smokeFile.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`

async function fixture(flow = 'standard', config = {}, diskRoot, createArgs = {}) {
  const cwd = diskRoot ?? resolve('docs/assessment-20261023/virtual-project')
  const records = new Map()
  const key = (p, opts) => join(opts?.cwd ?? cwd, p)
  const fs = {
    resolve: async (p, opts) => ({ targetKey: key(p, opts) }),
    readText: async t => {
      if (records.has(t.targetKey)) return records.get(t.targetKey)
      if (diskRoot) { try { return readFileSync(t.targetKey, 'utf8') } catch {} }
    },
    lstat: async (p, opts) => {
      if (records.has(key(p, opts))) return { version: 'v1', type: 'file' }
      if (diskRoot) {
        try {
          const info = lstatSync(key(p, opts))
          return { version: `${info.mtimeMs}:${info.size}`, type: info.isFile() ? 'file' : 'directory' }
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      return undefined
    },
    listDir: async target => [...new Set([...records.keys()].filter(p => p.startsWith(target.targetKey + sep))
      .map(p => p.slice(target.targetKey.length + 1).split(sep)[0]))].map(name => ({ name })),
    writeText: async (t, content) => { records.set(t.targetKey, content) },
  }
  records.set(join(cwd, '.dsh/eng.json'), JSON.stringify({ flow, ...config }))
  records.set(join(cwd, '.dsh/skills/one/SKILL.md'), '# one')
  records.set(join(cwd, '.dsh/rules/rule.md'), '# old rule')
  if (!diskRoot) records.set(join(cwd, 'a.js'), 'export const n = 2')
  const shell = {
    resolve: request => request,
    run: async spec => {
      // Only fixture commands: no host config or external application is touched.
      const childEnv = { ...process.env }
      delete childEnv.NODE_TEST_CONTEXT // Node's outer test runner must not suppress the real child suite.
      const out = spawnSync(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', process.platform === 'win32'
        ? ['-NoProfile', '-NonInteractive', '-Command', spec.command] : ['-c', spec.command],
      { cwd: diskRoot ? spec.workdir : process.cwd(), env: childEnv, encoding: 'utf8', timeout: 30000 })
      return { exitCode: out.status, timedOut: !!out.error, aborted: false, stdout: { text: out.stdout ?? '' }, stderr: { text: out.stderr ?? '' } }
    },
  }
  let execute
  const events = []
  const ctx = { fs, tools: { register(tool) { execute = tool.execute; return () => {} } },
    get: name => name === 'shell' ? shell : name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd }) } : undefined }
  registerDevTask(ctx)
  const session = { id: 'assessment', header: { cwd }, snapshotEvents: () => events }
  const call = args => execute({ task_id: 'ASSESS-1', ...args }, { agent: { session }, signal: new AbortController().signal })
  await call({ operation: 'create', title: 'isolated assessment', branch: 'main', files: ['a.js'], ...createArgs })
  const path = join(cwd, '.dsh/task-ASSESS-1.json')
  const current = () => JSON.parse(records.get(path))
  const save = state => records.set(path, JSON.stringify(state))
  const loadCurrent = async () => {
    for (const entry of current().flow.config.stage_bindings?.[current().stage]?.skills ?? []) {
      const skill_name = `${entry.skill.source}:${entry.skill.name}`
      const callId = 'load-' + events.length
      await call({ operation: 'load_skill', skill_name })
      events.push({ type: 'tool/call', data: { name: 'dev_task', callId, arguments: JSON.stringify({ operation: 'load_skill', task_id: 'ASSESS-1', skill_name }) } },
        { type: 'tool/result', data: { message: { toolCallId: callId, isError: false } } })
    }
  }
  return { cwd, fs, records, call, current, save, events, ctx, loadCurrent }
}

test('commit evidence: reject old HEAD, accept verified delivery, refuse later uncommitted changes at close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-engine-repair-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture')
  writeFileSync(join(root, 'a.js'), 'export const n = 1\n')
  git('add', 'a.js'); git('-c', 'core.hooksPath=NUL', 'commit', '-qm', 'old content')
  const old = git('rev-parse', 'HEAD')
  writeFileSync(join(root, 'a.js'), 'export const n = 2\n')
  writeFileSync(join(root, 'check.test.mjs'), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; test('new bytes',()=>assert.match(readFileSync('a.js','utf8'),/n = 2/));")
  const f = await fixture('standard', {}, root)
  const state = f.current(); state.stage = '代码审核'; f.save(state)
  // Seed already reviewed item prerequisites; the Git, verify, review and close path is real.
  const seeded = f.current(); seeded.items = [{ id: 'I1', title: 'implementation', status: 'done', review: { spec: { outcome: 'pass' }, quality: { outcome: 'pass' } } }]; f.save(seeded)
  await f.call({ operation: 'verify', command: 'node --test --test-reporter=tap check.test.mjs' })
  assert.equal(f.current().verification.passed, true)
  assert.equal(f.current().verification.receipt.scope_hash, hashText(JSON.stringify([['a.js', hashText(readFileSync(join(root, 'a.js'), 'utf8')), false]])))
  await f.call({ operation: 'review', outcome: 'pass' })
  await assert.rejects(() => f.call({ operation: 'commit', hash: old, message: 'old content', files: ['a.js'] }), /delivery files differ/)
  git('update-index', '--assume-unchanged', 'a.js')
  await assert.rejects(() => f.call({ operation: 'commit', hash: old, message: 'old content', files: ['a.js'] }), /delivery blobs differ/)
  git('update-index', '--no-assume-unchanged', 'a.js')
  git('add', 'a.js'); git('-c', 'core.hooksPath=NUL', 'commit', '-qm', 'new content')
  // An unrelated untracked file must not block delivery.
  const fullOid = git('rev-parse', 'HEAD')
  await f.call({ operation: 'commit', hash: fullOid.slice(0, 7), message: 'new content', files: ['a.js'] })
  assert.equal(f.current().commits.at(-1).hash, fullOid)
  assert.equal(f.current().commits.at(-1).provided_hash, fullOid.slice(0, 7))
  await f.call({ operation: 'advance', target_stage: '完成' })
  await f.call({ operation: 'verify', command: 'node --test --test-reporter=tap check.test.mjs' })
  await f.call({ operation: 'review', outcome: 'pass' })
  writeFileSync(join(root, 'a.js'), 'export const n = 3\n')
  await assert.rejects(() => f.call({ operation: 'complete' }), /stale/)
  writeFileSync(join(root, 'a.js'), 'export const n = 2\n')
  await f.call({ operation: 'complete' })
  assert.ok(f.current().completed)
  console.log('preserved real Git fixture:', root)
})

test('legacy abbreviated commit is resolved by real Git before accepting a fresh CI Sonar audit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-engine-legacy-oid-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.js'), 'export const n = 2\n')
  git('add', 'a.js'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=NUL', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
  const full = git('rev-parse', 'HEAD'), short = full.slice(0, 7)
  const f = await fixture('standard', {}, root)
  const state = f.current(); state.stage = '代码审核'; state.commits = [{ label: 'TASK', hash: short }]
  state.items = [{ id: 'I1', title: 'implementation', status: 'done', review: { spec: { outcome: 'pass' }, quality: { outcome: 'pass' } } }]
  state.sonar_policy = { enabled: true, source: 'ci', host_url: 'https://sonar.example.invalid', project_key: 'fixture', mode: 'branch', token_env: 'UNUSED_FIXTURE' }
  f.save(state)
  await f.call({ operation: 'verify', command: smokeCommand })
  const get = f.ctx.get
  f.ctx.get = name => name === 'credentials' ? { resolve: async () => ({ value: 'controlled-credential' }) } : get(name)
  const oldFetch = globalThis.fetch
  globalThis.fetch = async url => new Response(JSON.stringify(url.pathname.endsWith('/ce/task') ? { task: { status: 'SUCCESS', analysisId: 'analysis', componentKey: 'fixture', branch: 'main' } }
    : url.pathname.endsWith('/project_analyses/search') ? { analyses: [{ key: 'analysis', revision: full }] }
    : url.pathname.endsWith('/qualitygates/project_status') ? { projectStatus: { status: 'OK' } } : { issues: [], paging: { total: 0 } }))
  try {
    await f.call({ operation: 'sonar_check', ce_task_id: 'fixture-ce-task' })
    assert.equal(f.current().commits.at(-1).hash, full)
    assert.equal(f.current().commits.at(-1).provided_hash, short)
    assert.equal(f.current().sonar_audit.commit_hash, full)
    assert.equal(f.current().sonar_audit.gate, 'OK')
    await f.call({ operation: 'review', outcome: 'pass' })
  } finally { globalThis.fetch = oldFetch }
})

test('new Sonar task captures the real dirty baseline before writing its record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-engine-create-baseline-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.js'), 'export const n = 1\n')
  git('add', 'a.js')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=NUL', 'commit', '-qm', 'initial')
  writeFileSync(join(root, 'preexisting.xml'), '<existing/>\n')
  const f = await fixture('standard', {}, root)
  f.records.set(join(root, '.dsh/meta.json'), JSON.stringify({ sonar: { enabled: true,
    source: 'ide-local', host_url: 'https://sonar.example.invalid', project_key: 'fixture', reference_branch: 'HEAD' } }))
  await f.call({ operation: 'create', task_id: 'BASELINE', title: 'baseline wiring', branch: 'main',
    complexity: 'medium', complexity_reason: 'fixture for actual creation baseline', files: ['a.js'] })
  const created = JSON.parse(f.records.get(join(root, '.dsh/task-BASELINE.json')))
  assert.equal(created.sonar_baseline.reference, 'HEAD')
  assert.equal(created.sonar_baseline.files.find(file => file.path === 'preexisting.xml').hash, hashText('<existing/>\n'))
})

test('review: reject early pass; changed validation identity requires a fresh verdict', async () => {
  const f = await fixture()
  await assert.rejects(() => f.call({ operation: 'review', outcome: 'pass' }), /review stage/)
  const s = f.current(); s.stage = '代码审核'; f.save(s)
  await f.call({ operation: 'verify', command: smokeCommand })
  await f.call({ operation: 'review', outcome: 'pass' })
  const changed = f.current(); changed.verification.receipt.finished_at = '2099-01-01T00:00:00.000Z'; f.save(changed)
  assert.match(await f.call({ operation: 'status' }), /review is stale/)
  await f.call({ operation: 'review', outcome: 'pass' })
  assert.equal(f.current().review.verification_at, '2099-01-01T00:00:00.000Z')
})

test('Sonar: reject missing/old revision, accept only the exact analysis matching current commit', async () => {
  const policy = { enabled: true, source: 'ci', host_url: 'https://sonar.example.invalid', project_key: 'test', mode: 'branch', token_env: 'FIXTURE' }
  const commit = 'b'.repeat(40)
  const run = revision => inspectSonar(policy, 'dummy', 'ce-task-123', 'main', 'scope', async url => {
    const body = url.pathname.endsWith('/ce/task') ? { task: { status: 'SUCCESS', analysisId: 'exact-analysis', componentKey: 'test', branch: 'main' } }
      : url.pathname.endsWith('/project_analyses/search') ? { analyses: revision ? [{ key: 'exact-analysis', revision }] : [] }
      : url.pathname.endsWith('/project_status') ? { projectStatus: { status: 'OK' } } : { issues: [], paging: { total: 0 } }
    return new Response(JSON.stringify(body))
  }, true, commit)
  await assert.rejects(() => run(undefined), /SCM revision/)
  await assert.rejects(() => run('a'.repeat(40)), /SCM revision/)
  assert.equal((await run(commit)).scm_revision, commit)
})

test('revision: multiple finished items become todo and can dispatch sequentially', async () => {
  const f = await fixture()
  const s = f.current(); s.stage = '代码审核'; s.items = ['I1', 'I2'].map(id => ({ id, title: id, status: 'done' })); f.save(s)
  await f.call({ operation: 'revise', revision_kind: 'defect', revision_reason: 'fix defect', target_stage: '开发' })
  assert.deepEqual(f.current().items.map(item => item.status), ['todo', 'todo'])
  await f.call({ operation: 'dispatch', item_id: 'I1' })
  await assert.rejects(() => f.call({ operation: 'dispatch', item_id: 'I2' }), /current doing item/)
})

for (const fault of ['profile', 'meta']) test(`initialization resumes after ${fault} write failure and protects external edits`, async () => {
  const f = await fixture()
  const resources = [{ kind: 'rule', name: 'repair-rule', content: 'convention' },
    { kind: 'skill', name: 'repair-skill', description: 'guidance', content: 'instructions', rules: ['repair-rule'], meta_skills: ['code-development'] }]
  const receiver = { projectInitRoot: async p => p, fs: () => f.fs, listSkills: async () => ({ skills: [] }), previewProjectInit: Controller.prototype.previewProjectInit }
  const preview = () => receiver.previewProjectInit({ path: f.cwd, resources })
  const proposal = await preview()
  const write = f.fs.writeText
  f.fs.writeText = async (target, ...args) => {
    if (target.targetKey.endsWith(fault === 'profile' ? 'profile.json' : 'meta.json')) throw new Error('injected write failure')
    return write(target, ...args)
  }
  await assert.rejects(() => Controller.prototype.applyProjectInit.call(receiver, { path: f.cwd, resources, expected_hash: proposal.expected_hash, existing_hash: proposal.existing_hash }), /injected/)
  f.fs.writeText = write
  const resumed = await preview()
  assert.equal((await Controller.prototype.applyProjectInit.call(receiver, { path: f.cwd, resources, expected_hash: resumed.expected_hash, existing_hash: resumed.existing_hash })).ok, true)
  f.records.set(join(f.cwd, '.dsh/rules/repair-rule.md'), 'external edit')
  await assert.rejects(preview, /不能覆盖/)
})

test('ledger isolates corruption and marks changed verification stale', async () => {
  const f = await fixture()
  await f.call({ operation: 'verify', command: smokeCommand })
  const receiver = { authorizedPath: async p => p, fs: () => f.fs }
  const read = () => Controller.prototype.readTasks.call(receiver, f.cwd)
  assert.equal((await read()).tasks[0].evidence_status, 'valid')
  f.records.set(join(f.cwd, 'a.js'), 'changed')
  f.records.set(join(f.cwd, '.dsh/task-BAD.json'), '{')
  const ledger = await read()
  assert.equal(ledger.tasks.length, 1)
  assert.equal(ledger.tasks[0].evidence_status, 'stale')
  assert.equal(ledger.tasks[0].verification_passed, false)
  assert.equal(ledger.errors[0].file, 'task-BAD.json')
})

test('ledger explains a real commit checkpoint instead of asking to repeat an already valid review', async () => {
  const f = await fixture('standard', { commit: { policy: 'task', checkpoints: ['代码审核'], message_pattern: '', file_scope: true } })
  const state = f.current(); state.stage = '代码审核'; f.save(state)
  await f.call({ operation: 'verify', command: smokeCommand })
  await f.call({ operation: 'review', outcome: 'pass' })
  const receiver = { authorizedPath: async p => p, fs: () => f.fs }
  const read = () => Controller.prototype.readTasks.call(receiver, f.cwd)
  assert.match((await read()).tasks[0].next_action, /等待 Git 提交登记/)
  f.records.set(join(f.cwd, 'a.js'), 'changed after review')
  assert.doesNotMatch((await read()).tasks[0].next_action, /等待 Git 提交登记/)
})

test('Skill/Rule edits require reload and clear the old verdict', async () => {
  const f = await fixture('minimal', { stage_bindings: { '开发': { skills: [
    { skill: { source: 'project', name: 'one' }, rules: [{ source: 'project', name: 'rule' }], evidence: 'none' },
  ] } } })
  await f.loadCurrent()
  f.records.set(join(f.cwd, '.dsh/rules/rule.md'), 'updated rule')
  await assert.rejects(() => f.call({ operation: 'advance', target_stage: '交付' }), /inputs changed/)
  await f.loadCurrent()
  assert.equal(f.current().verification.passed, false)
  const state = f.current(); state.items = [{ id: 'I1', title: 'done', status: 'done', review: { spec: { outcome: 'pass' }, quality: { outcome: 'pass' } } }]; f.save(state)
  await f.call({ operation: 'advance', target_stage: '交付' })
})

for (const providerName of ['spawn', 'fork']) for (const outcome of ['completed', 'error', 'aborted', 'max-tokens']) test(`subagent ${providerName} ${outcome}: persist adapter-returned id and release; never auto-complete the item`, async () => {
  const f = await fixture()
  const state = f.current(); state.stage = '开发'; state.artifacts = { requirement: { scope: 'preserve interfaces' } }; f.save(state)
  await f.call({ operation: 'items', items: [{ id: 'I1', title: 'delegate' }] })
  let disposed = 0
  const get = f.ctx.get
  f.ctx.get = name => name === 'subagents' ? { getProvider: provider => ({ inheritsParentContext: provider === 'fork', capabilities: { depthLimit: true } }), startActivation: async ({provider,request,delivery}) => {
    assert.equal(delivery, "caller")
    assert.equal(provider, providerName)
    assert.equal(request.parent.session.id, 'assessment')
    assert.equal(request.maxDepth, 3)
    assert.match(request.prompt[0].text, /Allowed delivery paths: a.js/)
    assert.match(request.prompt[0].text, /preserve interfaces/)
    return { childId: 'real-host-id', result: Promise.resolve({ stopReason: outcome, output: [{ type: 'text', text: 'delivered' }] }), dispose: async () => { disposed++ } }
  } } : get(name)
  await f.call({ operation: 'dispatch', item_id: 'I1', execution: providerName, description: 'implement' })
  assert.equal(f.current().items[0].dispatch.run_id, 'real-host-id')
  assert.equal(f.current().items[0].dispatch.status, outcome === 'completed' ? 'completed' : 'failed')
  assert.equal(f.current().items[0].status, 'doing')
  assert.equal(disposed, 1)
  if (outcome !== 'completed') await assert.rejects(() => f.call({ operation: 'review_item', item_id: 'I1', spec_outcome: 'pass', quality_outcome: 'pass' }), /not completed/)
})

test('subagent absence does not record a fake delegation', async () => {
  const f = await fixture()
  const s = f.current(); s.stage = '开发'; f.save(s)
  await f.call({ operation: 'items', items: [{ id: 'I1', title: 'delegate' }] })
  await assert.rejects(() => f.call({ operation: 'dispatch', item_id: 'I1', execution: 'spawn' }), /unavailable/)
  assert.equal(f.current().items[0].dispatch, undefined)
})

test('memory initialization jobs deduplicate and read legacy records without creating or updating files', async () => {
  const { initJob } = await import('./lib/init-jobs.js')
  const f = await fixture()
  const id = 'a'.repeat(64)
  let finish
  let runs = 0
  const worker = () => { runs++; return new Promise(resolve => { finish = resolve }) }
  assert.equal((await initJob(f.fs, f.cwd, id, worker)).status, 'running')
  assert.equal((await initJob(f.fs, f.cwd, id, worker)).status, 'running')
  assert.equal(runs, 1)
  finish({ resource: null, reason: 'no optional facts' })
  await new Promise(setImmediate)
  assert.equal((await initJob(f.fs, f.cwd, id)).status, 'completed')
  const restarted = (await import('./lib/init-jobs.js?restart-test')).initJob
  await assert.rejects(restarted(f.fs, f.cwd, id), /已过期或 DSH 已重启/)
  assert.equal(runs, 1)
  assert.equal(f.records.has(join(f.cwd, `.dsh/init-jobs/${id}.json`)), false)
  const legacyDone = 'f'.repeat(64)
  f.records.set(join(f.cwd, `.dsh/init-jobs/${legacyDone}.json`), JSON.stringify({ job_id: legacyDone, status: 'completed', updated_at: new Date().toISOString(), result: { resource: null, reason: 'legacy draft' } }))
  assert.equal((await restarted(f.fs, f.cwd, legacyDone)).result.reason, 'legacy draft')
  const expired = 'b'.repeat(64)
  f.records.set(join(f.cwd, `.dsh/init-jobs/${expired}.json`), JSON.stringify({ job_id: expired, status: 'running', updated_at: '2000-01-01T00:00:00.000Z', owner: 'old-process' }))
  assert.equal((await restarted(f.fs, f.cwd, expired)).status, 'failed')
  await restarted(f.fs, f.cwd, expired, async () => ({ resource: null, reason: 'restarted' }))
  await new Promise(setImmediate)
  assert.equal((await restarted(f.fs, f.cwd, expired)).status, 'completed')
  assert.equal(JSON.parse(f.records.get(join(f.cwd, `.dsh/init-jobs/${expired}.json`))).status, 'running', 'legacy record is read-only')
})

test('initialization watchdog records failure in memory even when the worker ignores its deadline', async t => {
  const { initJob } = await import('./lib/init-jobs.js')
  const { INIT_JOB_TIMEOUT_MS } = await import('./lib/init-timeout.js')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(), id = 'c'.repeat(64)
  let finish
  await initJob(f.fs, f.cwd, id, () => new Promise(resolve => { finish = resolve }))
  await new Promise(setImmediate)
  t.mock.timers.tick(INIT_JOB_TIMEOUT_MS)
  await new Promise(setImmediate)
  assert.equal((await initJob(f.fs, f.cwd, id)).status, 'failed')
  assert.ok((await initJob(f.fs, f.cwd, id)).error.includes(`${INIT_JOB_TIMEOUT_MS / 1000}秒`))
  assert.equal(f.records.has(join(f.cwd, `.dsh/init-jobs/${id}.json`)), false)
  finish({ resource: null, reason: 'late result' })
  await new Promise(setImmediate)
  assert.equal((await initJob(f.fs, f.cwd, id)).status, 'failed')
})

test('expired active jobs can be reclaimed and an old same-process worker cannot overwrite the new attempt', async t => {
  const { initJob } = await import('./lib/init-jobs.js')
  const { INIT_JOB_TIMEOUT_MS } = await import('./lib/init-timeout.js')
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const f = await fixture(), id = 'd'.repeat(64), path = join(f.cwd, `.dsh/init-jobs/${id}.json`)
  let finishOld, finishNew
  const old = await initJob(f.fs, f.cwd, id, () => new Promise(resolve => { finishOld = resolve }))
  await new Promise(setImmediate)
  t.mock.timers.tick(INIT_JOB_TIMEOUT_MS + 1)
  assert.equal((await initJob(f.fs, f.cwd, id)).status, 'failed')
  assert.equal(f.records.has(path), false, 'expiry does not write a project cache')
  const fresh = await initJob(f.fs, f.cwd, id, () => new Promise(resolve => { finishNew = resolve }))
  await new Promise(setImmediate)
  assert.notEqual(old.owner, fresh.owner)
  finishOld({ resource: null, reason: 'obsolete worker' })
  await new Promise(setImmediate)
  assert.equal((await initJob(f.fs, f.cwd, id)).status, 'running')
  finishNew({ resource: null, reason: 'new worker' })
  await new Promise(setImmediate)
  assert.equal((await initJob(f.fs, f.cwd, id)).result.reason, 'new worker')
})

test('memory job results expire automatically and are bounded across projects', async t => {
  // Keep the fake clock's timer handles separate from real timers created by earlier tests.
  const { initJob, INIT_JOB_RETENTION_MS, INIT_JOB_MAX_ENTRIES } = await import('./lib/init-jobs.js?memory-budget-test')
  const { INIT_JOB_TIMEOUT_MS } = await import('./lib/init-timeout.js')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(), root = join(f.cwd, 'memory-expiry'), id = '1'.repeat(64)
  await initJob(f.fs, root, id, async () => ({ resource: null, reason: 'temporary' }))
  await new Promise(setImmediate)
  assert.equal((await initJob(f.fs, root, id)).status, 'completed')
  t.mock.timers.tick(INIT_JOB_RETENTION_MS)
  await assert.rejects(initJob(f.fs, root, id), /已过期或 DSH 已重启/)
  for (let index = 0; index <= INIT_JOB_MAX_ENTRIES; index++) {
    const jobId = index.toString(16).padStart(64, '0')
    await initJob(f.fs, root, jobId, async () => ({ resource: null, reason: String(index) }))
    await new Promise(setImmediate)
  }
  await assert.rejects(initJob(f.fs, root, '0'.repeat(64)), /已过期或 DSH 已重启/)
  assert.equal((await initJob(f.fs, root, INIT_JOB_MAX_ENTRIES.toString(16).padStart(64, '0'))).status, 'completed')
  assert.ok(![...f.records.keys()].some(path => path.includes('init-jobs')))
  const liveRoot = join(f.cwd, 'memory-capacity')
  for (let index = 0; index < INIT_JOB_MAX_ENTRIES; index++) {
    await initJob(f.fs, liveRoot, index.toString(16).padStart(64, '0'), () => new Promise(() => {}))
  }
  await assert.rejects(initJob(f.fs, liveRoot, '9'.repeat(64), async () => ({ resource: null, reason: 'must not start' })), /数量已达上限/)
  assert.equal((await initJob(f.fs, liveRoot, '0'.repeat(64))).status, 'running', 'running work is never evicted to admit another request')
  t.mock.timers.tick(INIT_JOB_TIMEOUT_MS)
  await new Promise(setImmediate)
  assert.equal((await initJob(f.fs, liveRoot, '0'.repeat(64))).status, 'failed')
})

test('concurrent requests reuse a memory worker and initialization leaves a real project empty', async t => {
  const { initJob } = await import('./lib/init-jobs.js')
  const root = mkdtempSync(join(tmpdir(), 'task-engine-no-init-cache-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fs = { resolve: async (p, o) => join(o.cwd, p), readText: async p => { try { return readFileSync(p, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e } },
    writeText: async () => { throw new Error('initialization must not write cache files') } }
  let runs = 0, finish
  const start = () => { runs++; return new Promise(resolve => { finish = resolve }) }
  const id = '2'.repeat(64)
  const requests = await Promise.all([initJob(fs, root, id, start), initJob(fs, root, id, start)])
  assert.equal(runs, 1)
  assert.equal(requests[0].owner, requests[1].owner)
  finish({ resource: null, reason: 'done' })
  await new Promise(setImmediate)
  assert.equal((await initJob(fs, root, id)).status, 'completed')
  assert.deepEqual(readdirSync(root), [])
})

test('interrupted dispatch recovery refuses live children and allows a fresh attempt after inactivity', async () => {
  const f = await fixture()
  const state = f.current(); state.stage = '开发'; state.items = [{ id: 'I1', title: 'interrupted', status: 'doing', dispatch: {
    description: 'work', at: new Date().toISOString(), run_id: 'child', parent_session: 'assessment', status: 'running', provider: 'spawn',
  } }]; f.save(state)
  let activity = 'running'
  const get = f.ctx.get
  f.ctx.get = name => name === 'subagents' ? { listDescendants: async () => [{ id: 'child', kind: 'child', activity, parentId: 'assessment', depth: 1 }] } : get(name)
  await assert.rejects(() => f.call({ operation: 'recover_dispatch', item_id: 'I1' }), /may still be running/)
  activity = 'inactive'
  await f.call({ operation: 'recover_dispatch', item_id: 'I1' })
  assert.equal(f.current().items[0].status, 'todo')
  await f.call({ operation: 'dispatch', item_id: 'I1', execution: 'direct' })
  assert.equal(f.current().items[0].dispatch_history[0].run_id, 'child')
})

test('recovery uses the host recursive activity projection and refuses unknown or nested live runs', async () => {
  const f = await fixture()
  const s = f.current(); s.stage = '开发'; s.items = [{ id: 'I1', title: 'interrupted', status: 'doing', dispatch: {
    description: 'work', at: new Date().toISOString(), run_id: 'child', parent_session: 'assessment', status: 'running', provider: 'fork',
  } }]; f.save(s)
  const get = f.ctx.get
  let rows = []
  let service = { listChildren: async () => [{ id: 'child', mode: 'one-shot', createdAt: 1 }] }
  f.ctx.get = name => name === 'subagents' ? service : get(name)
  await assert.rejects(() => f.call({ operation: 'recover_dispatch', item_id: 'I1' }), /listDescendants/)
  service = { listDescendants: async () => rows }
  await assert.rejects(() => f.call({ operation: 'recover_dispatch', item_id: 'I1' }), /missing from the host catalog/)
  const child = { id: 'child', kind: 'child', parentId: 'assessment', depth: 1, activity: 'inactive' }
  rows = [child, { id: 'grandchild', kind: 'child', parentId: 'child', depth: 2, activity: 'running' }]
  await assert.rejects(() => f.call({ operation: 'recover_dispatch', item_id: 'I1' }), /may still be running/)
  rows[1] = { id: 'grandchild', kind: 'diagnostic', parentId: 'child', depth: 2, reason: 'unavailable' }
  await assert.rejects(() => f.call({ operation: 'recover_dispatch', item_id: 'I1' }), /may still be running/)
  rows = [child, { id: 'unrelated', kind: 'child', parentId: 'assessment', depth: 1, activity: 'running' }]
  await f.call({ operation: 'recover_dispatch', item_id: 'I1' })
  assert.equal(f.current().items[0].status, 'todo')
})

test('active dispatch prevents parent ledger edits and failed disposal requires host recovery', async () => {
  const f = await fixture()
  const s = f.current(); s.stage = '开发'; s.items = [{ id: 'I1', title: 'delegate', status: 'todo' }]; f.save(s)
  const get = f.ctx.get
  f.ctx.get = name => name === 'subagents' ? { getProvider: () => ({ inheritsParentContext: false, capabilities: { depthLimit: true } }), startActivation: async () => {
    for (const args of [
      { operation: 'items', items: [{ id: 'I1', title: 'changed', status: 'done' }] },
      { operation: 'scope', files: ['other.js'] },
      { operation: 'dispatch', item_id: 'I1' },
      { operation: 'revise', revision_kind: 'defect', revision_reason: 'change', target_stage: '开发' },
    ]) await assert.rejects(() => f.call(args), /child dispatch is still active/)
    await f.call({ operation: 'status' })
    return { childId: 'child', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => { throw new Error('cleanup interrupted') } }
  } } : get(name)
  await f.call({ operation: 'dispatch', item_id: 'I1', execution: 'spawn' })
  assert.equal(f.current().items[0].dispatch.status, 'running')
  assert.match(f.current().items[0].dispatch.error, /disposal failed/)
  assert.equal(f.current().items[0].dispatch.finished_at, undefined)
  await assert.rejects(() => f.call({ operation: 'dispatch', item_id: 'I1', execution: 'spawn' }), /child dispatch is still active/)
})

test('audit archive bounds history payload and retains full details for later lookup', async () => {
  const f = await fixture()
  const s = f.current(); s.stage = '代码审核'; s.sonar_policy = { enabled: true, host_url: 'https://sonar.example.invalid', project_key: 'test', mode: 'branch', token_env: 'FIXTURE' }
  const blocking = Array.from({ length: 200 }, (_, i) => ({ key: `issue-${i}`, rule: 'java:S100', message: 'detail'.repeat(200), severity: 'MAJOR', file: 'a.js' }))
  s.sonar_audit = { analysis_id: 'history-id', ce_task_id: 'local', checked_at: '2026-10-23T01:00:00.000Z', gate: 'ERROR', scope_hash: 'old', target: 'HEAD', findings: blocking, blocking }
  f.save(s)
  await f.call({ operation: 'revise', revision_kind: 'defect', revision_reason: 'fix', target_stage: '开发' })
  const history = f.current().sonar_history[0]
  assert.equal(history.blocking.length, 50)
  assert.equal(history.blocking_count, 200)
  assert.equal(JSON.parse(f.records.get(join(f.cwd, history.detail_path))).blocking.length, 200)
})

test('local findings outside the active project rule manifest are rejected', async () => {
  const { assertActiveFindingRules } = await import('./lib/sonarlint-local.js')
  const enabled = new Set(['mycompany-java:Routine'])
  assert.doesNotThrow(() => assertActiveFindingRules([{ rule: 'mycompany-java:Routine' }], enabled))
  assert.throws(() => assertActiveFindingRules([{ rule: 'java:DisabledRule' }], enabled), /未启用的规则/)
})

test('ledger cursor reads at most 100 records and does not lose or duplicate remaining tasks', async () => {
  const f = await fixture()
  for (let i = 0; i < 130; i++) {
    const id = `PAGE-${String(i).padStart(3, '0')}`
    f.records.set(join(f.cwd, `.dsh/task-${id}.json`), JSON.stringify({ ...f.current(), id }))
  }
  const receiver = { authorizedPath: async p => p, fs: () => f.fs }
  const first = await Controller.prototype.readTasks.call(receiver, f.cwd)
  assert.equal(first.tasks.length, 100)
  assert.equal(first.total_count, 131)
  const next = await Controller.prototype.readTasks.call(receiver, f.cwd, first.next_cursor)
  assert.equal(next.tasks.length, 31)
  assert.equal(next.next_cursor, undefined)
  assert.equal(new Set([...first.tasks, ...next.tasks].map(task => task.task_id)).size, 131)
})

test('successful task load cannot substitute for a load in another stage', () => {
  const skills = [{ skill: { source: 'project', name: 'one' }, rules: [], evidence: 'none' }]
  const workflow = resolveFlow('standard', { stage_bindings: { '需求评审': { skills }, '设计': { skills } } }).config
  const session = { id: 'assessment', snapshotEvents: () => [
    { type: 'tool/call', data: { name: 'dev_task', callId: 'load', arguments: JSON.stringify({ operation: 'load_skill', task_id: 'T', skill_name: 'project:one' }) } },
    { type: 'tool/result', data: { message: { toolCallId: 'load', isError: false } } },
  ] }
  const state = { id: 'T', stage: '需求评审', complexity: 'medium', skill_loads: { '需求评审': { 'project:one': { session_id: 'assessment' } } } }
  assert.deepEqual(skillBlockers(state, workflow, session), [])
  state.stage = '设计'
  assert.match(skillBlockers(state, workflow, session).join(' '), /again for this stage/)
})

test('changing the actual synchronized analyzer configuration invalidates the old local audit', async () => {
  const { localRulesFingerprint } = await import('./lib/sonarlint-local.js')
  const f = await fixture()
  const cache = mkdtempSync(join(tmpdir(), 'task-engine-rules-'))
  const prior = process.env.DSH_HOME
  process.env.DSH_HOME = cache
  try {
    const policy = { enabled: true, host_url: 'https://sonar.example.invalid', project_key: 'fixture', mode: 'branch', source: 'ide-local', reference_branch: 'HEAD', token_env: 'FIXTURE' }
    const key = hashText(`${resolve(f.cwd).toLowerCase()}\0${policy.host_url}\0${policy.project_key}`).slice(0, 24)
    const dir = join(cache, 'sonarlint-cache', key, Buffer.from('project').toString('hex'), 'projects', Buffer.from('fixture').toString('hex'))
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'analyzer_config.pb')
    writeFileSync(file, 'synced-rules-v1')
    const fingerprint = localRulesFingerprint(policy, f.cwd)
    assert.ok(fingerprint)
    const s = f.current(); s.stage = '代码审核'; s.sonar_policy = policy
    const { scopeFingerprint } = await import('./lib/dev-task.js')
    s.sonar_audit = { ce_task_id: 'local', analysis_id: 'audit', checked_at: new Date().toISOString(), target: 'HEAD', gate: 'OK', findings: [], blocking: [], rules_hash: fingerprint, scope_hash: await scopeFingerprint(f.fs, s, f.cwd) }
    f.save(s)
    assert.doesNotMatch(await f.call({ operation: 'status' }), /local rule configuration changed/)
    writeFileSync(file, 'synced-rules-v2')
    assert.notEqual(localRulesFingerprint(policy, f.cwd), fingerprint)
    assert.match(await f.call({ operation: 'status' }), /local rule configuration changed/)
  } finally { if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior }
})

test('initialization RPC reuses a resumed attempt and starts a fresh job after an explicit reset', async () => {
  const f = await fixture()
  let runs = 0
  const receiver = { projectInitRoot: async p => p, fs: () => f.fs, inspectProjectInit: async () => ({ inventory: { project_name: 'fixture' } }),
    generateProjectInitStep: async () => { runs++; return { resource: null, reason: 'optional step skipped' } } }
  const generation = { target: 'fixture-project-map', prior_resources: [], generation_id: 'attempt-one' }
  const first = await Controller.prototype.projectInitJob.call(receiver, { path: f.cwd, generation })
  await new Promise(setImmediate)
  const resumed = await Controller.prototype.projectInitJob.call(receiver, { path: f.cwd, generation })
  assert.equal(resumed.job_id, first.job_id)
  assert.equal(resumed.status, 'completed')
  assert.equal(runs, 1)
  const reset = await Controller.prototype.projectInitJob.call(receiver, { path: f.cwd, generation: { ...generation, generation_id: 'attempt-two' } })
  assert.notEqual(reset.job_id, first.job_id)
  await new Promise(setImmediate)
  assert.equal(runs, 2)
})

test('initialization RPC forwards a custom generation budget to the worker and its outer deadline', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const f = await fixture()
  let finish, minutes
  const receiver = { projectInitRoot: async p => p, fs: () => f.fs,
    inspectProjectInit: async () => ({ inventory: { project_name: 'fixture' } }),
    generateProjectInitStep: async request => { minutes = request.timeout_minutes; return new Promise(resolve => { finish = resolve }) } }
  const started = await Controller.prototype.projectInitJob.call(receiver, { path: f.cwd,
    generation: { target: 'fixture-project-map', prior_resources: [], generation_id: 'custom-budget', timeout_minutes: 5 } })
  await new Promise(setImmediate)
  assert.equal(minutes, 5)
  t.mock.timers.tick(330_001)
  const ended = await Controller.prototype.projectInitJob.call(receiver, { path: f.cwd, job_id: started.job_id })
  assert.equal(ended.status, 'failed', '5-minute generation budget has a 5-minute-30-second outer deadline')
  finish({ resource: null, reason: 'late' })
  await new Promise(setImmediate)
})

test('ledger cannot use a task-supplied root to inspect an unregistered workspace', async () => {
  const f = await fixture()
  const s = f.current(); s.root = resolve('unregistered-project'); s.verification = { passed: true, receipt: { scope_hash: 'old' } }; f.save(s)
  const receiver = { authorizedPath: async p => { if (p !== f.cwd) throw new Error('unregistered evidence root'); return p }, fs: () => f.fs }
  const view = await Controller.prototype.readTasks.call(receiver, f.cwd)
  assert.deepEqual(view.tasks, [])
  assert.match(view.errors[0].message, /unregistered evidence root/)
})
