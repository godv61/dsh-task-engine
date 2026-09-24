/**
 * End-to-end test for the installed commit-msg hook.
 *
 * The P0 suite asserts on the hook SOURCE (that it disables path quoting, reads
 * NUL-separated paths, bundles the frozen snapshot). Those assertions catch a
 * hand-mirror regressing, but they cannot show the gate actually blocks a commit
 * — a hook that refuses everything, or nothing, passes every one of them.
 *
 * This runs the real bundled hook inside a throwaway git repository and asserts
 * both directions: an illegal commit is refused, a legal one proceeds.
 *
 * Run: `node --test .hook-test.mjs`
 * @module dsh-task-engine/.hook-test
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'

const HOOK = resolve('hooks/commit-msg')

/**
 * Git runs a hook by handing it to its own POSIX shell, which resolves
 * `#!/usr/bin/env node` against PATH. On Windows a `node.cmd` shim on PATH is
 * not executable from that shell, so the installed hook is wrapped in a
 * launcher that names the very interpreter running this test. Without it the
 * suite would read as the gate refusing everything, when in truth the hook
 * never started.
 */
const NODE = process.execPath.replace(/\\/gu, '/')

/** Run a git command in `cwd`, returning stdout (throws on non-zero exit). */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Run `git commit` and report whether the hook allowed it.
 * A refused commit surfaces as a non-zero exit whose stderr carries the gate's
 * own Chinese refusal banner.
 */
function tryCommit(cwd, message) {
  try {
    execFileSync('git', ['commit', '-m', message], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { allowed: true, stderr: '' }
  } catch (error) {
    return { allowed: false, stderr: String(error.stderr ?? '') }
  }
}

/** Build a throwaway repository with the real hook installed and one staged file. */
function repo(name, task) {
  const root = mkdtempSync(join(tmpdir(), `engine-hook-${name}-`))
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  mkdirSync(join(root, '.dsh'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  // The gate body stays byte-identical to the shipped hook; only the shebang is
  // replaced, so the test exercises the real gate under a runnable interpreter.
  const gate = readFileSync(HOOK, 'utf8').replace(/^#![^\n]*\n/u, '')
  writeFileSync(join(root, '.git', 'hooks', 'commit-msg'), `#!${NODE}\n${gate}`)
  writeFileSync(join(root, '.git', 'hooks', 'package.json'), '{\n  "type": "commonjs"\n}\n')
  writeFileSync(join(root, '.dsh', `task-${task.id}.json`), JSON.stringify(task, null, 2))
  writeFileSync(join(root, 'src', 'app.js'), 'console.log(1)\n')
  git(root, ['add', 'src/app.js'])
  return root
}

/**
 * A standard-flow task that has reached the commit checkpoint with a declared
 * scope. `代码审核` is the checkpoint stage, and the engine only permits a
 * commit there once that stage's OUTGOING guards already hold — so the fixture
 * must also satisfy the review artifact and the review verdict.
 */
function approvedTask(overrides = {}) {
  return {
    schema: 1,
    id: 'HOOK-1',
    title: 'hook probe',
    branch: 'main',
    work_size: 'standard',
    risk_level: 'standard',
    stage: '代码审核',
    requirement_confirmed: true,
    solution_confirmed: true,
    items: [{ id: 'i1', title: 'do the thing', status: 'done', review: { spec: { outcome: 'pass' }, quality: { outcome: 'pass' } } }],
    verification: { passed: true, evidence: [] },
    review: { outcome: 'pass' },
    // The `代码审核 -> 完成` edge requires `review_passed` and `artifacts_present`.
    artifacts: { review: { conclusion: 'looks good', issues: 'none' } },
    files: ['src/app.js'],
    commits: [],
    flow: { flow: 'standard', version: 2, config: null },
    ...overrides,
  }
}

/**
 * Resolve the standard preset's config the way a real project has it: the skeleton
 * plus the shipped recommendation, adopted. The hook reads the project's config
 * from disk, so a project that adopted the recommendation is what these tests
 * describe — the bare skeleton has no commit rule or artifacts to check.
 */
async function standardConfig() {
  const { resolveFlow, adoptRecommendation } = await import('./lib/workflows.js')
  const resolved = resolveFlow('standard', adoptRecommendation('standard'))
  assert.equal(resolved.ok, true, 'the built-in standard preset resolves')
  return resolved.config
}

test('a task at its checkpoint with the right message commits', async () => {
  const config = await standardConfig()
  const root = repo('allow', approvedTask({ flow: { flow: 'standard', version: 2, config } }))
  try {
    const result = tryCommit(root, '【HOOK-1】【TASK】probe the hook')
    assert.equal(result.allowed, true, `expected the commit to proceed, stderr: ${result.stderr}`)
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    rmSync(root, { recursive: true, force: true })
  }
})

test('a message that violates the configured pattern is refused', async () => {
  const config = await standardConfig()
  const root = repo('badmsg', approvedTask({ flow: { flow: 'standard', version: 2, config } }))
  try {
    const result = tryCommit(root, 'no task id here')
    assert.equal(result.allowed, false, 'a malformed summary must be refused')
    assert.match(result.stderr, /提交门禁拒绝/, 'the gate states its own refusal reason')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a commit touching files outside the declared scope is refused', async () => {
  const config = await standardConfig()
  const root = repo('scope', approvedTask({ flow: { flow: 'standard', version: 2, config } }))
  try {
    writeFileSync(join(root, 'src', 'other.js'), 'console.log(2)\n')
    git(root, ['add', 'src/other.js'])
    const result = tryCommit(root, '【HOOK-1】【TASK】probe the hook')
    assert.equal(result.allowed, false, 'an out-of-scope path must be refused')
    assert.match(result.stderr, /任务范围之外/, 'the refusal names the scope violation')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a commit before the checkpoint stage is refused', async () => {
  const config = await standardConfig()
  const root = repo('stage', approvedTask({ stage: '开发', flow: { flow: 'standard', version: 2, config } }))
  try {
    const result = tryCommit(root, '【HOOK-1】【TASK】probe the hook')
    assert.equal(result.allowed, false, 'committing before the checkpoint must be refused')
    assert.match(result.stderr, /提交门禁拒绝/, 'the gate states its refusal reason')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a task whose frozen snapshot was edited is refused', async () => {
  const config = await standardConfig()
  const tampered = { ...config, start_stage: '开发' }
  const root = repo('tamper', approvedTask({
    flow: { flow: 'standard', version: 2, config: tampered, hash: 'not-the-real-hash' },
  }))
  try {
    const result = tryCommit(root, '【HOOK-1】【TASK】probe the hook')
    assert.equal(result.allowed, false, 'a snapshot hash mismatch must be refused')
    assert.match(result.stderr, /hash 不匹配/, 'the refusal names the integrity failure')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('touching a sensitive path without a high-risk receipt is refused', async () => {
  const config = await standardConfig()
  const root = repo('sensitive', approvedTask({
    files: ['src/app.js', '.env'],
    flow: { flow: 'standard', version: 2, config },
  }))
  try {
    writeFileSync(join(root, '.env'), 'SECRET=1\n')
    git(root, ['add', '.env'])
    const result = tryCommit(root, '【HOOK-1】【TASK】probe the hook')
    assert.equal(result.allowed, false, 'a sensitive path without a high-risk receipt must be refused')
    assert.match(result.stderr, /敏感路径/, 'the refusal names the sensitive path')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})