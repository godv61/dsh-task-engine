// P0 acceptance test for dsh-task-engine 0.18.0: runs the pure engine +
// workflows functions and the registered `dev_task` tool against an in-memory
// fs, checking every P0 gate: capability binding, frozen snapshot, fail-closed
// unknown flow, core-rule shadow protection, and init three-phase flow.
import { readFileSync } from 'node:fs'
import { registerDevTask } from './lib/dev-task.js'
import { assertAdvance, checkFileScope, newTask, taskIdFromMessage, validateWorkflow } from './lib/engine.js'
import {
  FLOW_PRESETS,
  HIGH_RISK_REQUIRED_CAPABILITIES,
  flowSatisfies,
  resolveFlow,
} from './lib/workflows.js'

let passed = 0
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    throw new Error(msg)
  }
  passed++
}
async function assertThrows(fn, fragment, msg) {
  try {
    await fn()
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    assert(text.includes(fragment), `${msg} (got: ${text})`)
    return
  }
  throw new Error(`${msg}: expected throw containing "${fragment}"`)
}

function makeFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    async resolve(relPath, opts) {
      const base = opts && opts.cwd ? String(opts.cwd).replace(/\\/g, '/') : ''
      const key = base ? `${base}/${relPath}` : relPath
      return { targetKey: key, displayPath: key }
    },
    async readText(target) {
      return files.get(target.targetKey)
    },
    async writeText(target, content) {
      files.set(target.targetKey, content)
    },
    _files: files,
  }
}
function makeCtx(fs, approval) {
  const tools = []
  return {
    fs,
    tools: { register(tool) { tools.push(tool); return () => {} } },
    get(service) {
      if (service === 'approval') return approval
      return undefined
    },
    _tools: tools,
  }
}
async function registered(fs, approval) {
  const ctx = makeCtx(fs, approval)
  registerDevTask(ctx)
  return ctx._tools[0].execute
}
const EXEC = { agent: undefined, callId: undefined, signal: undefined }
// A tool call whose session workspace is `cwd` (the harness process directory is
// deliberately different, exactly like a web session running in e2e-project).
function sessionExec(cwd) {
  return { agent: { session: { header: { cwd } } }, callId: undefined, signal: undefined }
}

// ── 1. capability derivation and high-risk binding ────────────────────────
assert(flowSatisfies('standard', HIGH_RISK_REQUIRED_CAPABILITIES), 'standard satisfies high-risk capabilities')
assert(!flowSatisfies('agile', HIGH_RISK_REQUIRED_CAPABILITIES), 'agile lacks a high-risk capability')
assert(!flowSatisfies('minimal', HIGH_RISK_REQUIRED_CAPABILITIES), 'minimal lacks a high-risk capability')
assert(FLOW_PRESETS.standard.version === 1, 'preset carries a version')

// ── 2. unknown flow fails closed ───────────────────────────────────────────
const unknown = resolveFlow('nope')
assert(unknown.ok === false && unknown.code === 'UNKNOWN_FLOW', 'unknown flow returns UNKNOWN_FLOW')
assert(unknown.knownFlows.includes('standard'), 'known flow list is surfaced')

// ── 3. core bindings cannot be cancelled by an override ────────────────────
const merged = resolveFlow('standard', { stage_bindings: { '开发': { rules: [] } } })
assert(merged.ok && merged.config.stage_bindings['开发'].rules.includes('coding-conventions'),
  'emptying a stage override keeps the core rule')

// ── 4. newTask freezes the snapshot ────────────────────────────────────────
const snapshot = { flow: 'standard', version: 1, config: FLOW_PRESETS.standard.config }
const state = newTask({ id: 'T1', title: 'x', branch: 'main', work_size: 'standard', risk_level: 'standard', flow: snapshot })
assert(state.flow?.flow === 'standard' && state.flow.version === 1, 'newTask stores the frozen snapshot')
assert(state.stage === '需求评审', 'newTask starts at the frozen start stage')

// ── 5. high_risk create on minimal is rejected ─────────────────────────────
await assertThrows(
  () => registered(makeFs({ '.dsh/eng.json': JSON.stringify({ flow: 'minimal' }) }))
    .then(exe => exe({ operation: 'create', task_id: 'T2', title: 'x', branch: 'main', risk_level: 'high_risk' }, EXEC)),
  'high_risk',
  'high_risk on minimal is rejected',
)

// ── 6. a task keeps its frozen snapshot after eng.json changes ─────────────
{
  const fs = makeFs({ '.dsh/eng.json': JSON.stringify({ flow: 'standard' }) })
  const exe = await registered(fs)
  const created = await exe({ operation: 'create', task_id: 'T3', title: 'x', branch: 'main' }, EXEC)
  assert(created.includes('需求评审'), 'standard create starts at 需求评审')
  fs._files.set('.dsh/eng.json', JSON.stringify({ flow: 'minimal' }))
  const status = JSON.parse(await exe({ operation: 'status', task_id: 'T3' }, EXEC))
  assert(status.flow?.flow === 'standard' && status.flow.version === 1, 'status re-reads the frozen snapshot')
  assert(Array.isArray(status.legal_next) && status.legal_next.includes('设计'),
    'gates come from the frozen standard flow, not the live minimal flow')
}

// ── 7. unknown flow blocks state-changing operations ───────────────────────
await assertThrows(
  () => registered(makeFs({ '.dsh/eng.json': JSON.stringify({ flow: 'nope' }) }))
    .then(exe => exe({ operation: 'create', task_id: 'X', title: 'y', branch: 'z' }, EXEC)),
  'unknown flow',
  'create on an unknown flow fails closed',
)

// ── 8. a file missing its flow field fails closed ──────────────────────────
await assertThrows(
  () => registered(makeFs({ '.dsh/eng.json': JSON.stringify({}) }))
    .then(exe => exe({ operation: 'create', task_id: 'X', title: 'y', branch: 'z' }, EXEC)),
  'missing a "flow" field',
  'eng.json without a flow field is a config error',
)

// ── 9. init: inspect → propose → apply, no direct overwrite ────────────────
{
  const fs = makeFs()
  const exe = await registered(fs)
  const insp = await exe({ operation: 'init', phase: 'inspect' }, EXEC)
  assert(insp.includes('no AGENTS.md'), 'inspect on empty project prompts a scan')
  const prop = await exe({ operation: 'init', phase: 'propose', content: '# 项目\n示例' }, EXEC)
  assert(prop.includes('proposed create'), 'propose previews without writing')
  assert(fs._files.get('AGENTS.md') === undefined, 'propose writes nothing')
  const app = await exe({ operation: 'init', phase: 'apply', content: '# 项目\n示例' }, EXEC)
  assert(app.includes('wrote ./AGENTS.md'), 'apply writes the file')
  assert(fs._files.get('AGENTS.md') === '# 项目\n示例', 'apply persisted the draft')
}

// ── 10. init protects an existing governance file ─────────────────────────
{
  const fs = makeFs({ 'AGENTS.md': '# 已有治理文件\n' })
  const exe = await registered(fs)
  await assertThrows(
    () => exe({ operation: 'init', phase: 'apply', content: '# new' }, EXEC),
    'protected',
    'apply without overwrite on an existing file is rejected',
  )
  await assertThrows(
    () => exe({ operation: 'init', phase: 'apply', content: '# new', overwrite: true }, EXEC),
    'approval',
    'overwrite requires an approval service',
  )
}

// ── 11. a project cannot shadow a bundled core rule ────────────────────────
{
  const bundled = readFileSync('./rules/security-redlines.md', 'utf8')
  assert(bundled.includes('服务端'), 'bundled security-redlines exists as expected')
  const fs = makeFs({
    '.dsh/eng.json': JSON.stringify({ flow: 'standard' }),
    '.dsh/rules/security-redlines.md': '# 弱化的安全红线，前端校验即可',
  })
  const exe = await registered(fs)
  await exe({ operation: 'create', task_id: 'T9', title: 'x', branch: 'main' }, EXEC)
  const status = JSON.parse(await exe({ operation: 'status', task_id: 'T9' }, EXEC))
  const sec = status.bindings.rules.find(r => r.name === 'security-redlines')
  assert(sec !== undefined, 'security-redlines is disclosed at the start stage')
  assert(!sec.content.includes('前端校验即可'), 'a project shadow of a core rule is ignored')
  assert(sec.content.includes('服务端'), 'the bundled core rule body wins over a shadow')
}

// ── 12. session cwd drives every relative path (init regression) ──────────
{
  const cwd = 'C:/users/ggbond/.dsh-verify/e2e-project'
  const fs = makeFs({
    [`${cwd}/AGENTS.md`]: '# e2e 项目治理文件\n两行\n',
    'D:/dsharness/deepseek-harness/AGENTS.md': '# DeepSeek Harness monorepo (packages/pnpm)\n',
  })
  const exe = await registered(fs)
  const insp = await exe({ operation: 'init', phase: 'inspect' }, sessionExec(cwd))
  assert(insp.includes('# e2e 项目治理文件'), 'inspect reads the session workspace AGENTS.md')
  assert(!insp.includes('monorepo'), 'inspect does not read the harness repo AGENTS.md')
}

// ── 13. create writes the task record into the session workspace ──────────
{
  const cwd = 'C:/users/ggbond/.dsh-verify/e2e-project'
  const fs = makeFs({ [`${cwd}/.dsh/eng.json`]: JSON.stringify({ flow: 'standard' }) })
  const exe = await registered(fs)
  await exe({ operation: 'create', task_id: 'T12', title: 'x', branch: 'main' }, sessionExec(cwd))
  assert(fs._files.get(`${cwd}/.dsh/task-T12.json`) !== undefined, 'task record lands in the session workspace')
  assert(fs._files.get('.dsh/task-T12.json') === undefined, 'task record does not land in the backend base')
}

// ── 14. K: artifact ids must be unique across ALL stages ────────────────────
{
  const withDup = { ...FLOW_PRESETS.standard.config, artifacts: [
    { stage: '需求评审', id: 'doc', name: '需求', fields: ['scope'] },
    { stage: '设计', id: 'doc', name: '设计', fields: ['approach'] },
  ] }
  const problems = validateWorkflow(withDup)
  assert(problems.some(p => p.includes('duplicate artifact id "doc"')),
    'cross-stage duplicate artifact id is rejected')
}

// ── 15. K: record rejects an artifact owned by another stage ─────────────────
{
  const fs = makeFs({ '.dsh/eng.json': JSON.stringify({ flow: 'standard' }) })
  const exe = await registered(fs)
  await exe({ operation: 'create', task_id: 'K1', title: 'x', branch: 'main' }, EXEC)
  await assertThrows(
    () => exe({ operation: 'record', task_id: 'K1', artifact: 'design', fields: { approach: 'a', risks: 'r', impact: 'i' } }, EXEC),
    'belongs to stage',
    'recording an artifact at a non-owning stage is rejected',
  )
}

// ── 16. L: high-risk verification requires non-blank evidence ───────────────
{
  const cfg = FLOW_PRESETS.standard.config
  const mk = () => {
    const s = newTask({ id: 'L1', title: 'x', branch: 'main', work_size: 'standard', risk_level: 'high_risk', flow: snapshot })
    s.stage = '交付'
    return s
  }
  let s = mk(); s.verification = { passed: true, evidence: [''] }
  assert(!assertAdvance(s, '代码审核', cfg).ok, 'high_risk with empty-string evidence is blocked at the verified gate')
  s = mk(); s.verification = { passed: true, evidence: ['   '] }
  assert(!assertAdvance(s, '代码审核', cfg).ok, 'high_risk with whitespace-only evidence is blocked')
  s = mk(); s.verification = { passed: true, evidence: ['单测通过'] }
  assert(assertAdvance(s, '代码审核', cfg).ok, 'high_risk with non-blank evidence passes the verified gate')
}

// ── 17. J: task id extracted from the summary (the hook uses it, not a guess) ─
{
  const cfg = FLOW_PRESETS.standard.config
  assert(taskIdFromMessage('【GREET-001】【TASK】实现登录', cfg) === 'GREET-001', 'standard summary yields its task id')
  assert(taskIdFromMessage('【GREET-001】【T1】实现登录', cfg) === 'GREET-001', 'item-label summary yields its task id')
  assert(taskIdFromMessage('实现登录', cfg) === undefined, 'non-matching summary yields no task id')
  assert(taskIdFromMessage('随意', FLOW_PRESETS.minimal.config) === undefined, 'pattern-less flow yields no task id')
}

// ── 18. N: engine bookkeeping files are exempt from file scope ───────────────
{
  const s = newTask({ id: 'N1', title: 'x', branch: 'main', work_size: 'standard', risk_level: 'standard', flow: snapshot })
  s.files = ['src/a.ts']
  assert(checkFileScope(s, ['src/a.ts', '.dsh/task-N1.json', '.dsh/eng.json'], FLOW_PRESETS.standard.config).ok,
    'task record and eng.json do not violate file scope')
  assert(!checkFileScope(s, ['src/b.ts'], FLOW_PRESETS.standard.config).ok,
    'an out-of-scope code file is still flagged')
}

// ── 19. H/I: hook reads raw-byte paths, NUL-separated, including deletions ───
{
  const hook = readFileSync('./hooks/commit-msg', 'utf8')
  assert(hook.includes('-c core.quotePath=false'), 'hook disables git octal path quoting')
  assert(hook.includes('-z'), 'hook reads NUL-separated raw-byte paths')
  assert(hook.includes('--diff-filter=ACMRD'), 'hook includes deletions in the scope check')
}

// ── 20. 4.1/4.3: hook uses the frozen snapshot; writeInit guards overwrite ──
{
  const hook = readFileSync('./hooks/commit-msg', 'utf8')
  assert(hook.includes('state.flow && state.flow.config'), 'hook checks the task frozen flow snapshot')
  assert(hook.includes('function extractTaskId'), 'hook extracts the task id independent of the live config')
}
{
  const controller = readFileSync('./lib/controller.js', 'utf8')
  assert(controller.includes('AGENTS.md 已存在且受保护'), 'workbench writeInit refuses to overwrite without an explicit intent')
  assert(controller.includes('overwrite'), 'writeInit request carries an overwrite field')
}

console.log(`\nP0 acceptance: ${passed} checks passed`)