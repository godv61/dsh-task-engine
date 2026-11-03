#!/usr/bin/env node
/** Render the supplied template without changing its UI; validate returned answers. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const templatePath = fileURLToPath(new URL('../assets/confirmation-checklist-v1.html', import.meta.url))
const dataBlock = /(<script\b[^>]*\bid="card-data"[^>]*>)([\s\S]*?)(<\/script\s*>)/giu
const kinds = new Set(['逻辑冲突', '逻辑遗漏', '材料不对齐', '原型与文档冲突', '其他'])
const text = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须为非空文字`)
  return value.trim()
}
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须为对象`)
  return value
}
function keys(value, allowed, field) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${field} 包含未支持字段 ${key}`)
}
function pairs(value, field) {
  if (!Array.isArray(value) || !value.length) throw new Error(`${field} 必须为非空数组`)
  return value.map((entry, i) => {
    object(entry, `${field}[${i}]`)
    const names = field.endsWith('sources') ? ['label', 'text'] : ['title', 'text']
    keys(entry, names, field)
    return Object.fromEntries(names.map(name => [name, text(entry[name], `${field}[${i}].${name}`)]))
  })
}

export function prepareData(input) {
  object(input, '清单')
  keys(input, ['task_id', 'revision', 'title', 'questions'], '清单')
  if (!Array.isArray(input.questions) || !input.questions.length) throw new Error('没有待确认问题时无需生成空清单')
  const base = {
    task_id: text(input.task_id, 'task_id'), revision: text(input.revision, 'revision'), title: text(input.title, 'title'),
    questions: input.questions.map((item, i) => {
      object(item, `questions[${i}]`)
      keys(item, ['kind', 'question', 'evidence', 'need', 'options', 'recommendation', 'sources'], `questions[${i}]`)
      if (!kinds.has(item.kind)) throw new Error(`questions[${i}].kind 不在模板支持范围内`)
      if (item.options !== undefined && item.recommendation !== undefined) throw new Error('同一题的 options 和 recommendation 只选一种')
      return { kind: item.kind, question: text(item.question, 'question'), evidence: text(item.evidence, 'evidence'), need: text(item.need, 'need'),
        ...(item.options !== undefined ? { options: pairs(item.options, `questions[${i}].options`) } : {}),
        ...(item.recommendation !== undefined ? { recommendation: text(item.recommendation, 'recommendation') } : {}),
        ...(item.sources !== undefined ? { sources: pairs(item.sources, `questions[${i}].sources`) } : {}) }
    })
  }
  if (new Set(base.questions.map(q => q.question)).size !== base.questions.length) throw new Error('存在重复题目，请合并同一个决定')
  const checklist_hash = createHash('sha256').update(JSON.stringify(base)).digest('hex')
  return { ...base, engine_task_id: base.task_id, task_id: `${base.task_id}--${checklist_hash.slice(0, 16)}`, checklist_hash }
}

export function embeddedData(html) {
  const matches = [...html.matchAll(dataBlock)]
  if (matches.length !== 1) throw new Error('HTML 必须恰有一个 card-data 数据区')
  return JSON.parse(matches[0][2])
}

export function render(input, template = readFileSync(templatePath, 'utf8')) {
  const data = prepareData(input)
  if ([...template.matchAll(dataBlock)].length !== 1) throw new Error('模板必须恰有一个 card-data 数据区')
  const json = JSON.stringify(data, null, 2).replace(/[<>&\u2028\u2029]/gu,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return { data, html: template.replace(dataBlock, (_match, open, _old, close) => `${open}\n${json}\n${close}`) }
}

export function checkAnswers(html, response) {
  const data = embeddedData(html)
  const expected = prepareData({ task_id: data.engine_task_id, revision: data.revision, title: data.title, questions: data.questions })
  if (data.checklist_hash !== undefined) {
    if (data.task_id !== expected.task_id || data.checklist_hash !== expected.checklist_hash) throw new Error('清单内容或版本指纹不一致，请找到对应的原稿')
  } else if (typeof data.task_id !== 'string' || !data.task_id.startsWith(data.engine_task_id + '--')
    || !/--[a-f0-9]{16}$/u.test(data.task_id)) throw new Error('缺少宿主材料标识，请找到插件生成的对应版本')
  object(response, '答复')
  if (response.task_id !== data.task_id) throw new Error('答复属于其他任务或清单版本，不能套用')
  if (!Array.isArray(response.answers) || response.answers.length !== data.questions.length) throw new Error('答复数量不匹配')
  const seen = new Set()
  const answers = response.answers.map(answer => {
    object(answer, 'answer')
    if (!Number.isInteger(answer.index) || answer.index < 1 || answer.index > data.questions.length || seen.has(answer.index)) throw new Error('题目序号缺失、重复或越界')
    seen.add(answer.index)
    const question = data.questions[answer.index - 1]
    if (answer.question !== question.question || answer.kind !== question.kind) throw new Error(`第 ${answer.index} 题不匹配，可能使用了旧清单`)
    return { index: answer.index, question: question.question, answer: text(answer.answer, `第 ${answer.index} 题 answer`) }
  }).sort((a, b) => a.index - b.index)
  return { status: 'answers-structurally-valid', task_id: data.engine_task_id, checklist_id: data.task_id, revision: data.revision,
    note: '仅核对本版题目及非空答复；不证明答复人身份、业务完整性或最终需求批准。', answers }
}

function writeNew(path, content) {
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === content) return 'reused'
    throw new Error('目标文件已有不同内容；使用新版本文件名，保留已有稿件')
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' })
  return 'created'
}

function main(argv) {
  const [command, ...rest] = argv
  const allowed = command === 'render' ? ['--data', '--output'] : command === 'check-answers' ? ['--checklist', '--answers'] : []
  const args = {}
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--') || args[rest[i]]) throw new Error('参数无效或重复')
    args[rest[i]] = rest[i + 1]
  }
  if (!allowed.length || allowed.some(key => !args[key])) throw new Error('用法：render --data 清单.json --output 清单.html；check-answers --checklist 清单.html --answers 确认结果.json')
  if (command === 'render') {
    const { html, data } = render(readJson(args['--data']))
    const output = resolve(args['--output'])
    const status = writeNew(output, html)
    console.log(JSON.stringify({ status, output, task_id: data.engine_task_id, checklist_id: data.task_id, revision: data.revision, questions: data.questions.length }))
  } else console.log(JSON.stringify(checkAnswers(readFileSync(args['--checklist'], 'utf8'), readJson(args['--answers'])), null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
