/** Human-facing engineering timestamps use the fixed UTC+08:00 offset, independent of host/browser TZ. */
function eastEightIso(at: string): string | undefined {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/iu.test(at)) return undefined
  const instant = Date.parse(at)
  if (!Number.isFinite(instant)) return undefined
  const shifted = new Date(instant + 8 * 60 * 60 * 1000)
  return Number.isFinite(shifted.getTime()) ? shifted.toISOString().slice(0, -1) : undefined
}

export function formatEastEightTime(at: string): string {
  const iso = eastEightIso(at)
  return iso ? `${iso.replace('T', ' ')}（UTC+08:00）` : `${at}（无效或缺少时区的时间）`
}

/** File-safe local stamp; persisted audit instants stay UTC ISO and existing paths remain valid. */
export function eastEightFileStamp(at: string): string {
  const iso = eastEightIso(at)
  return iso ? `${iso.replace(/[:.]/gu, '-')}+0800` : `invalid-time-${at.replace(/[^A-Za-z0-9-]/gu, '-')}`
}
