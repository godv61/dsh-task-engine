import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSonarToken, sonarCredentialRef } from './lib/sonar-credential.js'
import Controller from './lib/controller.js'

test('Sonar credential references stay distinct for different workspaces', () => {
  const qms = sonarCredentialRef('D:/projects/qms')
  const eam = sonarCredentialRef('D:/projects/eam')
  assert.match(qms, /^DSH_TASK_ENGINE_SONAR_[A-F0-9]{24}$/)
  assert.notEqual(qms, eam)
  assert.equal(qms, sonarCredentialRef('D:/projects/qms'))
  assert.ok(!qms.includes('qms'))
  if (process.platform === 'win32') assert.equal(qms, sonarCredentialRef('d:/PROJECTS/QMS'))
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
  Object.defineProperty(controller, 'ctx', { value: { get: name => name === 'credentials' ? credentials : undefined } })
  const qms = 'D:/projects/qms'
  const eam = 'D:/projects/eam'
  const result = await controller.setSonarToken({ path: qms, token: 'qms-secret' })
  assert.equal(result.configured, true)
  assert.ok(!JSON.stringify(result).includes('qms-secret'))
  assert.equal((await controller.describeSonarToken(eam)).configured, false)
  assert.equal((await credentials.resolve(sonarCredentialRef(qms))).value, 'qms-secret')
  assert.equal(await resolveSonarToken(credentials, qms, 'old-env-token'), 'qms-secret')
  assert.equal(await resolveSonarToken(credentials, eam, 'old-env-token'), 'old-env-token')
  await controller.unsetSonarToken(qms)
  assert.equal((await controller.describeSonarToken(qms)).configured, false)
})
