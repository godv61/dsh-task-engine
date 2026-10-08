import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { registerDevTask } from './lib/dev-task.js'

test('hook installer protects another hook and registers a nested workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hook-install-'))
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    const workspace = join(root, 'module')
    mkdirSync(workspace)
    const hook = join(root, '.git', 'hooks', 'commit-msg')
    writeFileSync(hook, '#!/bin/sh\necho team-hook\n')
    const fs = {
      resolve: async (rel, options) => ({ path: resolve(options?.cwd ?? workspace, rel) }),
      readText: async target => readFileSync(target.path, 'utf8'),
      writeText: async (target, content) => { mkdirSync(resolve(target.path, '..'), { recursive: true }); writeFileSync(target.path, content) },
    }
    let execute
    const session = { header: { cwd: workspace } }
    registerDevTask({ fs, tools: { register(tool) { execute = tool.execute; return () => {} } }, get: () => undefined })
    const run = args => execute(args, { agent: { session }, signal: new AbortController().signal })
    await assert.rejects(run({ operation: 'install_hook' }), /不会覆盖/)
    assert.match(readFileSync(hook, 'utf8'), /team-hook/)
    execFileSync('git', ['config', 'core.hooksPath', '.custom-hooks'], { cwd: root })
    await assert.rejects(run({ operation: 'install_hook' }), /core\.hooksPath/)
    execFileSync('git', ['config', '--unset', 'core.hooksPath'], { cwd: root })
    const old = readFileSync('hooks/commit-msg', 'utf8') + '\n// old customisation\n'
    writeFileSync(hook, old)
    await run({ operation: 'install_hook' })
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.git', 'hooks', 'dsh-task-roots.json'), 'utf8')).roots, ['module'])
    assert.match(await run({ operation: 'verify_hook' }), /integrity OK/)
    const backups = readdirSync(join(root, '.git', 'hooks')).filter(name => name.startsWith('commit-msg.backup-'))
    assert.equal(backups.length, 1)
    assert.equal(readFileSync(join(root, '.git', 'hooks', backups[0]), 'utf8'), old)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
