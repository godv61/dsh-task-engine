/** Detect whether a Maven verification actually ran at least one Surefire/Failsafe test. */
export function mavenTestEvidence(command: string, output: string): { count: number | null } | null {
  const maven = /(?:^|[\s;&|])(?:[^\s]*[\\/])?(?:mvn|mvn\.cmd|mvnw|mvnw\.cmd)(?=\s|$)/iu.test(command)
  const testGoal = /(?:^|\s)(?:test|verify|package|install)(?=\s|$)/iu.test(command)
  if (!maven || !testGoal) return null
  const counts = [...output.matchAll(/Tests run:\s*(\d+)\s*,\s*Failures:/giu)].map(match => Number(match[1]))
  return { count: counts.length ? Math.max(...counts) : null }
}

/** Recognise a completed test suite, including the default runners for supported project types. */
export function testEvidence(command: string, output: string): { count: number | null } {
  // A later shell command or pipeline can turn a failing test process into exit 0.
  if (/(?:\|\||(?<!\|)\|(?!\|)|;)/u.test(command)) return { count: null }
  if (/(?:^|\n)\s*#\s*fail\s+[1-9]\d*\b|\b[1-9]\d*\s+failed\b|test result:\s*FAILED\b|(?:^|\n)FAIL\s+\S+/iu.test(output)) {
    return { count: 0 }
  }
  const maven = mavenTestEvidence(command, output)
  if (maven) return maven
  let match: RegExpMatchArray | null = null
  if (/(?:^|\s)(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?test\b|(?:^|\s)node(?:\.exe)?\s+--test\b/iu.test(command)) {
    match = output.match(/(?:^|\n)\s*#\s*tests\s+(\d+)\b/iu)
      ?? output.match(/(?:^|\n)\s*Tests?\s*:?\s*(\d+)\s+passed\b/iu)
      ?? output.match(/(?:^|\n)\s*Tests?\s*:\s*\d+\s+failed,\s*(\d+)\s+passed\b/iu)
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
