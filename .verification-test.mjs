import test from 'node:test'
import assert from 'node:assert/strict'
import { testEvidence, receiptHasRequiredTests, skillCommandProblem } from './lib/verification-tests.js'

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
    ['go test ./...', 'ok  example.com/app  0.02s', 1],
    ['go test ./...', 'ok  example.com/app  0.02s [no tests to run]', 0],
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
    ['go test ./...', '? example.com/app [no test files]', 0],
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

test('ctest and GoogleTest runs report the tests that actually passed', () => {
  const cases = [
    ['ctest --test-dir build --output-on-failure', '100% tests passed, 0 tests failed out of 192', 192],
    ['ctest --test-dir build', '100% tests passed out of 192', 192],
    ['ctest --test-dir build', '0% tests passed out of 0', 0],
    ['ctest --test-dir build --output-on-failure', '66% tests passed, 65 tests failed out of 192', 0],
    ['/usr/bin/ctest', '100% tests passed, 0 tests failed out of 1', 1],
    ['ctest', 'No tests were found!!!', 0],
    ['ctest --test-dir build', 'Test #1: link\n    Test Passed.', null],
    ['/work/build/foray_platform_tests', '[==========] 192 tests from 39 test suites ran.\n[  PASSED  ] 192 tests.', 192],
    ['/work/build/foray_platform_tests', '[==========] 5 tests from 2 test suites ran.\n[  FAILED  ] 3 tests, listed below:\n[  PASSED  ] 2 tests.', 0],
    ['/work/build/empty_tests', '[==========] 0 tests from 0 test suites ran.\n[  PASSED  ] 0 tests.', 0],
    ['./build/suite_tests', '[==========] Running 4 tests from 1 test suite.\n[       OK ] A.B (0 ms)\n[==========] 4 tests from 1 test suite ran. (2 ms total)\n[  PASSED  ] 4 tests.', 4],
    ['ctest --test-dir build --output-on-failure',
      'Test project /work/build\n    Start 1: RoboLinkCodec.AckPayloadRoundTrips\n1/2 Test #1: RoboLinkCodec.AckPayloadRoundTrips .... Passed\n2/2 Test #2: RoboLinkCodec.RejectsUnknownMessageType .... Passed\n\n100% tests passed, 0 tests failed out of 2', 2],
    ['ctest --test-dir build --output-on-failure',
      'Test project /work/build\n\n50% tests passed, 1 tests failed out of 2\n\nThe following tests FAILED:\n\t2 - RoboLinkCodec.Broken (Failed)', 0],
  ]
  for (const [command, stdout, expected] of cases) {
    assert.equal(testEvidence(command, stdout).count, expected, command)
    assert.equal(receiptHasRequiredTests({ command, stdout, stderr: '' }), expected > 0, command)
  }
})
