/**
 * Batch-1 reproductions for the 2026-09-23 external assessment.
 *
 * Each case asserts the CORRECT behaviour and is therefore expected to FAIL
 * against 0.23.9, proving the defect exists before it is fixed. They reuse the
 * existing simulated fixture pattern from .workflow-test.mjs: the real built
 * `dev_task` tool and real engine functions run against an in-memory fs, so no
 * assertion here is a source-string check.
 *
 * Not covered here: the real Harness Web pass, which the assessment also
 * requires and which is reported separately.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { registerDevTask } from './lib/dev-task.js'
import { newTask } from './lib/engine.js'
import { resolveFlow } from './lib/workflows.js'

/** Build a fixture on one preset, mirroring .workflow-test.mjs's contract. */
function fixture(preset = 'standard', stage, extra = {}, services = {}) {
  const cwd = resolve('test-project')
  const config = resolveFlow(preset, {}).config
  const state = newTask({
    id: 'LIVE-1', title: 'assessment', branch: 'test', work_size: 'standard',
    risk_level: 'standard', flow: { flow: preset, version: config.version ?? 1, config }, root: cwd,
  })
  Object.assign(state, {
    stage, execution_version: 1, files: ['app.js'],
    requirement_confirmed: true, solution_confirmed: true, ...extra,
  })
  const records = new Map([
    [join(cwd, '.dsh/task-LIVE-1.json'), JSON.stringify(state)],
    [join(cwd, 'app.js'), 'source'],
  ])
  const events = [], runs = []
  const session = { id: 'test-session', header: { cwd }, snapshotEvents: () => events }
  const policy = { mode: 'workspace-write', workspaceRoot: cwd, sessionId: session.id }
  const abort = new AbortController()
  let execute
  const key = (path, options) => join(options?.cwd ?? cwd, path)
  const fs = {
    resolve: async (path, options) => ({ targetKey: key(path, options) }),
    readText: async target => records.get(target.targetKey),
    listDir: async () => [...records.keys()].filter(p => /task-.+\.json$/.test(p)).map(p => ({ name: p.split(/[\\/]/).at(-1) })),
    lstat: async (path, options) => records.has(key(path, options)) ? { version: 'v' } : undefined,
    writeText: async (target, content) => { records.set(target.targetKey, content) },
  }
  const ctx = {
    fs,
    tools: { register(tool) { execute = tool.execute; return () => {} } },
    get(name) {
      if (Object.hasOwn(services, name)) return services[name]
      if (name === 'sandboxPolicy') return { resolve(request) { assert.equal(request.session, session); return policy } }
      if (name === 'shell') return {
        resolve(request) { runs.push(request); return request },
        async run(request) {
          const fail = request.command === 'fail'
          return {
            exitCode: fail ? 1 : 0, timedOut: false, aborted: false,
            sandbox: { mode: 'workspace-write', denied: false },
            stdout: { text: request.command.startsWith('git -c core.quotepath=false log')
              ? 'abcdef1234567890\n【LIVE-1】【TASK】done\n\napp.js\n'
              : 'checks passed' },
            stderr: { text: '' },
          }
        },
      }
      return undefined
    },
  }
  registerDevTask(ctx)
  const exec = { agent: { session }, signal: abort.signal }
  function load(name, success = true) {
    const callId = `call-${events.length}`
    events.push({ type: 'tool/call', data: { name: 'skill', callId, arguments: JSON.stringify({ name }) } })
    events.push({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: callId, isError: !success }] } } })
  }
  return {
    call: args => execute(JSON.parse(JSON.stringify({ task_id: 'LIVE-1', ...args })), exec),
    load, runs, policy, exec, records, cwd,
    state: () => JSON.parse(records.get(join(cwd, '.dsh/task-LIVE-1.json'))),
  }
}

/** Run `verify` with a command, optionally failing. */
async function verify(f, command) {
  return f.call({ operation: 'verify', command, description: 'checks' })
}

// ---------------------------------------------------------------- P1: stale verification

test('P1: a failed re-verification must block the commit at the review stage', async () => {
  // Standard flow: 交付 -> 代码审核 requires `verified`, 代码审核 -> 完成 requires only
  // review_passed. Re-verifying with a failing command flips `passed` to false, and
  // evidenceBlockers guards its staleness check behind `passed &&`, so nothing reports it.
  const f = fixture('standard', '代码审核')
  await verify(f, 'pass')                       // establish a passing receipt
  await f.call({ operation: 'record', artifact: 'review', fields: { conclusion: 'ok', issues: 'none' } })
  await f.call({ operation: 'review', outcome: 'pass' })
  await verify(f, 'fail')                       // re-verify: now failing
  const status = JSON.parse(await f.call({ operation: 'status' }))
  const passed = f.state().verification.passed
  await assert.rejects(
    () => f.call({ operation: 'commit' }),
    /verif/i,
    `commit must be refused while verification is failing (passed=${passed}, commit.allowed=${status.commit?.allowed})`,
  )
})

test('P1: completion must re-check verification for a task that once crossed it', async () => {
  const f = fixture('standard', '代码审核')
  await verify(f, 'pass')
  await f.call({ operation: 'record', artifact: 'review', fields: { conclusion: 'ok', issues: 'none' } })
  await f.call({ operation: 'review', outcome: 'pass' })
  await verify(f, 'fail')
  const status = JSON.parse(await f.call({ operation: 'status' }))
  const blockers = [...(status.evidence_blockers ?? []), ...(status.commit_blockers ?? [])]
  assert.ok(
    blockers.some(b => /verif/i.test(b)),
    `status must report verification as blocking; saw ${JSON.stringify(blockers)}`,
  )
})

// ---------------------------------------------------------------- P1: agile label contract

test('P1: the agile checkpoint label must satisfy the agile message pattern', async () => {
  // commitCheckpoint returns 'TASK' at a checkpoint stage while agile's pattern only
  // accepts \d+, so the label the model is handed cannot produce an acceptable message.
  const f = fixture('agile', '交付', { items: [{ id: 'A', title: 'a', status: 'done' }] })
  const status = JSON.parse(await f.call({ operation: 'status' }))
  const label = status.commit?.label
  const pattern = resolveFlow('agile', {}).config.commit.message_pattern
  assert.ok(label !== undefined, 'a commit must be due at the agile checkpoint')
  assert.match(
    `【LIVE-1】【${label}】did a thing`,
    new RegExp(pattern, 'u'),
    `label ${JSON.stringify(label)} must satisfy the preset's own pattern ${JSON.stringify(pattern)}`,
  )
})

// ---------------------------------------------------------------- verification scoping

test('P1: the verification requirement applies only after the flow reaches a verify gate', async () => {
  // The fix must not overreach. `verified` guards the edge INTO a stage, so a task
  // that has not crossed that edge has nothing to verify and must not be blocked
  // by a requirement it has not yet met — otherwise the flow cannot even start.
  const early = fixture('standard', '需求评审', {
    artifacts: { requirement: { scope: 's', acceptance_criteria: 'a' } },
  })
  const earlyStatus = JSON.parse(await early.call({ operation: 'status' }))
  assert.deepEqual(
    earlyStatus.verification_blockers ?? [],
    [],
    'a task before the verify gate must not be reported as failing verification',
  )

  // Past the gate it applies, and stays applied at every later stage.
  for (const stage of ['代码审核', '完成']) {
    const late = fixture('standard', stage)
    const lateStatus = JSON.parse(await late.call({ operation: 'status' }))
    assert.ok(
      (lateStatus.verification_blockers ?? []).length > 0,
      `stage ${stage} sits after the verify gate, so it must require verification`,
    )
  }
})

test('P1: a preset that never guards on verified must not demand verification', async () => {
  // "Only what the user configured should be enforced." agile and minimal declare
  // no `verified` edge, so the engine must not invent one.
  for (const preset of ['agile', 'minimal']) {
    const stage = preset === 'agile' ? '审查' : '交付'
    const f = fixture(preset, stage)
    const status = JSON.parse(await f.call({ operation: 'status' }))
    assert.deepEqual(
      status.verification_blockers ?? [],
      [],
      `${preset} declares no verification gate, so it must not report one`,
    )
  }
})

// ---------------------------------------------------------------- P1: agile artifact contract

test('P1: every skill bound by a preset must be able to record what it is told to record', async () => {
  // agile binds code-review at 审查, and that skill instructs the model to
  // `record artifact=review`, but agile declares only the `requirement` artifact.
  const f = fixture('agile', '审查', {
    verification: { passed: true, evidence: ['checks passed'] },
  })
  await assert.doesNotReject(
    () => f.call({ operation: 'record', artifact: 'review', fields: { conclusion: 'ok', issues: 'none' } }),
    'the review artifact a bound skill is instructed to write must exist in the preset contract',
  )
})

// ---------------------------------------------------------------- P2: minimal must be light

test('P2: the minimal preset must not demand a two-stage review per item', async () => {
  // todosBlockers is shared by all three presets and hard-requires
  // item.review.spec.outcome === 'pass' && item.review.quality.outcome === 'pass'.
  const f = fixture('minimal', '开发', {
    items: [{ id: 'A', title: 'a', status: 'done' }],
  })
  const status = JSON.parse(await f.call({ operation: 'status' }))
  assert.ok(
    !(status.skill_blockers ?? []).concat(status.commit_blockers ?? []).some(b => /two-stage review/u.test(b)),
    `minimal must not require a two-stage review; blockers: ${JSON.stringify(status.commit_blockers)}`,
  )
})

// ---------------------------------------------------------------- P2: missing rule must surface

test('P2: a bound rule that cannot be found must be reported, not skipped', async () => {
  // resolveRules walks bundled -> project -> user and simply omits a name it cannot
  // find, so a binding silently stops being disclosed.
  const f = fixture('standard', '开发', {}, {})
  // Point the stage at a rule that exists nowhere.
  const state = f.state()
  state.flow.config.stage_bindings = { 开发: { skills: [], rules: ['no-such-rule-anywhere'] } }
  f.records.set(join(f.cwd, '.dsh/task-LIVE-1.json'), JSON.stringify(state))
  const status = JSON.parse(await f.call({ operation: 'status' }))
  const text = JSON.stringify(status)
  assert.match(
    text,
    /no-such-rule-anywhere/u,
    'a missing bound rule must appear in status rather than vanishing',
  )
})