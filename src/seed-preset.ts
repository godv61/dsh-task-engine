/**
 * Seed the `eng` preset into the user's `.agent-presets` root on first boot.
 *
 * Installing the bundle must put a pickable "工程化开发引擎" preset in the
 * preset picker without anyone hand-copying a composition. This module copies
 * the currently shipped `standard` preset, swaps its persona for the
 * engineering persona, and appends the `@godv61/dsh-task-engine/agent` row.
 * The copy is idempotent (an existing `eng` is never overwritten), and every
 * edit reads the RUNTIME `standard` directory, so the seed tracks the running
 * harness version instead of pinning a stale tool list.
 *
 * @module dsh-task-engine/seed-preset
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHIPPED_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets'

/** The persona block `standard` ships, in its exact indentation. */
const SHIPPED_PERSONA_BLOCK =
  '    text: >-\n'
  + '      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.\n'

/** The agent-plane row that activates `dev_task` and the shipped skills. */
const AGENT_ROW = "\n- id: task-engine-agent\n  name: '@godv61/dsh-task-engine/agent'\n"

/** The harness home, honouring an explicit override first. */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Create the `eng` preset under `<dshHome>/.agent-presets` if it is absent.
 * Failures are swallowed: a seed that cannot write must not stop the bundle's
 * host half (its Remote controller and workbench) from loading.
 */
export function seedEngPreset(): void {
  const target = join(dshHome(), '.agent-presets', 'eng')
  if (existsSync(join(target, 'agent.cordis.yml'))) return
  try {
    mkdirSync(join(dshHome(), '.agent-presets'), { recursive: true })
    cpSync(join(SHIPPED_PRESET_ROOT, 'standard'), target, { recursive: true })

    const compPath = join(target, 'agent.cordis.yml')
    let comp = readFileSync(compPath, 'utf8')

    const personaPath = fileURLToPath(new URL('../preset/persona.md', import.meta.url))
    const persona = readFileSync(personaPath, 'utf8').trimEnd()
    if (comp.includes(SHIPPED_PERSONA_BLOCK)) {
      const block = '    text: |-\n' + persona.split('\n').map(line => '      ' + line).join('\n') + '\n'
      comp = comp.replace(SHIPPED_PERSONA_BLOCK, block)
    }

    if (!comp.includes("name: '@godv61/dsh-task-engine/agent'")) {
      comp = comp.trimEnd() + '\n' + AGENT_ROW
    }
    writeFileSync(compPath, comp, 'utf8')

    writeFileSync(
      join(target, 'preset.yml'),
      'name: 工程化开发引擎\n'
      + 'description: 通过 dev_task 工具硬性持有需求评审→设计→开发→交付→代码审核的状态机，按项目 .dsh/eng.json 配置流转与提交门禁。\n',
      'utf8',
    )
  } catch {
    // A failed seed is recoverable with `dsh-task-engine-enable`; do not fail boot.
  }
}