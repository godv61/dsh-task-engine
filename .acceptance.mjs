/**
 * Independent acceptance check against the corrected design.
 *
 * Reads the SHIPPED config and the built engine, not the test files, so a pass
 * here cannot come from an assertion I wrote to match my own implementation.
 */
import { readFileSync } from 'node:fs'
import { resolveFlow, FLOW_PRESETS } from './lib/workflows.js'
import { validateWorkflow, bindingsForStage, completionBlockers, invalidatedBy } from './lib/engine.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? '✅' : '❌') + ' ' + label + (detail ? ' — ' + detail : ''))
  if (!ok) failures++
}

console.log('=== 验收 1：节点只选技能，规则归技能 ===')
for (const [id, preset] of Object.entries(FLOW_PRESETS)) {
  for (const [stage, b] of Object.entries(preset.config.stage_bindings ?? {})) {
    if ('rules' in b && b.rules !== undefined) {
      check(`${id}/${stage} 无节点级规则`, false, JSON.stringify(b.rules))
    }
    for (const e of b.skills ?? []) {
      if (!Array.isArray(e.rules)) check(`${id}/${stage} 技能带规则数组`, false)
      if (!e.skill?.source) check(`${id}/${stage} 技能有来源`, false, e.skill?.name)
    }
  }
}
check('全部节点只含 skills', failures === 0)

console.log('')
console.log('=== 验收 2：同一技能在任何节点规则一致 ===')
const bySkill = new Map()
for (const [id, preset] of Object.entries(FLOW_PRESETS)) {
  for (const [stage, b] of Object.entries(preset.config.stage_bindings ?? {})) {
    for (const e of b.skills ?? []) {
      const key = `${e.skill.source}:${e.skill.name}`
      const sig = e.rules.map(r => `${r.source}:${r.name}`).sort().join('|')
      if (!bySkill.has(key)) bySkill.set(key, new Set())
      bySkill.get(key).add(sig)
    }
  }
}
for (const [skill, sigs] of bySkill) {
  check(`${skill} 规则集唯一`, sigs.size === 1, sigs.size > 1 ? [...sigs].join(' vs ') : '')
}

console.log('')
console.log('=== 验收 3：配置可被引擎接受 ===')
for (const id of ['standard', 'agile', 'minimal']) {
  const problems = validateWorkflow(resolveFlow(id, {}).config)
  check(`${id} validateWorkflow 无问题`, problems.length === 0, problems.join('; '))
}

console.log('')
console.log('=== 验收 4：默认配置示例与预设一致 ===')
const doc = JSON.parse(readFileSync('defaults/eng.json', 'utf8'))
const merged = resolveFlow('standard', { stage_bindings: doc.stage_bindings })
check('defaults/eng.json 可解析', merged.ok)
check('defaults/eng.json 无验证问题', validateWorkflow(merged.config).length === 0)

console.log('')
console.log('=== 验收 5：三预设都以 completed 收尾 ===')
for (const id of ['standard', 'agile', 'minimal']) {
  const cfg = resolveFlow(id, {}).config
  const terminals = cfg.stages.filter(s => !cfg.transitions.some(t => t.from === s))
  const state = {
    stage: terminals[0], execution_version: 1,
    items: [{ id: 'A', status: 'done', review: { spec: { outcome: 'pass' }, quality: { outcome: 'pass' } } }],
    verification: { passed: true, evidence: [] }, commits: [],
  }
  const blocked = completionBlockers(state, cfg)
  check(`${id} 未提交时不可完成`, blocked.length > 0)
  const done = { ...state, commits: [{ label: 'TASK', hash: 'abc1234' }] }
  check(`${id} 提交后可完成`, completionBlockers(done, cfg).length === 0)
}

console.log('')
console.log('=== 验收 6：返工三种类型范围不同 ===')
const r = invalidatedBy('requirement'), s = invalidatedBy('solution'), d = invalidatedBy('defect')
check('requirement 失效需求确认', r.includes('requirement_confirmation'))
check('solution 保留需求确认', !s.includes('requirement_confirmation'))
check('defect 保留需求与方案确认', !d.includes('requirement_confirmation') && !d.includes('solution_confirmation'))
check('defect 失效验证与审核', d.includes('verification') && d.includes('review'))
check('三者范围互不相同', new Set([r.join(), s.join(), d.join()]).size === 3)

console.log('')
console.log(failures === 0 ? '✅ 全部验收项通过' : `❌ ${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)