/** Task bundles, public projections and document exports against production modules. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  symlinkSync,
  rmSync,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import * as model from './lib/task-ledger-document.js'
import {
  TASKS_DIRECTORY,
  taskPath,
  taskDirectory,
  taskRequirementPath,
  taskMaterialDirectory,
  taskReviewDirectory,
  isEngineMeta,
  validTaskId,
  isTaskReviewPath,
} from './lib/task-paths.js'
import { loadTask, writeTask, listTaskIds, taskNamespace } from './lib/task-store.js'
import { newTask, checkFileScope } from './lib/engine.js'
import { adaptiveWorkflow } from './lib/adaptive.js'
import { taskLedgerContent } from './lib/task-ledger-content.js'
import Controller from './lib/controller.js'

const stateFor = (root, id = 'BUNDLE-1') =>
  newTask({
    id,
    title: 'Approval withdrawal',
    branch: 'feature/approval',
    work_size: 'standard',
    risk_level: 'standard',
    root,
    flow: { flow: 'adaptive-medium', version: 2, config: adaptiveWorkflow('medium') },
  })
const hostFs = (root) => ({
  resolve: async (path, opts) => ({ path: resolve(opts?.cwd ?? root, path) }),
  readText: async (target) => {
    try {
      return readFileSync(target.path, 'utf8')
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  },
  listDir: async (target) =>
    readdirSync(target.path, { withFileTypes: true }).map((e) => ({
      name: e.name,
      type: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file',
    })),
  lstat: async (path, opts) => {
    try {
      const s = lstatSync(resolve(opts?.cwd ?? root, path))
      return {
        version: `${s.mtimeMs}:${s.size}`,
        type: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'symlink',
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  },
  writeText: async (target, text, intent) => {
    mkdirSync(dirname(target.path), { recursive: true })
    if (intent?.kind === 'createIfAbsent') writeFileSync(target.path, text, { flag: 'wx' })
    else writeFileSync(target.path, text)
  },
})

test('task ids cannot escape, alias Windows devices, or collide by sanitization', () => {
  for (const id of ['../OTHER', 'A/B', 'A\\B', 'A.B', '', 'CON', 'nul', 'LPT1', 'COM9', 'x'.repeat(65)]) {
    assert.equal(validTaskId(id), false)
    assert.throws(() => taskPath(id))
  }
  assert.equal(taskPath('REQ-42'), '.dsh/tasks/REQ-42/task.json')
  assert.equal(taskRequirementPath('REQ-42'), '.dsh/tasks/REQ-42/requirement.md')
  assert.equal(taskMaterialDirectory('REQ-42'), '.dsh/tasks/REQ-42/materials')
  assert.equal(taskReviewDirectory('REQ-42'), '.dsh/tasks/REQ-42/reviews')
  assert.equal(isTaskReviewPath('REQ-42', '.dsh/tasks/REQ-42/reviews/../../OTHER/task.json'), false)
})

test('only actual metadata receives the engine exemption, never the whole task bundle', () => {
  const state = stateFor(process.cwd())
  state.files = ['app.ts']
  for (const path of [taskPath(state.id), '.dsh/eng.json', '.dsh/meta.json']) assert.equal(isEngineMeta(path), true)
  assert.equal(isEngineMeta('module/' + taskPath(state.id)), true)
  for (const path of [
    taskRequirementPath(state.id),
    `${taskReviewDirectory(state.id)}/review.json`,
    `${taskDirectory(state.id)}/other.json`,
    '.dsh/tasks/../meta.json',
  ]) {
    assert.equal(isEngineMeta(path), false)
    assert.equal(checkFileScope(state, [path], state.flow.config).ok, false)
  }
})

test('real task storage discovers direct task directories and isolates a mismatched record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-bundle-store-')),
    fs = hostFs(root)
  try {
    const state = stateFor(root)
    await writeTask(fs, state, root, 'workspace-write')
    assert.equal((await loadTask(fs, state.id, root)).title, state.title)
    assert.deepEqual(await listTaskIds(fs, root), [state.id])
    writeFileSync(join(root, TASKS_DIRECTORY, 'notes.txt'), 'not a task')
    mkdirSync(join(root, taskDirectory('MISMATCH')), { recursive: true })
    writeFileSync(join(root, taskPath('MISMATCH')), JSON.stringify({ ...state, id: 'OTHER' }))
    const view = await Controller.prototype.readTasks.call({ authorizedPath: async (p) => p, fs: () => fs }, root)
    assert.deepEqual(
      view.tasks.map((t) => t.task_id),
      [state.id],
    )
    assert.equal(view.errors.length, 1)
    assert.match(view.errors[0].message, /编号与目录不一致/)
    assert.equal(view.tasks[0].content.ledger_path, taskPath(state.id))
    assert.ok(!readFileSync(join(root, taskPath(state.id)), 'utf8').includes('notes.txt'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('task records cannot be read or written through a linked task directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-bundle-link-')),
    outside = join(root, 'other')
  try {
    mkdirSync(outside)
    mkdirSync(join(root, TASKS_DIRECTORY), { recursive: true })
    writeFileSync(join(outside, 'task.json'), JSON.stringify(stateFor(root)))
    symlinkSync(outside, join(root, taskDirectory('BUNDLE-1')), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(loadTask(hostFs(root), 'BUNDLE-1', root), /链接|联接/)
    await assert.rejects(writeTask(hostFs(root), stateFor(root), root, 'workspace-write'), /链接|联接/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a source-root-relative namespace still locates the selected child workspace', () => {
  const root = resolve('sample-project'),
    cwd = join(root, 'module')
  const namespace = taskNamespace('R1', root, cwd)
  assert.equal(namespace, 'module/.dsh/tasks/R1')
  assert.equal(resolve(root, taskRequirementPath('R1', namespace)), resolve(cwd, taskRequirementPath('R1')))
  assert.throws(() => taskNamespace('R1', cwd, root), /越出/)
})

test('readable projection, strict transport and Markdown preserve scope, dependencies and stale evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-bundle-view-'))
  try {
    const state = stateFor(root),
      config = state.flow.config
    state.stage = '代码开发'
    state.files = ['server.ts']
    state.artifacts = { requirement: { goal: 'Withdraw before approval', acceptance: 'Another user is denied' } }
    state.items = [
      {
        id: 'BACK',
        title: 'Backend',
        status: 'doing',
        execution_plan: {
          requested: 'auto',
          mode: 'direct',
          reason: 'One state module',
          boundary: 'local',
          context: 'brief',
          files: ['server.ts'],
          acceptance: ['Unauthorized requests are denied'],
          depends_on: [],
          review: 'main',
          review_reason: 'Main review',
          capabilities: { spawn: false, fork: false, reviewer: false },
          at: '2026-11-02T00:00:00Z',
        },
      },
      {
        id: 'WEB',
        title: 'Frontend',
        status: 'todo',
        execution_plan: {
          requested: 'auto',
          mode: 'direct',
          reason: 'Serial unit',
          boundary: 'local',
          context: 'brief',
          files: ['web.vue'],
          acceptance: ['Refresh on success'],
          depends_on: ['BACK'],
          review: 'main',
          review_reason: 'Main review',
          capabilities: { spawn: false, fork: false, reviewer: false },
          at: '2026-11-02T00:00:00Z',
        },
      },
    ]
    state.verification_groups = {
      web: {
        id: 'web',
        command: 'node --test web.test.mjs',
        files: ['web.vue', 'shared-fixture.json'],
        item_ids: ['WEB'],
        key: 'fixture',
        at: '2026-11-02T00:00:00Z',
      },
    }
    const content = taskLedgerContent(state)
    assert.deepEqual(content.files, ['server.ts'])
    assert.deepEqual(content.verification_inputs[0].files, ['server.ts', 'shared-fixture.json', 'web.vue'])
    assert.equal(content.artifacts[0].fields[0].label, '业务目标与当前问题')
    let registration, remote
    runInNewContext(readFileSync('lib/client.js', 'utf8'), {
      window: {
        __ModuleLoader__: {
          load(value) {
            registration = value
          },
        },
      },
    })
    const client = registration.factory(() => ({})),
      stop = new Error('captured')
    await assert.rejects(
      client.apply({
        remote: {
          $mount: async (value) => {
            remote = value
            throw stop
          },
        },
      }),
      (error) => error === stop,
    )
    const entry = {
      task_id: state.id,
      title: state.title,
      stage: state.stage,
      branch: state.branch,
      items: state.items,
      lifecycle: 'active',
      items_done: 0,
      next_action: 'Continue backend',
      evidence_status: 'stale',
      review_status: 'missing',
      content,
    }
    const view = remote.descriptors
      .find((d) => d.method === 'readTasks')
      .result.create()
      .parse({ tasks: [entry] })
    assert.deepEqual(JSON.parse(JSON.stringify(view.tasks[0].content)), content)
    assert.equal(model.registeredFiles(entry).find((f) => f.path === 'web.vue').plannedOnly, true)
    const document = model.taskDocument(entry)
    for (const text of [
      '业务目标与当前问题',
      'Unauthorized requests are denied',
      '依赖：BACK',
      'shared-fixture.json',
      '测试回执已过期',
      '不代表实际 Git 变更',
    ])
      assert.ok(document.includes(text), text)
    assert.equal(state.stage, '代码开发')
    assert.equal(state.requirement_confirmed, false)
    assert.ok(config.stages.includes(state.stage))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
