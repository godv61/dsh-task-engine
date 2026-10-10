import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { changedLines, currentBinding, missingLocalAuditScope, saveBinding, uncoveredLocalFiles } from './lib/sonarlint-local.js'
import { isIncludedAuditPath, validAuditIncludePaths } from './lib/sonar.js'
import { renderSonarReport, sonarReportPath } from './lib/sonar-report.js'

test('manual rule update persists the active project binding without leaving a staging file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-sonar-binding-'))
  try {
    assert.equal(currentBinding(directory), undefined)
    const first = { connection_id: 'project-11111111-1111-4111-8111-111111111111', updated_at: '2026-10-08T01:00:00.000Z' }
    const next = { connection_id: 'project-22222222-2222-4222-8222-222222222222', updated_at: '2026-10-08T02:00:00.000Z' }
    saveBinding(directory, first)
    assert.deepEqual(currentBinding(directory), first)
    saveBinding(directory, next)
    assert.deepEqual(currentBinding(directory), next)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('project scan roots mirror Maven backend scope without including the Vue app', () => {
  const roots = ['fp-bussiness', 'fp-ruoyi', 'fp-ruoyi-spring-boot', 'pom.xml']
  assert.equal(validAuditIncludePaths(roots), true)
  assert.equal(isIncludedAuditPath('fp-bussiness/src/main/java/A.java', roots), true)
  assert.equal(isIncludedAuditPath('fp-ruoyi-ui/src/views/auth.vue', roots), false)
  assert.equal(validAuditIncludePaths(['../outside']), false)
  assert.equal(validAuditIncludePaths(['C:/outside']), false)
})

test('one review gets a credential-free Markdown report path and issue details', () => {
  const audit = { analysis_id: 'abc12345-0000', checked_at: '2026-10-03T10:11:12.000Z',
    target: 'qdm_gw_chemical_260930', gate: 'ERROR', findings: [{key:'x',rule:'java:S103',
      severity:'MAJOR',file:'A.java',line:12,message:'Line too long'}], blocking:[{key:'x'}],
    scanned_files:['A.java'],uncovered_files:[],
    profile_coverage:[{language:'JAVA',active_rules:66,analyzer:'SYNCED'}] }
  const path = sonarReportPath('QMS-1', audit)
  assert.match(path, /^\.dsh\/reviews\/QMS-1\/2026-/)
  const report = renderSonarReport('QMS-1', {source:'ide-local',project_key:'project',include_paths:['fp-bussiness']}, audit)
  assert.match(report, /java:S103/)
  assert.match(report, /A.java:12/)
  assert.match(report, /JAVA：服务端启用 66 条规则；本地分析器 SYNCED/)
  assert.match(report, /不等同 SonarQube 服务端完整扫描或 Quality Gate/)
  assert.equal(report.includes('token-secret'),false)
})

test('review report shows only profiles used by the analyzed files, including Vue style rules', () => {
  const audit = { analysis_id: 'abc12345-0000', checked_at: '2026-10-03T10:11:12.000Z',
    target: 'HEAD', gate: 'OK', findings: [], blocking: [],
    scanned_files: ['src/Rule.java', 'src/mapper.xml', 'ui/Auth.vue'], uncovered_files: [],
    profile_coverage: [
      { language: 'JAVA', active_rules: 66, analyzer: 'SYNCED' },
      { language: 'XML', active_rules: 25, analyzer: 'SYNCED' },
      { language: 'JS', active_rules: 382, analyzer: 'SYNCED' },
      { language: 'CSS', active_rules: 27, analyzer: 'SYNCED' },
      { language: 'GO', active_rules: 22, analyzer: 'UNSUPPORTED' },
    ] }
  const report = renderSonarReport('QMS-1', { source: 'ide-local', project_key: 'project' }, audit)
  assert.match(report, /本次涉及语言的项目规则与本地分析器/)
  for (const language of ['JAVA', 'XML', 'JS', 'CSS']) assert.match(report, new RegExp(`- ${language}：`))
  assert.doesNotMatch(report, /- GO：/)
  assert.match(report, /规则来源为当前项目的 Quality Profile/)
  assert.doesNotMatch(report, /不能据此宣称全部服务端规则已覆盖/)
})

test('unsupported files block only when the project has active rules for their language', () => {
  const paths = ['migration.sql', 'settings.json', 'script.py']
  const profiles = [
    { language: 'java', activeRuleCount: 66 },
    { language: 'json', activeRuleCount: 0 },
    { language: 'py', activeRuleCount: 3 },
  ]
  assert.deepEqual(uncoveredLocalFiles(paths, profiles), ['script.py'])
  assert.deepEqual(uncoveredLocalFiles(paths, [...profiles, { language: 'plsql', activeRuleCount: 5 }]),
    ['migration.sql', 'script.py'])
})

test('local audit detects changed backend files omitted from the task scope', () => {
  assert.deepEqual(missingLocalAuditScope(['fp-bussiness/A.java', 'fp-bussiness/B.java'],
    ['fp-bussiness/A.java', 'fp-ruoyi-ui/view.vue']), ['fp-bussiness/B.java'])
  assert.deepEqual(missingLocalAuditScope(['fp-bussiness/A.java'], ['./FP-BUSSINESS\\A.java']), [])
})

test('local Sonar audit considers Git new code but excludes generated DSH records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sonarlint-diff-test-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  try {
    git('init', '--quiet')
    writeFileSync(join(root, 'Sample.java'), 'class Sample {}\n')
    git('add', 'Sample.java')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'baseline')
    writeFileSync(join(root, 'Sample.java'), 'class Sample {}\n// new code\n')
    writeFileSync(join(root, 'change.sql'), 'SELECT 1;\n')
    mkdirSync(join(root, '.dsh'))
    writeFileSync(join(root, '.dsh', 'task.json'), '{"generated":true}\n')
    const changed = await changedLines(root, 'HEAD')
    assert.deepEqual(changed.map(file => file.path).sort(), ['Sample.java', 'change.sql'])
    assert.deepEqual([...changed.find(file => file.path === 'Sample.java').lines], [2])
    assert.equal(changed.find(file => file.path === 'change.sql').newFile, true)
    assert.deepEqual((await changedLines(root, 'HEAD', ['Sample.java'])).map(file => file.path), ['Sample.java'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
