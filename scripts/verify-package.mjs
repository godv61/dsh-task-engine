/**
 * Black-box verification of the npm tarball before publishing: packs the
 * package, extracts it into a clean temp dir, and proves the published entry
 * points actually work —main import, browser client registration, the bundled
 * `.p0-test.mjs`, the CLI, and the `files` whitelist.
 *
 * Run: `npm run verify:package`
 * @module dsh-task-engine/scripts/verify-package
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? `: ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

// 1. pack
let tgzName
try {
  const packed = JSON.parse(execSync('npm pack --json', { cwd: pkgRoot, encoding: 'utf8' }))
  tgzName = packed[0]?.filename
} catch (error) {
  check('npm pack', false, String(error))
  process.exit(1)
}
check('npm pack', typeof tgzName === 'string', tgzName)

// 2. extract into a clean temp dir
const tmp = mkdtempSync(join(tmpdir(), 'dsh-pkg-verify-'))
const tgzPath = join(pkgRoot, tgzName)
execSync(`tar -xzf "${tgzPath}"`, { cwd: tmp, stdio: 'pipe' })
const pkgDir = join(tmp, 'package')
const listing = execSync(`tar -tzf "${tgzPath}"`, { encoding: 'utf8' })
  .trim().split(/\r?\n/u).map(line => line.replace(/^package\//u, ''))
check('extract', existsSync(join(pkgDir, 'package.json')))

// 3. files whitelist sanity
for (const required of ['hooks/commit-msg', 'lib/index.js', 'lib/client.js', 'lib/client.d.ts', '.p0-test.mjs', 'preset/enable.mjs', 'README.md', '.resource-test.mjs', '.workflow-test.mjs', '.hook-test.mjs', '.preset-test.mjs', '.assessment-batch1.mjs', '.e2e-presets.mjs', '.revision-test.mjs', '.freeze-test.mjs']) {
  check(`tarball contains ${required}`, listing.includes(required))
}
check('tarball excludes src sources', !listing.some(line => line.startsWith('src/')))
check('tarball excludes build scripts', !listing.some(line => line.endsWith('build-client.mjs') || line.endsWith('build-hook.mjs')))

// Every `node <file>` script the manifest declares must actually ship, EXCEPT
// the build-time ones that `prepare` needs in the source tree only. A script
// whose target is absent from `files` installs fine and then dies with
// MODULE_NOT_FOUND —which is exactly what verify:package and verify:dsh did
// until this assertion existed, because neither scripts/ path was published.
{
  const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
  // Scripts that legitimately run only before publishing, never from a consumer.
  const BUILD_ONLY = new Set(['prepare', 'build'])
  const missing = []
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (BUILD_ONLY.has(name)) continue
    for (const match of String(command).matchAll(/\bnode\s+(?:--[^\s]+\s+)*([^\s&|]+)/gu)) {
      const target = match[1].replace(/^\.\//u, '')
      if (!target.endsWith('.mjs') && !target.endsWith('.js')) continue
      if (!listing.includes(target)) missing.push(`${name} -> ${target}`)
    }
  }
  check('every declared node script ships in the tarball', missing.length === 0, missing.join(', '))
}

// 3b. install the tarball into a clean project so peer dependencies resolve,
// exactly like a real consumer's `npm install`.
const installDir = mkdtempSync(join(tmpdir(), 'dsh-pkg-install-'))
import { writeFileSync } from 'node:fs'
writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'probe', private: true, type: 'module' }))
try {
  execSync(`npm install "${tgzPath}" --no-audit --no-fund`, { cwd: installDir, encoding: 'utf8', stdio: 'pipe' })
  check('npm install tarball', true)
} catch (error) {
  check('npm install tarball', false, String(error.stderr ?? error))
  process.exit(1)
}
const installedDir = join(installDir, 'node_modules', '@godv61', 'dsh-task-engine')

// 4. main entry imports
try {
  await import(pathToFileURL(join(installedDir, 'lib/index.js')).href)
  check('import main entry', true)
} catch (error) {
  check('import main entry', false, error instanceof Error ? error.message : String(error))
}

// 5. browser client registers through the DSH module loader
try {
  const registry = { loaded: undefined }
  globalThis.window = { __ModuleLoader__: { load(reg) { registry.loaded = reg } } }
  await import(pathToFileURL(join(installedDir, 'lib/client.js')).href)
  check('client bundle registers via ModuleLoader', registry.loaded?.id === '@godv61/dsh-task-engine')
} catch (error) {
  check('client bundle registers via ModuleLoader', false, error instanceof Error ? error.message : String(error))
}

// 6. in-package acceptance test
try {
  const out = execSync('node .p0-test.mjs', { cwd: installedDir, encoding: 'utf8', stdio: 'pipe' })
  check('in-package .p0-test.mjs', /passed/u.test(out), out.trim().split('\n').at(-1))
} catch (error) {
  check('in-package .p0-test.mjs', false, String(error.stderr ?? error))
}

// Resource package behavior from the installed artifact, including the commit
// hook running for real inside throwaway repositories.
try {
  const out = execSync('node --test --test-reporter=tap .resource-test.mjs .workflow-test.mjs .hook-test.mjs .preset-test.mjs', { cwd: installedDir, encoding: 'utf8', stdio: 'pipe' })
  check('in-package resource, workflow and hook behavior', /# fail 0/u.test(out))
} catch (error) { check('in-package resource, workflow and hook behavior', false, String(error.stderr ?? error)) }

// 7. CLI parses
try {
  const cli = join(installedDir, 'preset', 'enable.mjs')
  execSync(`node --check "${cli}"`, { stdio: 'pipe' })
  check('CLI enable.mjs parses', true)
} catch (error) {
  check('CLI enable.mjs parses', false, String(error.stderr ?? error))
}

rmSync(tmp, { recursive: true, force: true })
rmSync(installDir, { recursive: true, force: true })
try { rmSync(tgzPath, { force: true }) } catch { /* keep the tarball when the FS declines */ }

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\npackage black-box verification passed')
