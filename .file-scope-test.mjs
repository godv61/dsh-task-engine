/** File declarations, readable error projections and controlled recovery against real modules. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, rmSync, symlinkSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { registerDevTask, scopeFingerprint, verificationInputHashes } from './lib/dev-task.js'
import { validateTaskFiles } from './lib/task-files.js'
import Controller from './lib/controller.js'
import { taskDocument } from './lib/task-ledger-document.js'
import { confirmedRequirement } from './scripts/fixtures/confirmed-requirement.mjs'

const command = 'node --test --experimental-test-isolation=none --test-reporter=tap example.test.mjs'
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'task-file-scope-'))
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'task-file-scope-'))
    rmSync(root, { recursive: true, force: true })
  })
  const put = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text) }
  put('package.json', '{"type":"module"}\n')
  put('example.mjs', 'export const value = 2\n')
  put('example.test.mjs', 'import{test}from"node:test";import assert from"node:assert/strict";import{value}from"./example.mjs";test("business value",()=>assert.equal(value,2))\n')
  const fs = {
    resolve: async (file, options) => ({ path: resolve(options?.cwd ?? root, file) }),
    readText: async target => { try { return readFileSync(target.path, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e } },
    lstat: async (file, options) => {
      try {
        const info = lstatSync(resolve(options?.cwd ?? root, file))
        return { type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'symlink', version: info.mtimeMs + ':' + info.size }
      } catch (e) { if (e.code !== 'ENOENT') throw e }
    },
    listDir: async target => readdirSync(target.path, { withFileTypes: true }).map(e => ({ name: e.name,
      type: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file' })),
    writeText: async (target, text) => { mkdirSync(dirname(target.path), { recursive: true }); writeFileSync(target.path, text) },
  }
  let execute, shellCalls = 0
  const ctx = { fs, tools: { register(tool) { execute = tool.execute } }, get(name) {
    if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) }
    if (name === 'shell') return { resolve: value => value, run: async spec => {
      shellCalls++
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT
      const result = spawnSync(process.execPath, spec.command.split(' ').slice(1), { cwd: spec.workdir, encoding: 'utf8', env })
      return { exitCode: result.status, timedOut: false, aborted: false, stdout: { text: result.stdout ?? '' }, stderr: { text: result.stderr ?? '' },
        sandbox: { mode: 'workspace-write', denied: false } }
    } }
  } }
  registerDevTask(ctx)
  const call = args => execute({ task_id: 'SCOPE', ...args }, { agent: { session: { id: 'scope-fixture', header: { cwd: root }, snapshotEvents: () => [] } },
    signal: new AbortController().signal, callId: 'scope-call' })
  const ledger = join(root, '.dsh/tasks/SCOPE/task.json')
  const raw = () => readFileSync(ledger, 'utf8'), state = () => JSON.parse(raw())
  await call({ operation: 'create', title: 'Scope regression', intent: 'implementation', intent_reason: 'Isolated scope fixture', branch: 'fixture',
    complexity: 'medium', complexity_reason: 'Local implementation', files: ['example.mjs', 'example.test.mjs'], items: [{ id: 'I1', title: 'complete unit' }] })
  const initial = confirmedRequirement(state(), put); initial.stage = '代码开发'; writeFileSync(ledger, JSON.stringify(initial))
  const plan = (files, id = 'checks') => call({ operation: 'plan_verification', verification_group: id, files, command, item_ids: ['I1'] })
  const view = () => Controller.prototype.readTasks.call({ authorizedPath: async path => path, fs: () => fs }, root)
  return { root, fs, put, call, raw, state, plan, view, calls: () => shellCalls }
}

for (const operation of ['create', 'scope', 'plan', 'plan_execution', 'plan_verification']) {
  test(operation + ' rejects existing directories before any task mutation', async t => {
    const f = await fixture(t)
    mkdirSync(join(f.root, 'module'))
    const before = f.raw()
    const fields = { files: ['module'], acceptance: ['works'], task_boundary: 'local', execution_reason: 'one complete unit', depends_on: [] }
    const args = operation === 'create'
      ? { operation, task_id: 'BAD', title: 'bad scope', intent: 'implementation', intent_reason: 'fixture', branch: 'fixture', complexity: 'medium', complexity_reason: 'fixture', files: ['module'] }
      : operation === 'plan' ? { operation, plans: [{ id: 'I1', title: 'complete unit', ...fields }] }
      : operation === 'plan_execution' ? { operation, item_id: 'I1', ...fields }
      : operation === 'plan_verification' ? { operation, verification_group: 'checks', command, files: ['module'], item_ids: ['I1'] }
      : { operation, files: ['module'] }
    await assert.rejects(f.call(args), /INVALID_FILE_SCOPE.*regular files, not directories/)
    assert.equal(f.raw(), before)
    assert.equal(await f.fs.lstat('.dsh/tasks/BAD/task.json', { cwd: f.root }), undefined)
  })
}

test('all declarations permit concrete new files, including extensionless files and bracketed routes', async t => {
  const f = await fixture(t)
  for (const use of ['delivery', 'verification'])
    assert.deepEqual(await validateTaskFiles(f.fs, ['new/module', 'routes/[slug]/page.tsx'], f.root, 'test', use),
      ['new/module', 'routes/[slug]/page.tsx'])
  await f.call({ operation: 'scope', files: ['new/module', 'routes/[slug]/page.tsx'] })
  await f.plan(['new/module', 'routes/[slug]/page.tsx'])
})

test('scope and verification reject ledger inputs and traversal; sensitive delivery policy is consistent', async t => {
  const f = await fixture(t)
  for (const path of ['.dsh/tasks/SCOPE/task.json', '../outside.txt', '*.mjs']) {
    const before = f.raw()
    await assert.rejects(f.call({ operation: 'scope', files: [path] }), /INVALID_FILE_SCOPE/)
    await assert.rejects(f.plan([path]), /INVALID_FILE_SCOPE/)
    assert.equal(f.raw(), before)
  }
  f.put('.env', 'FIXTURE_ONLY=value\n')
  await assert.rejects(f.call({ operation: 'scope', files: ['.env'] }), /sensitive delivery path/)
  // Ordinary configuration may be a read-only test input under existing policy.
  await f.plan(['example.mjs', 'example.test.mjs', '.env'])
  const first = await verificationInputHashes(f.fs, f.state(), f.root)
  f.put('.env', 'FIXTURE_ONLY=changed\n')
  assert.notEqual((await verificationInputHashes(f.fs, f.state(), f.root)).checks, first.checks)
})

test('future directory stays visible in status, ledger, transport and Markdown; verification stays blocked', async t => {
  const f = await fixture(t)
  await f.plan(['example.mjs', 'example.test.mjs', 'future'])
  await f.call({ operation: 'verify', verification_group: 'checks' })
  assert.equal(f.state().verification.passed, true)
  f.put('future/new.mjs', 'export const added = 1\n')
  const before = f.raw()
  const status = JSON.parse(await f.call({ operation: 'status' }))
  assert.ok(status.file_scope_problems.some(problem => /checks.*future/u.test(problem)))
  assert.ok(status.evidence_blockers.length)
  assert.equal(status.commit.allowed, false)
  const view = await f.view(), task = view.tasks[0]
  assert.equal(view.tasks.length, 1)
  assert.equal(view.errors, undefined)
  assert.equal(task.title, 'Scope regression')
  assert.equal(task.evidence_status, 'blocked')
  assert.equal(task.verification_passed, false)
  assert.equal(task.verification_groups[0].status, 'blocked')
  assert.match(task.evidence_problems.join('\n'), /checks.*future/)
  assert.match(taskDocument(task), /文件范围或证据无法核验/)
  assert.equal(f.raw(), before) // Rendering/status never rewrites original evidence.
  await assert.rejects(f.call({ operation: 'verify', verification_group: 'checks' }), /INVALID_FILE_SCOPE/)
  await assert.rejects(f.call({ operation: 'advance', target_stage: '测试' }), /INVALID_FILE_SCOPE/)
  assert.equal(f.calls(), 1)
  await f.plan(['example.mjs', 'example.test.mjs', 'future/new.mjs'])
  assert.equal(f.state().verification.passed, false)
  await f.call({ operation: 'verify', verification_group: 'checks' })
  assert.equal((await f.view()).tasks[0].evidence_status, 'valid')
  assert.equal(f.calls(), 2)

  let registration, contribution
  runInNewContext(readFileSync('lib/client.js', 'utf8'), { window: { __ModuleLoader__: { load(value) { registration = value } } } })
  // React is provided by the DSH browser host. Codec registration does not
  // render components and must also run in a clean npm consumer without React.
  const client = registration.factory(() => ({}))
  const stop = new Error('descriptors captured')
  await assert.rejects(client.apply({ remote: { $mount: async value => { contribution = value; throw stop } } }), error => error === stop)
  const method = contribution.descriptors.find(d => d.method === 'readTasks')
  assert.deepEqual(JSON.parse(JSON.stringify(method.result.create().parse(view))), view)
})

test('two invalid groups can be repaired individually without faking either receipt', async t => {
  const f = await fixture(t)
  await f.plan(['example.mjs', 'example.test.mjs', 'future-a'], 'a')
  await f.plan(['example.mjs', 'example.test.mjs', 'future-b'], 'b')
  f.put('future-a/a.mjs', 'a\n'); f.put('future-b/b.mjs', 'b\n')
  assert.equal((await f.view()).tasks[0].verification_groups.filter(g => g.status === 'blocked').length, 2)
  await f.plan(['example.mjs', 'example.test.mjs', 'future-a/a.mjs'], 'a')
  assert.equal(f.state().verification.passed, false)
  const partial = await f.view()
  assert.equal(partial.tasks[0].evidence_status, 'blocked')
  assert.ok(partial.tasks[0].evidence_problems.some(p => /group b/.test(p)))
  await assert.rejects(f.call({ operation: 'verify', verification_group: 'a' }), /group b.*future-b/)
  assert.equal(f.calls(), 0)
  await f.plan(['example.mjs', 'example.test.mjs', 'future-b/b.mjs'], 'b')
  assert.equal((f.state().verification_runs ?? []).length, 0)
  await f.call({ operation: 'verify', verification_group: 'a' })
  await f.call({ operation: 'verify', verification_group: 'b' })
  assert.equal(f.state().verification.passed, true)
  assert.equal((await f.view()).tasks[0].evidence_status, 'valid')
})

test('a declared delivery file that becomes a directory is repairable through scope', async t => {
  const f = await fixture(t)
  await f.call({ operation: 'scope', files: ['future'] })
  f.put('future/real.mjs', 'content\n')
  assert.equal((await f.view()).tasks[0].evidence_status, 'blocked')
  const before = f.raw()
  assert.ok(JSON.parse(await f.call({ operation: 'status' })).file_scope_problems.length)
  assert.equal(f.raw(), before)
  await f.call({ operation: 'scope', files: ['future/real.mjs'] })
  assert.deepEqual(JSON.parse(await f.call({ operation: 'status' })).file_scope_problems, [])
})

test('legal prototype-like group IDs are not mistaken for file diagnostics', async t => {
  const f = await fixture(t)
  await f.plan(['example.mjs', 'example.test.mjs'], 'constructor')
  const view = await f.view()
  assert.equal(view.tasks.length, 1)
  assert.equal(view.tasks[0].evidence_problems, undefined)
  await f.call({ operation: 'verify', verification_group: 'constructor' })
  assert.equal((await f.view()).tasks[0].evidence_status, 'valid')
})

test('linked parents are rejected even for a missing target file', async t => {
  const f = await fixture(t)
  mkdirSync(join(f.root, 'actual'))
  symlinkSync(join(f.root, 'actual'), join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.call({ operation: 'scope', files: ['linked/missing.mjs'] }), /parent is not an ordinary directory/)
  await assert.rejects(f.plan(['linked/missing.mjs']), /parent is not an ordinary directory/)
  await assert.rejects(scopeFingerprint(f.fs, { ...f.state(), files: ['linked/missing.mjs'] }, f.root), /INVALID_FILE_SCOPE/)
})

test('a missing declared file that becomes a linked file never gets a valid fingerprint', async t => {
  const f = await fixture(t)
  await f.plan(['example.mjs', 'example.test.mjs', 'future-link'])
  mkdirSync(join(f.root, 'actual'))
  symlinkSync(join(f.root, 'actual'), join(f.root, 'future-link'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(verificationInputHashes(f.fs, f.state(), f.root), /non-regular/)
  assert.equal((await f.view()).tasks[0].evidence_status, 'blocked')
})

test('unreadable evidence preserves task identity and never promotes an old passing run', async t => {
  const f = await fixture(t)
  await f.plan(['example.mjs', 'example.test.mjs'])
  await f.call({ operation: 'verify', verification_group: 'checks' })
  const read = f.fs.readText
  f.fs.readText = async target => {
    if (target.path === join(f.root, 'example.mjs')) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' })
    return read(target)
  }
  const view = await f.view()
  assert.equal(view.tasks.length, 1)
  assert.equal(view.tasks[0].evidence_status, 'blocked')
  assert.equal(view.tasks[0].verification_passed, false)
  assert.match(view.tasks[0].evidence_problems.join('\n'), /example.mjs.*fixture denied/)
  assert.ok(JSON.parse(await f.call({ operation: 'status' })).file_scope_problems.length)
  await assert.rejects(f.call({ operation: 'verify', verification_group: 'checks' }), /fixture denied/)
})
