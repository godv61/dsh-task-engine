import { goTestEvidence } from './go-test-evidence.ts'
import { skillReceiptProblem } from './skill-command.ts'
import { commandName, commandWords } from './command-words.ts'

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

/** The program a command runs, skipping `NAME=value` assignments and an `env` prefix. */
function commandProgramName(command: string): string | undefined {
  const words = commandWords(command)
  if (!words?.length) return undefined
  let index = 0
  while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index]!) || words[index] === 'env')) index++
  return index < words.length ? commandName(words[index]) : undefined
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
 * GoogleTest markers only count when a real program printed them, never a printer
 * or another runner whose output happens to contain the same lines.
 */
export function ctestOrGtestEvidence(command: string, output: string): { count: number | null } | null {
  const name = commandProgramName(command)
  if (!name) return null
  if (name === 'ctest') return ctestEvidence(output)
  if (outputOnlyCommands.has(name) || runnerCommands.has(name) || skillReceiptProblem(command)) return null
  return gtestEvidence(output)
}

/** Detect whether a Maven verification actually ran at least one Surefire/Failsafe test. */
export function mavenTestEvidence(command: string, output: string): { count: number | null } | null {
  const maven = /(?:^|[\s;&|])(?:[^\s]*[\\/])?(?:mvn|mvn\.cmd|mvnw|mvnw\.cmd)(?=\s|$)/iu.test(command)
  const testGoal = /(?:^|\s)["']?(?:test|verify|package|install|surefire:test|failsafe:(?:integration-test|verify)|org\.apache\.maven\.plugins:maven-surefire-plugin:(?:[^\s:"']+:)?test|org\.apache\.maven\.plugins:maven-failsafe-plugin:(?:[^\s:"']+:)?(?:integration-test|verify))["']?(?=\s|$)/iu.test(command)
  if (!maven || !testGoal) return null
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
  const maven = /(?:^|[\s"'])(?:[^\s]*[\\/])?(?:mvn|mvn\.cmd|mvnw|mvnw\.cmd)(?=\s|$)/iu.test(command)
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

/** Recognise a completed test suite, including the default runners for supported project types. */
export function isGradleTestCommand(command: string): boolean {
  return /(?:^|\s)(?:\.\/[\w./-]*gradlew|[\w.\\/-]*gradlew(?:\.bat)?|gradle(?:\.bat)?)\s+(?:[^\r\n]*\s)?test(?:\s|$)/iu.test(command)
}

export function testEvidence(command: string, output: string): { count: number | null } {
  // A later shell command or pipeline can turn a failing test process into exit 0.
  if (validationCommandProblem(command)) return { count: null }
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
  if (/(?:^|\s)(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?test\b|(?:^|\s)node(?:\.exe)?\s+--test\b/iu.test(command)) {
    const passed = output.match(/(?:^|\n)\s*#\s*pass\s+(\d+)\b/iu)
    const total = output.match(/(?:^|\n)\s*#\s*tests\s+(\d+)\b/iu)
    match = passed ?? total
      ?? output.match(/(?:^|\n)\s*Tests?\s*:?\s*(\d+)\s+passed\b/iu)
      ?? output.match(/(?:^|\n)\s*Tests?\s*:\s*\d+\s+failed,\s*(\d+)\s+passed\b/iu)
    const skipped = output.match(/(?:^|\n)\s*#\s*skipped\s+(\d+)\b/iu)
    if (!passed && total && skipped) return { count: Math.max(0, Number(total[1]) - Number(skipped[1])) }
  } else if (/(?:^|\s)(?:python(?:3)?(?:\.exe)?\s+-m\s+)?pytest\b|(?:^|\s)python(?:3)?(?:\.exe)?\s+-m\s+pytest\b/iu.test(command)) {
    if (/\b[1-9]\d*\s+(?:errors?|failed)\b/iu.test(output)) return { count: 0 }
    match = output.match(/(?:^|\s)(\d+)\s+passed\b/iu)
    if (!match && /no tests ran/iu.test(output)) return { count: 0 }
  } else if (/(?:^|\s)cargo\s+test\b/iu.test(command)) {
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
