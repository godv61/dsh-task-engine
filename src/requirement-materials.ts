/** Task-owned text materials. No shell execution, business paths or implied approval. */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { TaskState } from './engine.ts'
import { assertInsideRoot } from './path-guard.ts'
import { assertRealPath } from './resource-import.ts'
import { hashText } from './snapshot.ts'
import { readText, writeText, writeTask } from './task-store.ts'
import { invalidateRequirement, materialRelativePath, requirementMaterialPath, requirementConfirmed, requirementsView, type RequirementMaterial } from './requirements.ts'

export const MATERIAL_MAX_BYTES = 1024 * 1024
export interface MaterialTemplate {
  skill_name: string; path: string; data_id: string; json: string; identity_field?: string
}
export interface MaterialArgs {
  material_name?: string; material_content?: string; material_template?: MaterialTemplate; expected_hash?: string
}
export interface MaterialEnvironment {
  fs: Context['fs']; state: TaskState; cwd: string | undefined
  writeMode(): Promise<'workspace-write' | 'danger-full-access'>
  readTemplate(template: MaterialTemplate): Promise<string>
}

function sizeCheck(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MATERIAL_MAX_BYTES) throw new Error('单份需求材料不能超过 1 MiB')
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]))
  return value
}
async function probe(fs: Context['fs'], root: string, path: string): Promise<{ type?: string; version: unknown } | undefined> {
  assertInsideRoot(root, root, path)
  assertRealPath(resolve(root, path))
  let parent = ''
  for (const part of path.split('/').slice(0, -1)) {
    parent = parent ? `${parent}/${part}` : part
    const info = await fs.lstat(parent, { cwd: root })
    if (info && info.type !== 'directory') throw new Error('需求材料的父路径不是普通目录：' + parent)
  }
  const info = await fs.lstat(path, { cwd: root })
  if (info && info.type !== 'file') throw new Error('需求材料不是普通文件：' + path)
  return info
}

/** Only application/json script data is replaced; the template is never executed. */
export function renderMaterialTemplate(template: string, spec: MaterialTemplate, materialId: string): string {
  sizeCheck(template); sizeCheck(spec.json)
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(spec.data_id)) throw new Error('data_id 必须是普通 HTML 元素标识')
  let data: unknown
  try { data = JSON.parse(spec.json) } catch { throw new Error('material_template.json 必须是合法 JSON') }
  if (spec.identity_field !== undefined) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(spec.identity_field) || ['__proto__', 'constructor', 'prototype'].includes(spec.identity_field)
      || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('identity_field 需要 JSON 对象及普通顶层字段名')
    ;(data as Record<string, unknown>)[spec.identity_field] = materialId
  }
  const blocks = [...template.matchAll(/(<script\b(?:"[^"]*"|'[^']*'|[^'">])*>)([\s\S]*?)(<\/script\s*>)/giu)]
  const selected = blocks.filter(match => /\sid\s*=\s*(["'])(.*?)\1/iu.exec(match[1]!)?.[2] === spec.data_id)
  if (selected.length !== 1 || !/\stype\s*=\s*(["'])application\/json\1/iu.test(selected[0]![1]!))
    throw new Error('模板需要恰好一个指定 id 的 application/json script 数据区')
  const block = selected[0]!, start = block.index! + block[1]!.length
  const json = JSON.stringify(canonical(data), null, 2).replace(/[<>&\u2028\u2029]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return template.slice(0, start) + '\n' + json + '\n' + template.slice(start + block[2]!.length)
}

export async function requirementMaterialProblem(fs: Context['fs'], state: TaskState, cwd?: string): Promise<string | undefined> {
  const root = state.root ?? cwd ?? ''
  for (const material of state.requirements?.materials ?? []) {
    if (material.retired_at) continue
    try {
      if (material.path !== requirementMaterialPath(state, material.name)) return '需求材料登记路径不合法'
      await probe(fs, root, material.path)
      const raw = await readText(fs, material.path, root)
      if (raw === undefined || hashText(raw) !== material.hash) return `需求材料已变更或丢失：${material.path}；请核对材料并重新生成、确认需求总结`
    } catch { return `需求材料路径不可用：${material.path}；请核对后再确认需求` }
  }
  return undefined
}

export async function writeRequirementMaterial(args: MaterialArgs, env: MaterialEnvironment): Promise<string> {
  const { state, fs } = env, root = state.root ?? env.cwd ?? ''
  const name = args.material_name ?? '', path = requirementMaterialPath(state, name)
  if ((args.material_content === undefined) === (args.material_template === undefined)) throw new Error('material_content 和 material_template 必须且只能提供一种')
  let content: string, source: RequirementMaterial['template'], id: string
  if (args.material_template) {
    const spec = args.material_template
    materialRelativePath(spec.path)
    if (!spec.path.startsWith('assets/') || !/\.html?$/iu.test(spec.path) || !/\.html?$/iu.test(name)) throw new Error('HTML 模板必须来自已加载 Skill 的 assets/*.html 或 *.htm，输出也须是 HTML')
    const template = await env.readTemplate(spec)
    sizeCheck(spec.json)
    let json: unknown
    try { json = JSON.parse(spec.json) } catch { throw new Error('material_template.json 必须是合法 JSON') }
    id = `${state.id}--${hashText(JSON.stringify([path, template, spec.skill_name, spec.path, spec.data_id, canonical(json), spec.identity_field ?? null])).slice(0, 16)}`
    content = renderMaterialTemplate(template, spec, id)
    source = { skill_name: spec.skill_name, path: spec.path, hash: hashText(template), data_id: spec.data_id }
  } else {
    content = args.material_content!
    id = `${state.id}--${hashText(JSON.stringify([path, content])).slice(0, 16)}`
  }
  // The host filesystem stores LF-normalized text; fingerprint those exact bytes.
  content = content.replace(/\r\n/gu, '\n')
  if (!content.trim()) throw new Error('需求材料正文不能为空')
  sizeCheck(content)
  if (/\.json$/iu.test(name)) { try { JSON.parse(content) } catch { throw new Error('JSON 需求材料必须是合法 JSON') } }
  const previous = state.requirements?.materials?.find(m => m.path.toLowerCase() === path.toLowerCase())
  if (previous && previous.path !== path) throw new Error('请使用已登记材料路径的原始大小写')
  if (previous?.retired_at) throw new Error('这份材料已停用并保留原稿；请使用新版本文件名')
  const info = await probe(fs, root, path), existing = await readText(fs, path, root)
  if ((info && existing === undefined) || (existing !== undefined && (!previous || hashText(existing) !== previous.hash)))
    throw new Error('目标材料已有未登记内容或人工修改；使用新文件名保留原稿，不会覆盖')
  const hash = hashText(content), unchanged = previous?.hash === hash
  if (unchanged && existing === content) return JSON.stringify({ material: previous, reused: true, requirement: requirementsView(state) })
  if (!unchanged && requirementConfirmed(state, state.flow!.config)) throw new Error('本版需求已确认；先 revise revision_kind=requirement，再修订需求材料')
  if (previous && !unchanged && args.expected_hash !== previous.hash) throw new Error('修改已登记材料需要 expected_hash=当前材料指纹；先 status 核对或使用新版本文件名')
  if (!previous && (state.requirements?.materials?.length ?? 0) >= 64) throw new Error('每个任务最多登记 64 份需求材料')
  const mode = await env.writeMode()
  await writeText(fs, path, content, root, mode, info ? { kind: 'replaceIfVersion', version: info.version } : { kind: 'createIfAbsent' })
  if (await readText(fs, path, root) !== content) throw new Error('材料写入后内容核对失败；未登记产物，请保留文件并检查宿主写入结果')
  const material: RequirementMaterial = unchanged ? previous! : { name, path, id, hash, bytes: Buffer.byteLength(content, 'utf8'),
    version: (previous?.version ?? 0) + 1, updated_at: new Date().toISOString(), ...(source ? { template: source } : {}) }
  state.requirements ??= { clarifications: [] }
  if (!unchanged) {
    state.requirements.materials = [...(state.requirements.materials ?? []).filter(m => m.path !== path), material]
    invalidateRequirement(state)
  }
  try { await writeTask(fs, state, env.cwd, mode) }
  catch (error) { throw new Error(`材料文件已保存于 ${path}，但登记失败；保留该文件并刷新任务后处理：${error instanceof Error ? error.message : String(error)}`) }
  return JSON.stringify({ material, restored: unchanged, requirement: requirementsView(state),
    next_action: '把材料交给相应负责人填写或审阅；答复用于完善需求字段，随后 prepare_requirement 和 confirm_requirement。生成材料或填写完整不代表需求获批。' })
}

/** Stop using an obsolete/missing material without deleting or overwriting any file. */
export async function retireRequirementMaterial(args: MaterialArgs, env: MaterialEnvironment): Promise<string> {
  const { state } = env, path = requirementMaterialPath(state, args.material_name ?? '')
  const material = state.requirements?.materials?.find(m => m.path === path)
  if (!material || args.expected_hash !== material.hash) throw new Error('停用材料需要已登记的 material_name 和当前 expected_hash')
  if (material.retired_at) return JSON.stringify({ material, reused: true, requirement: requirementsView(state) })
  if (requirementConfirmed(state, state.flow!.config)) throw new Error('本版需求已确认；先 revise revision_kind=requirement，再停用材料')
  material.retired_at = new Date().toISOString()
  invalidateRequirement(state)
  await writeTask(env.fs, state, env.cwd, await env.writeMode())
  return JSON.stringify({ material, file_preserved: true, requirement: requirementsView(state),
    next_action: '原文件及登记记录保留，已从本期确认依据移除；如需替换请生成新材料，再重新 prepare_requirement 和 confirm_requirement。' })
}
