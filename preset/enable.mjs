#!/usr/bin/env node
/**
 * One-shot activation helper: copy the shipped `standard` preset to a `eng`
 * preset under `$DSH_HOME/.agent-presets`, swap its persona for the engineering
 * persona, and append the `@godv61/dsh-task-engine/agent` row.
 *
 * Run after `dsh plugin --profile <name> add @godv61/dsh-task-engine`:
 *   node <this-file>
 *
 * The script writes files only under `$DSH_HOME/.agent-presets/eng`; it never
 * touches the shipped preset install.
 */

import { createRequire } from 'node:module'
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** The persona block `standard` ships, in its exact indentation. */
const SHIPPED_PERSONA_BLOCK =
  '    text: >-\n'
  + '      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.\n'

const AGENT_ROW = "\n- id: task-engine-agent\n  name: '@godv61/dsh-task-engine/agent'\n"

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  let shippedRoot
  try {
    ;({ SHIPPED_PRESET_ROOT: shippedRoot } = require('@deepseek-ai/dsh-agent-presets'))
  } catch {
    console.error('未找到 @deepseek-ai/dsh-agent-presets —— 请先执行 dsh plugin --profile <name> add @godv61/dsh-task-engine')
    process.exitCode = 1
    return
  }

  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const source = join(shippedRoot, 'standard')
  const target = join(home, '.agent-presets', 'eng')

  if (await exists(target)) {
    console.error(`预设 "eng" 已存在（${target}），本脚本不会覆盖；请先删除它再重跑，或改用它已有的 agent.cordis.yml。`)
    process.exitCode = 1
    return
  }

  await mkdir(join(home, '.agent-presets'), { recursive: true })
  await cp(source, target, { recursive: true })

  const compPath = join(target, 'agent.cordis.yml')
  let comp = await readFile(compPath, 'utf8')

  const persona = (await readFile(fileURLToPath(new URL('./persona.md', import.meta.url)), 'utf8')).trimEnd()
  if (comp.includes(SHIPPED_PERSONA_BLOCK)) {
    const block = '    text: |-\n' + persona.split('\n').map(line => '      ' + line).join('\n') + '\n'
    comp = comp.replace(SHIPPED_PERSONA_BLOCK, block)
  } else {
    console.warn('未能定位 standard 的 persona 段，跳过 persona 替换（仍会追加 agent 行）。')
  }

  if (!comp.includes("name: '@godv61/dsh-task-engine/agent'")) {
    comp = comp.trimEnd() + '\n' + AGENT_ROW
  }
  await writeFile(compPath, comp, 'utf8')

  await writeFile(
    join(target, 'preset.yml'),
    'name: 工程化开发引擎\n'
    + 'description: 通过 dev_task 工具硬性持有需求评审→设计→开发→交付→代码审核的状态机，按项目 .dsh/eng.json 配置流转与提交门禁。\n',
    'utf8',
  )

  console.log('完成。已创建预设 "eng"：persona 已替换为工程人设，并追加了 @godv61/dsh-task-engine/agent 行。')
  console.log('新建会话时选择「工程化开发引擎」即可激活流程。')
}

await main()