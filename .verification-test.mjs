import test from 'node:test'
import assert from 'node:assert/strict'
import { testEvidence, receiptHasRequiredTests, skillCommandProblem, verificationPlanProblem } from './lib/verification-tests.js'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
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

test('ctest and GoogleTest runs report the tests that actually passed', () => {
  const gtestPassed = '[==========] 5 tests from 2 test suites ran.\n[  PASSED  ] 5 tests.'
  const ctestPassed = '100% tests passed, 0 tests failed out of 3'
  const cases = [
    // CTest: clean, failing, empty and --output-on-failure summaries.
    ['ctest --test-dir build --output-on-failure', '100% tests passed, 0 tests failed out of 192', 192],
    ['ctest --test-dir build', '100% tests passed out of 192', 192],
    ['ctest --test-dir build', '0% tests passed out of 0', 0],
    ['ctest --test-dir build --output-on-failure', '66% tests passed, 65 tests failed out of 192', 0],
    ['/usr/bin/ctest', '100% tests passed, 0 tests failed out of 1', 1],
    ['ctest', 'No tests were found!!!', 0],
    ['ctest --test-dir build', 'Test #1: link\n    Test Passed.', null],
    // A quoted Windows path with spaces is still the ctest program.
    ['"C:\\Program Files\\CMake\\bin\\ctest.exe" --test-dir build', '100% tests passed, 0 tests failed out of 3', 3],
    // CTest keeps 100% when cases are skipped; skipped cases are not passing evidence.
    ['ctest --test-dir build',
      '1/2 Test #1: a .......***Skipped\n2/2 Test #2: b .......   Passed\n\n100% tests passed out of 2', 1],
    ['ctest --test-dir build',
      '1/1 Test #1: only .......***Skipped\n\n100% tests passed out of 1', 0],
    ['ctest --test-dir build',
      '1/2 Test #1: a .......***Failed\n2/2 Test #2: b .......***Skipped\n\n50% tests passed, 1 tests failed out of 2', 0],
    // GoogleTest: passed, failed, skipped and empty suites.
    ['/work/build/foray_platform_tests', '[==========] 192 tests from 39 test suites ran.\n[  PASSED  ] 192 tests.', 192],
    ['./build/suite_tests', '[==========] 5 tests from 2 test suites ran.\n[  FAILED  ] 3 tests, listed below:\n[  PASSED  ] 2 tests.', 0],
    ['./build/suite_tests', '[==========] 2 tests from 1 test suite ran.\n[  FAILED  ] Suite.Broken\n[  PASSED  ] 1 test.', 0],
    ['./build/empty_tests', '[==========] 0 tests from 0 test suites ran.\n[  PASSED  ] 0 tests.', 0],
    ['./build/suite_tests', '[==========] Running 4 tests from 1 test suite.\n[       OK ] A.B (0 ms)\n[==========] 4 tests from 1 test suite ran. (2 ms total)\n[  PASSED  ] 4 tests.', 4],
    // Real GoogleTest keeps skipped cases out of PASSED; a fully skipped suite cannot pass.
    ['./build/suite_tests',
      '[==========] 3 tests from 1 test suite ran. (0 ms total)\n[  PASSED  ] 2 tests.\n[  SKIPPED ] 1 test, listed below:\n[  SKIPPED ] Suite.B', 2],
    ['./build/all_skipped_tests',
      '[==========] 2 tests from 1 test suite ran. (0 ms total)\n[  PASSED  ] 0 tests.\n[  SKIPPED ] 2 tests, listed below:\n[  SKIPPED ] S.A\n[  SKIPPED ] S.B', 0],
    // Printers and other runners cannot forge either runner's evidence.
    ['echo "[==========] 5 tests from 2 test suites ran. [  PASSED  ] 5 tests."', 'fake', null],
    ['cat gtest-output.txt', '[==========] 5 tests from 2 test suites ran.\n[  PASSED  ] 5 tests.', null],
    [`sh -c "echo '[==========] 5 tests from 2 test suites ran.'"`, '[==========] 5 tests from 2 test suites ran.', null],
    ['python -c "print(\'[  PASSED  ] 5 tests.\')"', '[==========] 5 tests from 2 test suites ran.\n[  PASSED  ] 5 tests.', null],
    // The CTest summary needs an actual ctest invocation.
    ['/work/build/tests', '100% tests passed, 0 tests failed out of 3', null],
    // A wrapper or a reader is never the program that ran the suite, even with a real summary.
    ['cmd /d /c type old-results.txt', gtestPassed, null],
    ['cmd /c type old-results.txt', gtestPassed, null],
    ['powershell -NoProfile -Command "Get-Content old-results.txt"', gtestPassed, null],
    ['sh -c "cat old-results.txt"', gtestPassed, null],
    ['bash -c "type old-results.txt"', gtestPassed, null],
    ['type old-results.txt', gtestPassed, null],
    ['more old-results.txt', gtestPassed, null],
    ['findstr passed old-results.txt', gtestPassed, null],
    ['Get-Content old-results.txt', gtestPassed, null],
    ['cmd /c ctest --test-dir build', ctestPassed, null],
    ['sh -c "ctest --test-dir build"', ctestPassed, null],
    // A PATH lookup and an interpreter wrapper are not the compiled suite either.
    ['suite_tests', gtestPassed, null],
    ['./run-tests.sh', gtestPassed, null],
    ['node ./build/suite_tests', gtestPassed, null],
  ]
  for (const [command, stdout, expected] of cases) {
    assert.equal(testEvidence(command, stdout).count, expected, command)
    assert.equal(receiptHasRequiredTests({ command, stdout, stderr: '' }), expected > 0, command)
  }
})

test('a real program cannot borrow a runner summary it only prints', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forged-receipt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fixtures = {
    'npm-test.mjs': "console.log('# tests 5\\n# pass 5')\n",
    'maven-test.mjs': "console.log('Tests run: 5, Failures: 0, Errors: 0, Skipped: 0')\n",
    'gradle-test.mjs': "console.log('5 tests completed')\n",
    'pytest-test.mjs': "console.log('5 passed in 0.2s')\n",
    'cargo-test.mjs': "console.log('test result: ok. 5 passed; 0 failed')\n",
    'gtest-print.mjs': "console.log('[==========] 5 tests from 2 test suites ran.\\n[  PASSED  ] 5 tests.')\n",
  }
  for (const [file, body] of Object.entries(fixtures)) writeFileSync(join(root, file), body)
  const run = (file, args) => {
    const result = spawnSync(process.execPath, [join(root, file), ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return `${result.stdout}\n${result.stderr}`
  }
  // Each command really runs a script that prints another runner's summary: the words are arguments,
  // so only the invoked program decides which parser may read the output.
  for (const [file, args] of [
    ['npm-test.mjs', ['npm', 'test']],
    ['npm-test.mjs', ['pnpm', 'run', 'test']],
    ['maven-test.mjs', ['mvn', 'test']],
    ['gradle-test.mjs', ['./gradlew', 'test']],
    ['pytest-test.mjs', ['python', '-m', 'pytest']],
    ['cargo-test.mjs', ['cargo', 'test']],
    ['gtest-print.mjs', ['./build/suite_tests']],
  ]) {
    const command = `"${process.execPath}" "${join(root, file)}" ${args.join(' ')}`
    const output = run(file, args)
    assert.equal(testEvidence(command, output).count, null, command)
    assert.equal(receiptHasRequiredTests({ command, stdout: output, stderr: '' }), false, command)
  }
  // The same summaries remain valid evidence for the real runner.
  assert.equal(testEvidence('npm test', run('npm-test.mjs', [])).count, 5)
  assert.equal(testEvidence('mvn test', run('maven-test.mjs', [])).count, 5)
  assert.equal(testEvidence('gradle test', run('gradle-test.mjs', [])).count, 5)
  assert.equal(testEvidence('python -m pytest', run('pytest-test.mjs', [])).count, 5)
  assert.equal(testEvidence('cargo test', run('cargo-test.mjs', [])).count, 5)
  assert.equal(testEvidence(`"${join(root, 'gtest-print.mjs')}"`, run('gtest-print.mjs', [])).count, null)
})

test('a verification plan rejects a shell wrapper before the command runs', () => {
  for (const command of [
    'sh -c "ctest --test-dir build"',
    'bash -c "npm test"',
    'cmd /c "npm test"',
    'cmd /d /s /c "ctest --test-dir build"',
    'powershell -NoProfile -Command "npm test"',
    'pwsh -Command "go test ./..."',
  ]) assert.match(verificationPlanProblem(command) ?? '', /外壳/u, command)
  for (const command of ['ctest --test-dir build', 'npm test', 'mvn test', 'python -m pytest', './build/suite_tests']) {
    assert.equal(verificationPlanProblem(command), undefined, command)
  }
})

test('a real CTest run reports passing cases and rejects an all-skipped suite', async t => {
  const cmake = process.env.CMAKE_BINARY ?? 'cmake'
  const ctest = process.env.CTEST_BINARY ?? 'ctest'
  const requireReal = process.env.REQUIRE_CPP_EVIDENCE === '1'
  const cmakeProbe = spawnSync(cmake, ['--version'], { encoding: 'utf8' })
  const ctestProbe = spawnSync(ctest, ['--version'], { encoding: 'utf8' })
  if (cmakeProbe.error?.code === 'ENOENT' || ctestProbe.error?.code === 'ENOENT') {
    // A skipped smoke test proves nothing; CI sets this flag so a missing toolchain fails the run.
    if (requireReal) assert.fail('CMake and CTest must be installed when REQUIRE_CPP_EVIDENCE=1')
    t.skip('CMake/CTest is not installed; parser cases remain covered above')
    return
  }
  assert.equal(cmakeProbe.status, 0, cmakeProbe.stderr)
  assert.equal(ctestProbe.status, 0, ctestProbe.stderr)
  const root = mkdtempSync(join(tmpdir(), 'ctest-evidence-'))
  // This exact absolute directory was created above, with no caller-supplied path.
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // The generator stays whatever the host defaults to unless CI pins one. A multi-config
  // generator (Visual Studio, Xcode) needs `-C <config>` or every test reports "***Not Run".
  const extra = []
  if (process.env.CMAKE_GENERATOR) extra.push('-G', process.env.CMAKE_GENERATOR)
  if (process.env.CMAKE_TOOLCHAIN_FILE) extra.push(`-DCMAKE_TOOLCHAIN_FILE=${process.env.CMAKE_TOOLCHAIN_FILE}`)
  const configure = (name, body) => {
    writeFileSync(join(root, 'CMakeLists.txt'), body)
    const dir = join(root, name)
    const result = spawnSync(cmake, ['-S', root, '-B', dir, `-DNODE=${process.execPath}`, ...extra], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return dir
  }
  const multiConfig = dir => {
    const cache = join(dir, 'CMakeCache.txt')
    return existsSync(cache) && /^CMAKE_CONFIGURATION_TYPES:/mu.test(readFileSync(cache, 'utf8'))
  }
  const run = dir => {
    const result = spawnSync(ctest, ['--test-dir', dir, ...(multiConfig(dir) ? ['-C', 'Debug'] : []), '--output-on-failure'], { encoding: 'utf8' })
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
  }
  const head = 'cmake_minimum_required(VERSION 3.20)\nproject(evidence NONE)\nenable_testing()\n'
  const mixed = configure('mixed', `${head}add_test(NAME pass COMMAND \${CMAKE_COMMAND} -E true)\nadd_test(NAME skip COMMAND \${NODE} -e "process.exit(77)")\nset_tests_properties(skip PROPERTIES SKIP_RETURN_CODE 77)\n`)
  const mixedRun = run(mixed)
  assert.equal(mixedRun.status, 0, mixedRun.output)
  // The directory path is quoted (and contains a space on many hosts), like a real Windows call.
  assert.equal(testEvidence(`ctest --test-dir "${mixed}" --output-on-failure`, mixedRun.output).count, 1, mixedRun.output)
  const skipped = configure('skipped', `${head}add_test(NAME skip COMMAND \${NODE} -e "process.exit(77)")\nset_tests_properties(skip PROPERTIES SKIP_RETURN_CODE 77)\n`)
  const skippedRun = run(skipped)
  assert.equal(skippedRun.status, 0, skippedRun.output)
  assert.equal(testEvidence(`ctest --test-dir "${skipped}"`, skippedRun.output).count, 0, skippedRun.output)
  const failing = configure('failing', `${head}add_test(NAME fail COMMAND \${NODE} -e "process.exit(1)")\n`)
  const failingRun = run(failing)
  assert.notEqual(failingRun.status, 0)
  assert.equal(testEvidence(`ctest --test-dir "${failing}"`, failingRun.output).count, 0, failingRun.output)
})

test('a real GoogleTest binary reports the tests that actually ran', async t => {
  const requireReal = process.env.REQUIRE_CPP_EVIDENCE === '1'
  const cmake = process.env.CMAKE_BINARY ?? 'cmake'
  const cmakeProbe = spawnSync(cmake, ['--version'], { encoding: 'utf8' })
  if (cmakeProbe.error?.code === 'ENOENT') {
    if (requireReal) assert.fail('CMake must be installed when REQUIRE_CPP_EVIDENCE=1')
    t.skip('CMake is not installed; parser cases remain covered above')
    return
  }
  assert.equal(cmakeProbe.status, 0, cmakeProbe.stderr)
  const root = mkdtempSync(join(tmpdir(), 'gtest-evidence-'))
  // This exact absolute directory was created above, with no caller-supplied path.
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'mixed.cpp'), '#include <gtest/gtest.h>\nTEST(S, A) { EXPECT_EQ(1, 1); }\nTEST(S, B) { EXPECT_EQ(2, 2); }\nTEST(S, C) { GTEST_SKIP() << "not applicable"; }\n')
  writeFileSync(join(root, 'skipped.cpp'), '#include <gtest/gtest.h>\nTEST(S, A) { GTEST_SKIP() << "not applicable"; }\n')
  writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\nproject(gtest_evidence CXX)\nfind_package(GTest REQUIRED)\nadd_executable(mixed mixed.cpp)\ntarget_link_libraries(mixed PRIVATE GTest::gtest_main)\nadd_executable(all_skipped skipped.cpp)\ntarget_link_libraries(all_skipped PRIVATE GTest::gtest_main)\n')
  const build = join(root, 'build')
  const extra = []
  if (process.env.CMAKE_GENERATOR) extra.push('-G', process.env.CMAKE_GENERATOR)
  if (process.env.CMAKE_TOOLCHAIN_FILE) extra.push(`-DCMAKE_TOOLCHAIN_FILE=${process.env.CMAKE_TOOLCHAIN_FILE}`)
  const configure = spawnSync(cmake, ['-S', root, '-B', build, ...extra], { encoding: 'utf8' })
  if (configure.status !== 0) {
    const output = `${configure.stdout}\n${configure.stderr}`
    // Only a genuinely absent package may skip; a broken configuration is a real failure.
    const missing = /could not find gtest|could not find a package configuration file provided by "gtest"|find_package\(gtest\)|no cmake_cxx_compiler could be found/iu.test(output)
    if (missing && !requireReal) { t.skip('The GoogleTest development package is not installed; parser cases remain covered above'); return }
    assert.fail(`cmake configure failed:\n${output}`)
  }
  const cache = join(build, 'CMakeCache.txt')
  const multiConfig = existsSync(cache) && /^CMAKE_CONFIGURATION_TYPES:/mu.test(readFileSync(cache, 'utf8'))
  const compile = spawnSync(cmake, ['--build', build, ...(multiConfig ? ['--config', 'Debug'] : [])], { encoding: 'utf8' })
  assert.equal(compile.status, 0, compile.stdout + compile.stderr)
  const binary = name => join(build, ...(multiConfig ? ['Debug'] : []), `${name}${process.platform === 'win32' ? '.exe' : ''}`)
  const run = name => {
    const result = spawnSync(binary(name), [], { encoding: 'utf8' })
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
  }
  const mixed = run('mixed')
  assert.equal(mixed.status, 0, mixed.output)
  assert.equal(testEvidence(`"${binary('mixed')}"`, mixed.output).count, 2, mixed.output)
  const skipped = run('all_skipped')
  assert.equal(skipped.status, 0, skipped.output)
  assert.equal(testEvidence(`"${binary('all_skipped')}"`, skipped.output).count, 0, skipped.output)
  assert.equal(receiptHasRequiredTests({ command: `"${binary('all_skipped')}"`, stdout: skipped.output, stderr: '' }), false)
})
