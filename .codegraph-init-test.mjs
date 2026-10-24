import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { codeGraphEvidence, codeGraphInitHint, codeGraphStatus, prepareCodeGraph, queryInitCodeGraph } from './lib/codegraph-init.js'

test('optional CodeGraph indexing uses the selected project and supplies bounded evidence', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-codegraph-'))
  const bin = join(temp, 'bin')
  const project = join(temp, 'project')
  mkdirSync(bin)
  mkdirSync(project)
  const executable = join(bin, process.platform === 'win32' ? 'codegraph.cmd' : 'codegraph')
  const script = process.platform === 'win32'
    ? '@echo off\r\nif "%1"=="--version" (echo 1.6.0 & exit /b 0)\r\nif "%1"=="init" (mkdir .codegraph & exit /b 0)\r\nif "%1"=="status" (echo Files: 2 Nodes: 5 & exit /b 0)\r\nif "%1"=="sync" (echo updated>.codegraph\\synced & exit /b 0)\r\nif "%1"=="files" (echo backend/src/App.java & exit /b 0)\r\nif "%1"=="context" (if not "%~5"=="backend entry points controllers services components" exit /b 2\r\necho - backend/src/App.java:1 entry point & echo - unrelated/public/js/chart.js:1 & exit /b 0)\r\nexit /b 1\r\n'
    : '#!/bin/sh\ncase "$1" in --version) echo 1.6.0;; init) mkdir .codegraph;; status) echo "Files: 2 Nodes: 5";; sync) echo updated > .codegraph/synced;; files) echo backend/src/App.java;; context) printf "%s\\n" "- backend/src/App.java:1 entry point" "- unrelated/public/js/chart.js:1";; *) exit 1;; esac\n'
  writeFileSync(executable, script)
  if (process.platform !== 'win32') chmodSync(executable, 0o755)
  const previous = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${previous ?? ''}`
  try {
    const before = await codeGraphStatus(project)
    assert.equal(before.installed, true)
    assert.equal(before.indexed, false)
    assert.match(codeGraphInitHint(project), /未检测到/)
    await assert.rejects(queryInitCodeGraph(project, 'files'), /索引不存在/)
    const ready = await prepareCodeGraph(project, false)
    assert.equal(ready.indexed, true)
    assert.equal(existsSync(join(project, '.codegraph')), true)
    writeFileSync(join(project, '.codegraph', 'codegraph.db'), '')
    assert.match(codeGraphInitHint(project), /检测到/)
    assert.equal((await queryInitCodeGraph(project, 'status')).indexed, true)
    const graphFiles = await queryInitCodeGraph(project, 'files')
    assert.match(graphFiles.output, /backend\/src\/App.java/)
    assert.equal(graphFiles.truncated, false)
    const graphContext = await queryInitCodeGraph(project, 'context', 'backend entry points controllers services components')
    assert.match(graphContext.output, /entry point/)
    for (const query of ['foo & whoami', 'foo"bar', '%PATH%', '$(command)', '--help']) await assert.rejects(queryInitCodeGraph(project, 'context', query), /仅接受/)
    await assert.rejects(queryInitCodeGraph(project, 'sync'), /只允许/)
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

test('Windows CodeGraph setup passes the npm package name without literal quotes',
  { skip: process.platform !== 'win32' }, async () => {
    const temp = mkdtempSync(join(tmpdir(), 'dsh-codegraph-install-'))
    const bin = join(temp, 'bin')
    const project = join(temp, 'project')
    mkdirSync(bin)
    mkdirSync(project)
    writeFileSync(join(bin, 'npm.cmd'),
      '@echo off\r\nif not "%1"=="install" exit /b 1\r\n' +
      'if not "%2"=="-g" exit /b 2\r\n' +
      'if not "%3"=="@colbymchenry/codegraph@latest" exit /b 3\r\n' +
      'echo installed>"%~dp0installed"\r\n')
    writeFileSync(join(bin, 'codegraph.cmd'),
      '@echo off\r\nif not exist "%~dp0installed" exit /b 1\r\n' +
      'if "%1"=="--version" (echo 1.6.0 & exit /b 0)\r\n' +
      'if "%1"=="init" (mkdir .codegraph & exit /b 0)\r\n' +
      'if "%1"=="status" (echo Files: 2 Nodes: 5 & exit /b 0)\r\n' +
      'exit /b 1\r\n')
    const previous = process.env.PATH
    process.env.PATH = `${bin}${delimiter}${previous ?? ''}`
    try {
      assert.equal((await codeGraphStatus(project)).installed, false)
      const ready = await prepareCodeGraph(project, true)
      assert.equal(ready.installed, true)
      assert.equal(ready.indexed, true)
      assert.equal(existsSync(join(bin, 'installed')), true)
    } finally {
      process.env.PATH = previous
      rmSync(temp, { recursive: true, force: true })
    }
  })
