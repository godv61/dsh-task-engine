import test from 'node:test'
import assert from 'node:assert/strict'
import { testEvidence, receiptHasRequiredTests, skillCommandProblem } from './lib/verification-tests.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

test('verification needs a visible nonzero test result for common runners', () => {
  const cases = [
    ['mvn test', 'Tests run: 2, Failures: 0, Errors: 0, Skipped: 0', 2],
    ['mvn test', 'Tests run: 3, Failures: 0, Errors: 0, Skipped: 3', 0],
    ['mvn test', 'Tests run: 3, Failures: 1, Errors: 0, Skipped: 0', 0],
    ['mvn -o org.apache.maven.plugins:maven-surefire-plugin:3.2.5:test', 'Tests run: 3, Failures: 0, Errors: 0, Skipped: 0', 3],
    ['mvn "org.apache.maven.plugins:maven-surefire-plugin:3.2.5:test"', 'Tests run: 3, Failures: 0, Errors: 0, Skipped: 0', 3],
    ['mvnw.cmd surefire:test', 'Tests run: 2, Failures: 0, Errors: 0, Skipped: 0', 2],
    ['mvn org.apache.maven.plugins:maven-failsafe-plugin:3.2.5:verify', 'Tests run: 2, Failures: 0, Errors: 0, Skipped: 0', 2],
    ['mvn surefire:test', 'Tests run: 3, Failures: 0, Errors: 0, Skipped: 3', 0],
    ['mvn surefire:test', 'Tests run: 3, Failures: 1, Errors: 0, Skipped: 0', 0],
    ['mvn help:evaluate -Dvalue=surefire:test', 'Tests run: 3, Failures: 0, Errors: 0, Skipped: 0', null],
    ['mvn example:fake:test', 'Tests run: 3, Failures: 0, Errors: 0, Skipped: 0', null],
    ['npm test', '# tests 4\n# pass 4', 4],
    ['python -m pytest', '==== 3 passed in 0.2s ====', 3],
    ['python -m pytest', '=== 2 passed, 1 error in 0.12s ===', 0],
    ['go test ./...', 'ok  example.com/app  0.02s', null],
    ['go test ./...', 'ok  example.com/app  0.02s [no tests to run]', null],
    ['cargo test', 'test result: ok. 5 passed; 0 failed', 5],
    ['./gradlew test --info', '4 tests completed\nBUILD SUCCESSFUL', 4],
    ['gradlew.bat test --info', '4 tests completed, 4 skipped\nBUILD SUCCESSFUL', 0],
    ['gradle test --info', '4 tests completed, 1 failed\nBUILD FAILED', 0],
    ['./gradlew test --info', 'BUILD SUCCESSFUL', null],
    ['npm test', '# tests 0\n# pass 0', 0],
    ['npm test', '# tests 3\n# pass 0\n# skipped 3', 0],
    ['npm test', '# tests 4\n# fail 1', 0],
    ['npm test', 'PASS src/a.test.js\n# tests 5\n# pass 5\n# fail 0\n(retried after 3 failed attempts)', 5],
    ['npm test || true', '# tests 4\n# pass 4', null],
    ['npm test && echo Tests: 1 passed', 'Tests: 1 passed', null],
    ['mvn test & echo Tests run: 1, Failures: 0, Errors: 0, Skipped: 0', 'Tests run: 1, Failures: 0, Errors: 0, Skipped: 0', null],
    ['go test ./...', '? example.com/app [no test files]', null],
    ['true', '', null],
  ]
  for (const [command, stdout, expected] of cases) {
    assert.equal(testEvidence(command, stdout).count, expected, command)
    assert.equal(receiptHasRequiredTests({ command, stdout, stderr: '' }), expected > 0, command)
  }
})

test('trivial shell commands cannot satisfy a skill command receipt', () => {
  for (const command of ['echo ok', 'printf ok', 'true', 'exit 0']) assert.ok(skillCommandProblem(command), command)
  assert.equal(skillCommandProblem('npm run lint'), undefined)
})

test('unittest requires a completed terminal summary from a real module invocation', () => {
  const success = 'Ran 3 tests in 0.001s\n\nOK (skipped=1, expected failures=1)\n'
  for (const command of ['python -m unittest', 'python3 -m unittest discover -v', 'py -3.13 -m unittest', '"C:\\Python Dir\\python.exe" -B -m unittest -q']) {
    assert.equal(testEvidence(command, success).count, 1, command)
  }
  for (const command of ['echo python -m unittest', 'python -c "print(1)" -m unittest', 'python -m unittest.mock', 'python -m unittest && echo ok']) {
    assert.equal(testEvidence(command, success).count, null, command)
  }
  for (const output of ['Ran 3 tests in 0.001s', 'Ran 3 tests in 0.001s\n\nOK\nunfinished output', 'Ran 1 test in 0.001s\n\nOK (skipped=2)', 'Ran 1 test in 0.001s\n\nOK (unknown=1)']) {
    assert.equal(testEvidence('python -m unittest', output).count, null, output)
  }
  assert.equal(testEvidence('python -m unittest', 'Ran 1 test in 0.001s\n\nFAILED (unexpected successes=1)\n').count, 0)
})

test('actual stdlib unittest distinguishes passing cases from skips, expected failures, empty and failing suites', async t => {
  const python = process.env.PYTHON_BINARY ?? 'python'
  const available = spawnSync(python, ['--version'], { encoding: 'utf8' })
  if (available.error?.code === 'ENOENT') { t.skip('Python is not installed; parser cases remain covered above'); return }
  assert.equal(available.status, 0, available.stderr)
  const root = mkdtempSync(join(tmpdir(), 'stdlib-unittest-evidence-'))
  // This exact absolute directory was created above, with no caller-supplied path.
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cases = [
    ['mixed', '    def test_pass(self): self.assertEqual(2 + 2, 4)\n    @unittest.skip("not applicable")\n    def test_skip(self): pass\n    @unittest.expectedFailure\n    def test_expected(self): self.fail("known")', 0, 1],
    ['skipped', '    @unittest.skip("not applicable")\n    def test_skip(self): pass', 0, 0],
    ['empty', '    pass', null, 0],
    ['failure', '    def test_fail(self): self.assertEqual(2, 3)', 1, 0],
    ['unexpected', '    @unittest.expectedFailure\n    def test_pass(self): self.assertEqual(2, 2)', 1, 0],
  ]
  for (const [name, body, exitCode, count] of cases) await t.test(name, () => {
    writeFileSync(join(root, 'test_case.py'), `import unittest\nclass Fixture(unittest.TestCase):\n${body}\n`)
    const result = spawnSync(python, ['-B', '-m', 'unittest', 'discover', '-s', root, '-v'], { encoding: 'utf8' })
    if (exitCode === null) assert.ok([0, 5].includes(result.status), result.stderr)
    else assert.equal(result.status, exitCode, result.stderr)
    assert.equal(testEvidence(`python -B -m unittest discover -s "${root}" -v`, result.stdout + '\n' + result.stderr).count, count, result.stderr)
    assert.equal(receiptHasRequiredTests({ command: 'python -B -m unittest discover -v', stdout: result.stdout, stderr: result.stderr }), count > 0)
  })
})
