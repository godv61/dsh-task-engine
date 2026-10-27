import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { discoverInitStepPaths, InitRepositoryReader, initPathPrompt, initReadablePath, runInitRepositoryModel } from './lib/init-repository.js'
import Controller from './lib/controller.js'
import { projectMapCoverageGaps, scanProject } from './lib/project-init.js'
import { withInitTimeout } from './lib/init-timeout.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'init-reader-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const probe = {
    read: async (dir, path) => { try { return readFileSync(join(dir, path), 'utf8') } catch { return undefined } },
    list: async (dir, path) => { try { return readdirSync(join(dir, path)) } catch { return [] } },
  }
  return { root, probe, reader: new InitRepositoryReader(probe, root) }
}
const result = async (reader, name, args) => {
  const r = await reader.execute(name, JSON.stringify(args))
  return { ...r, value: JSON.parse(r.text) }
}

test('initialization brief contains paths and exploration instructions, never source heads or fabricated read claims', () => {
  const inventory = { modules: [{ path: 'backend', entries: ['src'] }, { path: 'frontend', entries: ['src'] }],
    root_entries: ['README.md', '.env'], manifests: [{ path: 'frontend/package.json', facts: [] }] }
  const brief = initPathPrompt('/repo', inventory, { name: 'repo-business-capabilities', why: 'Business map' },
    ['.', 'frontend/package.json', 'README.md', 'backend', 'frontend'])
  assert.deepEqual(brief.evidence_paths, ['.', 'frontend/package.json', 'README.md', 'backend', 'frontend'])
  assert.match(brief.evidence_prompt, /不包含源码正文/)
  assert.match(brief.evidence_prompt, /init_read_file/)
  assert.match(brief.evidence_prompt, /跨领域/)
  assert.doesNotMatch(brief.evidence_prompt, /\.env|###|dependencies/)
})

test('file reads continue beyond the former 1500 character head and expose exact complete ranges and footer', async t => {
  const f = fixture(t)
  const lines = Array.from({ length: 310 }, (_, i) => `line-${i + 1}: ${'evidence'.repeat(15)}`)
  lines.push('TAIL_ONLY_PROOF=verified-after-former-cutoff')
  writeFileSync(join(f.root, 'source.txt'), lines.join('\r\n'))
  const first = await result(f.reader, 'init_read_file', { path: 'source.txt', line_count: 240 })
  assert.equal(first.isError, false)
  assert.equal(first.value.start_line, 1)
  assert.equal(first.value.next_line, first.value.end_line + 1)
  assert.ok(first.value.end_line < 240, 'character budget ends at a full line')
  assert.equal(first.value.lines.at(-1).text, lines[first.value.end_line - 1])
  const tail = await result(f.reader, 'init_read_file', { path: 'source.txt', start_line: 300 })
  assert.equal(tail.value.next_line, null)
  assert.equal(tail.value.lines.at(-1).text, lines.at(-1))
  assert.equal(tail.value.sha256, first.value.sha256)
  assert.equal(f.reader.reads.length, 2)
})

test('listing paginates all domains and search reports line numbers without substituting for a file read', async t => {
  const f = fixture(t)
  for (let i = 0; i < 205; i++) mkdirSync(join(f.root, `domain-${String(i).padStart(3, '0')}`))
  mkdirSync(join(f.root, '.git'))
  writeFileSync(join(f.root, '.env'), 'SECRET')
  const first = await result(f.reader, 'init_list_directory', { path: '.', limit: 200 })
  assert.equal(first.value.total, 205)
  assert.equal(first.value.next_offset, 200)
  const last = await result(f.reader, 'init_list_directory', { path: '.', offset: 200 })
  assert.equal(last.value.entries.length, 5)
  assert.equal(last.value.next_offset, null)
  writeFileSync(join(f.root, 'controller.java'), 'import Example;\n\n@PostMapping("/approve")\nvoid approve() {}')
  const found = await result(f.reader, 'init_search_file', { path: 'controller.java', query: 'postmapping' })
  assert.deepEqual(found.value.matches, [3])
  assert.equal(f.reader.reads.length, 0)
})

test('invalid paths, private files, unsupported operations and symlink escapes cannot be read', async t => {
  const f = fixture(t)
  for (const path of ['../outside', '/etc/passwd', 'C:/Windows/file', '..\\outside', 'src/../outside', '.git/config', '.env.local', 'credentials.json', 'private.pem', 'src/file:stream']) {
    assert.throws(() => initReadablePath(path), undefined, path)
    assert.equal((await result(f.reader, 'init_read_file', { path })).isError, true)
  }
  assert.equal((await result(f.reader, 'write_file', { path: 'README.md' })).isError, true)
  const other = mkdtempSync(join(tmpdir(), 'init-reader-external-'))
  t.after(() => rmSync(other, { recursive: true, force: true }))
  writeFileSync(join(other, 'outside.txt'), 'must not be returned')
  symlinkSync(other, join(f.root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await result(f.reader, 'init_read_file', { path: 'link/outside.txt' })).isError, true)
  assert.equal(f.reader.reads.length, 0)
})

test('missing, binary and oversized lines fail explicitly instead of silently returning broken excerpts', async t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'binary.dat'), 'a\0b')
  writeFileSync(join(f.root, 'huge-line.json'), JSON.stringify({ x: 'x'.repeat(20_000) }))
  for (const path of ['missing.txt', 'binary.dat', 'huge-line.json']) {
    const r = await result(f.reader, 'init_read_file', { path })
    assert.equal(r.isError, true)
    assert.ok(r.value.error)
  }
  assert.equal(f.reader.reads.length, 0)
  const denied = new InitRepositoryReader({ ...f.probe, list: async () => { throw new Error('directory access denied') } }, f.root)
  const listing = await result(denied, 'init_list_directory', { path: '.' })
  assert.equal(listing.isError, true)
  assert.match(listing.value.error, /directory access denied/)
})

test('model tool conversation returns actual file content and call identity before accepting final JSON', async t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'README.md'), 'verified source footer')
  let turns = 0
  const output = await runInitRepositoryModel(async function* (options) {
    turns++
    assert.equal(options.tools.length, 4)
    if (turns === 1) {
      yield { type: 'tool-call-delta', index: 0, id: 'read-1', name: 'init_read_file', argumentsDelta: '{"path":' }
      yield { type: 'tool-call-delta', index: 0, id: 'read-1', argumentsDelta: '"README.md"}' }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      const reply = options.messages.at(-1)
      assert.equal(reply.role, 'tool')
      assert.equal(reply.toolCallId, 'read-1')
      assert.match(reply.content[0].text, /verified source footer/)
      yield { type: 'text-delta', index: 0, text: '{"resources":[]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }, { provider: 'test', model: 'test', messages: [createUserMessage({ content: [{ type: 'text', text: 'read paths' }], source: { kind: 'user' } })] }, f.reader)
  assert.equal(turns, 2)
  assert.equal(output, '{"resources":[]}')
  assert.equal(f.reader.reads[0].path, 'README.md')
})

test('five steps discover different real entry paths, including nested Maven sources and all sampled view domains', async t => {
  const f = fixture(t)
  for (const path of ['server/admin/src/main/java/acme', 'server/admin/src/test/java', 'ui/src/views/audit', 'ui/src/views/employee', 'ui/src/api', 'ui/src/router', 'ui/src/components', 'ui/tests', 'docs']) mkdirSync(join(f.root, path), { recursive: true })
  for (const path of ['server/pom.xml', 'server/admin/pom.xml', 'ui/package.json', 'ui/vite.config.ts', 'README.md']) writeFileSync(join(f.root, path), 'fixture')
  const inventory = { root_entries: readdirSync(f.root), modules: ['server', 'ui', 'docs'].map(path => ({ path, entries: readdirSync(join(f.root, path)) })),
    manifests: ['server/pom.xml', 'ui/package.json'].map(path => ({ path, facts: [] })) }
  const paths = {}
  const prompts = []
  for (const suffix of ['project-map', 'tech-stack', 'business-capabilities', 'code-backend', 'code-frontend']) {
    const step = { name: `repo-${suffix}`, why: suffix }
    paths[suffix] = await discoverInitStepPaths(f.probe, f.root, inventory, step)
    prompts.push(initPathPrompt(f.root, inventory, step, paths[suffix]).evidence_prompt)
  }
  assert.equal(new Set(Object.values(paths).map(value => JSON.stringify(value))).size, 5)
  assert.ok(paths['tech-stack'].includes('ui/vite.config.ts'))
  assert.ok(paths['business-capabilities'].includes('ui/src/views/audit'))
  assert.ok(paths['business-capabilities'].includes('ui/src/views/employee'))
  assert.ok(paths['code-backend'].includes('server/admin/src/main/java'))
  assert.ok(!paths['code-backend'].some(path => path.startsWith('ui/')))
  assert.ok(paths['code-frontend'].includes('ui/src/components'))
  assert.ok(!paths['code-frontend'].some(path => path.startsWith('server/')))
  assert.match(prompts[3], /事务/)
  assert.match(prompts[4], /不跨应用套用约定/)
  for (const prompt of prompts) assert.doesNotMatch(prompt, /QMS|QDM|稽核|Vue2|Vue3|RuoYi|Java 教程|Vue 教程/iu)
  for (const prompt of prompts) assert.match(prompt, /init_query_codegraph/)
})

test('initialization derives facts from different repository types without importing a business project or framework assumption', async t => {
  const cases = [
    { name: 'react-single', files: { 'package.json': '{"name":"react-sample","dependencies":{"react":"19.0.0"}}', 'src/components/View.tsx': 'export const View=()=>null' },
      target: 'code-frontend', expected: 'src/components', absent: 'code-backend' },
    { name: 'gradle-service', files: { 'build.gradle': "plugins { id 'java' }", 'src/main/java/demo/App.java': 'class App {}' },
      target: 'code-backend', expected: 'src/main/java', absent: 'code-frontend' },
    { name: 'python-tool', files: { 'pyproject.toml': '[project]\nname="python-tool"\nrequires-python=">=3.11"', 'tool.py': 'print("sample")' },
      target: 'tech-stack', expected: 'pyproject.toml', absent: 'code-frontend' },
    { name: 'go-service', files: { 'go.mod': 'module example.local/service\ngo 1.23', 'main.go': 'package main' },
      target: 'tech-stack', expected: 'go.mod', absent: 'code-frontend' },
    { name: 'rust-cli', files: { 'Cargo.toml': '[package]\nname="rust-cli"\nrust-version="1.80"', 'src/main.rs': 'fn main() {}' },
      target: 'tech-stack', expected: 'Cargo.toml', absent: 'code-frontend' },
  ]
  for (const sample of cases) await t.test(sample.name, async subtest => {
    const f = fixture(subtest)
    for (const [path, content] of Object.entries(sample.files)) {
      const full = join(f.root, path)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content)
    }
    const inventory = await scanProject(f.probe, f.root)
    const step = inventory.suggestions.find(item => item.name.endsWith(`-${sample.target}`))
    assert.ok(step, `detected ${sample.target} for ${sample.name}`)
    assert.ok(!inventory.suggestions.some(item => item.name.endsWith(`-${sample.absent}`)))
    const paths = await discoverInitStepPaths(f.probe, f.root, inventory, step)
    assert.ok(paths.includes(sample.expected), JSON.stringify(paths))
    const prompt = initPathPrompt(f.root, inventory, step, paths).evidence_prompt
    assert.doesNotMatch(prompt, /QMS|QDM|稽核|Vue2|Vue3|RuoYi|fp-bussiness|qdmai/iu)
    assert.match(prompt, /init_query_codegraph/)
  })
})

test('CodeGraph tool uses the selected root, records queries, and never counts graph metadata as source reads', async t => {
  const f = fixture(t)
  const calls = []
  const reader = new InitRepositoryReader(f.probe, f.root, async (root, mode, query) => {
    calls.push({ root, mode, query })
    if (mode === 'context') throw new Error('graph query unavailable')
    return { installed: true, indexed: true }
  })
  assert.equal((await result(reader, 'init_query_codegraph', { mode: 'status' })).isError, false)
  assert.equal((await result(reader, 'init_query_codegraph', { mode: 'context', query: 'employee' })).isError, true)
  assert.equal((await result(reader, 'init_query_codegraph', { mode: 'sync' })).isError, true)
  assert.equal(calls[0].root, f.root)
  assert.equal(reader.reads.length, 0)
  assert.deepEqual(reader.graphQueries, [{ mode: 'status', ok: true }, { mode: 'context', query: 'employee', ok: false }])
})

test('a model without file tools cannot submit an invented nonempty initialization resource', async t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'package.json'), '{"name":"fixture"}')
  const fileSystem = {
    resolve: async (path, options) => ({ path: join(options.cwd, path) }),
    readText: async target => f.probe.read(f.root, target.path),
    listDir: async target => (await f.probe.list(f.root, target.path)).map(name => ({ name })),
  }
  const receiver = { fs: () => fileSystem, projectInitRoot: async () => f.root,
    inspectProjectInit: async () => ({ inventory: { project_name: 'fixture', modules: [], root_entries: ['package.json'],
      manifests: [{ path: 'package.json', facts: [] }], suggestions: [{ name: 'fixture-tech-stack', kind: 'skill',
        why: 'verified stack', meta_skills: ['architecture-design'] }] }, existing: [], system_prompt: 'JSON', user_prompt: 'paths', step_prompt: '{{target}}' }),
    ctx: { get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test' }) }
      if (name === 'llm') return { async *stream() {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ resources: [{ kind: 'skill', name: 'fixture-tech-stack',
          description: 'invented', content: '# no file reads', meta_skills: ['code-development'], rules: [] }] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }
    } } }
  await assert.rejects(Controller.prototype.generateProjectInitStep.call(receiver,
    { path: f.root, target: 'fixture-tech-stack', prior_resources: [] }), /未实际读取仓库文件/)
})

const options = () => ({ provider: 'test', model: 'test', messages: [createUserMessage({ content: [{ type: 'text', text: 'inspect repository' }], source: { kind: 'user' } })] })
function* readChunk(id = 'read') {
  yield { type: 'tool-call-delta', index: 0, id, name: 'init_read_file', argumentsDelta: '{"path":"README.md"}' }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
function* textChunks(text) {
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

test('exploration reaches a reserved composition round instead of discarding 23 rounds of evidence', async t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'README.md'), 'actual source')
  let turns = 0
  const output = await runInitRepositoryModel(async function* (request) {
    turns++
    if (request.tools.length) yield* readChunk(`read-${turns}`)
    else {
      assert.match(request.messages.at(-1).content[0].text, /停止扩大扫描/)
      assert.equal(f.reader.reads.length, 23)
      yield* textChunks('{"resources":[]}')
    }
  }, options(), f.reader, JSON.parse)
  assert.equal(turns, 24)
  assert.equal(output, '{"resources":[]}')
})

test('tool volume also triggers composition before repeated exhausted-budget calls', async t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'README.md'), 'actual source')
  let turns = 0
  await runInitRepositoryModel(async function* (request) {
    turns++
    if (!request.tools.length) { yield* textChunks('{"resources":[]}'); return }
    for (let i = 0; i < 10; i++) yield { type: 'tool-call-delta', index: i, id: `r-${turns}-${i}`, name: 'init_read_file', argumentsDelta: '{"path":"README.md"}' }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }, options(), f.reader)
  assert.equal(turns, 8)
  assert.equal(f.reader.reads.length, 70)
})

test('elapsed time alone no longer forces composition at 110 seconds', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const f = fixture(t)
  writeFileSync(join(f.root, 'README.md'), 'verified source')
  let turns = 0
  await runInitRepositoryModel(async function* (request) {
    turns++
    if (turns === 1) { t.mock.timers.tick(200_000); yield* readChunk() }
    else { assert.equal(request.tools.length, 4); yield* textChunks('{"resources":[]}') }
  }, options(), f.reader)
  assert.equal(turns, 2)
  assert.equal(f.reader.reads.length, 1)
})

test('large mixed-language discovery can stop at 1024 directories without rejecting all known map paths', async () => {
  const tree = new Map([['.', ['api', 'cli', 'docs']], ['api', ['go.mod', 'main.go']], ['cli', ['Cargo.toml', 'src']],
    ['cli/src', ['main.rs']], ['docs', Array.from({ length: 1200 }, (_, i) => `topic-${i}`)]])
  let calls = 0
  const inventory = await scanProject({ read: async (_, path) => path === 'api/go.mod' ? 'module example.local/api\ngo 1.23'
    : path === 'cli/Cargo.toml' ? '[package]\nname="example-cli"' : undefined,
    list: async (_, path) => { calls++; return tree.get(path) ?? [] },
    directories: async (_, path) => path === '.' ? ['api', 'cli', 'docs'] : path === 'docs' ? tree.get('docs') : path === 'cli' ? ['src'] : [] }, '/large-mixed')
  assert.equal(calls, 1024)
  assert.equal(inventory.discovery.status, 'partial')
  assert.deepEqual(inventory.manifests.map(m => m.path), ['api/go.mod', 'cli/Cargo.toml'])
  assert.deepEqual(projectMapCoverageGaps('api: Go service. cli: Rust CLI; exact responsibilities need source confirmation.', inventory), [])
  assert.notDeepEqual(projectMapCoverageGaps('api only', inventory), [], 'known module omissions are still rejected')
})

test('JSON repair retains original file evidence and bad draft, and offers no more repository tools', async t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'README.md'), 'original evidence footer')
  let turns = 0
  const output = await runInitRepositoryModel(async function* (request) {
    turns++
    if (turns === 1) yield* readChunk()
    else if (turns === 2) yield* textChunks('{"resources":[')
    else {
      assert.deepEqual(request.tools, [])
      assert.ok(request.messages.some(m => m.role === 'tool' && m.content[0].text.includes('original evidence footer')))
      assert.equal(request.messages.at(-2).content[0].text, '{"resources":[')
      assert.match(request.messages.at(-1).content[0].text, /草案校验失败/)
      yield* textChunks('{"resources":[]}')
    }
  }, options(), f.reader, JSON.parse)
  assert.equal(output, '{"resources":[]}')
  assert.equal(turns, 3)
  assert.equal(f.reader.reads.length, 1)
})

test('truncated draft output is compressed in the same conversation instead of discarding its evidence', async t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'README.md'), 'read before truncation')
  let turns = 0
  await runInitRepositoryModel(async function* (request) {
    turns++
    if (turns === 1) yield* readChunk()
    else if (turns === 2) {
      yield { type: 'text-delta', index: 0, text: '{"resources":[' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    } else {
      assert.deepEqual(request.tools, [])
      assert.match(request.messages.at(-1).content[0].text, /压缩正文/)
      yield* textChunks('{"resources":[]}')
    }
  }, options(), f.reader, JSON.parse)
  assert.equal(turns, 3)
  assert.equal(f.reader.reads.length, 1)
})

function stepReceiver(f, stream, inventory) {
  return { fs: () => ({ resolve: async (path, o) => ({ path: join(o.cwd, path) }),
    readText: async target => readFileSync(target.path, 'utf8'),
    listDir: async target => readdirSync(target.path).map(name => ({ name })) }),
    projectInitRoot: async () => f.root,
    inspectProjectInit: async () => ({ inventory, existing: [], system_prompt: 'JSON', user_prompt: 'paths', step_prompt: '{{target}}' }),
    ctx: { get: name => name === 'llm' ? { stream } : name === 'agentDefaultModel'
      ? { currentSelection: () => ({ provider: 'test', model: 'test' }) } : undefined } }
}
const stackInventory = () => ({ project_name: 'fixture', modules: [], root_entries: ['README.md'], manifests: [],
  suggestions: [{ name: 'fixture-tech-stack', kind: 'skill', why: 'stack', meta_skills: ['architecture-design'] }] })
const draft = (name, content) => JSON.stringify({ resources: [{ kind: 'skill', name, description: 'verified navigation',
  content, meta_skills: ['architecture-design'], rules: [] }] })

test('configured reasoning effort is forwarded and transport retries share one total time budget', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const f = fixture(t)
  writeFileSync(join(f.root, 'README.md'), 'evidence')
  let turns = 0, retrySignal
  const receiver = stepReceiver(f, async function* (request) {
    assert.equal(request.reasoningEffort, 'max')
    turns++
    if (turns === 1) yield* readChunk()
    else if (turns === 2) { t.mock.timers.tick(240_000); throw new Error('503 temporarily unavailable') }
    else { retrySignal = request.signal; await new Promise(() => {}) }
  }, stackInventory())
  const get = receiver.ctx.get
  receiver.ctx.get = name => name === 'agentDefaultModel'
    ? { currentSelection: () => ({ provider: 'test', model: 'test', reasoningEffort: 'max' }) } : get(name)
  const generation = Controller.prototype.generateProjectInitStep.call(receiver,
    { path: f.root, target: 'fixture-tech-stack', prior_resources: [], evidence_prompt: 'README.md', timeout_minutes: 10 })
  const failed = assert.rejects(generation, /超过10分钟预算/)
  await new Promise(setImmediate)
  assert.equal(turns, 3)
  t.mock.timers.tick(359_999)
  assert.equal(retrySignal.aborted, false)
  t.mock.timers.tick(1)
  await failed
  assert.equal(retrySignal.aborted, true, 'retry expires at the original 10-minute deadline, not 10 minutes after its own start')
})

test('AGENTS generation also inherits the selected reasoning effort', async t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'README.md'), 'repository overview')
  let effort
  const receiver = { authorizedPath: async path => path, ctx: { get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'test', reasoningEffort: 'high' }) }
    if (name === 'llm') return { async *stream(request) { effort = request.reasoningEffort; yield* textChunks('# Repository overview') } }
  } } }
  const result = await Controller.prototype.generateInit.call(receiver, { path: f.root })
  assert.equal(result.ok, true)
  assert.equal(effort, 'high')
})

test('a supplied project map does not replace actual business source reads or become a prerequisite', async t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'README.md'), 'Orders can be submitted and then reviewed by a manager.')
  const inventory = { ...stackInventory(), suggestions: [{ name: 'fixture-business-capabilities', kind: 'skill', why: 'business', meta_skills: ['requirements-analysis'] }] }
  const map = { kind: 'skill', name: 'fixture-project-map', description: 'map summary', content: '# FULL_MAP_ONLY\norders/: entry; behavior requires source confirmation.', meta_skills: ['architecture-design'] }
  let calls = 0
  const receiver = stepReceiver(f, async function* (request) {
    calls++
    assert.match(request.messages[0].content[0].text, /FULL_MAP_ONLY/)
    yield* textChunks(draft('fixture-business-capabilities', '# copied from map without reading source'))
  }, inventory)
  const inspect = receiver.inspectProjectInit
  receiver.inspectProjectInit = async () => ({ ...await inspect(), step_prompt: '{{previous}}\n{{target}}' })
  await assert.rejects(Controller.prototype.generateProjectInitStep.call(receiver,
    { path: f.root, target: 'fixture-business-capabilities', prior_resources: [map], evidence_prompt: 'README.md' }), /未实际读取仓库文件/)
  assert.equal(calls, 3)
  let turns = 0
  const independent = stepReceiver(f, async function* () {
    turns++
    if (turns === 1) yield* readChunk()
    else yield* textChunks(draft('fixture-business-capabilities', '# Orders\nSubmit → manager review. Source: README.md:1. Other domains unreviewed.'))
  }, inventory)
  const result = await Controller.prototype.generateProjectInitStep.call(independent,
    { path: f.root, target: 'fixture-business-capabilities', prior_resources: [], evidence_prompt: 'README.md' })
  assert.equal(result.resource.name, 'fixture-business-capabilities')
  assert.equal(result.reads.length, 1)
})

test('partial inventories can produce useful maps, with known omissions repaired and discovery explicitly disclosed', async t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'README.md'), 'Python tool and Rust CLI share an API')
  const inventory = { ...stackInventory(), manifests: [{ path: 'tools/py/pyproject.toml', facts: [] }, { path: 'tools/rs/Cargo.toml', facts: [] }],
    suggestions: [{ name: 'fixture-project-map', kind: 'skill', why: 'map', meta_skills: ['architecture-design'] }],
    discovery: { status: 'partial', directories: 1024, entries: 5072, warnings: ['directory or entry discovery budget reached'], exclusions: [], limits: { directories: 1024, depth: 16, entries: 20000 } } }
  let turns = 0
  const receiver = stepReceiver(f, async function* (request) {
    turns++
    if (turns === 1) yield* readChunk()
    else if (turns === 2) yield* textChunks(draft('fixture-project-map', '# Map\ntools/py: Python tool; source: README.md'))
    else {
      assert.match(request.messages.at(-1).content[0].text, /tools\/rs/)
      assert.deepEqual(request.tools, [])
      yield* textChunks(draft('fixture-project-map', '# Map\ntools/py: Python tool. tools/rs: Rust CLI. Evidence: README.md. Detailed dependencies need confirmation.'))
    }
  }, inventory)
  const result = await Controller.prototype.generateProjectInitStep.call(receiver,
    { path: f.root, target: 'fixture-project-map', prior_resources: [], evidence_prompt: 'README.md' })
  assert.equal(turns, 3)
  assert.equal(result.reads.length, 1)
  assert.deepEqual(projectMapCoverageGaps(result.resource.content, inventory), [])
  assert.match(result.resource.content, /目录发现尚未完成/)
  assert.match(result.resource.content, /1024/)
  assert.match(result.resource.content, /Detailed dependencies need confirmation/)
})

test('a fresh transport retry cannot borrow source evidence from its failed predecessor', async t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'README.md'), 'only read in the failed attempt')
  let turns = 0
  const receiver = stepReceiver(f, async function* () {
    turns++
    if (turns === 1) yield* readChunk()
    else if (turns === 2) throw new Error('503 temporarily unavailable')
    else yield* textChunks(draft('fixture-tech-stack', '# fabricated retry'))
  }, stackInventory())
  await assert.rejects(Controller.prototype.generateProjectInitStep.call(receiver,
    { path: f.root, target: 'fixture-tech-stack', prior_resources: [], evidence_prompt: 'README.md' }), /未实际读取仓库文件/)
  assert.equal(turns, 5, 'only one fresh transport attempt; no repeated full scan after output validation failure')
})

test('an uncooperative provider is bounded even when it never settles or handles cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal, finish
  const attempt = withInitTimeout(s => { signal = s; return new Promise(resolve => { finish = resolve }) }, 150_000, 'attempt expired')
  const rejected = assert.rejects(attempt, /attempt expired/)
  await Promise.resolve()
  t.mock.timers.tick(150_000)
  await rejected
  assert.equal(signal.aborted, true)
  finish('late output must be ignored')
  await assert.rejects(attempt, /attempt expired/)
})
