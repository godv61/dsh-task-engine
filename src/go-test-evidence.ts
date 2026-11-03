import { commandName, commandWords } from './command-words.ts'

/** Go package success is not evidence that any test passed. Parse test2json events instead. */
export function goTestEvidence(command: string, output: string): { count: number | null } | undefined {
  const words = commandWords(command)
  if (!words || commandName(words[0]) !== 'go' || words[1] !== 'test') return undefined
  // Plain/verbose summaries cannot reliably distinguish empty suites from passing tests.
  const end = words.findIndex((word, i) => i > 1 && (word === '-args' || word === '--'))
  const args = words.slice(2, end < 0 ? undefined : end)
  if (!args.some(word => word === '-json' || word === '-json=true') || args.includes('-json=false')) return { count: null }
  const packages = new Map<string, string>()
  const passed = new Map<string, string>()
  let seen = false
  for (const line of output.split(/\r?\n/u)) {
    if (!line.trim()) continue
    // Go may emit toolchain diagnostics to stderr, appended separately to stdout by the host.
    if (!line.trimStart().startsWith('{')) {
      if (/^go:/u.test(line)) continue
      return { count: null }
    }
    let value: unknown
    try { value = JSON.parse(line) } catch { return { count: null } }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { count: null }
    const event = value as { Action?: unknown; Package?: unknown; Test?: unknown }
    if (event.Action === 'build-output' || event.Action === 'build-fail') {
      if (event.Action === 'build-fail') return { count: 0 }
      continue
    }
    if (typeof event.Package !== 'string' || !event.Package.trim()
      || !['start', 'run', 'pause', 'cont', 'pass', 'bench', 'fail', 'output', 'skip'].includes(String(event.Action))
      || (event.Test !== undefined && typeof event.Test !== 'string')) return { count: null }
    seen = true
    if (event.Action === 'fail') return { count: 0 }
    if (!packages.has(event.Package)) packages.set(event.Package, 'incomplete')
    if (!event.Test && (event.Action === 'pass' || event.Action === 'skip')) packages.set(event.Package, event.Action)
    if (event.Test && event.Action === 'pass') passed.set(`${event.Package}\0${event.Test}`, event.Package)
  }
  if (!seen || [...packages.values()].some(status => status === 'incomplete')) return { count: null }
  return { count: [...passed.values()].filter(pkg => packages.get(pkg) === 'pass').length }
}
