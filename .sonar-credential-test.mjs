import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSonarToken, sonarCredentialRef } from './lib/sonar-credential.js'
import Controller from './lib/controller.js'

test('Sonar credential references stay distinct for different workspaces', () => {
  const host = 'http://sonar.internal:9000'
  const qms = sonarCredentialRef('D:/projects/qms', host, 'qms-key')
  const eam = sonarCredentialRef('D:/projects/eam', host, 'eam-key')
  assert.match(qms, /^DSH_TASK_ENGINE_SONAR_[A-F0-9]{24}$/)
  assert.notEqual(qms, eam)
  assert.notEqual(qms, sonarCredentialRef('D:/projects/qms', 'http://other.internal:9000', 'qms-key'))
  assert.notEqual(qms, sonarCredentialRef('D:/projects/qms', host, 'other-key'))
  assert.equal(qms, sonarCredentialRef('D:/projects/qms', host, 'qms-key'))
  assert.ok(!qms.includes('qms'))
  if (process.platform === 'win32') assert.equal(qms, sonarCredentialRef('d:/PROJECTS/QMS', host, 'qms-key'))
})

test('Sonar token management keeps each workspace value private', async () => {
  const stored = new Map()
  const credentials = {
    describe: async ref => ({ configured: stored.has(ref), writable: true, source: stored.has(ref) ? 'file' : undefined }),
    set: async (ref, value) => { stored.set(ref, value) },
    unset: async ref => { stored.delete(ref) },
    resolve: async ref => stored.has(ref) ? { value: stored.get(ref), source: 'file' } : undefined,
  }
  const controller = Object.create(Controller.prototype)
  controller.authorizedPath = async path => path
  controller.readAdaptive = async path => ({ config: { sonar: { host_url: 'http://sonar.internal:9000', project_key: path.includes('qms') ? 'qms-key' : 'eam-key' } } })
  Object.defineProperty(controller, 'ctx', { value: { get: name => name === 'credentials' ? credentials : undefined } })
  const qms = 'D:/projects/qms'
  const eam = 'D:/projects/eam'
  const result = await controller.setSonarToken({ path: qms, token: 'qms-secret' })
  assert.equal(result.configured, true)
  assert.ok(!JSON.stringify(result).includes('qms-secret'))
  assert.equal((await controller.describeSonarToken(eam)).configured, false)
  assert.equal((await credentials.resolve(sonarCredentialRef(qms, 'http://sonar.internal:9000', 'qms-key'))).value, 'qms-secret')
  assert.equal(await resolveSonarToken(credentials, qms, 'http://sonar.internal:9000', 'qms-key', 'old-env-token'), 'qms-secret')
  assert.equal(await resolveSonarToken(credentials, qms, 'http://other.internal:9000', 'qms-key', 'old-env-token'), '')
  assert.equal(await resolveSonarToken(credentials, eam, 'http://sonar.internal:9000', 'eam-key', 'old-env-token'), '')
  const oldHost = process.env.DSH_SONAR_TRUSTED_HOST
  const oldKey = process.env.DSH_SONAR_TRUSTED_PROJECT_KEY
  try {
    process.env.DSH_SONAR_TRUSTED_HOST = 'http://sonar.internal:9000'
    process.env.DSH_SONAR_TRUSTED_PROJECT_KEY = 'eam-key'
    assert.equal(await resolveSonarToken(credentials, eam, 'http://sonar.internal:9000', 'eam-key', 'env-token'), 'env-token')
    assert.equal(await resolveSonarToken(credentials, qms, 'http://sonar.internal:9000', 'qms-key', 'env-token'), 'qms-secret')
    assert.equal(await resolveSonarToken(credentials, eam, 'http://other.internal:9000', 'eam-key', 'env-token'), '')
  } finally {
    if (oldHost === undefined) delete process.env.DSH_SONAR_TRUSTED_HOST
    else process.env.DSH_SONAR_TRUSTED_HOST = oldHost
    if (oldKey === undefined) delete process.env.DSH_SONAR_TRUSTED_PROJECT_KEY
    else process.env.DSH_SONAR_TRUSTED_PROJECT_KEY = oldKey
  }
  await controller.unsetSonarToken(qms)
  assert.equal((await controller.describeSonarToken(qms)).configured, false)
})
