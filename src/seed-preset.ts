/**
 * Seed the `eng` preset into the user's `.agent-presets` root.
 *
 * Installing the bundle must put a pickable "工程化开发引�? preset in the preset
 * picker without anyone hand-copying a composition. The preset is the shipped
 * `standard` composition with three edits: the persona is replaced by the
 * engineering persona, `task-engine-agent` is appended, and nothing else changes
 * �?so a session on it has every tool `standard` has, plus `dev_task`.
 *
 * The seed DERIVES the composition from the `standard` that is running, and
 * RE-DERIVES it whenever that source moves. The earlier version copied once and
 * then returned early on every later boot, which turned the preset into a frozen
 * snapshot of whatever `standard` looked like the first time:
 *
 *   - DSH 2026-09-06 changed the persona row from `text:` to `prefix`/`suffix`.
 *     A stale copy kept `text:`, which the persona plugin's schema (prefix is
 *     required) rejects outright.
 *   - DSH 2026-09-13 replaced the `workflow-worker-thread` row with
 *     `workflow-ptc`. A stale copy kept the removed row, and because that
 *     package also left `apps/cli`'s dependencies the roster could no longer
 *     resolve it: the preset reported "加载失败" and no new session could use
 *     the task flow at all.
 *
 * Both were invisible until a user upgraded DSH, and both left the preset
 * unusable rather than merely outdated. Re-deriving on every boot makes the
 * preset track its source, and a hand-edited preset is never silently
 * clobbered: any local edit is detected and preserved.
 *
 * @module dsh-task-engine/seed-preset
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The persona row `standard` shipped before 2026-09-06, kept so a preset seeded
 * by an older release can still be recognised and re-derived.
 */
const LEGACY_PERSONA_BLOCK =
  '    text: >-\n'
  + '      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.\n'

/** The persona fragment the seed itself wrote into `eng`, in the old `text:` form. */
const SEEDED_PERSONA_MARKER = '    text: |-\n'
/** The agent-plane row that activates `dev_task` and the shipped skills. */
const AGENT_ROW_ID = 'task-engine-agent'
/** The agent-plane row that activates `dev_task` and the shipped skills. */
const AGENT_ROW = "\n- id: task-engine-agent\n  name: '@godv61/dsh-task-engine/agent'\n"
/** Metadata written beside the composition. */
const PRESET_META =
  'name: 工程化开发引擎\n'
  + 'description: 通过 dev_task 工具硬性持有需求评审→设计→开发→交付→代码审核的状态机，按项目 .dsh/eng.json 配置流转与提交门禁。\n'

/** The harness home, honouring an explicit override first. */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * The shipped `standard` composition this preset derives from, resolved at CALL
 * time from the installed DSH rather than from a build-time constant.
 *
 * `@deepseek-ai/dsh-agent-presets` also exports `SHIPPED_PRESET_ROOT`, but that
 * is `fileURLToPath(new URL('../presets/', import.meta.url))` �?a constant baked
 * into whichever copy of the package the *plugin* resolves. Under a real install
 * that is the plugin's own dependency tree, which can sit at a different DSH
 * version than the one running: the seed then copies an obsolete `standard`,
 * which is exactly how the `eng` preset acquired a row
 * (`workflow-worker-thread`) that the running harness had already replaced with
 * `workflow-ptc`, and a persona in the pre-`prefix` `text:` form the persona
 * plugin now rejects. Resolving from this module's own location follows the
 * host's install graph, so the derived preset matches the harness that will
 * mount it.
 * @returns the absolute `presets` directory, or undefined when unresolvable.
 */
function shippedPresetRoot(): string | undefined {
  try {
    const require_ = createRequire(import.meta.url)
    return join(dirname(require_.resolve('@deepseek-ai/dsh-agent-presets/package.json')), 'presets')
  } catch {
    return undefined
  }
}

/** The shipped `standard` composition this preset derives from. */
function shippedStandard(): string | undefined {
  const root = shippedPresetRoot()
  return root === undefined ? undefined : join(root, 'standard')
}

/** The engineering persona body, read from this package. */
function personaBody(): string {
  return readFileSync(fileURLToPath(new URL('../preset/persona.md', import.meta.url)), 'utf8').trimEnd()
}

/**
 * Which persona config field the RUNNING harness expects.
 *
 * `@deepseek-ai/dsh-persona` renamed `text` to `prefix`/`suffix` in
 * `40792330c0` (2026-09-06, first shipped in `dsh-v0.1.3-alpha.2`). The two
 * schemas are mutually exclusive: a preset written with `prefix` is rejected
 * outright by an older persona plugin with `$.text missing required value`, and
 * `text` is rejected by the newer one. The seed therefore cannot hardcode
 * either name �?it reads which one the source composition already uses, since
 * that composition is what the running harness mounts.
 */
type PersonaField = 'text' | 'prefix'

/** The block-scalar styles a persona row may use, kept verbatim from the source. */
type ScalarStyle = '|-' | '>-' | '|' | '>'

/**
 * Detect the persona field and its block-scalar style from the source's own
 * persona row.
 *
 * The style is part of the value, not decoration: `>-` folds the single
 * newlines inside the payload back into spaces, while `|-` preserves them. The
 * shipped presets all use `>-`, so writing `|-` would silently change how the
 * persona prose renders.
 * @param composition - the `standard` composition text.
 * @returns the field name and scalar style, defaulting to the older `text`/`>-`.
 */
function personaShapeOf(composition: string): { field: PersonaField; style: ScalarStyle } {
  const lines = composition.split('\n')
  const start = lines.findIndex(line => line.trimEnd() === '- id: persona')
  if (start < 0) return { field: 'text', style: '>-' }
  let end = start + 1
  while (end < lines.length && !/^- /u.test(lines[end] ?? '')) end++
  for (const line of lines.slice(start, end)) {
    const match = /^\s+(text|prefix):\s*([|>][-+]?)\s*$/u.exec(line)
    if (match === null) continue
    return { field: match[1] as PersonaField, style: (match[2] ?? '>-') as ScalarStyle }
  }
  return { field: 'text', style: '>-' }
}

/**
 * Detect the persona field from the source composition's own persona row.
 * @param composition - the `standard` composition text.
 * @returns the field name, defaulting to `text` for the pre-2026-09-06 shape.
 */
function personaFieldOf(composition: string): PersonaField {
  return personaShapeOf(composition).field
}

/**
 * Replace the persona row's config with the engineering persona, keeping the
 * field name the running harness uses.
 *
 * The persona schema has moved (`text:` �?`prefix`/`suffix`), so this rewrites
 * the whole `config:` block of the `persona` row rather than matching one
 * historical phrasing, and writes whichever field
 * {@link personaFieldOf} found in the source. A `suffix:` row is preserved when
 * the source had one, because the newer schema renders it after first-party
 * guidance and dropping it would change the system prompt's shape.
 * @param composition - the `standard` composition text.
 * @param persona - the engineering persona prose.
 * @returns the rewritten text plus whether the row was found.
 */
function applyPersona(composition: string, persona: string): { text: string; applied: boolean } {
  const lines = composition.split('\n')
  const start = lines.findIndex(line => line.trimEnd() === '- id: persona')
  if (start < 0) return { text: composition, applied: false }
  // The row ends at the next top-level entry.
  let end = start + 1
  while (end < lines.length && !/^- /u.test(lines[end] ?? '')) end++

  // Keep the row's identity lines (`- id`, `  name:`); drop only its config.
  const header = lines.slice(start, end).filter(line => !/^\s{2,}config:/u.test(line) && !/^\s{4,}\S/u.test(line))
  const { field, style } = personaShapeOf(composition)
  // The shipped suffix names the working directory; carry it over verbatim.
  const suffixLine = lines.slice(start, end).find(line => /^\s+suffix:/u.test(line))
  const indented = persona.split('\n').map(line => (line === '' ? '' : `      ${line}`))
  // `complete` is deliberately NOT set: it would make this prose the entire
  // system prompt, suppressing the suffix and every other section.
  const config = [
    '  config:',
    // Carry the shipped suffix verbatim under `config:`, keeping its own
    // indentation: it names the working directory and the newer persona schema
    // renders it after first-party guidance.
    ...(field === 'prefix' && suffixLine !== undefined ? [`    ${suffixLine.trim()}`] : []),
    `    ${field}: ${style}`,
    ...indented,
  ]
  const body = [...header.filter(line => line !== ''), ...config]
  return { text: [...lines.slice(0, start), ...body, ...lines.slice(end)].join('\n'), applied: true }
}

/** Append the agent row when the composition does not already name it. */
function applyAgentRow(composition: string): string {
  if (composition.includes(`id: ${AGENT_ROW_ID}`)) return composition
  return composition.trimEnd() + '\n' + AGENT_ROW
}

/**
 * Whether an existing `eng` composition is one this package previously seeded,
 * as opposed to something the user has since edited by hand. Only a previously
 * seeded preset is re-derived; a hand-edited one is left exactly as it is.
 * @param composition - the existing composition text.
 * @returns true when the seed owns the file.
 */
function wasSeeded(composition: string): boolean {
  return composition.includes(`id: ${AGENT_ROW_ID}`)
}

/**
 * Build the `eng` composition from the running `standard`.
 * @returns the composition text, or undefined when `standard` cannot be read.
 */
function deriveComposition(): { text: string; personaApplied: boolean } | undefined {
  const standard = shippedStandard()
  if (standard === undefined) return undefined
  let source: string
  try {
    source = readFileSync(join(standard, 'agent.cordis.yml'), 'utf8')
  } catch {
    return undefined
  }
  const persona = applyPersona(source, personaBody())
  return { text: applyAgentRow(persona.text), personaApplied: persona.applied }
}

/**
 * Create or refresh the `eng` preset under `<dshHome>/.agent-presets`.
 *
 * Failures are swallowed: a seed that cannot write must not stop the bundle's
 * host half (its Remote controller and workbench) from loading. A preset that
 * was deleted by the user stays deleted �?re-derivation only touches a file the
 * seed itself created.
 */
export function seedEngPreset(): void {
  const target = join(dshHome(), '.agent-presets', 'eng')
  const compositionPath = join(target, 'agent.cordis.yml')
  try {
    const derived = deriveComposition()
    if (derived === undefined) return // no readable `standard`: leave any existing preset alone

    if (existsSync(compositionPath)) {
      const existing = readFileSync(compositionPath, 'utf8')
      if (!wasSeeded(existing)) return // hand-authored: never clobber
      if (existing === derived.text) return // already current
      writeFileSync(compositionPath, derived.text, 'utf8')
      writeFileSync(join(target, 'preset.yml'), PRESET_META, 'utf8')
      return
    }

    mkdirSync(join(dshHome(), '.agent-presets'), { recursive: true })
    // Copy the source directory so any future companion file travels with it,
    // then overwrite the composition with the derived text.
    const source = shippedStandard()
    if (source !== undefined) cpSync(source, target, { recursive: true })
    writeFileSync(compositionPath, derived.text, 'utf8')
    writeFileSync(join(target, 'preset.yml'), PRESET_META, 'utf8')
  } catch {
    // A failed seed is recoverable with `dsh-task-engine-enable`; do not fail boot.
  }
}

/**
 * The composition text this package would seed right now. Exported for the
 * package's own verification, so the derivation can be asserted without booting
 * a harness.
 * @returns the derived composition, or undefined when `standard` is unreadable.
 */
export function derivedEngComposition(): { text: string; personaApplied: boolean } | undefined {
  return deriveComposition()
}

/** Exported for tests: whether a composition is one this seed owns. */
export { wasSeeded }

/**
 * Exported for tests: apply the persona rewrite to an arbitrary composition, so
 * both persona schema generations can be asserted without swapping harnesses.
 */
export { applyPersona, personaFieldOf, personaShapeOf }

/** Exported for tests: the pre-2026-09-06 persona phrasing this seed must still recognise. */
export { LEGACY_PERSONA_BLOCK, SEEDED_PERSONA_MARKER }