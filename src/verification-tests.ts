/** Detect whether a Maven verification actually ran at least one Surefire/Failsafe test. */
export function mavenTestEvidence(command: string, output: string): { count: number | null } | null {
  const maven = /(?:^|[\s;&|])(?:[^\s]*[\\/])?(?:mvn|mvn\.cmd|mvnw|mvnw\.cmd)(?=\s|$)/iu.test(command)
  const testGoal = /(?:^|\s)(?:test|verify|package|install)(?=\s|$)/iu.test(command)
  if (!maven || !testGoal) return null
  const counts = [...output.matchAll(/Tests run:\s*(\d+)\s*,\s*Failures:/giu)].map(match => Number(match[1]))
  return { count: counts.length ? Math.max(...counts) : null }
}

/** Re-evaluate stored receipts so older zero-test passes cannot cross a current gate. */
export function receiptHasRequiredTests(receipt: { command: string; stdout: string; stderr: string }): boolean {
  const evidence = mavenTestEvidence(receipt.command, `${receipt.stdout}\n${receipt.stderr}`)
  return evidence === null || (evidence.count ?? 0) > 0
}
