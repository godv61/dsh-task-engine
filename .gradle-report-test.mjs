import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { freshGradleReportSummary, snapshotGradleReports } from './lib/gradle-reports.js'

test('Gradle evidence counts only fresh, passing test methods', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gradle-report-'))
  try {
    const results = join(root, 'module', 'build', 'test-results', 'test')
    mkdirSync(results, { recursive: true })
    const report = join(results, 'TEST-example.Sample.xml')
    writeFileSync(report, '<testsuite tests="2" failures="0" errors="0" skipped="0"/>')
    const before = snapshotGradleReports(root)
    assert.equal(freshGradleReportSummary(before, snapshotGradleReports(root)), undefined)
    writeFileSync(report, '<testsuite tests="3" failures="0" errors="0" skipped="1"/>')
    assert.deepEqual(freshGradleReportSummary(before, snapshotGradleReports(root)), { count: 2, files: 1 })
    writeFileSync(report, '<testsuite tests="3" failures="1" errors="0" skipped="0"/>')
    assert.deepEqual(freshGradleReportSummary(before, snapshotGradleReports(root)), { count: 0, files: 1 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('missing or empty Gradle reports cannot prove tests ran', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gradle-report-'))
  try {
    const before = snapshotGradleReports(root)
    assert.equal(freshGradleReportSummary(before, snapshotGradleReports(root)), undefined)
    const results = join(root, 'build', 'test-results', 'test')
    mkdirSync(results, { recursive: true })
    writeFileSync(join(results, 'TEST-empty.xml'), '<testsuite tests="0" failures="0" errors="0" skipped="0"/>')
    assert.deepEqual(freshGradleReportSummary(before, snapshotGradleReports(root)), { count: 0, files: 1 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
