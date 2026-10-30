// Explicit setup for tests of gates OTHER than human requirement confirmation.
// These fixtures start after an accepted requirement, just as they seed verified
// items or Git history. Production code never imports this helper. The actual
// question/confirmation lifecycle is tested by .requirements-test and the host probe.
import { hashConfig, hashText } from '../../lib/snapshot.js'
import { requirementSource } from '../../lib/requirements.js'

export function confirmedRequirement(state, put) {
  const config = state.flow.config = structuredClone(state.flow.config)
  const hadHash = state.flow.hash !== undefined
  const intact = !hadHash || state.flow.hash === hashConfig(config)
  if (!config.requirement_review) {
    const originalStart = config.start_stage, stage = 'fixture-requirement-review', artifact = 'fixture-requirement'
    config.stages.unshift(stage); config.start_stage = stage
    config.transitions.unshift({from:stage,to:originalStart,requires:['requirement_confirmation']})
    config.requirement_review = { version: 1, stage, artifact }
    config.artifacts.push({ stage, id: artifact, name: 'Accepted fixture requirement', fields: ['goal', 'scope', 'acceptance'] })
    const edge = config.transitions.find(edge => edge.from === stage)
    if (edge) edge.requires = [...new Set([...(edge.requires ?? []), 'requirement_confirmation'])]
  }
  const policy = config.requirement_review
  const def = config.artifacts.find(def => def.id === policy.artifact)
  state.artifacts ??= {}
  state.artifacts[policy.artifact] = { ...Object.fromEntries(def.fields.map(key => [key, `Fixture ${key}`])), ...state.artifacts[policy.artifact] }
  const content = `# Accepted fixture requirement for ${state.id}\n`
  const hash = hashText(content)
  state.requirements = { clarifications: [], document: { version: 1, path: `docs/requirements/${state.id}.md`, content, hash,
    source: requirementSource(state, policy), status: 'confirmed',
    confirmation: { hash, version: 1, at: '2026-10-30T00:00:00Z', session_id: 'fixture-human' } } }
  state.requirement_confirmed = true
  if (hadHash && intact) state.flow.hash = hashConfig(config)
  put(state.requirements.document.path, content)
  return state
}
