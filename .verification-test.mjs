import test from 'node:test'
import assert from 'node:assert/strict'
import { testEvidence, receiptHasRequiredTests } from './lib/verification-tests.js'

test('verification needs a visible nonzero test result for common runners', () => {
  const cases = [
    ['mvn test', 'Tests run: 2, Failures: 0, Errors: 0, Skipped: 0', 2],
    ['npm test', '# tests 4\n# pass 4', 4],
    ['python -m pytest', '==== 3 passed in 0.2s ====', 3],
    ['go test ./...', 'ok  example.com/app  0.02s', 1],
    ['cargo test', 'test result: ok. 5 passed; 0 failed', 5],
    ['npm test', '# tests 0\n# pass 0', 0],
    ['npm test', '# tests 4\n# fail 1', 0],
    ['npm test || true', '# tests 4\n# pass 4', null],
    ['go test ./...', '? example.com/app [no test files]', 0],
    ['true', '', null],
  ]
  for (const [command, stdout, expected] of cases) {
    assert.equal(testEvidence(command, stdout).count, expected, command)
    assert.equal(receiptHasRequiredTests({ command, stdout, stderr: '' }), expected > 0, command)
  }
})
