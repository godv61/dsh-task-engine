/**
 * Hand-written Typert Remote contribution for the `task-engine` namespace.
 *
 * This is the browser-side declaration of the Remote methods the host
 * {@link ../controller.ts} exposes: workflow config read/write, the skill/rule
 * catalogs, and skill/rule creation. The generator is not required: the Client
 * gateway only consumes a plain `{ package, descriptors }` object, and each
 * codec is a plain object wrapping a `{ parse(value) }` validator. zod is
 * bundled privately into `lib/client.js`, so this module stays self-contained.
 *
 * Every strict codec carries BOTH `create` and `schema`. DSH 0.1.6-alpha.2
 * changed the contract to a lazy `create: () => TypertSchema` factory and
 * rejects a schema-only codec with "strict codec has no create() factory";
 * earlier releases read the materialized `schema` field and never call
 * `create`. Emitting both keeps one artifact loadable on either side of that
 * break, and `makeCodec` is the single place that decides the shape.
 *
 * @module dsh-task-engine/remote
 */

import { z } from 'zod'

/** Browser-safe shape of a workflow transition (guard names are plain strings). */
const transitionSchema = z.object({
  from: z.string(),
  to: z.string(),
  requires: z.array(z.string()).optional(),
})

/** Browser-safe shape of a stage-owned artifact definition. */
const artifactSchema = z.object({
  stage: z.string(),
  id: z.string(),
  name: z.string(),
  fields: z.array(z.string()),
})

/** Browser-safe shape of the commit rule. */
const commitSchema = z.object({
  policy: z.enum(['task', 'item', 'manual']),
  message_pattern: z.string(),
  message_hint: z.string(),
  checkpoints: z.array(z.string()),
  file_scope: z.boolean(),
})

/** Preserve source-qualified identities across the browser/host boundary. */
const resourceRefSchema = z.object({ source: z.enum(['bundled', 'project', 'user']), name: z.string() })
const evidenceSchema = z.enum(['command', 'artifact', 'review', 'manual', 'none'])
const skillProfileSchema = z.object({ rules: z.array(resourceRefSchema), evidence: evidenceSchema.optional() })
const skillBindingSchema = z.object({
  skill: resourceRefSchema,
  rules: z.array(resourceRefSchema),
  evidence: evidenceSchema.optional(),
})

/** Browser-safe shape of one stage's skill references and legacy bindings. */
const stageBindingSchema = z.object({
  skills: z.array(skillBindingSchema).optional(),
  skill_refs: z.array(resourceRefSchema).optional(),
  legacy_rules: z.array(z.string()).optional(),
})

/** The complete workflow config. Structural only: semantic checks live in `validateWorkflow`. */
const configSchema = z.object({
  stages: z.array(z.string()),
  start_stage: z.string(),
  transitions: z.array(transitionSchema),
  artifacts: z.array(artifactSchema),
  commit: commitSchema,
  high_risk_requires_verification: z.boolean(),
  stage_bindings: z.record(z.string(), stageBindingSchema).optional(),
  skill_profiles: z.record(z.string(), skillProfileSchema).optional(),
  configuration_errors: z.array(z.string()).optional(),
  review_depth: z.enum(['two-stage', 'single']).optional(),
  commit_required: z.boolean().optional(),
  completion_guards: z.array(z.string()).optional(),
})

/** `read`/`write` result: preset flow, resolved workflow, plus validation state. */
const viewSchema = z.object({
  ok: z.boolean(),
  source: z.enum(['default', 'project', 'invalid']),
  flow: z.string(),
  config: configSchema,
  problems: z.array(z.string()),
  adoption: z.object({ created: z.array(z.string()), reused: z.array(z.string()) }).optional(),
})

/** `write` request: workspace directory + the flow selection. */
const writeRequestSchema = z.object({
  path: z.string(),
  flow: z.string(),
  stage_bindings: z.record(z.string(), stageBindingSchema).optional(),
  skill_profiles: z.record(z.string(), skillProfileSchema).optional(),
  commit: commitSchema.optional(),
  artifacts: z.array(artifactSchema).optional(),
  review_depth: z.enum(['two-stage', 'single']).optional(),
  commit_required: z.boolean().optional(),
  materialize_bundled: z.enum(['project', 'user']).optional(),
})

/** `listSkills` result: one entry per mountable skill. */
const skillCatalogSchema = z.object({
  skills: z.array(z.object({
    name: z.string(),
    description: z.string(),
    source: z.string(),
    ref: resourceRefSchema,
    sourceLabel: z.string(),
  })),
})

/** `listRules` result: one entry per mountable rule. */
const ruleCatalogSchema = z.object({
  rules: z.array(z.object({
    name: z.string(),
    source: z.string(),
    ref: resourceRefSchema,
    sourceLabel: z.string(),
  })),
})

/** `writeSkill` request: skill content plus target level. */
const writeSkillRequestSchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string().optional(),
  content: z.string(),
  level: z.enum(['project', 'user']),
  path: z.string().optional(),
})

/** `installSkill` request: an existing directory-bundle skill plus target level. */
const installSkillRequestSchema = z.object({
  sourceDir: z.string(),
  level: z.enum(['project', 'user']),
  path: z.string().optional(),
})

/** `listDirs` request/result for the install directory picker. */
const listDirsRequestSchema = z.object({ path: z.string() })
const listDirsViewSchema = z.object({
  ok: z.boolean(),
  path: z.string(),
  entries: z.array(z.object({ name: z.string(), hasSkill: z.boolean() })),
  roots: z.array(z.string()),
  currentHasSkill: z.boolean(),
  error: z.string().optional(),
})

/** `writeRule` request: rule content plus target level. */
const writeRuleRequestSchema = z.object({
  name: z.string(),
  content: z.string(),
  level: z.enum(['project', 'user']),
  path: z.string().optional(),
})
const writeUserSkillProfileRequestSchema = z.object({ name: z.string(), profile: skillProfileSchema })
const writeUserSkillProfileResultSchema = z.object({ ok: z.boolean(), error: z.string().optional() })

/** `writeSkill`/`writeRule` result. */
const writeResourceResultSchema = z.object({
  ok: z.boolean(),
  name: z.string(),
  path: z.string(),
  error: z.string().optional(),
})

/** `readSkill` request. */
const readSkillRequestSchema = z.object({
  name: z.string(),
  level: z.enum(['project', 'user', 'bundled']),
  path: z.string().optional(),
})

/** `readSkill` result: frontmatter fields plus the body. */
const readSkillResultSchema = z.object({
  ok: z.boolean(),
  name: z.string(),
  description: z.string(),
  whenToUse: z.string(),
  content: z.string(),
  error: z.string().optional(),
})

/** `readRule` request. */
const readRuleRequestSchema = z.object({
  name: z.string(),
  level: z.enum(['project', 'user', 'bundled']),
  path: z.string().optional(),
})

/** `readRule` result: the raw markdown body. */
const readRuleResultSchema = z.object({
  ok: z.boolean(),
  name: z.string(),
  content: z.string(),
  error: z.string().optional(),
})

/** `deleteSkill` request: name plus the project/user level to remove. */
const deleteSkillRequestSchema = z.object({
  name: z.string(),
  level: z.enum(['project', 'user']),
  path: z.string().optional(),
})

/** `deleteRule` request: name plus the project/user level to remove. */
const deleteRuleRequestSchema = z.object({
  name: z.string(),
  level: z.enum(['project', 'user']),
  path: z.string().optional(),
})

/** Browser-safe shape of one task ledger item's dispatch/review audit. */
const taskLedgerItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  dispatch: z.object({ description: z.string(), at: z.string() }).optional(),
  review: z.object({
    spec: z.object({ outcome: z.enum(['pass', 'fail']), notes: z.array(z.string()).optional() }),
    quality: z.object({ outcome: z.enum(['pass', 'fail']), notes: z.array(z.string()).optional() }),
  }).optional(),
})

/** `readTasks` result: every task record under the workspace's `.dsh/`. */
const taskLedgerViewSchema = z.object({
  tasks: z.array(z.object({
    risk_level: z.string().optional(), updated_at: z.string().optional(),
    verification_passed: z.boolean().optional(), review_outcome: z.string().optional(),
    task_id: z.string(),
    title: z.string(),
    stage: z.string(),
    branch: z.string(),
    items: z.array(taskLedgerItemSchema),
  })),
})

/** `readInit` result: the workspace's root `AGENTS.md`, or absent. */
const initViewSchema = z.object({
  exists: z.boolean(),
  content: z.string(),
  lines: z.number(),
  path: z.string().optional(),
})

/** `writeInit` request: workspace directory + full body + optional overwrite intent. */
const initWriteRequestSchema = z.object({
  path: z.string(),
  content: z.string(),
  overwrite: z.boolean().optional(),
})

/** `writeInit` result: write succeeded, or failed with the offending line count. */
const initWriteResultSchema = z.object({
  ok: z.boolean(),
  lines: z.number(),
  error: z.string().optional(),
})

/** `generateInit` request: workspace directory to scan. */
const initGenerateRequestSchema = z.object({
  path: z.string(),
})

/** `generateInit` result: a model-drafted AGENTS.md body (not yet written). */
const initDraftSchema = z.object({
  ok: z.boolean(),
  content: z.string(),
  lines: z.number(),
  error: z.string().optional(),
})

const resourceRequestSchema = z.object({
  kind: z.enum(['skill', 'rule']), level: z.enum(['project', 'user']), path: z.string(),
  files: z.array(z.object({ path: z.string(), base64: z.string() })).max(1000),
  sourceDir: z.string().optional(), expectedHash: z.string().optional(),
})
const resourcePreviewSchema = z.object({ ok: z.boolean(), name: z.string(), description: z.string(), content: z.string(), target: z.string(), files: z.number(), bytes: z.number(), hash: z.string(), conflict: z.boolean(), error: z.string().optional() })
const resourceRootsRequestSchema = z.object({ kind: z.enum(['skill', 'rule']), path: z.string() })
const resourceRootsSchema = z.object({ project: z.string(), user: z.string() })
const PACKAGE = '@godv61/dsh-task-engine'

export const TYPERT_REMOTE = {
  package: PACKAGE,
  descriptors: [
    ...(['previewResource', 'importResource'] as const).map(method => ({
      id: `${PACKAGE}#task-engine/${method}`, service: 'taskEngineController', namespace: 'task-engine', method,
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#ResourceImportRequest`, create: () => resourceRequestSchema, schema: resourceRequestSchema } }],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#ResourcePreview`, create: () => resourcePreviewSchema, schema: resourcePreviewSchema },
    })),
    {
      id: `${PACKAGE}#task-engine/resourceRoots`, service: 'taskEngineController', namespace: 'task-engine', method: 'resourceRoots',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#ResourceRootsRequest`, create: () => resourceRootsRequestSchema, schema: resourceRootsRequestSchema } }],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#ResourceRoots`, create: () => resourceRootsSchema, schema: resourceRootsSchema },
    },
    {
      id: `${PACKAGE}#task-engine/read`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'read',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'path',
          wire: 'path',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'string', create: () => z.string(), schema: z.string() },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#EngConfigView`, create: () => viewSchema, schema: viewSchema },
    },
    {
      id: `${PACKAGE}#task-engine/write`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'write',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#EngWriteRequest`, create: () => writeRequestSchema, schema: writeRequestSchema },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#EngConfigView`, create: () => viewSchema, schema: viewSchema },
    },
    {
      id: `${PACKAGE}#task-engine/listSkills`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'listSkills',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'path',
          wire: 'path',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'string', create: () => z.string(), schema: z.string() },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#SkillCatalog`, create: () => skillCatalogSchema, schema: skillCatalogSchema },
    },
    {
      id: `${PACKAGE}#task-engine/listRules`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'listRules',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'path',
          wire: 'path',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'string', create: () => z.string(), schema: z.string() },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#RuleCatalog`, create: () => ruleCatalogSchema, schema: ruleCatalogSchema },
    },
    {
      id: `${PACKAGE}#task-engine/writeSkill`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'writeSkill',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#WriteSkillRequest`, create: () => writeSkillRequestSchema, schema: writeSkillRequestSchema },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#WriteResourceResult`, create: () => writeResourceResultSchema, schema: writeResourceResultSchema },
    },
    {
      id: `${PACKAGE}#task-engine/installSkill`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'installSkill',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#InstallSkillRequest`, create: () => installSkillRequestSchema, schema: installSkillRequestSchema },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#WriteResourceResult`, create: () => writeResourceResultSchema, schema: writeResourceResultSchema },
    },
    {
      id: `${PACKAGE}#task-engine/listDirs`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'listDirs',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#ListDirsRequest`, create: () => listDirsRequestSchema, schema: listDirsRequestSchema },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#ListDirsView`, create: () => listDirsViewSchema, schema: listDirsViewSchema },
    },
    {
      id: `${PACKAGE}#task-engine/writeRule`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'writeRule',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#WriteRuleRequest`, create: () => writeRuleRequestSchema, schema: writeRuleRequestSchema },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#WriteResourceResult`, create: () => writeResourceResultSchema, schema: writeResourceResultSchema },
    },
    {
      id: `${PACKAGE}#task-engine/writeUserSkillProfile`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'writeUserSkillProfile',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json',
        codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#WriteUserSkillProfileRequest`, create: () => writeUserSkillProfileRequestSchema, schema: writeUserSkillProfileRequestSchema } }],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#WriteUserSkillProfileResult`, create: () => writeUserSkillProfileResultSchema, schema: writeUserSkillProfileResultSchema },
    },
    {
      id: `${PACKAGE}#task-engine/readSkill`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'readSkill',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#ReadSkillRequest`, create: () => readSkillRequestSchema, schema: readSkillRequestSchema },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#ReadSkillResult`, create: () => readSkillResultSchema, schema: readSkillResultSchema },
    },
    {
      id: `${PACKAGE}#task-engine/readRule`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'readRule',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#ReadRuleRequest`, create: () => readRuleRequestSchema, schema: readRuleRequestSchema },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#ReadRuleResult`, create: () => readRuleResultSchema, schema: readRuleResultSchema },
    },
    {
      id: `${PACKAGE}#task-engine/deleteSkill`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'deleteSkill',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#DeleteSkillRequest`, create: () => deleteSkillRequestSchema, schema: deleteSkillRequestSchema },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#WriteResourceResult`, create: () => writeResourceResultSchema, schema: writeResourceResultSchema },
    },
    {
      id: `${PACKAGE}#task-engine/deleteRule`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'deleteRule',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#DeleteRuleRequest`, create: () => deleteRuleRequestSchema, schema: deleteRuleRequestSchema },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#WriteResourceResult`, create: () => writeResourceResultSchema, schema: writeResourceResultSchema },
    },
    {
      id: `${PACKAGE}#task-engine/readTasks`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'readTasks',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'path',
          wire: 'path',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'string', create: () => z.string(), schema: z.string() },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#TaskLedgerView`, create: () => taskLedgerViewSchema, schema: taskLedgerViewSchema },
    },
    {
      id: `${PACKAGE}#task-engine/readInit`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'readInit',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'path',
          wire: 'path',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: 'string', create: () => z.string(), schema: z.string() },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#InitView`, create: () => initViewSchema, schema: initViewSchema },
    },
    {
      id: `${PACKAGE}#task-engine/writeInit`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'writeInit',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#InitWriteRequest`, create: () => initWriteRequestSchema, schema: initWriteRequestSchema },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#InitWriteResult`, create: () => initWriteResultSchema, schema: initWriteResultSchema },
    },
    {
      id: `${PACKAGE}#task-engine/generateInit`,
      service: 'taskEngineController',
      namespace: 'task-engine',
      method: 'generateInit',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}/types#InitGenerateRequest`, create: () => initGenerateRequestSchema, schema: initGenerateRequestSchema },
        },
      ],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}/types#InitDraft`, create: () => initDraftSchema, schema: initDraftSchema },
    },
  ],
}

export default TYPERT_REMOTE
