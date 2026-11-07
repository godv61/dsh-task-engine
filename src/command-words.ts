/** Split one already syntax-checked command without executing it or expanding variables. */
export function commandWords(command: string): string[] | undefined {
  const words: string[] = []
  let word = '', quote = '', active = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote) {
      if (char === quote) quote = ''
      else if (quote === '"' && char === '\\' && command[i + 1] === '"') { word += '"'; i++ }
      else word += char
      active = true
    } else if (char === '"' || char === "'") { quote = char; active = true }
    else if (/\s/u.test(char)) { if (active) { words.push(word); word = ''; active = false } }
    else { word += char; active = true }
  }
  if (quote) return undefined
  if (active) words.push(word)
  return words
}
export function commandName(word: string | undefined): string {
  const parts = (word ?? '').replace(/\\/gu, '/').split('/')
  return parts[parts.length - 1]!.replace(/\.(?:exe|cmd|bat)$/iu, '').toLowerCase()
}

/** The program a command ends up executing, after the wrappers that only forward it. */
export interface Invocation {
  /** Lower-cased program name, without a directory or `.exe`/`.cmd`/`.bat` suffix. */
  program: string
  /** The program token as written, quotes removed, so a path stays a path. */
  token: string
  argv: string[]
  /** The token names a path (a separator or a binary extension) rather than a PATH lookup. */
  pathLike: boolean
  /** How many shell wrappers (`sh -c`, `cmd /c`, …) were removed before reaching the program. */
  shellDepth: number
}

/** Programs that only run the command they are given, so the real program sits behind them. */
const shellPrograms = new Set(['cmd', 'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'pwsh', 'powershell'])
const pathLikeToken = (word: string): boolean => /[\\/]/u.test(word) || /\.(?:exe|out|bin)$/iu.test(word)
const assignment = (word: string | undefined): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word ?? '')

/** The inline command a shell was asked to run; a shell without one runs nothing we can name. */
function shellBody(shell: string, argv: string[]): string | undefined {
  const isBodyFlag = (word: string): boolean => {
    if (shell === 'cmd') return /^[/-]c$/iu.test(word)
    if (shell === 'powershell' || shell === 'pwsh') return /^-(?:c|command)$/iu.test(word)
    return /^-[A-Za-z]*c[A-Za-z]*$/u.test(word)
  }
  const index = argv.findIndex(isBodyFlag)
  if (index < 0) return undefined
  const body = argv.slice(index + 1)
  return body.length ? body.join(' ') : undefined
}

function resolve(words: string[], depth: number): Invocation | undefined {
  if (depth > 4) return undefined
  let index = 0
  for (;;) {
    while (index < words.length && assignment(words[index])) index++
    const prefix = commandName(words[index])
    // `env`/`timeout`/`nice`/`nohup`/`command`/`exec`/`stdbuf` only choose how to run the next program.
    if (prefix === 'env') {
      index++
      while (index < words.length) {
        if (assignment(words[index])) index++
        else if (['-i', '--ignore-environment', '-0', '--null', '-v', '--debug'].includes(words[index]!)) index++
        else if (words[index] === '-u' || words[index] === '--unset') index += 2
        else break
      }
      continue
    }
    if (prefix === 'nice') {
      index++
      if (words[index] === '-n') index += 2
      else if (/^-\d+$/u.test(words[index] ?? '')) index++
      continue
    }
    if (prefix === 'timeout') {
      index++
      while (index < words.length && /^-/u.test(words[index]!)) index++
      index++ // the duration operand
      continue
    }
    if (['nohup', 'command', 'exec', 'stdbuf'].includes(prefix)) {
      index++
      while (index < words.length && /^-/u.test(words[index]!)) index++
      continue
    }
    break
  }
  const token = words[index]
  if (token === undefined) return undefined
  const program = commandName(token)
  if (shellPrograms.has(program)) {
    const body = shellBody(program, words.slice(index + 1))
    const nested = body === undefined ? undefined : commandWords(body)
    if (!nested?.length) return undefined
    const inner = resolve(nested, depth + 1)
    return inner ? { ...inner, shellDepth: inner.shellDepth + 1 } : undefined
  }
  return { program, token, argv: words.slice(index + 1), pathLike: pathLikeToken(token), shellDepth: 0 }
}

/** Resolve the program a command really runs, skipping assignments, wrappers and shell layers. */
export function invokedProgram(command: string): Invocation | undefined {
  const words = commandWords(command)
  return words?.length ? resolve(words, 0) : undefined
}
