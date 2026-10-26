// Read-only verification of the real rc.3 fixture, child logs and parent receipts.
// Writes only this assessment's compact evidence, never the live task ledger.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames } from 'file:///D:/dsharness/deepseek-harness-rc3/packages/session/session-persistence-jsonl/src/zstd.ts'
import { verificationInputHashes } from '../../lib/dev-task.js'
import { groupEvidenceBlockers, latestGroupRun } from '../../lib/verification-state.js'
import { executionItemBlockers, fullReadCoverage } from '../../lib/execution-plan.js'

const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
const root = join(tmpdir(), 'dsh-rc3-acceptance-20261026')
const task = json(join(root, '.dsh/task-RC3-ACCEPT-20261026.json'))
const before = json(new URL('./rc3-live-after-add.json', import.meta.url))
const parentId = 'session-bb7074ae-8559-4476-8b16-1cafb5a8c2f7'
const sessions = join(tmpdir(), 'task-engine-rc3-local-20261026/sessions/--C-Users-ggbond-AppData-Local-Temp-dsh-rc3-acceptance-20261026--')
const fs = {
  resolve: async (path, options) => ({ key: join(options?.cwd ?? root, path) }),
  lstat: async (path, options) => {
    try { return { type: lstatSync(join(options?.cwd ?? root, path)).isFile() ? 'file' : 'other' } }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  },
  readBytes: async target => readFileSync(target.key),
}
function log(id) {
  const bytes = readFileSync(join(sessions, id, 'session.v4.jsonl.zstd'))
  const frames = scanZstdFrames(bytes)
  assert.equal(frames.tornStart, undefined)
  const rows = Buffer.concat(frames.frames.map(frame => zstdDecompressSync(bytes.subarray(frame.start, frame.end))))
    .toString('utf8').trim().split('\n').map(JSON.parse)
  const seedEnd = rows[0].isSeeded ? rows.findIndex(row => row.type === 'session/end-seed') : -1
  const own = seedEnd < 0 ? rows.slice(1) : rows.slice(seedEnd + 1)
  const usage = {}
  for (const row of own.filter(row => row.type === 'assistant/message')) {
    for (const [key, value] of Object.entries(row.data.usage ?? {})) if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value
  }
  const calls = own.filter(row => row.type === 'tool/call').map(row => ({ seq: row.seq, ...row.data, args: JSON.parse(row.data.arguments ?? '{}') }))
  return { header: rows[0], own, calls, inherited_records: Math.max(0, seedEnd - 1), usage }
}
const hashes = await verificationInputHashes(fs, task, root)
assert.equal(task.verification.passed, true)
assert.deepEqual(groupEvidenceBlockers(task, hashes), [])
assert.equal(task.stage, '代码开发')
assert.deepEqual(task.commits, [])
assert.equal(task.completed, undefined)
assert.equal(task.items.length, 2)
assert.equal(task.verification_runs.length, 2)
assert.deepEqual(latestGroupRun(task, 'add'), latestGroupRun(before, 'add'))
assert.deepEqual(Object.fromEntries(Object.keys(before.items[0]).map(key => [key, task.items[0][key]])), before.items[0])
const parent = log(parentId)
assert.equal(parent.own.filter(row => row.type === 'turn/start').length, 3)
const lastTurn = parent.own.filter(row => row.type === 'turn/start').at(-1).seq
assert.deepEqual(parent.calls.filter(call => call.seq > lastTurn && call.name === 'dev_task' && call.args.operation === 'verify')
  .map(call => call.args.verification_group), ['multiply'])
assert.ok(!parent.calls.some(call => ['write', 'edit'].includes(call.name) && /\.dsh[\\/]task-/u.test(String(call.args.file_path ?? ''))))
assert.ok(!parent.calls.some(call => call.args.sandbox_permissions === 'require_escalated'))
const items = task.items.map(item => {
  assert.equal(item.status, 'done')
  assert.deepEqual(executionItemBlockers(task, item), [])
  const implementation = log(item.dispatch.run_id)
  assert.equal(implementation.header.parentSession, parentId)
  assert.equal(implementation.header.cwd, root)
  const descriptor = implementation.own.find(row => row.type === 'subagent/descriptor').data
  assert.equal(descriptor.provider, item.execution_plan.mode)
  assert.equal(implementation.header.isSeeded, item.execution_plan.mode === 'fork')
  if (item.execution_plan.mode === 'fork') assert.ok(implementation.inherited_records > 0)
  const review = item.independent_review
  const reviewer = log(review.run_id)
  assert.equal(reviewer.header.agentPreset, 'task-engine-review')
  assert.equal(reviewer.header.parentSession, parentId)
  assert.equal(reviewer.header.isSeeded, false)
  const catalogs = reviewer.own.filter(row => row.type === 'request/header').map(row => row.data.header.tools.map(tool => tool.name).sort())
  assert.ok(catalogs.length > 0)
  for (const tools of catalogs) assert.deepEqual(tools, ['read', 'structured_output'])
  assert.ok(reviewer.calls.every(call => ['read', 'structured_output'].includes(call.name)))
  assert.ok(reviewer.calls.some(call => call.name === 'structured_output'))
  const source = item.execution_plan.files.map(file => ({ file, content: readFileSync(join(root, file), 'utf8') }))
  assert.deepEqual(fullReadCoverage(reviewer.own, source, path => resolve(root, path).toLowerCase()), review.read_coverage)
  return { id: item.id, status: item.status, mode: item.execution_plan.mode, implementation_id: item.dispatch.run_id,
    inherited_records: implementation.inherited_records, review_id: review.run_id, policy: review.policy,
    actual_review_catalogs: catalogs, actual_review_calls: reviewer.calls.map(call => call.name),
    full_reads: review.read_coverage, spec: review.spec, quality: review.quality,
    implementation_usage: implementation.usage, review_usage: reviewer.usage }
})
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
assert.equal(git('branch', '--show-current'), 'codex/rc3-smoke-20261026')
assert.equal(git('rev-list', '--all', '--count'), '1')
assert.equal(git('diff', '--', 'package.json'), '')
const groups = ['add', 'multiply'].map(id => {
  const run = latestGroupRun(task, id)
  assert.equal(run.passed, true)
  assert.equal(run.receipt.exit_code, 0)
  assert.equal(run.receipt.sandbox.mode, 'workspace-write')
  return { id, run_id: run.id, command: run.receipt.command, tests: run.receipt.test_summary.count,
    exit_code: run.receipt.exit_code, sandbox: run.receipt.sandbox, current_hash: run.receipt.scope_hash === hashes[id] }
})
assert.equal(groups[0].tests, 17)
assert.equal(groups[1].tests, 18)
const result = {
  captured_at: new Date().toISOString(), captured_at_east8: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) + ' UTC+08:00',
  assertions_passed: true, dsh_tag: 'dsh-v0.2.1-rc.3', dsh_revision: '1f81c047fc48fa190a683e469daa699857e9afe8',
  plugin_version: '0.35.0-local-unpublished', root, parent_id: parentId, stage: task.stage,
  verified: task.verification.passed, items, groups, add_item_and_receipt_preserved: true,
  initial_failed_review_attempts: task.items[0].independent_review_history.map(review => ({ status: review.status, error: review.error })),
  parent_own_tool_calls: parent.calls.length, parent_usage: parent.usage,
  file_hashes: Object.fromEntries([...task.files, 'package.json'].map(file => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')])),
  limits: ['Explicit spawn/fork instructions in a controlled fixture; this does not establish optimal automatic delegation cost.',
    'Initial D: fixtures failed native Windows ACL provisioning; no ACL-repair command was approved.',
    'Reviewer startup failed twice before the local guard fix; first parent turn searched outside the fixture and was stopped.',
    'Runtime cancellation, cleanup failure and observation lease release were controlled API tests, not live cancellation trials.',
    'Task-level review, SonarQube, commit, publish and archive were intentionally not executed.'],
}
writeFileSync(new URL('./rc3-live-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ assertions_passed: true, groups, items: items.map(({ id, mode, implementation_id, review_id }) => ({ id, mode, implementation_id, review_id })) }, null, 2))
