/**
 * DSH codec-contract compatibility check.
 *
 * The plugin's Typert Remote contribution must satisfy whichever strict-codec
 * contract the installed DSH expects. DSH 0.1.6-alpha.2 replaced the
 * materialized `schema` field with a lazy `create: () => TypertSchema` factory
 * and rejects the old shape at plugin load, which took the whole contribution
 * down at boot — a failure the unit tests could not see, because they never
 * load the descriptors through a real registry.
 *
 * npm semver cannot wildcard prereleases, so the peer range enumerates them and
 * a new DSH alpha silently falls outside it; pnpm only warns at install time.
 * This check runs against a real DSH checkout, where the contract actually
 * lives, and fails loudly when the two drift apart again.
 *
 * Run: `node scripts/verify-dsh-compat.mjs [path-to-dsh-checkout]`
 * @module dsh-task-engine/scripts/verify-dsh-compat
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DSH_ROOT = 'D:/dsharness/deepseek-harness'

const problems = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : `: ${detail}`}`)
  if (!ok) problems.push(name)
}

/** Locate the typert protocol package inside a DSH checkout. */
function protocolDir(root) {
  const candidates = [
    join(root, 'packages', 'typert', 'protocol'),
    join(root, 'node_modules', '@deepseek-ai', 'dsh-typert-protocol'),
  ]
  return candidates.find(dir => existsSync(join(dir, 'package.json')))
}

const dshRoot = process.argv[2] ?? DEFAULT_DSH_ROOT
console.log(`DSH checkout: ${dshRoot}`)

if (!existsSync(dshRoot)) {
  // Absent checkout is not a failure: this script is advisory outside CI.
  console.log('ok   (skipped) no DSH checkout at that path')
  process.exit(0)
}

const dir = protocolDir(dshRoot)
if (dir === undefined) {
  check('locate the typert protocol package', false, 'not found under the DSH checkout')
  process.exit(1)
}
const protocol = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
console.log(`     typert protocol version: ${protocol.version}`)

// 1. Which contract does this DSH expect? Read the type, not a guess.
const typesPath = [
  join(dir, 'src', 'types.ts'),
  join(dir, 'lib', 'types', 'types.d.ts'),
].find(path => existsSync(path))
const typesText = typesPath === undefined ? '' : readFileSync(typesPath, 'utf8')
const wantsCreate = /readonly create: \(\) => TypertSchema/u.test(typesText)
const wantsSchema = /readonly schema: TypertSchema/u.test(typesText)
console.log(`     contract: ${wantsCreate ? 'create() factory' : wantsSchema ? 'schema field' : 'unknown'}`)

// 2. Our descriptors must satisfy it. Import the built contribution and inspect
//    every strict codec exactly as the DSH registry would.
const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const clientBundle = join(pluginRoot, 'lib', 'client.js')
if (!existsSync(clientBundle)) {
  check('built client bundle exists', false, 'run `npm run build` first')
  process.exit(1)
}
const bundleText = readFileSync(clientBundle, 'utf8')
const strictCodecs = (bundleText.match(/mode:\s*"strict"/gu) ?? []).length
const withCreate = (bundleText.match(/create:\s*\(\)\s*=>/gu) ?? []).length
const withSchema = (bundleText.match(/schema:/gu) ?? []).length

check('the bundle carries strict codecs', strictCodecs > 0, `${strictCodecs} found`)
if (wantsCreate) {
  check('every strict codec provides create()', withCreate >= strictCodecs,
    `${withCreate} of ${strictCodecs}`)
}
if (wantsSchema) {
  check('every strict codec provides schema', withSchema >= strictCodecs,
    `${withSchema} of ${strictCodecs}`)
}

// 3. The peer range must actually admit the installed DSH version, because npm
//    semver will not match a prerelease the range does not name. Implemented
//    here rather than via the `semver` package: that is a devDependency, so a
//    consumer running this script from the installed tarball has no copy, and
//    the whole point of this check is to run against whatever DSH is present.
const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
const range = pkg.peerDependencies['@deepseek-ai/dsh-typert-protocol'] ?? ''
check(`peer range admits DSH ${protocol.version}`, rangeAdmits(range, protocol.version), range)

/**
 * Whether one of a `||`-joined range's comparators admits `version`.
 *
 * npm semver matches a prerelease only when the comparator names a prerelease
 * on the SAME major.minor.patch, which is why enumerating versions is the only
 * way to cover a DSH alpha. This mirrors that rule for the caret and exact
 * forms the manifest actually uses; it is deliberately conservative, and an
 * unrecognized comparator reports `false` so the check fails loudly rather than
 * passing by accident.
 * @param range - the peer range expression.
 * @param version - the installed DSH version to test.
 * @returns true when the range admits the version.
 */
function rangeAdmits(range, version) {
  const parse = text => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(text.trim())
    return match === null
      ? undefined
      : { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] }
  }
  const target = parse(version)
  if (target === undefined) return false
  for (const part of range.split('||').map(text => text.trim()).filter(Boolean)) {
    const caret = /^\^(.+)$/u.exec(part)
    const lower = parse(caret === null ? part : caret[1])
    if (lower === undefined) continue
    // Same prerelease tuple, or a plain release on the same caret line.
    const sameTuple = target.major === lower.major
      && target.minor === lower.minor
      && target.patch === lower.patch
    if (lower.pre !== undefined) {
      if (sameTuple) return true
    } else if (target.pre === undefined && target.major === lower.major) {
      if (caret === null ? sameTuple : target.minor >= lower.minor) return true
    }
  }
  return false
}

if (problems.length > 0) {
  console.error(`\n${problems.length} DSH compatibility problem(s)`)
  console.error('A new DSH alpha likely changed the Typert contract. Update src/client/remote.ts')
  console.error('and add the version to peerDependencies before releasing.')
  process.exit(1)
}
console.log('\nDSH compatibility verified')