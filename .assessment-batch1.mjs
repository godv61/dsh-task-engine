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
import { newTask, todosBlockers, completionBlockers, validateWorkflow, formatResourceRef } from './lib/engine.js'
import { FLOW_PRESETS } from './lib/workflows.js'
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

test('P2: the minimal preset reviews each item once, and still reviews it', () => {
  // This earlier asserted on status.skill_blockers/commit_blockers, which never
  // contain todosBlockers output, so it passed against a completely unfixed
  // engine. Call the function under test directly instead.
  const minimal = resolveFlow('minimal', {}).config
  const standard = resolveFlow('standard', {}).config
  const specPassQualityFail = {
    items: [{ id: 'A', title: 'a', status: 'done', review: { spec: { outcome: 'pass' }, quality: { outcome: 'fail' } } }],
  }
  assert.deepEqual(todosBlockers(specPassQualityFail, minimal), [],
    'minimal asks for one verdict, so a missing quality verdict must not block')
  assert.ok(todosBlockers(specPassQualityFail, standard).length > 0,
    'the full flow still requires both verdicts')

  // "Lighter" must mean fewer verdicts, never fewer checks.
  const noReview = { items: [{ id: 'A', title: 'a', status: 'done' }] }
  assert.ok(todosBlockers(noReview, minimal).length > 0,
    'an unreviewed item must still block the lightest flow')
  const specFail = {
    items: [{ id: 'A', title: 'a', status: 'done', review: { spec: { outcome: 'fail' }, quality: { outcome: 'pass' } } }],
  }
  assert.ok(todosBlockers(specFail, minimal).length > 0,
    'a failing verdict must still block the lightest flow')
})

test('P2: the three presets must not share one identical review burden', () => {
  // The presets differ by task complexity, so their audit weight must differ too.
  // Before this change all three returned byte-identical blockers for one state.
  const state = {
    items: [{ id: 'A', title: 'a', status: 'done', review: { spec: { outcome: 'pass' }, quality: { outcome: 'fail' } } }],
  }
  const byDepth = ['standard', 'agile', 'minimal'].map(id =>
    todosBlockers(state, resolveFlow(id, {}).config).length)
  assert.ok(
    byDepth[2] < byDepth[0],
    `the fast-change flow must audit less per item than the full one; got ${JSON.stringify(byDepth)}`,
  )
})

// ---------------------------------------------------------------- P2: missing rule must surface

test('P2: a rule a skill declares but that resolves nowhere must be reported, not skipped', async () => {
  // Resolution used to simply omit a name it could not find, so a binding silently
  // stopped being disclosed. Rules now hang off the skill, so the reference to
  // check lives on the skill binding.
  const f = fixture('standard', '开发', {}, {})
  const state = f.state()
  state.flow.config.stage_bindings = {
    开发: {
      skills: [
        { skill: { source: 'bundled', name: 'code-implement' }, rules: [{ source: 'bundled', name: 'no-such-rule-anywhere' }] },
      ],
    },
  }
  f.records.set(join(f.cwd, '.dsh/task-LIVE-1.json'), JSON.stringify(state))
  const status = JSON.parse(await f.call({ operation: 'status' }))
  const text = JSON.stringify(status)
  assert.match(
    text,
    /no-such-rule-anywhere/u,
    'a rule that resolves nowhere must appear in status rather than vanishing',
  )
})

// ---------------------------------------------------------------- batch 3: rules belong to skills

test('batch3: a stage selects skills only, and a skill carries its own complete rule list', () => {
  // The whole point of the model: opening a skill tells you every rule it runs
  // under, and binding it anywhere does not add or override any rule.
  const config = resolveFlow('standard', {}).config
  for (const [stage, binding] of Object.entries(config.stage_bindings ?? {})) {
    assert.ok(
      !('rules' in binding) || binding.rules === undefined,
      `stage ${stage} must not carry a stage-level rule list`,
    )
    for (const entry of binding.skills ?? []) {
      assert.ok(Array.isArray(entry.rules),
        `skill ${entry.skill.name} on ${stage} must declare its own rules array`)
      assert.ok(entry.skill.source === 'bundled',
        `preset bindings are bundled resources; ${entry.skill.name} declares ${entry.skill.source}`)
    }
  }
})

test('batch3: the same skill carries identical rules wherever it is bound', () => {
  // "Same skill, same rules" is the acceptance criterion: copying the skill is how
  // a user gets a different rule set, so the same reference must never differ.
  const byRef = new Map()
  for (const [id, preset] of Object.entries(FLOW_PRESETS)) {
    for (const [stage, binding] of Object.entries(preset.config.stage_bindings ?? {})) {
      for (const entry of binding.skills ?? []) {
        const key = formatResourceRef(entry.skill)
        const rules = entry.rules.map(formatResourceRef).sort().join(',')
        if (byRef.has(key)) {
          assert.equal(byRef.get(key).rules, rules,
            `${key} carries different rules in ${byRef.get(key).where} and ${id}/${stage}`)
        } else {
          byRef.set(key, { rules, where: `${id}/${stage}` })
        }
      }
    }
  }
})

test('batch3: a rule shared by two skills is one resource, referenced twice', () => {
  // Reuse must not duplicate the rule body: two skills referencing one rule point
  // at the same source-qualified reference.
  const config = resolveFlow('standard', {}).config
  const review = config.stage_bindings['代码审核'].skills
  const reviewRules = review.find(entry => entry.skill.name === 'code-review').rules.map(formatResourceRef)
  const implementRules = config.stage_bindings['开发'].skills
    .find(entry => entry.skill.name === 'code-implement').rules.map(formatResourceRef)
  const shared = reviewRules.filter(rule => implementRules.includes(rule))
  assert.ok(shared.length > 0,
    'coding-conventions and security-redlines apply to both implementing and reviewing code, so at least one rule must be shared by reference')
  assert.ok(shared.includes('bundled:security-redlines'),
    `security-redlines is the clear shared case; saw ${JSON.stringify(shared)}`)
})

test('batch3: legacy stage-level rules stay in force and are named as unassigned', async () => {
  // A pre-migration config put rules on the stage. Assigning them silently would
  // invent an answer the config never had; dropping them would lose a constraint.
  const f = fixture('standard', '开发', {}, {})
  const state = f.state()
  state.flow.config.stage_bindings = { 开发: { skills: [], legacy_rules: ['security-redlines'] } }
  f.records.set(join(f.cwd, '.dsh/task-LIVE-1.json'), JSON.stringify(state))
  const status = JSON.parse(await f.call({ operation: 'status' }))
  assert.ok(
    (status.unassigned_legacy_rules ?? []).includes('security-redlines'),
    `the legacy rule must be reported as unassigned; saw ${JSON.stringify(status.unassigned_legacy_rules)}`,
  )
  // Still enforced: it resolves and appears among the rules in force.
  assert.ok(
    (status.rules ?? []).some(rule => rule.name === 'security-redlines'),
    `a legacy rule must keep applying; saw ${JSON.stringify(status.rules)}`,
  )
})

// ---------------------------------------------------------------- batch 2: completion

test('P2: reaching the last stage is not completion for any preset', () => {
  // minimal's final stage is also its commit checkpoint, and the "commit before
  // leaving a checkpoint" rule only fires on the way OUT of a stage — so that
  // flow could stand on its last stage with no delivery record at all. Completion
  // is now its own checked event, shared by all three presets.
  for (const [preset, stage] of [['standard', '完成'], ['agile', '审查'], ['minimal', '交付']]) {
    const config = resolveFlow(preset, {}).config
    const state = {
      stage,
      execution_version: 1,
      items: [{ id: 'A', title: 'a', status: 'done', review: { spec: { outcome: 'pass' }, quality: { outcome: 'pass' } } }],
      verification: { passed: true, evidence: [] },
      commits: [],
    }
    assert.ok(
      completionBlockers(state, config).length > 0,
      `${preset} must not complete without its delivery record`,
    )
    const committed = { ...state, commits: [{ label: 'TASK', hash: 'abc1234' }] }
    assert.deepEqual(
      completionBlockers(committed, config), [],
      `${preset} must complete once the delivery record exists`,
    )
  }
})

test('P2: completion refuses a task that has not reached a final stage', () => {
  const config = resolveFlow('standard', {}).config
  const state = {
    stage: '开发',
    execution_version: 1,
    items: [{ id: 'A', title: 'a', status: 'done', review: { spec: { outcome: 'pass' }, quality: { outcome: 'pass' } } }],
    verification: { passed: true, evidence: [] },
    commits: [{ label: 'TASK', hash: 'abc1234' }],
  }
  const blockers = completionBlockers(state, config)
  assert.ok(blockers.some(b => /not a final stage/u.test(b)),
    `an unfinished flow must not be completable; saw ${JSON.stringify(blockers)}`)
})

test('P2: a flow may declare that its delivery mode needs no commit', () => {
  // A Git commit is one delivery mode, not a universal finish line: a non-code
  // task or a project outside version control has nothing to commit.
  const withoutCommit = { ...resolveFlow('minimal', {}).config, commit_required: false }
  const state = {
    stage: '交付',
    execution_version: 1,
    items: [{ id: 'A', title: 'a', status: 'done', review: { spec: { outcome: 'pass' } } }],
    verification: { passed: true, evidence: [] },
    commits: [],
  }
  assert.deepEqual(
    completionBlockers(state, withoutCommit), [],
    'a flow that does not require a commit must be completable without one',
  )
})

test('P2: an unknown review_depth is a configuration error, not a silent downgrade', () => {
  const config = { ...resolveFlow('minimal', {}).config, review_depth: 'thorough' }
  const problems = validateWorkflow(config)
  assert.ok(problems.some(p => /review_depth/u.test(p)),
    `a typo must be reported; saw ${JSON.stringify(problems)}`)
})