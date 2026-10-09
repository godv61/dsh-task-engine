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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

async function stampReceipt(root, taskFile) {
  const { hashBytes, hashText } = await import('./lib/snapshot.js')
  const task = JSON.parse(readFileSync(taskFile, 'utf8'))
  const entries = [...new Set(task.files)].sort().map(file => {
    const target = join(root, file)
    if (!existsSync(target)) return [file, null, null]
    const info = lstatSync(target)
    return [file, hashBytes(readFileSync(target)), process.platform === 'win32' ? false : (info.mode & 0o111) !== 0]
  })
  task.verification.receipt = {
    command: 'node --test', exit_code: 0, timed_out: false, aborted: false,
    started_at: '2026-10-01T00:00:00.000Z', finished_at: '2026-10-01T00:00:01.000Z',
    stdout: '# tests 1\n# pass 1', stderr: '', scope_hash: hashText(JSON.stringify(entries)),
  }
  writeFileSync(taskFile, JSON.stringify(task, null, 2))
}

/** Build a throwaway repository with the real hook installed and one staged file. */
async function repo(name, task) {
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
  if (task.verification.passed) await stampReceipt(root, join(root, '.dsh', `task-${task.id}.json`))
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
  const root = await repo('allow', approvedTask({ flow: { flow: 'standard', version: 2, config } }))
  try {
    const result = tryCommit(root, '【HOOK-1】【TASK】probe the hook')
    assert.equal(result.allowed, true, `expected the commit to proceed, stderr: ${result.stderr}`)
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
    rmSync(root, { recursive: true, force: true })
  }
})

test('the installed hook rejects a failed verification on a current task', async () => {
  const config = await standardConfig()
  const root = await repo('failed-verification', approvedTask({
    execution_version: 1,
    verification: { passed: false, evidence: [] },
    flow: { flow: 'standard', version: 2, config },
  }))
  try {
    const result = tryCommit(root, '【HOOK-1】【TASK】probe failed verification')
    assert.equal(result.allowed, false, 'a failed verification must block the real Git hook')
    assert.match(result.stderr, /verification is not passing/, 'the refusal names verification')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removing execution_version cannot bypass the installed verification gate', async () => {
  const config = await standardConfig()
  const root = await repo('missing-version', approvedTask({
    verification: { passed: false, evidence: [] },
    flow: { flow: 'standard', version: 2, config },
  }))
  try {
    const result = tryCommit(root, '【HOOK-1】【TASK】probe missing version')
    assert.equal(result.allowed, false)
    assert.match(result.stderr, /verification is not passing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the installed hook finds a registered task in a monorepo subdirectory', async () => {
  const config = await standardConfig()
  const root = mkdtempSync(join(tmpdir(), 'engine-hook-subdir-'))
  try {
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    git(root, ['config', 'commit.gpgsign', 'false'])
    const sub = join(root, 'module')
    mkdirSync(join(sub, '.dsh'), { recursive: true })
    mkdirSync(join(sub, 'src'), { recursive: true })
    const gate = readFileSync(HOOK, 'utf8').replace(/^#![^\n]*\n/u, '')
    writeFileSync(join(root, '.git', 'hooks', 'commit-msg'), `#!${NODE}\n${gate}`)
    writeFileSync(join(root, '.git', 'hooks', 'package.json'), '{ "type": "commonjs" }\n')
    writeFileSync(join(root, '.git', 'hooks', 'dsh-task-roots.json'), '{ "roots": ["module"] }\n')
    writeFileSync(join(sub, '.dsh', 'task-HOOK-1.json'), JSON.stringify(approvedTask({
      root: sub, files: ['src/app.js'], flow: { flow: 'standard', version: 2, config },
    })))
    writeFileSync(join(sub, 'src', 'app.js'), 'console.log(1)\n')
    git(root, ['add', 'module/src/app.js'])
    await stampReceipt(sub, join(sub, '.dsh', 'task-HOOK-1.json'))
    const result = tryCommit(sub, '【HOOK-1】【TASK】probe subdirectory')
    assert.equal(result.allowed, true, `registered subdirectory task should commit: ${result.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the installed hook fails closed on a damaged workspace registry', async () => {
  const config = await standardConfig()
  const root = await repo('damaged-roots', approvedTask({ flow: { flow: 'standard', version: 2, config } }))
  try {
    writeFileSync(join(root, '.git', 'hooks', 'dsh-task-roots.json'), '{broken')
    const result = tryCommit(root, '【HOOK-1】【TASK】probe damaged roots')
    assert.equal(result.allowed, false)
    assert.match(result.stderr, /工作区配置无法读取或解析/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a message that violates the configured pattern is refused', async () => {
  const config = await standardConfig()
  const root = await repo('badmsg', approvedTask({ flow: { flow: 'standard', version: 2, config } }))
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
  const root = await repo('scope', approvedTask({ flow: { flow: 'standard', version: 2, config } }))
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
  const root = await repo('stage', approvedTask({ stage: '开发', flow: { flow: 'standard', version: 2, config } }))
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
  const root = await repo('tamper', approvedTask({
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
  const root = await repo('sensitive', approvedTask({
    files: ['src/app.js', '.env'],
    flow: { flow: 'standard', version: 2, config },
  }))
  try {
    writeFileSync(join(root, '.env'), 'SECRET=1\n')
    git(root, ['add', '.env'])
    await stampReceipt(root, join(root, '.dsh', 'task-HOOK-1.json'))
    const result = tryCommit(root, '【HOOK-1】【TASK】probe the hook')
    assert.equal(result.allowed, false, 'a sensitive path without a high-risk receipt must be refused')
    assert.match(result.stderr, /敏感路径/, 'the refusal names the sensitive path')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('adaptive task can make its first CI commit before Sonar review', async () => {
  const { adaptiveWorkflow } = await import('./lib/adaptive.js')
  const config = adaptiveWorkflow('medium')
  const root = await repo('adaptive-sonar', approvedTask({
    stage: '测试',
    review: { outcome: 'pending' },
    sonar_policy: { enabled: true, host_url: 'https://sonar.example.test', project_key: 'example', mode: 'branch', token_env: 'SONAR_TOKEN' },
    flow: { flow: 'adaptive-medium', version: 1, config },
  }))
  try {
    const result = tryCommit(root, 'first CI scan')
    assert.equal(result.allowed, true, `the commit must precede its Sonar analysis: ${result.stderr}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('common credential filenames also require a high-risk receipt', async () => {
  const config = await standardConfig()
  for (const filename of ['.env.local', 'credentials.json']) {
    const root = await repo('credential-name', approvedTask({
      files: ['src/app.js', filename],
      flow: { flow: 'standard', version: 2, config },
    }))
    try {
      writeFileSync(join(root, filename), 'secret=1\n')
      git(root, ['add', filename])
      await stampReceipt(root, join(root, '.dsh', 'task-HOOK-1.json'))
      const result = tryCommit(root, '【HOOK-1】【TASK】probe the hook')
      assert.equal(result.allowed, false, filename)
      assert.match(result.stderr, /敏感路径/, filename)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('deleting a scoped file needs a high-risk task and fresh verification', async () => {
  const config = await standardConfig()
  const root = await repo('delete-risk', approvedTask({ flow: { flow: 'standard', version: 3, config } }))
  try {
    git(root, ['-c', 'core.hooksPath=missing-hooks', 'commit', '-m', 'seed'])
    rmSync(join(root, 'src', 'app.js'))
    git(root, ['add', '-u'])
    await stampReceipt(root, join(root, '.dsh', 'task-HOOK-1.json'))
    const result = tryCommit(root, '【HOOK-1】【TASK】remove app')
    assert.equal(result.allowed, false)
    assert.match(result.stderr, /高风险操作/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the hook rejects a receipt after source code changes', async () => {
  const config = await standardConfig()
  const root = await repo('stale-receipt', approvedTask({ flow: { flow: 'standard', version: 2, config } }))
  try {
    writeFileSync(join(root, 'src', 'app.js'), 'console.log(2)\n')
    git(root, ['add', 'src/app.js'])
    const result = tryCommit(root, '【HOOK-1】【TASK】changed after tests')
    assert.equal(result.allowed, false)
    assert.match(result.stderr, /verification is stale/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the hook rejects staged bytes that differ from the tested worktree', async () => {
  const config = await standardConfig()
  const root = await repo('index-mismatch', approvedTask({ flow: { flow: 'standard', version: 2, config } }))
  try {
    writeFileSync(join(root, 'src', 'app.js'), 'console.log(2)\n')
    git(root, ['add', 'src/app.js'])
    writeFileSync(join(root, 'src', 'app.js'), 'console.log(1)\n')
    const result = tryCommit(root, '【HOOK-1】【TASK】stage different bytes')
    assert.equal(result.allowed, false)
    assert.match(result.stderr, /暂存区内容与已验证工作区不一致/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an explicit task id on another branch is rejected', async () => {
  const config = await standardConfig()
  const root = await repo('wrong-branch', approvedTask({ branch: 'feature/other', flow: { flow: 'standard', version: 2, config } }))
  try {
    const result = tryCommit(root, '【HOOK-1】【TASK】wrong branch')
    assert.equal(result.allowed, false)
    assert.match(result.stderr, /记录的分支/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a pattern-less commit cannot guess between two active tasks on one branch', async () => {
  const { adaptiveWorkflow } = await import('./lib/adaptive.js')
  const config = adaptiveWorkflow('low')
  const root = await repo('ambiguous', approvedTask({ stage: '测试', flow: { flow: 'adaptive-low', version: 1, config } }))
  try {
    const second = approvedTask({ id: 'HOOK-2', stage: '测试', flow: { flow: 'adaptive-low', version: 1, config } })
    writeFileSync(join(root, '.dsh', 'task-HOOK-2.json'), JSON.stringify(second))
    await stampReceipt(root, join(root, '.dsh', 'task-HOOK-2.json'))
    const result = tryCommit(root, 'unqualified task commit')
    assert.equal(result.allowed, false)
    assert.match(result.stderr, /多个未完成任务/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('approved local Sonar false positives retain the raw error but allow a first commit', async () => {
  const config = await standardConfig()
  const root = await repo('local-disposition', approvedTask({
    sonar_policy: { enabled: true, source: 'ide-local', host_url: 'https://sonar.example.test', project_key: 'example', mode: 'branch', token_env: 'SONAR_TOKEN' },
    flow: { flow: 'standard', version: 2, config },
  }))
  try {
    const taskFile = join(root, '.dsh', 'task-HOOK-1.json')
    const task = JSON.parse(readFileSync(taskFile, 'utf8'))
    const finding = { key: 'issue-1', rule: 'java:S1', message: 'false positive', severity: 'MAJOR', file: 'src/app.js' }
    task.sonar_audit = { ce_task_id: 'local', analysis_id: 'local', gate: 'ERROR',
      checked_at: '2026-10-01T00:00:00.000Z', scope_hash: task.verification.receipt.scope_hash,
      findings: [finding], blocking: [finding], target: 'main',
      dispositions: [{ issue_key: 'issue-1', kind: 'false_positive', reason: 'reviewed', evidence: ['manual review'], approved_at: '2026-10-01T00:00:00.000Z' }] }
    writeFileSync(taskFile, JSON.stringify(task))
    const result = tryCommit(root, '【HOOK-1】【TASK】approved local finding')
    assert.equal(result.allowed, true, result.stderr)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
