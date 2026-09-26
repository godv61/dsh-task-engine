import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import Controller from './lib/controller.js'
import { registerDevTask } from './lib/dev-task.js'
import { loadedSkills, skillBlockers } from './lib/skill-audit.js'
import { resolveFlow } from './lib/workflows.js'
import { validateWorkflow } from './lib/engine.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codex-project-'))
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}
function put(path, body) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}
function diskFs() {
  return {
    resolve: async (path, options) => resolve(options?.cwd ?? '', path),
    readText: async path => { try { return readFileSync(path, 'utf8') } catch { return undefined } },
    lstat: async (path, options) => { try { return { version: String(statSync(resolve(options?.cwd ?? '', path)).mtimeMs) } } catch { return undefined } },
    writeText: async (path, body) => put(path, body),
    listDir: async path => readdirSync(path, { withFileTypes: true }).map(entry => ({ name: entry.name })),
  }
}

test('Codex project Skills are discovered separately; new DSH Skills stay in .dsh', async t => {
  const root = fixture(t)
  const body = '---\nname: same\ndescription: Codex method\n---\nCodex body v1\n'
  put(join(root, '.agents/skills/same/SKILL.md'), body)
  put(join(root, '.dsh/skills/same/SKILL.md'), '---\nname: same\ndescription: DSH method\n---\nDSH body\n')
  const receiver = { authorizedPath: async path => path }
  const catalog = await Controller.prototype.listSkills.call(receiver, root)
  assert.deepEqual(catalog.skills.filter(skill => skill.name === 'same').map(skill => skill.ref.source).sort(), ['codex-project', 'project'])
  const read = await Controller.prototype.readSkill.call(receiver, { level: 'codex-project', name: 'same', path: root })
  assert.equal(read.content, 'Codex body v1')
  const created = await Controller.prototype.writeSkill.call(receiver, { level: 'project', name: 'new-one', description: 'New DSH method', whenToUse: '', content: 'body', path: root })
  assert.equal(created.ok, true)
  assert.equal(readFileSync(join(root, '.dsh/skills/new-one/SKILL.md'), 'utf8').includes('body'), true)
})

test('a bound Codex Skill loads its attached DSH Rule and reads edits next time', async t => {
  const root = fixture(t)
  const skillFile = join(root, '.agents/skills/sample/SKILL.md')
  const ruleFile = join(root, '.dsh/rules/shared.md')
  put(skillFile, '---\nname: sample\ndescription: Sample\n---\nSkill v1\n')
  put(ruleFile, 'Rule v1')
  const ref = { source: 'codex-project', name: 'sample' }
  const rule = { source: 'project', name: 'shared' }
  const project = { flow: 'minimal', stage_bindings: { '开发': { skill_refs: [ref] } }, skill_profiles: { 'codex-project:sample': { rules: [rule], evidence: 'none' } } }
  put(join(root, '.dsh/eng.json'), JSON.stringify(project))
  assert.deepEqual(validateWorkflow(resolveFlow('minimal', project).config), [])
  const fs = diskFs(), tools = []
  registerDevTask({ fs, tools: { register(tool) { tools.push(tool) } }, get() { return undefined } })
  const execute = tools[0].execute
  const events = []
  const session = { id: 'test-session', header: { cwd: root }, snapshotEvents: () => events }
  const run = (args, callId = 'call') => execute(args, { agent: { session }, callId, signal: undefined })
  await run({ operation: 'create', task_id: 'T1', title: 'Test', branch: 'main' })
  const first = await run({ operation: 'load_skill', task_id: 'T1', skill_name: 'codex-project:sample' }, 'load-1')
  assert.match(first, /Skill v1/)
  assert.match(first, /Rule v1/)
  events.push({ type: 'tool/call', data: { name: 'dev_task', callId: 'load-1', arguments: JSON.stringify({ operation: 'load_skill', task_id: 'T1', skill_name: 'codex-project:sample' }) } })
  events.push({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'load-1', isError: false }] } } })
  assert.equal(loadedSkills(session).get('T1#codex-project:sample'), 'load-1')
  const state = JSON.parse(readFileSync(join(root, '.dsh/task-T1.json'), 'utf8'))
  assert.deepEqual(skillBlockers(state, state.flow.config, session), [])
  assert.match(skillBlockers({ ...state, id: 'T2' }, state.flow.config, session).join('; '), /load_skill/,
    'loading a Skill for one task must not satisfy another task with a different Rule profile')
  put(skillFile, '---\nname: sample\ndescription: Sample\n---\nSkill v2\n')
  put(ruleFile, 'Rule v2')
  const second = await run({ operation: 'load_skill', task_id: 'T1', skill_name: 'codex-project:sample' }, 'load-2')
  assert.match(second, /Skill v2/)
  assert.match(second, /Rule v2/)
})
