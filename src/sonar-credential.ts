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

/** A repository cannot redirect a saved token by editing its Sonar host or project key. */
export function sonarCredentialRef(workspace: string, hostUrl: string, projectKey: string) {
  const normalized = process.platform === 'win32' ? resolve(workspace).toLowerCase() : resolve(workspace)
  const host = new URL(hostUrl).toString().replace(/\/+$/u, '')
  const suffix = createHash('sha256').update(`${normalized}\0${host}\0${projectKey}`).digest('hex').slice(0, 24).toUpperCase()
  return `DSH_TASK_ENGINE_SONAR_${suffix}`
}

export async function resolveSonarToken(provider: SonarCredentialProvider | undefined, workspace: string | undefined,
  hostUrl: string, projectKey: string, legacyValue?: string): Promise<string> {
  if (provider && workspace && hostUrl && projectKey) {
    const saved = await provider.resolve(sonarCredentialRef(workspace, hostUrl, projectKey))
    if (saved?.value) return saved.value
  }
  // Legacy environment credentials are usable only with an explicit local host/project pin.
  if (legacyValue && process.env.DSH_SONAR_TRUSTED_HOST === hostUrl
    && process.env.DSH_SONAR_TRUSTED_PROJECT_KEY === projectKey) return legacyValue
  return ''
}
