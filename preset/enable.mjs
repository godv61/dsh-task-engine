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

import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyPersona, PRESET_META, shippedStandard } from '../lib/seed-preset.js'

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
  const source = shippedStandard()
  if (!source) {
    console.error('未找到 @deepseek-ai/dsh-agent-presets —— 请先执行 dsh plugin --profile <name> add @godv61/dsh-task-engine')
    process.exitCode = 1
    return
  }

  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const target = join(home, '.agent-presets', 'eng')

  if (await exists(target)) {
    console.error(`预设 "eng" 已存在（${target}），本脚本不会覆盖；请先删除它再重跑，或改用它已有的 agent.cordis.yml。`)
    process.exitCode = 1
    return
  }

  let comp = await readFile(join(source, 'agent.cordis.yml'), 'utf8')

  const persona = (await readFile(fileURLToPath(new URL('./persona.md', import.meta.url)), 'utf8')).trimEnd()
  const rewritten = applyPersona(comp, persona)
  if (!rewritten.applied) throw new Error('standard 预设没有可识别的 persona；停止创建以避免不完整的预设')
  comp = rewritten.text

  if (!comp.includes("name: '@godv61/dsh-task-engine/agent'")) {
    comp = comp.trimEnd() + '\n' + AGENT_ROW
  }
  await mkdir(join(home, '.agent-presets'), { recursive: true })
  await cp(source, target, { recursive: true })
  const compPath = join(target, 'agent.cordis.yml')
  await writeFile(compPath, comp, 'utf8')

  await writeFile(join(target, 'preset.yml'), PRESET_META, 'utf8')

  console.log('完成。已创建预设 "eng"：persona 已替换为工程人设，并追加了 @godv61/dsh-task-engine/agent 行。')
  console.log('新建会话时选择「工程化开发引擎」即可激活流程。')
}

await main()
