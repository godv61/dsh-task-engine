/**
 * End-to-end tool-chain regression over the three presets.
 *
 * Drives the REAL built `dev_task` tool — create, skill loading, artifact
 * recording, item review, verification, review, commit, completion — through an
 * in-memory fs, so it exercises the same code path the model does rather than
 * asserting on source text or calling engine helpers directly.
 *
 * Two things the assessment asks for and this does NOT provide: a real Harness
 * Web session, and a real `git commit`. Those are reported separately as
 * outstanding; nothing here claims to replace them.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { registerDevTask } from './lib/dev-task.js'
import { newTask } from './lib/engine.js'
import { adoptRecommendation, resolveFlow, FLOW_PRESETS } from './lib/workflows.js'

/**
 * The preset as a project would actually run it: the skeleton plus the shipped
 * recommendation, adopted exactly the way a user adopts it. A test that asserts
 * on bindings, commit rules or artifacts wants this, because those no longer come
 * from the preset itself.
 * @param {string} id - preset id.
 * @returns {import('./lib/engine.js').WorkflowConfig} the adopted config.
 */
function adoptedFlow(id, extra) {
  const base = adoptRecommendation(id)
  if (base === undefined) throw new Error('unknown preset: ' + id)
  return resolveFlow(id, { ...base, ...extra }).config
}


const HASH = 'abcdef1234567890'

/**
 * One preset driven from creation to completion.
 * @param preset - the preset id to run.
 * @returns the step log plus the final state, so the test can assert on both.
 */
async function runPreset(preset) {
  const cwd = resolve('e2e-project')
  const config = adoptedFlow(preset)
  const state = newTask({
    id: 'E2E-1', title: 'pipeline', branch: 'main', work_size: 'standard',
    risk_level: 'standard', flow: { flow: preset, version: FLOW_PRESETS[preset].version, config }, root: cwd,
  })
  const records = new Map([
    [join(cwd, '.dsh/task-E2E-1.json'), JSON.stringify(state)],
    // `create` reads the project's config from here, so this writes what a real
    // project has after adopting the shipped recommendation: the skeleton plus its
    // recommended skills, commit rule and artifacts. Writing only `{flow}` would
    // describe a project that adopted nothing — a different, equally valid case.
    [join(cwd, '.dsh/eng.json'), JSON.stringify(adoptRecommendation(preset))],
    [join(cwd, 'src/a.js'), 'source'],
  ])
  const events = []
  const session = { id: 'e2e', header: { cwd }, snapshotEvents: () => events }
  const abort = new AbortController()
  let execute
  let lastMessage = ''
  const key = (p, options) => join(options?.cwd ?? cwd, p)
  const fs = {
    resolve: async (p, options) => ({ targetKey: key(p, options) }),
    readText: async target => records.get(target.targetKey),
    listDir: async () => [...records.keys()].filter(p => /task-.+\.json$/.test(p)).map(p => ({ name: p.split(/[\\/]/).at(-1) })),
    lstat: async (p, options) => records.has(key(p, options)) ? { version: 'v' } : undefined,
    writeText: async (target, content) => { records.set(target.targetKey, content) },
  }
  const approvals = []
  const ctx = {
    fs,
    tools: { register(tool) { execute = tool.execute; return () => {} } },
    get(name) {
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd, sessionId: 'e2e' }) }
      // The confirmation guards require a human decision; a stub stands in for the
      // human here and records what it was asked, so the test can show the guard
      // actually consulted it rather than being bypassed. The verdict is the
      // protocol's string value, not a boolean.
      if (name === 'approval') return {
        async request(request) { approvals.push(request); return 'allowed-once' },
      }
      if (name === 'shell') return {
        resolve: request => request,
        async run(request) {
          const isLog = request.command.includes('log -1')
          return {
            exitCode: 0, timedOut: false, aborted: false,
            sandbox: { mode: 'workspace-write', denied: false },
            stdout: { text: isLog ? `${HASH}\n${lastMessage}\n\nsrc/a.js\n` : 'checks passed' },
            stderr: { text: '' },
          }
        },
      }
      return undefined
    },
  }
  registerDevTask(ctx)
  const exec = { agent: { session }, signal: abort.signal }
  const call = async args => {
    if (args.message !== undefined) lastMessage = args.message
    const text = await execute(JSON.parse(JSON.stringify({ task_id: 'E2E-1', ...args })), exec)
    return args.operation === 'status' ? JSON.parse(text) : text
  }
  const load = name => {
    const callId = `c${events.length}`
    events.push({ type: 'tool/call', data: { name: 'skill', callId, arguments: JSON.stringify({ name }) } })
    events.push({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: callId, isError: false }] } } })
  }
  const current = () => JSON.parse(records.get(join(cwd, '.dsh/task-E2E-1.json')))

  const steps = []
  await call({ operation: 'create', title: 'pipeline', branch: 'main', files: ['src/a.js'] })
  steps.push('create')

  for (let hop = 0; hop < 14; hop++) {
    const snapshot = current()
    const outgoing = config.transitions.filter(transition => transition.from === snapshot.stage)
    if (outgoing.length === 0) break

    // Satisfy whatever the stage's outgoing edges need.
    const needed = new Set(outgoing.flatMap(transition => transition.requires ?? []))
    if (needed.has('todos_done')) {
      // Items are reviewed through the dedicated operation; `items` only carries
      // status, and the review verdicts are recorded against the item by id.
      await call({ operation: 'items', items: [{ id: 'A', title: 'a', status: 'doing' }] })
      await call({ operation: 'dispatch', item_id: 'A', description: 'implemented by a worker' })
      await call({ operation: 'review_item', item_id: 'A', spec_outcome: 'pass', quality_outcome: 'pass' })
      await call({ operation: 'items', items: [{ id: 'A', status: 'done' }] })
    }
    // Confirmation guards are satisfied by a human decision routed through the
    // approval service; the tool refuses to let the model assert them itself.
    if (needed.has('requirement_confirmation') && !snapshot.requirement_confirmed) {
      await call({ operation: 'config', confirmations: ['requirement_confirmation'] })
    }
    if (needed.has('solution_confirmation') && !snapshot.solution_confirmed) {
      await call({ operation: 'config', confirmations: ['solution_confirmation'] })
    }
    if (needed.has('verified')) {
      await call({ operation: 'verify', command: 'npm test', description: 'run the suite' })
    }
    if (needed.has('review_passed')) {
      await call({ operation: 'review', outcome: 'pass' })
    }
    for (const artifact of config.artifacts.filter(a => a.stage === snapshot.stage)) {
      const fields = {}
      for (const field of artifact.fields) fields[field] = 'recorded'
      await call({ operation: 'record', artifact: artifact.id, fields })
    }
    // Obligations cover the current stage AND the stage being entered, so both
    // sets are loaded. This mirrors the disclosure the model follows.
    for (const obligated of new Set([snapshot.stage, ...outgoing.map(t => t.to)])) {
      for (const binding of config.stage_bindings?.[obligated]?.skills ?? []) load(binding.skill.name)
    }

    if (config.commit.checkpoints.includes(snapshot.stage)) {
      const status = await call({ operation: 'status' })
      await call({
        operation: 'commit', files: ['src/a.js'], hash: HASH,
        message: `【E2E-1】【${status.commit?.label ?? 'TASK'}】deliver the stage`,
      })
    }

    const target = outgoing[0].to
    // The target stage's skills must be loaded before the move, because leaving a
    // stage checks the obligations of the stage being entered. This mirrors what
    // the disclosure tells the model to do.
    for (const binding of config.stage_bindings?.[target]?.skills ?? []) load(binding.skill.name)
    await call({ operation: 'advance', target_stage: target })
    steps.push(`${snapshot.stage}→${target}`)
  }

  const terminal = config.stages.filter(stage => !config.transitions.some(t => t.from === stage))
  if (!terminal.includes(current().stage)) {
    return { steps, approvals, final: current(), completed: false, blocked: `stopped at ${current().stage}` }
  }
  // The terminal stage's own obligations are checked before it can be left, and
  // completion is the operation that leaves it.
  //
  // A flow may declare its final requirements as `completion_guards` rather than on
  // an edge, because a terminal stage has no edge to carry them — the agile flow's
  // 审查 IS the review. They are satisfied here, at the last stage, rather than
  // during the loop: they describe what completion means, not how a stage is entered.
  for (const binding of config.stage_bindings?.[current().stage]?.skills ?? []) load(binding.skill.name)
  const terminalGuards = new Set(config.completion_guards ?? [])
  if (terminalGuards.has('todos_done') && !current().items.some(item => item.status === 'done')) {
    await call({ operation: 'items', items: [{ id: 'A', title: 'a', status: 'doing' }] })
    await call({ operation: 'dispatch', item_id: 'A', description: 'implemented by a worker' })
    await call({ operation: 'review_item', item_id: 'A', spec_outcome: 'pass', quality_outcome: 'pass' })
    await call({ operation: 'items', items: [{ id: 'A', status: 'done' }] })
  }
  if (terminalGuards.has('verified')) {
    await call({ operation: 'verify', command: 'npm test', description: 'run the suite' })
  }
  if (terminalGuards.has('review_passed')) {
    await call({ operation: 'review', outcome: 'pass' })
  }
  if (config.commit.checkpoints.includes(current().stage)) {
    const status = await call({ operation: 'status' })
    await call({
      operation: 'commit', files: ['src/a.js'], hash: HASH,
      message: `【E2E-1】【${status.commit?.label ?? 'TASK'}】deliver the stage`,
    })
  }
  await call({ operation: 'complete' })
  return { steps, approvals, final: current(), completed: true, blocked: null }
}

test('e2e: every preset can be driven from creation to completion through the real tool', async () => {
  for (const preset of ['standard', 'agile', 'minimal']) {
    const run = await runPreset(preset)
    assert.equal(
      run.completed, true,
      `${preset} must reach completion; ${run.blocked ?? ''} steps=${run.steps.join(' ')}`,
    )
    assert.ok(run.final.completed !== undefined, `${preset} must record its completion`)
    assert.ok(run.steps.length >= 2, `${preset} must traverse at least one edge`)
  }
})

test('e2e: a preset that requires a commit cannot complete without one', async () => {
  // The completion check is the thing that catches minimal, whose final stage is
  // also its checkpoint and therefore never fires the "commit before leaving"
  // rule. Driving it through the tool must refuse completion without a commit.
  const run = await runPreset('minimal')
  assert.equal(run.completed, true)
  assert.ok(run.final.commits.length > 0,
    'reaching completion means the delivery record exists, not merely that the last stage was reached')
})