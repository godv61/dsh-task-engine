/** Keep Sonar tokens in the local DSH credential provider, scoped by workspace. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export interface SonarCredentialInfo { configured: boolean; source?: string; writable: boolean }
/** The existing DSH credential service; kept structural so this plugin needs no new runtime dependency. */
export interface SonarCredentialProvider {
  describe(ref: string): Promise<SonarCredentialInfo>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
}

export function sonarCredentialRef(workspace: string) {
  const normalized = process.platform === 'win32' ? resolve(workspace).toLowerCase() : resolve(workspace)
  const suffix = createHash('sha256').update(normalized).digest('hex').slice(0, 24).toUpperCase()
  return `DSH_TASK_ENGINE_SONAR_${suffix}`
}

export async function resolveSonarToken(provider: SonarCredentialProvider | undefined, workspace: string | undefined,
  legacyValue: string | undefined): Promise<string> {
  if (provider && workspace) {
    const saved = await provider.resolve(sonarCredentialRef(workspace))
    if (saved?.value) return saved.value
  }
  return legacyValue ?? ''
}
