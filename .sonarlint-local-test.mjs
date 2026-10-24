import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureLocalAuditBaseline, changedLines, currentBinding, filterPreexistingAuditChanges, missingLocalAuditScope, saveBinding, uncoveredLocalFiles } from './lib/sonarlint-local.js'
import { isIncludedAuditPath, validAuditIncludePaths } from './lib/sonar.js'
import { renderSonarReport, sonarReportPath } from './lib/sonar-report.js'
import { formatEastEightTime } from './lib/time.js'

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
  assert.match(path, /2026-10-03T18-11-12-000\+0800-abc12345\.md$/)
  const report = renderSonarReport('QMS-1', {source:'ide-local',project_key:'project',include_paths:['fp-bussiness']}, audit)
  assert.match(report, /java:S103/)
  assert.match(report, /时间：2026-10-03 18:11:12\.000（UTC\+08:00）/)
  assert.equal(audit.checked_at, '2026-10-03T10:11:12.000Z')
  assert.match(report, /A.java:12/)
  assert.match(report, /JAVA：服务端启用 66 条规则；本地分析器 SYNCED/)
  assert.match(report, /不等同 SonarQube 服务端完整扫描或 Quality Gate/)
  assert.equal(report.includes('token-secret'),false)
})

test('report and approval timestamps use UTC+08:00 across midnight and preserve audit instants', () => {
  const audit = { analysis_id: 'timezone-1', checked_at: '2026-12-31T20:00:00.123Z', target: 'HEAD', gate: 'OK',
    findings: [], blocking: [], dispositions: [{ issue_key: 'one', kind: 'false_positive',
      reason: 'reviewed', evidence: ['source'], approved_at: '2027-01-01T04:10:00+09:00' }] }
  const original = JSON.stringify(audit)
  const report = renderSonarReport('TZ-1', { source: 'ide-local', project_key: 'fixture' }, audit)
  assert.match(report, /时间：2027-01-01 04:00:00\.123（UTC\+08:00）/)
  assert.match(report, /批准于 2027-01-01 03:10:00\.000（UTC\+08:00）/)
  assert.match(sonarReportPath('TZ-1', audit), /2027-01-01T04-00-00-123\+0800/)
  assert.equal(JSON.stringify(audit), original)
  for (const at of ['invalid', '2026-10-23 08:42:18']) assert.match(formatEastEightTime(at), /无效或缺少时区/)
})

test('report time is independent of operating-system and browser-default timezone', () => {
  const moduleUrl = new URL('./lib/time.js', import.meta.url).href
  const script = `import { formatEastEightTime } from ${JSON.stringify(moduleUrl)}; process.stdout.write(formatEastEightTime('2026-10-23T08:42:18.227Z'))`
  for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
    const text = execFileSync(process.execPath, ['--input-type=module', '-e', script],
      { encoding: 'utf8', env: { ...process.env, TZ: tz } })
    assert.equal(text, '2026-10-23 16:42:18.227（UTC+08:00）')
  }
})

test('review report does not claim CSS coverage from a Vue file alone', () => {
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
  for (const language of ['JAVA', 'XML', 'JS']) assert.match(report, new RegExp(`- ${language}：`))
  assert.doesNotMatch(report, /- CSS：/)
  assert.doesNotMatch(report, /- GO：/)
  const withCssFile = renderSonarReport('QMS-1', { source: 'ide-local', project_key: 'project' },
    { ...audit, scanned_files: [...audit.scanned_files, 'ui/auth.css'] })
  assert.match(withCssFile, /- CSS：/)
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

test('task creation baseline excludes only unchanged pre-existing code outside its declared scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sonar-baseline-test-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '--quiet')
  for (const path of ['Existing.java', 'Staged.java', 'Delivery.java']) writeFileSync(join(root, path), 'class Initial {}\n')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=NUL', 'commit', '--quiet', '-m', 'baseline')
  writeFileSync(join(root, 'Existing.java'), 'class Existing {}\n')
  writeFileSync(join(root, 'Staged.java'), 'class Staged {}\n')
  git('add', 'Staged.java')
  writeFileSync(join(root, 'Untracked.java'), 'class Untracked {}\n')
  const baseline = await captureLocalAuditBaseline(root, 'HEAD')
  assert.equal(baseline.files.length, 3)
  const select = async (paths = ['Delivery.java'], snapshot = baseline) => filterPreexistingAuditChanges(root, 'HEAD',
    await changedLines(root, 'HEAD'), paths, snapshot)
  writeFileSync(join(root, 'Delivery.java'), 'class Delivery {}\n')
  let selected = await select()
  assert.deepEqual(selected.excluded.sort(), ['Existing.java', 'Staged.java', 'Untracked.java'])
  assert.deepEqual(selected.changes.map(file => file.path), ['Delivery.java'])
  assert.deepEqual(missingLocalAuditScope(selected.changes.map(file => file.path), ['Delivery.java']), [])
  // Existing files explicitly adopted into this task are still analyzed.
  selected = await select(['Delivery.java', 'Existing.java'])
  assert.ok(selected.changes.some(file => file.path === 'Existing.java'))
  writeFileSync(join(root, 'Existing.java'), 'class ChangedAfterStart {}\n')
  writeFileSync(join(root, 'Late.java'), 'class Late {}\n')
  selected = await select()
  assert.deepEqual(missingLocalAuditScope(selected.changes.map(file => file.path), ['Delivery.java']).sort(), ['Existing.java', 'Late.java'])
  const legacy = await filterPreexistingAuditChanges(root, 'HEAD', await changedLines(root, 'HEAD'), ['Delivery.java'])
  assert.equal(legacy.excluded.length, 0)
  const movedReference = await select(['Delivery.java'], { ...baseline, commit: '0'.repeat(40) })
  assert.equal(movedReference.excluded.length, 0)
  const report = renderSonarReport('BASELINE', { source: 'ide-local', project_key: 'fixture' }, {
    analysis_id: 'baseline', checked_at: '2026-10-23T00:00:00Z', target: 'HEAD', gate: 'OK',
    findings: [], blocking: [], excluded_preexisting_files: selected.excluded })
  assert.match(report, /未纳入本任务的既有改动/)
  console.log('preserved local audit baseline fixture:', root)
})
