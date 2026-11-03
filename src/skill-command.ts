/** Reject obvious success-only programs, without banning legitimate inline assertions or lint commands. */
import { commandName, commandWords } from './command-words.ts'

const literal = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[+-]?\d+(?:\.\d+)?|true|false|null|undefined|None|True|False)`
const literalOnly = new RegExp(`^${literal}$`, 'u')
const printingLiteral = new RegExp(`^(?:console\\.(?:log|info|warn|error)|print)\\(\\s*${literal}(?:\\s*,\\s*${literal})*\\s*\\)$`, 'u')
function obviousNoop(program: string): boolean {
  const body = program.trim()
  return !body || literalOnly.test(body) || printingLiteral.test(body)
    || /^(?:process\.exit|sys\.exit|exit|quit)\(\s*0?\s*\)$/u.test(body)
    || /^__import__\(['"]sys['"]\)\.exit\(\s*0?\s*\)$/u.test(body) || /^void\s+0$/u.test(body)
}
function inspect(words: string[], depth: number): string | undefined {
  if (depth > 4) return '技能命令的外壳转发嵌套过深；请直接运行项目检查命令'
  const name = commandName(words[0])
  if (['echo', 'printf', 'true', ':', 'exit', 'write-output', 'write-host'].includes(name)) return '技能命令必须执行实际检查，不能只打印文字或直接成功退出'
  const shell = ['cmd', 'sh', 'bash', 'powershell', 'pwsh'].includes(name)
  if (shell) {
    const flag = words.findIndex((word, i) => i > 0 && (name === 'cmd' ? /^\/[ck]$/iu : /^-(?:c|command)$/iu).test(word))
    if (flag >= 0) {
      const rest = words.slice(flag + 1)
      if (rest.length === 1) {
        const nested = commandWords(rest[0]!)
        return nested?.length ? inspect(nested, depth + 1) : '技能外壳命令无法解析；请直接运行项目检查脚本'
      }
      return rest.length ? inspect(rest, depth + 1) : '技能外壳命令缺少检查程序'
    }
  }
  if (['node', 'python', 'python3'].includes(name)) {
    for (let i = 1; i < words.length; i++) {
      const word = words[i]!
      const inline = name === 'node' ? /^--(?:eval|print)=(.*)$/su.exec(word)?.[1] : undefined
      const separate = name === 'node' ? ['-e', '--eval', '-p', '--print'].includes(word) : word === '-c'
      const program = inline ?? (separate ? words[i + 1] ?? '' : undefined)
      if (program !== undefined && obviousNoop(program)) return '技能命令是明显的空操作或固定输出；请执行实际断言、lint、类型检查或项目检查脚本'
    }
  }
  return undefined
}
export function skillReceiptProblem(command: string): string | undefined {
  const words = commandWords(command)
  return words?.length ? inspect(words, 0) : '技能命令为空或引号不完整'
}
