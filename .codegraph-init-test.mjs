import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { codeGraphEvidence, codeGraphStatus, prepareCodeGraph } from './lib/codegraph-init.js'

test('optional CodeGraph indexing uses the selected project and supplies bounded evidence', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-codegraph-'))
  const bin = join(temp, 'bin')
  const project = join(temp, 'project')
  mkdirSync(bin)
  mkdirSync(project)
  const executable = join(bin, process.platform === 'win32' ? 'codegraph.cmd' : 'codegraph')
  const script = process.platform === 'win32'
    ? '@echo off\r\nif "%1"=="--version" (echo 1.6.0 & exit /b 0)\r\nif "%1"=="init" (mkdir .codegraph & exit /b 0)\r\nif "%1"=="status" (echo Files: 2 Nodes: 5 & exit /b 0)\r\nif "%1"=="sync" (echo updated>.codegraph\\synced & exit /b 0)\r\nif "%1"=="files" (echo backend/src/App.java & exit /b 0)\r\nif "%1"=="context" (echo - backend/src/App.java:1 entry point & echo - unrelated/public/js/chart.js:1 & exit /b 0)\r\nexit /b 1\r\n'
    : '#!/bin/sh\ncase "$1" in --version) echo 1.6.0;; init) mkdir .codegraph;; status) echo "Files: 2 Nodes: 5";; sync) echo updated > .codegraph/synced;; files) echo backend/src/App.java;; context) printf "%s\\n" "- backend/src/App.java:1 entry point" "- unrelated/public/js/chart.js:1";; *) exit 1;; esac\n'
  writeFileSync(executable, script)
  if (process.platform !== 'win32') chmodSync(executable, 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${previous ?? ''}`
  try {
    const before = await codeGraphStatus(project)
    assert.equal(before.installed, true)
    assert.equal(before.indexed, false)
    const ready = await prepareCodeGraph(project, false)
    assert.equal(ready.indexed, true)
    assert.equal(existsSync(join(project, '.codegraph')), true)
    const evidence = await codeGraphEvidence(project, ['backend'])
    assert.match(evidence, /backend\/src\/App.java:1/)
    assert.doesNotMatch(evidence, /unrelated\/public\/js\/chart/)
    await prepareCodeGraph(project, false)
    assert.match(readFileSync(join(project, '.codegraph', 'synced'), 'utf8'), /updated/)
  } finally {
    process.env.PATH = previous
    rmSync(temp, { recursive: true, force: true })
  }
})
