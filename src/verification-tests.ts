import { goTestEvidence } from './go-test-evidence.ts'
import { skillReceiptProblem } from './skill-command.ts'
import { commandName, commandWords, invokedProgram } from './command-words.ts'
import type { Invocation } from './command-words.ts'

/** Python's standard-library runner, with a completed final summary on stderr. */
export function unittestTestEvidence(command: string, output: string): { count: number | null } | undefined {
  const words = commandWords(command)
  if (!words) return undefined
  const name = commandName(words[0])
  if (!/^python(?:\d+(?:\.\d+)*)?$/u.test(name) && name !== 'py') return undefined
  let index = 1
  if (name === 'py' && /^-\d+(?:\.\d+)*$/u.test(words[index] ?? '')) index++
  while (['-B', '-E', '-I', '-O', '-OO', '-s', '-S', '-u'].includes(words[index] ?? '')) index++
  if (words[index] !== '-m' || words[index + 1] !== 'unittest') return undefined
  const summary = output.replace(/\r\n/gu, '\n').trimEnd()
    .match(/(?:^|\n)Ran (\d+) tests? in \d+(?:\.\d+)?s\n\n(OK|FAILED|NO TESTS RAN)(?: \(([^\n]*)\))?$/u)
  if (!summary) return { count: null }
  if (summary[2] === 'FAILED') return { count: 0 }
  const total = Number(summary[1])
  if (summary[2] === 'NO TESTS RAN') return { count: total === 0 ? 0 : null }
  let excluded = 0
  for (const field of summary[3]?.split(',') ?? []) {
    const counter = field.trim().match(/^(?:skipped|expected failures)=(\d+)$/u)
    if (!counter) return { count: null }
    excluded += Number(counter[1])
  }
  return { count: Number.isSafeInteger(total) && Number.isSafeInteger(excluded) && excluded <= total ? total - excluded : null }
}

/** Commands that only print text and can therefore forge a runner summary. */
const outputOnlyCommands = new Set([
  'echo', 'printf', 'cat', 'tee', 'head', 'tail', 'sed', 'awk', 'grep', 'rg', 'cut', 'tr',
  'sort', 'uniq', 'find', 'ls', 'pwd', 'xxd', 'od', 'strings', 'base64', 'true', 'false', ':',
])

/** Runners with their own evidence parser; their output markers are not GoogleTest. */
const runnerCommands = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'python', 'python3', 'py', 'pytest',
  'go', 'cargo', 'mvn', 'mvnw', 'gradle', 'gradlew', 'dotnet', 'java', 'dart', 'flutter',
  'ruby', 'rake', 'php', 'phpunit', 'composer', 'make', 'ninja', 'cmake', 'msbuild',
])

/** Programs that only read existing text, so a stored log is never fresh test evidence. */
const readerCommands = new Set([
  'type', 'more', 'findstr', 'get-content', 'gc', 'select-string', 'sls', 'get-item', 'gi',
  'dir', 'cp', 'copy', 'mv', 'move', 'del', 'erase', 'where', 'which', 'diff', 'cmp', 'jq',
])

/** Interpreted wrappers: their names look like a program, but the printed text is theirs. */
const scriptExtensions = new Set([
  'sh', 'bash', 'zsh', 'ps1', 'cmd', 'bat', 'py', 'rb', 'pl', 'js', 'mjs', 'cjs', 'ts', 'jar',
])

/**
 * GoogleTest is a compiled binary, so its markers count only when the command runs one:
 * a path-named program, reached without a shell, a printer, a reader or another runner.
 */
function isGoogleTestInvocation(inv: Invocation): boolean {
  if (inv.shellDepth > 0 || !inv.pathLike) return false
  if (outputOnlyCommands.has(inv.program) || runnerCommands.has(inv.program) || readerCommands.has(inv.program)) return false
  const extension = inv.token.replace(/\\/gu, '/').split('/').pop()?.match(/\.([^./]+)$/u)?.[1]?.toLowerCase()
  return extension === undefined || !scriptExtensions.has(extension)
}

/** CTest prints "N% tests passed, M tests failed out of T" only when M > 0. */
export function ctestEvidence(output: string): { count: number | null } {
  const text = output.replace(/\r\n/gu, '\n')
  if (/no tests were found/iu.test(text)) return { count: 0 }
  const summary = text.match(/(\d+)%\s+tests?\s+passed(?:,\s*(\d+)\s+tests?\s+failed)?\s+out\s+of\s*(\d+)/iu)
  if (!summary) return { count: null }
  const failed = Number(summary[2] ?? 0)
  const total = Number(summary[3])
  if (!Number.isSafeInteger(total) || total < 0) return { count: null }
  if (failed > 0) return { count: 0 }
  // `***Skipped` marks a case that did not run; a fully skipped suite is not passing evidence.
  const skipped = text.match(/\*\*\*Skipped\b/gu)?.length ?? 0
  return { count: Math.max(0, total - skipped) }
}

/** GoogleTest's own final summary; a fully skipped suite reports zero passed tests. */
export function gtestEvidence(output: string): { count: number | null } | null {
  const text = output.replace(/\r\n/gu, '\n')
  const ran = text.match(/\[\s*=+\s*\]\s*(\d+)\s+tests?\s+from\s+(\d+)\s+test\s+suite(?:s)?\s+ran\./iu)
  if (!ran) return null
  const total = Number(ran[1])
  if (total === 0 || Number(ran[2]) === 0) return { count: 0 }
  if (/\[\s*FAILED\s*\]/iu.test(text)) return { count: 0 }
  const passed = text.match(/\[\s*PASSED\s*\]\s*(\d+)\s+tests?/iu)
  if (!passed) return { count: null }
  // Real GoogleTest keeps skipped cases out of `[  PASSED  ]`; a suite that skipped
  // everything must still report zero even if a build counts them together.
  const skipped = Number(text.match(/\[\s*SKIPPED\s*\]\s*(\d+)\s+tests?/iu)?.[1] ?? 0)
  if (skipped >= total) return { count: 0 }
  return { count: Number(passed[1]) }
}

/**
 * CTest / GoogleTest evidence, so C/C++ suites can cross the verification gate.
 * A quoted Windows path ("C:\Program Files\CMake\bin\ctest.exe") is a real ctest;
 * GoogleTest markers only count when a real binary printed them, never a printer,
 * a reader of an old log, a shell wrapper or another runner that echoes the lines.
 */
export function ctestOrGtestEvidence(command: string, output: string): { count: number | null } | null {
  const inv = invokedProgram(command)
  if (!inv) return null
  if (inv.program === 'ctest' && inv.shellDepth === 0) return ctestEvidence(output)
  if (!isGoogleTestInvocation(inv)) return null
  return gtestEvidence(output)
}

/** Maven goals that compile the project without running a test. */
const mavenTestGoal = /^(?:test|verify|package|install|surefire:test|failsafe:(?:integration-test|verify)|org\.apache\.maven\.plugins:maven-surefire-plugin:(?:[^\s:]+:)?test|org\.apache\.maven\.plugins:maven-failsafe-plugin:(?:[^\s:]+:)?(?:integration-test|verify))$/u

/** Detect whether a Maven verification actually ran at least one Surefire/Failsafe test. */
export function mavenTestEvidence(command: string, output: string): { count: number | null } | null {
  const inv = invokedProgram(command)
  if (!inv || inv.shellDepth > 0 || (inv.program !== 'mvn' && inv.program !== 'mvnw')) return null
  if (!inv.argv.some(word => mavenTestGoal.test(word))) return null
  const summaries = [...output.matchAll(/Tests run:\s*(\d+)\s*,\s*Failures:\s*(\d+)\s*,\s*Errors:\s*(\d+)\s*,\s*Skipped:\s*(\d+)/giu)]
  if (!summaries.length) return { count: null }
  if (summaries.some(match => Number(match[2]) > 0 || Number(match[3]) > 0)) return { count: 0 }
  return { count: Math.max(...summaries.map(match => Math.max(0, Number(match[1]) - Number(match[4])))) }
}

/** The shell must run one validator, not a second command that can forge its output or exit status. */
export function validationCommandProblem(command: string): string | undefined {
  if (/[;&|`<>\r\n]/u.test(command) || /\$\(/u.test(command)) {
    return '验证命令只能包含一个测试程序；请移除管道、命令连接、重定向和命令替换'
  }
  return undefined
}

/** Fail early for known Maven build-only/skip-test plans instead of compiling before rejecting the receipt. */
export function verificationPlanProblem(command: string): string | undefined {
  const syntax = validationCommandProblem(command)
  if (syntax) return syntax
  const invocation = invokedProgram(command)
  // A wrapper the gate cannot see through is rejected while the plan is written, not after the run.
  if (invocation && invocation.shellDepth > 0) {
    return '验证命令不能包在外壳里；请直接运行测试程序，例如 ./build/suite_tests 或 ctest --test-dir build'
  }
  const maven = invocation?.program === 'mvn' || invocation?.program === 'mvnw'
  if (maven && (/(?:^|\s)["']?-D(?:skipTests|maven\.test\.skip)(?:=(?:true|1))?["']?(?=\s|$)/iu.test(command)
    || /(?:^|\s)(?:compile|test-compile|validate|process-resources|clean)(?=\s|$)/u.test(command) && mavenTestEvidence(command, '') === null))
    return 'TEST_PLAN_REQUIRES_TESTS: this test group cannot use a build-only or skip-tests command. Plan a real test goal such as mvn test -DskipTests=false; run optional compile checks separately.'
  return undefined
}

/** Reject commands that only manufacture a successful receipt. */
export function skillCommandProblem(command: string): string | undefined {
  const syntax = validationCommandProblem(command)
  if (syntax) return syntax
  return skillReceiptProblem(command)
}

/** Gradle test tasks, including a task path such as `:app:test`. */
const gradleTask = /^(?:[\w-]+:)*test$/u

/** Recognise a completed test suite, including the default runners for supported project types. */
export function isGradleTestCommand(command: string): boolean {
  const inv = invokedProgram(command)
  if (!inv || inv.shellDepth > 0) return false
  if (inv.program !== 'gradle' && inv.program !== 'gradlew') return false
  return inv.argv.some(word => gradleTask.test(word))
}

const packageRunners = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const testScript = /^test(?::[\w:.-]+)?$/u
const pythonProgram = /^python(?:\d+(?:\.\d+)*)?$/u

/** The package manager (or `node --test`) ran its test script, not an arbitrary node program. */
function isNodeTestInvocation(inv: Invocation): boolean {
  if (inv.shellDepth > 0) return false
  if (packageRunners.has(inv.program)) {
    const script = inv.argv[0] === 'run' ? inv.argv[1] : inv.argv[0]
    return testScript.test(script ?? '')
  }
  return inv.program === 'node' && inv.argv.includes('--test')
}

function isPytestInvocation(inv: Invocation): boolean {
  if (inv.shellDepth > 0) return false
  if (inv.program === 'pytest') return true
  if (!pythonProgram.test(inv.program) && inv.program !== 'py') return false
  const flag = inv.argv.indexOf('-m')
  return flag >= 0 && inv.argv[flag + 1] === 'pytest'
}

function isCargoTestInvocation(inv: Invocation): boolean {
  if (inv.shellDepth > 0 || inv.program !== 'cargo') return false
  return inv.argv.find(word => !word.startsWith('-') && !word.startsWith('+')) === 'test'
}

export function testEvidence(command: string, output: string): { count: number | null } {
  // A later shell command or pipeline can turn a failing test process into exit 0.
  if (validationCommandProblem(command)) return { count: null }
  const invocation = invokedProgram(command)
  // A shell wrapper hides which program printed the summary; it provides no evidence.
  if (invocation && invocation.shellDepth > 0) return { count: null }
  if (/(?:^|\n)\s*#\s*fail\s+[1-9]\d*\b|(?:^|\n)\s*(?:Tests?|Test Suites?):\s*[^\r\n]*\b[1-9]\d*\s+failed\b|test result:\s*FAILED\b|(?:^|\n)FAIL\s+\S+/iu.test(output)) {
    return { count: 0 }
  }
  const maven = mavenTestEvidence(command, output)
  if (maven) return maven
  const go = goTestEvidence(command, output)
  if (go) return go
  const unittest = unittestTestEvidence(command, output)
  if (unittest) return unittest
  const ctestOrGtest = ctestOrGtestEvidence(command, output)
  if (ctestOrGtest) return ctestOrGtest
  if (isGradleTestCommand(command)) {
    if (/\bBUILD FAILED\b/iu.test(output)) return { count: 0 }
    const summaries = [...output.matchAll(/\b(\d+) tests? completed(?:,\s*(\d+) failed)?(?:,\s*(\d+) skipped)?/giu)]
    if (!summaries.length) return { count: null }
    if (summaries.some(entry => Number(entry[2] ?? 0) > 0)) return { count: 0 }
    return { count: Math.max(...summaries.map(entry => Math.max(0, Number(entry[1]) - Number(entry[3] ?? 0)))) }
  }
  let match: RegExpMatchArray | null = null
  if (invocation && isNodeTestInvocation(invocation)) {
    const passed = output.match(/(?:^|\n)\s*#\s*pass\s+(\d+)\b/iu)
    const total = output.match(/(?:^|\n)\s*#\s*tests\s+(\d+)\b/iu)
    match = passed ?? total
      ?? output.match(/(?:^|\n)\s*Tests?\s*:?\s*(\d+)\s+passed\b/iu)
      ?? output.match(/(?:^|\n)\s*Tests?\s*:\s*\d+\s+failed,\s*(\d+)\s+passed\b/iu)
    const skipped = output.match(/(?:^|\n)\s*#\s*skipped\s+(\d+)\b/iu)
    if (!passed && total && skipped) return { count: Math.max(0, Number(total[1]) - Number(skipped[1])) }
  } else if (invocation && isPytestInvocation(invocation)) {
    if (/\b[1-9]\d*\s+(?:errors?|failed)\b/iu.test(output)) return { count: 0 }
    match = output.match(/(?:^|\s)(\d+)\s+passed\b/iu)
    if (!match && /no tests ran/iu.test(output)) return { count: 0 }
  } else if (invocation && isCargoTestInvocation(invocation)) {
    const counts = [...output.matchAll(/test result:\s*ok\.\s*(\d+)\s+passed/giu)].map(entry => Number(entry[1]))
    return { count: counts.length ? Math.max(...counts) : null }
  }
  return { count: match ? Number(match[1]) : null }
}

/** Re-evaluate stored receipts so older zero-test passes cannot cross a current gate. */
export function receiptHasRequiredTests(receipt: { command: string; stdout: string; stderr: string;
  gradle_report?: { count: number; files: number } }): boolean {
  if (isGradleTestCommand(receipt.command) && receipt.gradle_report !== undefined) return receipt.gradle_report.count > 0
  return (testEvidence(receipt.command, `${receipt.stdout}\n${receipt.stderr}`).count ?? 0) > 0
}
