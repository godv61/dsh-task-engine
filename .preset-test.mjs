/**
 * Tests for the `eng` preset derivation.
 *
 * The preset must track the RUNNING harness's `standard`, because a copy that
 * freezes once goes stale the moment DSH edits its own composition, and a stale
 * preset fails to load entirely. Two real regressions motivate these cases:
 *
 *   - DSH 2026-09-06 moved the persona row from `text:` to `prefix`/`suffix`.
 *   - DSH 2026-09-13 replaced the `workflow-worker-thread` row with
 *     `workflow-ptc`; the plugin kept emitting the removed row, whose package
 *     had also left `apps/cli`'s dependencies, so the roster could not resolve
 *     it and reported "加载失败" for the whole preset.
 *
 * Run: `node --test .preset-test.mjs`
 * @module dsh-task-engine/.preset-test
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { derivedEngComposition, wasSeeded, applyPersona, personaFieldOf } from './lib/seed-preset.js'

/**
 * The live derivation resolves `@deepseek-ai/dsh-agent-presets`, a PEER the
 * running harness provides. In a consumer's install it may be absent or a
 * different version, so the assertions that read a real `standard` skip when it
 * is unavailable rather than failing —the fixture-driven cases below cover the
 * logic itself and always run.
 */
const derived = derivedEngComposition()
const liveSource = derived !== undefined
const live = { skip: liveSource ? false : 'no resolvable @deepseek-ai/dsh-agent-presets in this install' }

test('the derivation reads a readable standard composition', live, () => {
  assert.ok(derived !== undefined, 'standard must be resolvable when a peer provides it')
  assert.ok(derived.text.length > 0, 'the derived composition must not be empty')
})

test('the engineering persona replaces the shipped one', live, () => {
  assert.equal(derived.personaApplied, true, 'the persona row must be found and rewritten')
  assert.match(derived.text, /engineering-delivery coding agent/u, 'the persona body must be the engineering one')
  // The shipped prose must be gone, in whichever field the source used.
  assert.doesNotMatch(derived.text, /You are a coding agent powered by the \{\{model\}\} model/u,
    'the shipped persona prose must be replaced, not merely shadowed')
})

test('the derived persona row is well formed and never sets complete', live, () => {
  // Which field is correct depends on the running harness, so assert the SHAPE
  // (a block scalar under `config:`) rather than one field name —the field
  // itself is pinned by the two fixtures below.
  assert.match(derived.text, /- id: persona\n {2}name: '@deepseek-ai\/dsh-persona'\n {2}config:\n(?: {4}suffix: .*\n)? {4}(?:text|prefix): [|>]-/u,
    'the persona row must carry a block scalar under config')
  // `complete: true` would make this prose the ENTIRE system prompt and
  // suppress every other section, silently gutting the agent.
  assert.doesNotMatch(derived.text, /complete: true/u, 'complete must not be set')
})

test('the agent row is appended exactly once', live, () => {
  const matches = derived.text.match(/id: task-engine-agent/gu) ?? []
  assert.equal(matches.length, 1, 'task-engine-agent must appear once')
  assert.match(derived.text, /name: '@godv61\/dsh-task-engine\/agent'/u, 'the row must name the agent entry')
})

test('every top-level row of standard survives the derivation', live, () => {
  // The point of deriving rather than hand-writing: the preset must inherit the
  // harness's whole tool roster, not a remembered subset of it.
  const ids = (text) => (text.match(/^- id: (\S+)$/gmu) ?? []).map(line => line.replace(/^- id: /u, ''))
  const derivedIds = ids(derived.text)
  assert.ok(derivedIds.length > 10, `expected the full roster, saw ${derivedIds.length} rows`)
  assert.ok(derivedIds.includes('persona'), 'persona must be present')
  assert.equal(new Set(derivedIds).size, derivedIds.length, 'row ids must be unique')
})

test('a composition carrying the agent row is recognised as seeded', () => {
  assert.equal(wasSeeded("  - id: task-engine-agent\n    name: 'x'\n"), true, 'the agent row marks a seeded file')
  assert.equal(wasSeeded('- id: persona\n  name: y\n'), false, 'a hand-authored composition is not ours')
})

test('re-deriving is stable: the same standard yields the same text', live, () => {
  // Idempotence is what lets the seed run on every boot without rewriting.
  const again = derivedEngComposition()
  assert.equal(again.text, derived.text, 'two derivations of one source must agree')
})

// The persona plugin renamed `text` to `prefix`/`suffix` in DSH commit 40792330c0
// (2026-09-06, first shipped in dsh-v0.1.3-alpha.2). The two schemas are mutually
// exclusive: a preset written with `prefix` is rejected by an older persona
// plugin with "$.text missing required value", and vice versa. The seed must
// therefore follow whichever field the SOURCE composition uses, which is what
// these two fixtures pin.
const PERSONA_FIXTURE_LEGACY = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    text: >-',
  '      You are a coding agent powered by the {{model}} model.',
  '',
  '- id: agent-instructions',
  "  name: '@deepseek-ai/dsh-agent-instructions'",
  '',
].join('\n')

const PERSONA_FIXTURE_MODERN = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    suffix: Your working directory is {{cwd}}.',
  '    prefix: >-',
  '      You are a coding agent powered by the {{model}} model.',
  '',
  '- id: agent-instructions',
  "  name: '@deepseek-ai/dsh-agent-instructions'",
  '',
].join('\n')

/** Read the scalar keys of a persona row's `config:` mapping. */
function personaConfig(text) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trimEnd() === '- id: persona')
  assert.ok(start >= 0, 'the fixture must carry a persona row')
  let end = start + 1
  while (end < lines.length && !/^- /u.test(lines[end] ?? '')) end++
  const config = {}
  for (const line of lines.slice(start, end)) {
    const match = /^ {4}([a-z]+):(.*)$/u.exec(line)
    if (match !== null) config[match[1]] = match[2].trim()
  }
  return config
}

test('the persona field follows the source schema, both generations', () => {
  assert.equal(personaFieldOf(PERSONA_FIXTURE_LEGACY), 'text', 'a text-based source is detected')
  assert.equal(personaFieldOf(PERSONA_FIXTURE_MODERN), 'prefix', 'a prefix-based source is detected')

  const legacy = applyPersona(PERSONA_FIXTURE_LEGACY, 'ENGINEER')
  assert.equal(legacy.applied, true, 'the legacy persona row is rewritten')
  const legacyConfig = personaConfig(legacy.text)
  assert.equal(legacyConfig.text, '>-', 'the legacy shape keeps `text`, never `prefix`')
  assert.equal(legacyConfig.prefix, undefined, 'no prefix field is introduced for an old harness')

  const modern = applyPersona(PERSONA_FIXTURE_MODERN, 'ENGINEER')
  const modernConfig = personaConfig(modern.text)
  assert.equal(modernConfig.prefix, '>-', 'the modern shape uses `prefix`')
  assert.equal(modernConfig.text, undefined, 'no text field is introduced for a new harness')
  assert.equal(modernConfig.suffix, 'Your working directory is {{cwd}}.', 'the shipped suffix is carried over')
})

test('the rewritten persona row keeps valid indentation for both shapes', () => {
  // A mis-indented `suffix:` under `config:` silently changes the YAML shape,
  // so assert the exact lines rather than trusting the mapping parse alone.
  const modern = applyPersona(PERSONA_FIXTURE_MODERN, 'ENGINEER').text
  assert.match(modern, /- id: persona\n {2}name: '@deepseek-ai\/dsh-persona'\n {2}config:\n {4}suffix: /u,
    'suffix sits at four spaces under config')
  assert.match(modern, /\n {4}prefix: [|>]-\n {6}ENGINEER\n/u, 'prefix and its body are indented correctly')

  const legacy = applyPersona(PERSONA_FIXTURE_LEGACY, 'ENGINEER').text
  assert.match(legacy, /- id: persona\n {2}name: '@deepseek-ai\/dsh-persona'\n {2}config:\n {4}text: [|>]-\n {6}ENGINEER\n/u,
    'the legacy row is indented correctly')
})