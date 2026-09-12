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

// ── 16. L/4.2: high-risk verification requires a REAL command receipt ────────
{
  const cfg = FLOW_PRESETS.standard.config
  const receipt = overrides => ({
    command: 'npm test', exit_code: 0, timed_out: false, aborted: false,
    started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z',
    stdout: '', stderr: '', ...overrides,
  })
  const mk = () => {
    const s = newTask({ id: 'L1', title: 'x', branch: 'main', work_size: 'standard', risk_level: 'high_risk', flow: snapshot })
    s.stage = '交付'
    return s
  }
  let s = mk(); s.verification = { passed: true, evidence: ['单测通过'] }
  assert(!assertAdvance(s, '代码审核', cfg).ok, 'high_risk with text-only evidence is blocked (no command receipt)')
  s = mk(); s.verification = { passed: true, evidence: [], receipt: receipt({}) }
  assert(assertAdvance(s, '代码审核', cfg).ok, 'high_risk with an exit-0 receipt passes the verified gate')
  s = mk(); s.verification = { passed: true, evidence: [], receipt: receipt({ exit_code: 1 }) }
  assert(!assertAdvance(s, '代码审核', cfg).ok, 'high_risk with a non-zero exit receipt is blocked')
  s = mk(); s.verification = { passed: true, evidence: [], receipt: receipt({ timed_out: true }) }
  assert(!assertAdvance(s, '代码审核', cfg).ok, 'high_risk with a timed-out receipt is blocked')
  s = mk(); s.verification = { passed: true, evidence: [], receipt: receipt({ aborted: true }) }
  assert(!assertAdvance(s, '代码审核', cfg).ok, 'high_risk with an aborted receipt is blocked')
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
  assert(hook.includes('--diff-filter=ACMRDT'), 'hook includes deletions and type changes in the scope check')
}

// ── 20. 4.1/4.3: hook uses the frozen snapshot; writeInit guards overwrite ──
{
  const hook = readFileSync('./hooks/commit-msg', 'utf8')
  assert(hook.includes('config = state.flow.config'), 'hook checks the task frozen flow snapshot')
  assert(hook.includes('function extractTaskId'), 'hook extracts the task id independent of the live config')
  assert(!hook.includes('const FLOWS'), 'hook bundles the single source (workflows.ts), not a hand mirror')
}
{
  const controller = readFileSync('./lib/controller.js', 'utf8')
  assert(controller.includes('AGENTS.md 已存在且受保护'), 'workbench writeInit refuses to overwrite without an explicit intent')
  assert(controller.includes('overwrite'), 'writeInit request carries an overwrite field')
}

// ── 21. 0.21-A: project adapter — type detection, root discovery, default verify commands ──
const project = await import('./lib/project.js')

function memProbe(files) {
  return {
    async read(dir, relPath) {
      const key = `${dir.replace(/\\/g, '/')}/${relPath}`.replace(/\/+/g, '/')
      return files[key]
    },
  }
}

{
  const probe = memProbe({ '/repo/package.json': '{}' })
  assert(await project.detectType(probe, '/repo') === 'node', 'node marker resolves to node')
  assert(await project.detectRoot(probe, '/repo/src/nested') === '/repo', 'root discovery climbs to the package.json directory')
}
{
  const probe = memProbe({ '/repo/pom.xml': '<project/>' })
  assert(await project.detectType(probe, '/repo') === 'java', 'pom.xml resolves to java')
}
{
  const probe = memProbe({ '/repo/go.mod': 'module x' })
  assert(await project.detectType(probe, '/repo') === 'go', 'go.mod resolves to go')
}
{
  const probe = memProbe({ '/repo/Cargo.toml': '[package]' })
  assert(await project.detectType(probe, '/repo') === 'rust', 'Cargo.toml resolves to rust')
}
{
  const probe = memProbe({ '/repo/requirements.txt': 'flask' })
  assert(await project.detectType(probe, '/repo') === 'python', 'requirements.txt resolves to python')
}
{
  const probe = memProbe({})
  assert(await project.detectType(probe, '/empty') === 'unknown', 'empty tree reports unknown type')
  assert(await project.detectRoot(probe, '/empty/deep/dir') === '/empty/deep/dir', 'root discovery falls back to the start directory')
}
{
  const probe = memProbe({ '/repo/package.json': '{}', '/repo/pyproject.toml': '[tool]' })
  assert(await project.detectType(probe, '/repo') === 'unknown', 'mixed tree reports unknown, never a silent single-language guess')
}
{
  const probe = memProbe({ '/repo/.git/HEAD': 'ref: refs/heads/main' })
  assert(await project.detectRoot(probe, '/repo/sub/module') === '/repo', 'root discovery stops at the git repository')
}
{
  assert(project.defaultVerifyCommand('node') === 'npm test', 'node default verify command')
  assert(project.defaultVerifyCommand('java') === 'mvn -q test', 'java default verify command')
  assert(project.defaultVerifyCommand('go') === 'go test ./...', 'go default verify command')
  assert(project.defaultVerifyCommand('unknown') === undefined, 'unknown type has no default command')
}
{
  const probe = memProbe({ '/repo/AGENTS.md': '# a', '/repo/CLAUDE.md': '# c' })
  const present = await project.presentGovernanceFiles(probe, '/repo')
  assert(present.includes('AGENTS.md') && present.includes('CLAUDE.md'), 'governance files are recognized as present')
  assert(!present.includes('.cursorrules'), 'absent governance files are not listed')
}

// ── 22. 0.21-C/D/E: out-of-root write guard, hook risk policy, project binding dirs ──
{
  const { assertInsideRoot } = await import('./lib/dev-task.js')
  assertInsideRoot('/repo', '/repo/sub', 'AGENTS.md')
  assertInsideRoot('/repo/sub', '/repo/sub', 'AGENTS.md')
  await assertThrows(
    () => assertInsideRoot('/repo', '/repo', '../outside.txt'),
    'escapes the project root',
    'init write escaping the root is rejected',
  )
  await assertThrows(
    () => assertInsideRoot('/repo', '/repo', 'C:/elsewhere/x.txt'),
    'escapes the project root',
    'absolute target outside the root is rejected',
  )
}
{
  const hook = readFileSync('./hooks/commit-msg', 'utf8')
  assert(hook.includes('sensitive_paths'), 'hook bundles the risk policy table (single source)')
  assert(hook.includes('risk_level === "high_risk"') || hook.includes('risk_level === \'high_risk\''), 'hook requires high_risk before touching sensitive paths')
}
{
  const probe = {
    async read(dir, relPath) {
      const key = `${dir}/${relPath}`.replace(/\/+/g, '/')
      return files[key]
    },
    async list(dir, relPath) {
      const prefix = `${dir}/${relPath}`.replace(/\/+/g, '/')
      return Object.keys(files).filter(k => k.startsWith(prefix + '/')).map(k => k.slice(prefix.length + 1).split('/')[0])
    },
  }
  const files = {
    '/repo/.dsh/rules/api-conventions.md': '# r',
    '/repo/.dsh/rules/README.md': '# meta',
    '/repo/.dsh/skills/java-dev/SKILL.md': '# s',
    '/repo/.dsh/skills/empty/': '# no skill file',
  }
  const rules = await project.listProjectRules(probe, '/repo')
  assert(rules.length === 2 && rules.includes('api-conventions'), 'project rules list from .dsh/rules/*.md')
  const skills = await project.listProjectSkills(probe, '/repo')
  assert(skills.length === 1 && skills.includes('java-dev'), 'project skills list only dirs carrying SKILL.md')
}

// ── 23. 0.22-A: snapshot hash integrity ────────────────────────────────────
{
  const { hashConfig } = await import('./lib/snapshot.js')
  const config = FLOW_PRESETS.standard.config
  const h1 = hashConfig(config)
  const h2 = hashConfig(JSON.parse(JSON.stringify(config)))
  assert(h1 === h2 && /^[0-9a-f]{64}$/.test(h1), 'hashConfig is a deterministic sha256')
  const tampered = JSON.parse(JSON.stringify(config))
  tampered.commit.file_scope = false
  assert(hashConfig(tampered) !== h1, 'editing the frozen config changes the hash')
}
{
  const fs = makeFs({ '.dsh/eng.json': JSON.stringify({ flow: 'standard' }) })
  const exe = await registered(fs)
  await exe({ operation: 'create', task_id: 'HASH-1', title: 'x', branch: 'main' }, EXEC)
  const record = JSON.parse(fs._files.get('.dsh/task-HASH-1.json'))
  record.flow.config.commit.file_scope = false
  fs._files.set('.dsh/task-HASH-1.json', JSON.stringify(record))
  await assertThrows(
    () => exe({ operation: 'status', task_id: 'HASH-1' }, EXEC),
    'hash mismatch',
    'status on a tampered snapshot is rejected',
  )
}
{
  const hook = readFileSync('./hooks/commit-msg', 'utf8')
  assert(hook.includes('hashConfig'), 'hook reuses the single hashConfig source')
  assert(hook.includes('sha256') || hook.includes('createHash'), 'hook bundles the sha256 snapshot check')
}

// ── 24. 0.22-B: installed-hook integrity check ─────────────────────────────
{
  const fs = makeFs({})
  const exe = await registered(fs)
  assert((await exe({ operation: 'verify_hook' }, EXEC)).includes('run install_hook'), 'verify_hook reports an absent hook')
  await exe({ operation: 'install_hook' }, EXEC)
  assert((await exe({ operation: 'verify_hook' }, EXEC)).includes('integrity OK'), 'verify_hook passes on the bundled hook')
  fs._files.set('.git/hooks/commit-msg', fs._files.get('.git/hooks/commit-msg') + '\n// tampered')
  await assertThrows(
    () => exe({ operation: 'verify_hook' }, EXEC),
    'integrity FAILED',
    'verify_hook rejects a tampered hook',
  )
}

// ── 25. 0.22-B: risk downgrade approval + bindings fingerprint ─────────────
{
  const fs = makeFs({ '.dsh/eng.json': JSON.stringify({ flow: 'standard' }) })
  const exe = await registered(fs)
  await exe({ operation: 'create', task_id: 'RISK-1', title: 'x', branch: 'main', risk_level: 'high_risk' }, EXEC)
  await assertThrows(
    () => exe({ operation: 'set_risk', task_id: 'RISK-1', risk_level: 'standard' }, EXEC),
    'approval',
    'downgrade without an approval service is rejected',
  )
  assert((await exe({ operation: 'set_risk', task_id: 'RISK-1', risk_level: 'high_risk' }, EXEC)).includes('already'),
    'same-risk set_risk is a no-op')
}
{
  const approval = { async request() { return 'allowed-once' } }
  const fs = makeFs({ '.dsh/eng.json': JSON.stringify({ flow: 'standard' }) })
  const exe = await registered(fs, approval)
  await exe({ operation: 'create', task_id: 'RISK-2', title: 'x', branch: 'main', risk_level: 'high_risk' }, EXEC)
  assert((await exe({ operation: 'set_risk', task_id: 'RISK-2', risk_level: 'standard' }, EXEC)).includes('risk_level set to standard'),
    'approved downgrade succeeds')
  const status = JSON.parse(await exe({ operation: 'status', task_id: 'RISK-2' }, EXEC))
  assert(status.risk_level === 'standard' && status.risk_downgrades.length === 1,
    'downgrade is recorded in the audit trail')
}
{
  const fs = makeFs({ '.dsh/eng.json': JSON.stringify({ flow: 'standard' }) })
  const exe = await registered(fs)
  await exe({ operation: 'create', task_id: 'FP-1', title: 'x', branch: 'main' }, EXEC)
  const status = JSON.parse(await exe({ operation: 'status', task_id: 'FP-1' }, EXEC))
  assert(status.bindings_drift === undefined, 'fresh task shows no bindings drift')
  const record = JSON.parse(fs._files.get('.dsh/task-FP-1.json'))
  assert(typeof record.bindings_fingerprint === 'string' && record.bindings_fingerprint.length === 64,
    'create records the bundled-rules fingerprint')
}

// ── 26. 0.22-C: multi-language verify command chain + parallel tasks ────────
{
  const fs = makeFs({ '.dsh/eng.json': JSON.stringify({ flow: 'standard', verify_command: 'mvn test' }) })
  const exe = await registered(fs)
  await exe({ operation: 'create', task_id: 'V-1', title: 'x', branch: 'main' }, EXEC)
  await assertThrows(
    () => exe({ operation: 'verify', task_id: 'V-1' }, EXEC),
    'shell',
    'verify falls back to the eng.json command and fails loud without a shell service',
  )
}
{
  const fs = makeFs({ '.dsh/eng.json': JSON.stringify({ flow: 'standard' }), 'package.json': '{}' })
  const exe = await registered(fs)
  await exe({ operation: 'create', task_id: 'V-2', title: 'x', branch: 'main' }, EXEC)
  await assertThrows(
    () => exe({ operation: 'verify', task_id: 'V-2' }, EXEC),
    'shell',
    'verify falls back to the language default (node → npm test) and fails loud without a shell service',
  )
}
{
  const fs = makeFs({ '.dsh/eng.json': JSON.stringify({ flow: 'standard' }) })
  const exe = await registered(fs)
  await exe({ operation: 'create', task_id: 'V-3', title: 'x', branch: 'main' }, EXEC)
  assert((await exe({ operation: 'verify', task_id: 'V-3', passed: true }, EXEC)).includes('ok'),
    'unknown-type verify keeps the legacy self-reported path')
}
{
  const fs = makeFs({ '.dsh/eng.json': JSON.stringify({ flow: 'standard' }) })
  const exe = await registered(fs)
  await exe({ operation: 'create', task_id: 'A-1', title: 'x', branch: 'main' }, EXEC)
  await exe({ operation: 'create', task_id: 'B-2', title: 'y', branch: 'main' }, EXEC)
  await exe({ operation: 'scope', task_id: 'A-1', files: ['src/a.ts'] }, EXEC)
  const a = JSON.parse(await exe({ operation: 'status', task_id: 'A-1' }, EXEC))
  const b = JSON.parse(await exe({ operation: 'status', task_id: 'B-2' }, EXEC))
  assert(a.files.length === 1 && b.files.length === 0, 'two tasks in one repo advance independently')
}

// ── 27. 9.4: init apply validates the expected hash ─────────────────────────
{
  const fs = makeFs({})
  const exe = await registered(fs)
  const propose = await exe({ operation: 'init', phase: 'propose', content: 'hello' }, EXEC)
  const match = /content hash: ([0-9a-f]{64})/.exec(propose)
  assert(match !== null, 'propose returns the content hash')
  await assertThrows(
    () => exe({ operation: 'init', phase: 'apply', content: 'hello', expected_hash: '0'.repeat(64) }, EXEC),
    'expected_hash mismatch',
    'apply with a mismatched hash is rejected',
  )
  assert((await exe({ operation: 'init', phase: 'apply', content: 'hello', expected_hash: match[1] }, EXEC)).includes('wrote'),
    'apply with the matching hash writes the file')
}

// ── 28. risk policy excludes project binding dirs ───────────────────────────
{
  const policy = project.DEFAULT_RISK_POLICY
  assert(!policy.sensitive_paths.includes('.dsh'),
    'project binding dir (.dsh/rules, .dsh/skills) stays committable by normal tasks')
  assert(policy.sensitive_paths.includes('.env'), 'env files remain sensitive')
}

console.log(`\nP0 acceptance: ${passed} checks passed`)