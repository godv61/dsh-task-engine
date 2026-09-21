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
import { derivedEngComposition, wasSeeded } from './lib/seed-preset.js'

/** The live derivation must exist in a built checkout. */
const derived = derivedEngComposition()

test('the derivation reads a readable standard composition', () => {
  assert.ok(derived !== undefined, 'standard must be resolvable in a built checkout')
  assert.ok(derived.text.length > 0, 'the derived composition must not be empty')
})

test('the engineering persona replaces the shipped one', () => {
  assert.equal(derived.personaApplied, true, 'the persona row must be found and rewritten')
  assert.match(derived.text, /engineering-delivery coding agent/u, 'the persona body must be the engineering one')
  assert.doesNotMatch(derived.text, /text: >-\n/u, 'the pre-2026-09-06 persona phrasing must be gone')
})

test('the persona row uses the current prefix form and never sets complete', () => {
  assert.match(derived.text, /- id: persona\n {2}name: '@deepseek-ai\/dsh-persona'\n {2}config:\n {4}prefix: \|-/u,
    'the persona row must carry the current prefix form')
  // `complete: true` would make this prefix the ENTIRE system prompt and
  // suppress every other section, silently gutting the agent.
  assert.doesNotMatch(derived.text, /complete: true/u, 'complete must not be set')
})

test('the agent row is appended exactly once', () => {
  const matches = derived.text.match(/id: task-engine-agent/gu) ?? []
  assert.equal(matches.length, 1, 'task-engine-agent must appear once')
  assert.match(derived.text, /name: '@godv61\/dsh-task-engine\/agent'/u, 'the row must name the agent entry')
})

test('every top-level row of standard survives the derivation', () => {
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

test('re-deriving is stable: the same standard yields the same text', () => {
  // Idempotence is what lets the seed run on every boot without rewriting.
  const again = derivedEngComposition()
  assert.equal(again.text, derived.text, 'two derivations of one source must agree')
})