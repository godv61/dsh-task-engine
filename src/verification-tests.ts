/** Detect whether a Maven verification actually ran at least one Surefire/Failsafe test. */
export function mavenTestEvidence(command: string, output: string): { count: number | null } | null {
  const maven = /(?:^|[\s;&|])(?:[^\s]*[\\/])?(?:mvn|mvn\.cmd|mvnw|mvnw\.cmd)(?=\s|$)/iu.test(command)
  const testGoal = /(?:^|\s)(?:test|verify|package|install)(?=\s|$)/iu.test(command)
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

/** Recognise a completed test suite, including the default runners for supported project types. */
export function testEvidence(command: string, output: string): { count: number | null } {
  // A later shell command or pipeline can turn a failing test process into exit 0.
  if (validationCommandProblem(command)) return { count: null }
  if (/(?:^|\n)\s*#\s*fail\s+[1-9]\d*\b|\b[1-9]\d*\s+failed\b|test result:\s*FAILED\b|(?:^|\n)FAIL\s+\S+/iu.test(output)) {
    return { count: 0 }
  }
  const maven = mavenTestEvidence(command, output)
  if (maven) return maven
  if (/(?:^|\s)(?:\.\/[\w./-]*gradlew|[\w.\\/-]*gradlew(?:\.bat)?|gradle(?:\.bat)?)\s+(?:[^\r\n]*\s)?test(?:\s|$)/iu.test(command)) {
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
    match = output.match(/(?:^|\s)(\d+)\s+passed\b/iu)
    if (!match && /no tests ran/iu.test(output)) return { count: 0 }
  } else if (/(?:^|\s)go\s+test\b/iu.test(command)) {
    return { count: /(?:^|\n)ok\s+\S+/u.test(output) ? 1 : 0 }
  } else if (/(?:^|\s)cargo\s+test\b/iu.test(command)) {
    const counts = [...output.matchAll(/test result:\s*ok\.\s*(\d+)\s+passed/giu)].map(entry => Number(entry[1]))
    return { count: counts.length ? Math.max(...counts) : null }
  }
  return { count: match ? Number(match[1]) : null }
}

/** Re-evaluate stored receipts so older zero-test passes cannot cross a current gate. */
export function receiptHasRequiredTests(receipt: { command: string; stdout: string; stderr: string }): boolean {
  return (testEvidence(receipt.command, `${receipt.stdout}\n${receipt.stderr}`).count ?? 0) > 0
}
