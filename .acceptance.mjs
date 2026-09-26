/**
 * Independent acceptance check for the skeleton/recommendation design.
 *
 * Reads the SHIPPED config and the built engine, not the test files, so a pass
 * cannot come from an assertion written to match the implementation.
 *
 * The criteria are the product principles rather than implementation details:
 *   1. a flow is state control only — adopting a setup is a separate act
 *   2. adoption yields a config the user fully owns, editable and removable
 *   3. a node references skills; a rule belongs to the skill that carries it
 *   4. nothing is merged back after adoption, and an upgrade never overwrites
 */
import { readFileSync } from 'node:fs'
import { resolveFlow, FLOW_PRESETS, adoptRecommendation } from './lib/workflows.js'
import { validateWorkflow, formatResourceRef, completionBlockers, terminalRequirements, invalidatedBy } from './lib/engine.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log('  ' + (ok ? '✅' : '❌') + ' ' + label + (detail ? ' — ' + detail : ''))
  if (!ok) failures++
}

console.log('=== 1. 流程只做状态控制 ===')
for (const [id, preset] of Object.entries(FLOW_PRESETS)) {
  const skeleton = resolveFlow(id, { flow: id }).config
  check(`${id} 骨架不带技能`, Object.keys(skeleton.stage_bindings ?? {}).length === 0)
  check(`${id} 骨架不带产物`, skeleton.artifacts.length === 0)
  check(`${id} 骨架保留状态机`, preset.config.transitions.length > 0 && preset.config.stages.length > 0)
  check(`${id} 提交文本约定不在骨架里`, skeleton.commit.message_pattern === '', JSON.stringify(skeleton.commit.message_pattern))
}
// When a commit gate fires and whether the file scope is protected are flow
// control, so they must stay on the skeleton: they are a safety floor, not a
// writing convention, and must not disappear because a user declined a setup.
check('standard 骨架保留提交检查点', FLOW_PRESETS.standard.config.commit.checkpoints.length > 0,
  JSON.stringify(FLOW_PRESETS.standard.config.commit.checkpoints))
check('standard 骨架保留文件范围保护', FLOW_PRESETS.standard.config.commit.file_scope === true)

console.log('')
console.log('=== 2. 采用是显式动作 ===')
check('推荐配置单独存在', Object.values(FLOW_PRESETS).every(p => p.recommendation !== undefined))
check('选流程不产生绑定', Object.keys(resolveFlow('standard', { flow: 'standard' }).config.stage_bindings ?? {}).length === 0)

console.log('')
console.log('=== 3. 采用后完全可编辑、可删除 ===')
for (const id of ['standard', 'agile', 'minimal']) {
  const adopted = adoptRecommendation(id)
  check(`${id} 采用后仍不绑定业务技能`, Object.keys(adopted.stage_bindings ?? {}).length === 0)
  const retained = adoptRecommendation(id, { flow: id, stage_bindings: {
    开发: { skill_refs: [{ source: 'project', name: 'mine' }] },
  } })
  check(`${id} 采用推荐文本时保留用户技能`, retained.stage_bindings.开发.skill_refs[0].name === 'mine')
  if (id !== 'minimal') check(`${id} 推荐提交文本实际写入`, retained.commit.message_pattern !== '')
  const replaced = resolveFlow(id, { ...adopted, stage_bindings: {} }).config
  check(`${id} 清空后为空（不补回）`, Object.keys(replaced.stage_bindings ?? {}).length === 0)
  const mine = resolveFlow(id, {
    ...adopted,
    stage_bindings: { 开发: { skills: [{ skill: { source: 'project', name: 'mine' }, rules: [] }] } },
  }).config
  const dev = mine.stage_bindings['开发'].skills ?? []
  check(`${id} 用户技能被原样采纳`, dev.length === 1 && dev[0].skill.name === 'mine',
    JSON.stringify(dev.map(s => s.skill.name)))
}

console.log('')
console.log('=== 4. 规则归属技能，节点只引用 ===')
for (const id of ['standard', 'agile', 'minimal']) {
  const cfg = resolveFlow(id, adoptRecommendation(id)).config
  let stageRuleList = false
  let badSkill = false
  for (const binding of Object.values(cfg.stage_bindings ?? {})) {
    if (binding.rules !== undefined) stageRuleList = true
    for (const entry of binding.skills ?? []) {
      if (!Array.isArray(entry.rules)) badSkill = true
      if (entry.skill?.source === undefined) badSkill = true
    }
  }
  check(`${id} 节点无规则列表`, !stageRuleList)
  check(`${id} 每个技能自带规则数组`, !badSkill)
}

console.log('')
console.log('=== 5. 同一技能引用在任何节点规则一致 ===')
for (const id of ['standard', 'agile', 'minimal']) {
  const cfg = resolveFlow(id, adoptRecommendation(id)).config
  const bySkill = new Map()
  for (const binding of Object.values(cfg.stage_bindings ?? {})) {
    for (const entry of binding.skills ?? []) {
      const key = formatResourceRef(entry.skill)
      const sig = entry.rules.map(formatResourceRef).sort().join('|')
      if (!bySkill.has(key)) bySkill.set(key, new Set())
      bySkill.get(key).add(sig)
    }
  }
  let ok = true
  for (const [skill, sigs] of bySkill) if (sigs.size > 1) { ok = false; console.log('    ' + skill + ' 有 ' + sigs.size + ' 种规则集') }
  check(`${id} 每个技能的规则集唯一`, ok, bySkill.size + ' 个技能')
}

console.log('')
console.log('=== 6. 配置可被引擎接受 ===')
for (const id of ['standard', 'agile', 'minimal']) {
  const problems = validateWorkflow(resolveFlow(id, adoptRecommendation(id)).config)
  check(`${id} 采用后配置无问题`, problems.length === 0, problems.join('; '))
  const bare = validateWorkflow(resolveFlow(id, { flow: id }).config)
  check(`${id} 裸骨架也合法`, bare.length === 0, bare.join('; '))
}

console.log('')
console.log('=== 7. defaults/eng.json 是空绑定配置示例 ===')
const doc = JSON.parse(readFileSync('defaults/eng.json', 'utf8'))
const merged = resolveFlow(doc.flow, doc)
check('defaults/eng.json 可解析', merged.ok)
if (merged.ok) {
  check('defaults/eng.json 无验证问题', validateWorkflow(merged.config).length === 0)
  check('defaults/eng.json 不含技能', Object.keys(merged.config.stage_bindings ?? {}).length === 0)
}

console.log('')
console.log('=== 8. 三预设都以 completed 收尾，且检查各自声明的节点结果 ===')
for (const id of ['standard', 'agile', 'minimal']) {
  const cfg = resolveFlow(id, adoptRecommendation(id)).config
  const terminals = cfg.stages.filter(s => !cfg.transitions.some(t => t.from === s))
  // Every conclusion a flow could ask for, so each preset is judged on what IT
  // declared rather than on what one preset happens to need.
  const satisfied = {
    stage: terminals[0], execution_version: 1,
    items: [{ id: 'A', status: 'done', review: { spec: { outcome: 'pass' }, quality: { outcome: 'pass' } } }],
    verification: { passed: true, evidence: [] },
    review: { outcome: 'pass' },
    commits: [{ label: 'TASK', hash: 'abc1234' }],
  }
  check(`${id} 未提交不可完成`, completionBlockers({ ...satisfied, commits: [] }, cfg).length > 0)
  check(`${id} 齐全后可完成`, completionBlockers(satisfied, cfg).length === 0,
    JSON.stringify(completionBlockers(satisfied, cfg)))

  // The result the assessment found could be missing: a flow that declares a review
  // must not complete with the review blocked, and a flow that declares none must
  // not be made to demand one.
  const wantsReview = terminalRequirements(cfg).includes('review_passed')
  const blocked = completionBlockers({ ...satisfied, review: { outcome: 'blocked' } }, cfg)
  check(`${id} ${wantsReview ? '审核未通过不可完成' : '不发明审核要求'}`,
    wantsReview ? blocked.some(b => b.includes('passing review')) : blocked.length === 0,
    JSON.stringify(blocked))
}

console.log('')
console.log('=== 9. 返工三种类型范围不同 ===')
const r = invalidatedBy('requirement'), s = invalidatedBy('solution'), d = invalidatedBy('defect')
check('requirement 失效需求确认', r.includes('requirement_confirmation'))
check('solution 保留需求确认', !s.includes('requirement_confirmation'))
check('defect 保留需求与方案确认', !d.includes('requirement_confirmation') && !d.includes('solution_confirmation'))
check('三者范围互不相同', new Set([r.join(), s.join(), d.join()]).size === 3)

console.log('')
console.log(failures === 0 ? '✅ 全部验收项通过' : `❌ ${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
