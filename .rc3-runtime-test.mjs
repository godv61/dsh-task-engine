// Actual rc.3 tool registry, scope and prompt assembly; controlled activation/query lifecycle adapters.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import ReviewerPolicy from './lib/reviewer-policy.js'
import { apply as reviewer } from './lib/reviewer.js'
import { reviewerEvents, reviewerProof, ownActivation } from './lib/subagent-runtime.js'
import { executionCapabilities } from './lib/execution-plan.js'

function tool(name, execute = async () => 'ok') { return defineTool({ name, description: name, parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute }) }
async function guarded() {
  const root = new Context(); await root.plugin(SystemPrompt); await root.plugin(ToolRuntime); await root.plugin(ReviewerPolicy)
  let ctx
  await root.plugin({name:'review-test-owner',inject:['tools','systemPrompt','taskEngineReviewPolicy'],apply(c){ctx=c}})
  ctx.tools.register(tool('subagent_codex')); ctx.tools.register(tool('shell')); ctx.tools.register(tool('write'))
  const presetKey={}, preset = createScope(ctx, presetKey)
  preset.ctx.tools.register(tool('read')); reviewer(preset.ctx)
  const agent = { id: 'review-child', session: { header: { cwd: process.cwd() } } }, scope = createScope(preset.ctx, agent, { parent: presetKey })
  agent.ctx=scope.ctx
  scope.ctx.tools.register(tool('structured_output'))
  await root.serial(scopeTarget(agent,agent),'agent/created',{agent})
  return { root, ctx, scope, agent, dispose: async () => { await scope.dispose(); await preset.dispose(); await root.fiber.dispose() } }
}
test('reviewer preset hides inherited global tools while leaving parent tools intact', async () => {
  const f = await guarded()
  try {
    assert.deepEqual(f.ctx.tools.schemas(f.agent).map(t => t.name).sort(), ['read', 'structured_output'])
    assert.ok(f.ctx.tools.schemas().some(t => t.name === 'subagent_codex'))
    const sibling = { id: 'parent-agent', session: { header: { cwd: process.cwd() } } }
    const siblingScope = createScope(f.ctx, sibling)
    sibling.ctx = siblingScope.ctx
    try {
      await f.root.serial(scopeTarget(sibling, sibling), 'agent/created', { agent: sibling })
      await f.ctx.systemPrompt.assemble({ scope: sibling })
      assert.ok(f.ctx.tools.schemas(sibling).some(t => t.name === 'write'))
      assert.equal(f.ctx.taskEngineReviewPolicy.proof(sibling.id), undefined)
    } finally { await siblingScope.dispose() }
    await f.ctx.systemPrompt.assemble({ scope: f.agent })
    assert.deepEqual(reviewerProof(f.ctx, f.agent.id, true).tools.sort(), ['read', 'structured_output'])
    const out = await f.ctx.tools.execute({ name: 'read', arguments: {}, agent: f.agent, signal: new AbortController().signal, callId: 'read' })
    assert.equal(out.isError, false)
  } finally { await f.dispose() }
})
test('reviewer blocks newly registered local mutation tools and refuses a contaminated prompt', async () => {
  const f = await guarded(); let mutated = false
  try {
    f.scope.ctx.tools.register(tool('unexpected_write', async () => { mutated = true; return 'bad' }))
    const out = await f.ctx.tools.execute({ name: 'unexpected_write', arguments: {}, agent: f.agent, signal: new AbortController().signal, callId: 'bad' })
    assert.equal(out.isError, true); assert.equal(mutated, false)
    await assert.rejects(f.ctx.systemPrompt.assemble({ scope: f.agent }), /invalid reviewer tool policy/)
    assert.throws(() => reviewerProof(f.ctx, f.agent.id, true), /policy is missing or invalid/)
  } finally { await f.dispose() }
})
test('activation cancellation after publication disposes that exact activation once', async () => {
  const controller = new AbortController(); let disposed = 0
  const run = ownActivation({ childId: 'child', result: new Promise(() => {}), dispose: async () => { disposed++ } }, controller.signal)
  controller.abort(); await assert.rejects(run.result, /parent cancelled/); await run.dispose(); await run.dispose()
  assert.equal(disposed, 1)
})
test('activation cleanup failure is retained for the final owner and successful completion preserves native structured output', async () => {
  const controller = new AbortController()
  const failed = ownActivation({ childId: 'child', result: new Promise(() => {}), dispose: async () => { throw new Error('cleanup failure') } }, controller.signal)
  controller.abort(); await assert.rejects(failed.result, /cleanup failure/); await assert.rejects(failed.dispose(), /cleanup failure/)
  let disposed = 0
  const output = { stopReason: 'completed', output: [], structured: { spec: 'pass' } }
  const finished = ownActivation({ childId: 'another', result: Promise.resolve(output), dispose: async () => { disposed++ } }, new AbortController().signal)
  assert.equal(await finished.result, output); await finished.dispose(); assert.equal(disposed, 1)
})
test('review evidence reads the exact child observation and always releases its lease', async () => {
  let disposed = 0, id = 'child'
  const ctx = { get: () => ({ observeSession: async requested => { assert.equal(requested, 'child'); return { header: { id }, events: [{ type: 'tool/result', data: {} }], [Symbol.dispose]() { disposed++ } } } }) }
  assert.equal((await reviewerEvents(ctx, 'child', new AbortController().signal)).length, 1); assert.equal(disposed, 1)
  id = 'wrong-child'; await assert.rejects(reviewerEvents(ctx, 'child', new AbortController().signal), /another child/); assert.equal(disposed, 2)
})
test('rc.3 detection requires managed activation and a reviewer preset/query seam; old start is not accepted', () => {
  const provider = name => ({ inheritsParentContext: name === 'fork', capabilities: { depthLimit: true, agentPreset: true } })
  const services = { subagents: { getProvider: provider, startActivation() {} }, sessionQuery: {}, taskEngineReviewPolicy: { preset: 'task-engine-review' } }
  const ctx = { get: name => services[name] }
  assert.deepEqual(executionCapabilities(ctx, true), { spawn: true, fork: true, reviewer: true })
  delete services.sessionQuery; assert.equal(executionCapabilities(ctx, true).reviewer, false)
  services.subagents = { getProvider: provider, start() {} }; assert.deepEqual(executionCapabilities(ctx, true), { spawn: false, fork: false, reviewer: false })
})
test('shipped preset removes removed rc.2 options and declares the guarded read-only reviewer', () => {
  const patch = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(patch, /\{\{cwd\}\}|backgroundMode:|enableRunInBackground:|toolFilter:/)
  assert.match(patch, /id: task-engine-review/); assert.match(patch, /write: false/); assert.match(patch, /edit: false/)
  assert.match(patch, /@godv61\/dsh-task-engine\/reviewer/)
})
