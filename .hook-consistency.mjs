/**
 * The commit hook must agree with the tool about the same commit.
 *
 * The assessment requires one set of semantics shared by `status`, the tool's own
 * gates and the Git hook, rather than three implementations that drift. The hook
 * is built from the same engine source, so this checks the built artefact rather
 * than the source relationship.
 */
import { readFileSync } from 'node:fs'
import { resolveFlow } from './lib/workflows.js'
import { validateCommitMessage, commitCheckpoint, verificationBlockers } from './lib/engine.js'

let bad = 0
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? '✅' : '❌') + ' ' + label + (detail ? ' — ' + detail : ''))
  if (!ok) bad++
}

console.log('=== hook 与工具共享判定 ===')
const hook = readFileSync('hooks/commit-msg', 'utf8')
for (const fn of ['validateCommitMessage', 'commitCheckpoint', 'verificationHeldStages', 'verificationBlockers']) {
  check('hook 内置 ' + fn, hook.includes(fn), hook.includes(fn) ? '' : 'hook 与工具语义会漂移')
}

console.log('')
console.log('=== 每种标签形状都能通过它自己预设的校验 ===')
for (const id of ['standard', 'agile', 'minimal']) {
  const cfg = resolveFlow(id, {}).config
  const labels = id === 'agile' ? ['TASK', 'T1', 'T2'] : ['TASK']
  for (const label of labels) {
    const message = `【T-1】【${label}】did the thing`
    const r = validateCommitMessage(message, cfg)
    check(`${id}「${label}」被接受`, r.ok, r.ok ? '' : (r.errors ?? []).join('; '))
  }
}

console.log('')
console.log('=== 提交许可与验证要求一致（三个预设）===')
for (const id of ['standard', 'agile', 'minimal']) {
  const cfg = resolveFlow(id, {}).config
  const terminal = cfg.stages.filter(s => !cfg.transitions.some(t => t.from === s))[0]
  const failing = {
    stage: terminal, execution_version: 1,
    items: [{ id: 'A', status: 'done', review: { spec: { outcome: 'pass' }, quality: { outcome: 'pass' } } }],
    verification: { passed: false, evidence: [] }, commits: [],
  }
  const vb = verificationBlockers(failing, cfg)
  const cp = commitCheckpoint(failing, cfg)
  // 需要验证的流程：失败必须同时阻止提交；不需要验证的流程：两者都不应因验证而阻止
  const requires = cfg.transitions.some(t => (t.requires ?? []).includes('verified'))
  if (requires) {
    check(`${id} 验证失败阻止提交`, vb.length > 0 && cp.allowed === false, `blockers=${vb.length} allowed=${cp.allowed}`)
  } else {
    check(`${id} 不发明验证要求`, vb.length === 0, JSON.stringify(vb))
  }
}

console.log('')
console.log(bad === 0 ? '✅ hook 与工具语义一致' : `❌ ${bad} 项不一致`)
process.exit(bad === 0 ? 0 : 1)