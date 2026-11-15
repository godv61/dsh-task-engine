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

/** The program a command actually invokes. A shell wrapper is not unwrapped: its first word is the shell. */
export interface Invocation { program: string; argv: string[] }

export function invokedProgram(command: string): Invocation | undefined {
  const words = commandWords(command)
  if (!words?.length) return undefined
  return { program: words[0]!, argv: words.slice(1) }
}

/** Strip trailing version digits so `python3.11`, `python` and `php8` compare as the same family. */
export function programFamily(name: string): string {
  return name.replace(/\d+(?:\.\d+)*$/u, '')
}
