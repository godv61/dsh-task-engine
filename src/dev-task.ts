import { readText, writeText, loadTask, writeTask, taskPath, type WriteFs } from './task-store.ts'
/**
 * The model-facing `dev_task` tool: the hard engineering-delivery gate.
 *
 * This module owns the tool definition and every filesystem-adjacent helper it
 * needs, so the registration can run on the AGENT plane (inside a preset's
 * scope) rather than the host plane. Registering through a scoped context files
 * the tool in that scope's layer — a session on another preset never sees it —
 * while the pure state machine in {@link ../engine} and the config-facing
 * `task-engine` Remote stay shared.
 *
 * @module dsh-task-engine/dev-task
 */

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
// Type-only: pulls the `Context.fs` augmentation into this module.
import type {} from '@deepseek-ai/dsh-fs'
import {
  assertAdvance,
  bindingsForStage,
  checkFileScope,
  commitCheckpoint,
  applyRevision,
  completionBlockers,
  formatResourceRef,
  invalidatedBy,
  legalTargets,
  resourceBlockers,
  newTask,
  taskIdFromMessage,
  terminalRequirements,
  unmetGuards,
  validateCommitMessage,
  validateWorkflow,
  verificationBlockers,
  type FlowSnapshot,
  type ParsedProjectConfig,
  type FrozenResource,
  type GuardName,
  type ResourceRef,
  type ResourceSource,
  type Result,
  type SkillProfile,
  type StageBinding,
  type TaskItem,
  type TaskState,
  type VerificationReceipt,
  type WorkflowConfig,
} from './engine.ts'
import {
  HIGH_RISK_REQUIRED_CAPABILITIES,
  workflowSatisfies,
  resolveFlow,
} from './workflows.ts'
import { ADAPTIVE_VERSION, COMPLEXITY_OPTIONS, META_EVIDENCE, META_STAGES, adaptiveWorkflow, isComplexity, metaForStage,
  type Complexity, type MetaSkill } from './adaptive.ts'
import { assertLocalSonarReady, inspectSonar, localReviewGate, sonarCommitBlockers, unresolvedBlockingFindings, validAuditIncludePaths, validLocalScanCommand, type SonarAudit, type SonarHistoryRef, type SonarFinding, type SonarPolicy } from './sonar.ts'
import { captureLocalAuditBaseline, inspectLocalRules, lastLocalRuleUpdate, localRulesFingerprint } from './sonarlint-local.ts'
import { renderSonarReport, sonarReportPath } from './sonar-report.ts'
import { resolveSonarToken, type SonarCredentialProvider } from './sonar-credential.ts'
import { projectMapCoverageGaps, projectMapCoveragePaths, projectMetaSkillTargets, scanProject, validateInitResources, type InitResource } from './project-init.ts'
import { hashBytes, hashConfig, hashText } from './snapshot.ts'
import { acquireTaskMutation, executionCapabilities, executionCoverageBlockers, executionItemBlockers, executionPlanKey, fullReadCoverage, hasFullReadCoverage, makeExecutionPlan, parseIndependentReview, reviewStrategy, REVIEW_OUTPUT_SCHEMA, taskSubagents, validateIndependentReview } from './execution-plan.ts'
import { ownActivation, reviewerEvents, reviewerProof, type TaskActivation } from './subagent-runtime.ts'
import { analysisWorkflow, deliveryContract, deliveryView, isAnalysis, type DelegationBenefit, type DeliveryIntent, type InvestigationQuestion } from './delivery-contract.ts'
import { executeAnalysisCommand } from './analysis-commands.ts'
import { assertInsideRoot } from './path-guard.ts'
import { runMetrics, parentMetrics, unknownMetrics } from './run-observation.ts'
import { bindDeliveryIntent, installDeliveryAccess } from './delivery-access.ts'
import { REVIEW_PRESET, validReviewPolicy } from './reviewer-spec.ts'
import type {} from '@deepseek-ai/dsh-working-directory'
import { isFullOid, isOidInput } from './git-oid.ts'
import { requiredReviewPaths, validateDeliveryChanges, type DeliveryChange, type DeliveryChangeInput } from './delivery-changes.ts'
import { reviewEvidenceBlockers, verificationEvidenceBlockers } from './evidence-gate.ts'
import { withUserSkillProfiles } from './user-skill-profiles.ts'
import { isGradleTestCommand, skillCommandProblem, testEvidence, validationCommandProblem } from './verification-tests.ts'
import { freshGradleReportSummary, snapshotGradleReports } from './gradle-reports.ts'
import { affectedItems, groupEvidenceBlockers, groupInputs, groupKey, groupPlanningBlockers, latestGroupRun, preserveVerification, receiptProblems, refreshVerification, requiredGroups, verificationGroupViews, verificationKey, verificationTime } from './verification-state.ts'
import { loadedSkills, needsSkillReceipt, obligationStages, skillBlockers, type SkillSession } from './skill-audit.ts'
import {
  detectRoot,
  detectType,
  defaultVerifyCommand,
  listProjectRules,
  listProjectSkills,
  isSensitivePath,
  presentGovernanceFiles,
  type FileProbe,
} from './project.ts'

/** Bundled commit-msg hook, copied into `.git/hooks/` by the `install_hook` operation. */
const HOOK_TEMPLATE = readFileSync(
  fileURLToPath(new URL('../hooks/commit-msg', import.meta.url)), 'utf8',
)

/** Pins the hook directory to CommonJS so the extensionless hook runs under any repo `type`. */
const HOOK_PACKAGE_JSON = '{\n  "type": "commonjs"\n}\n'

type Fs = Context['fs']

/**
 * Read a workspace-relative file through the sandboxed filesystem. `cwd` is the
 * calling session's workspace (`exec.agent.session.header.cwd`); without it the
 * backend falls back to its own base, which is NOT the session workspace.
 */

/**
 * Per-call sandbox policy every dev_task write must carry. DSH's filesystem
 * sandbox is resolved PER CALL (mode + workspace root), never fixed on the
 * provider; a write that omits it runs under the backend's own default root,
 * which is NOT the session workspace — so workspace-relative writes get
 * misjudged as out-of-root and denied. Narrowed like `ApprovalAsk` so this
 * bundle stays free of the dsh-sandbox package's dependency tree.
 */
/** Project-adapter probe over the sandboxed filesystem. */
function projectProbe(fs: Fs): FileProbe {
  if (typeof fs.listDir !== 'function') return { read: (dir, rel) => readText(fs, rel, dir) }
  const directories = new Map<string, string[] | undefined>()
  return {
    read: (dir, relPath) => readText(fs, relPath, dir),
    list: async (dir, relPath) => {
      try {
        const target = await fs.resolve(relPath, { cwd: dir })
        const entries = await fs.listDir(target)
        directories.set(`${dir}\0${relPath}`, entries.every(entry => entry.type !== undefined) ? entries.filter(entry => entry.type === 'directory').map(entry => entry.name) : undefined)
        return entries.map(entry => entry.name)
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'FS_NOT_FOUND', 'FS_NOT_DIRECTORY'].includes((error as { code?: string }).code ?? '')) return []
        throw error
      }
    },
    directories: async (dir, rel) => directories.get(`${dir}\0${rel}`),
  }
}

export { assertInsideRoot } from './path-guard.ts'

/**
 * The verification command a bare `verify` should run: the project's
 * `.dsh/eng.json` override wins, then the language default (node → `npm test`,
 * java → `mvn -B test` or the Gradle wrapper, …). `undefined` means the
 * project must provide a test command explicitly.
 */
async function resolveVerifyCommand(fs: Fs, cwd?: string): Promise<string | undefined> {
  const raw = await readText(fs, '.dsh/eng.json', cwd)
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as { verify_command?: unknown }
      if (typeof parsed.verify_command === 'string' && parsed.verify_command.trim() !== '') {
        return parsed.verify_command.trim()
      }
    } catch {
      // Unparsable eng.json is already rejected by resolveWorkflow; keep the default here.
    }
  }
  const root = await detectRoot(projectProbe(fs), cwd ?? '')
  const probe = projectProbe(fs)
  if (await probe.read(root, 'build.gradle') !== undefined || await probe.read(root, 'build.gradle.kts') !== undefined) {
    const wrapper = process.platform === 'win32' ? await probe.read(root, 'gradlew.bat') !== undefined
      : await probe.read(root, 'gradlew') !== undefined
    return `${wrapper ? process.platform === 'win32' ? 'gradlew.bat' : './gradlew' : 'gradle'} test --rerun-tasks`
  }
  return defaultVerifyCommand(await detectType(projectProbe(fs), root))
}

/** Hard cap on a verification command's run time; a timeout marks the receipt non-passing. */
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Narrow runtime view of the shared `shell` executor (read optionally), mirroring
 * the shape the host's `@deepseek-ai/dsh-shell` provider exposes. Narrowed like
 * `ApprovalAsk` so this bundle stays free of the shell package's dependency tree
 * (whose peer version line clashes with the dsh-llm line this bundle pins).
 */
interface ShellRunRequest {
  command: string
  workdir?: string
  timeoutMs?: number
  signal?: AbortSignal | undefined
  sandboxPolicy?: unknown
  env?: Record<string, string>
}
interface ShellRunSpec {
  command: string
  workdir: string
  timeoutMs: number
  env?: Record<string, string>
}
interface ShellRunOutcome {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stdout?: { text?: string }
  stderr?: { text?: string }
  sandbox?: VerificationReceipt['sandbox']
}
interface ShellRunner {
  resolve(request: ShellRunRequest): ShellRunSpec
  /** DSH 0.2 foreground projection: execute returns a handle, then result(). */
  execute?(spec: ShellRunSpec): Promise<{ result(): Promise<ShellRunOutcome> }>
  /** Older DSH providers exposed a direct run method. */
  run?(spec: ShellRunSpec): Promise<ShellRunOutcome>
}

async function runShell(shell: ShellRunner, spec: ShellRunSpec): Promise<ShellRunOutcome> {
  if (typeof shell.execute === 'function') return (await shell.execute(spec)).result()
  if (typeof shell.run === 'function') return shell.run(spec)
  throw new Error('host shell service has neither execute nor run')
}

/**
 * Run a verification command through the host shell service and return an
 * objective {@link VerificationReceipt}; `passed` derives from the exit code,
 * never from the model's claim.
 */
async function runVerificationCommand(ctx: Context, command: string, cwd: string | undefined, exec: ToolRunContext, approvedMode?: 'workspace-write' | 'danger-full-access'): Promise<VerificationReceipt> {
  const shell = ctx.get('shell') as ShellRunner | undefined
  if (shell === undefined) {
    throw new Error('verify 带 command 需要 host 提供 shell 服务（用于跑真实验证命令），但当前未挂载')
  }
  const started_at = new Date().toISOString()
  const policyService = ctx.get('sandboxPolicy') as { resolve(request: { session?: unknown }): Record<string, unknown> } | undefined
  if (approvedMode !== undefined && policyService === undefined) {
    throw new Error('verification sandbox override requires the host sandboxPolicy service')
  }
  const standingPolicy = policyService?.resolve({ session: exec.agent?.session })
  const sandboxPolicy = approvedMode === undefined ? standingPolicy : { ...standingPolicy, mode: approvedMode }
  const spec = shell.resolve({ command, ...(cwd !== undefined ? { workdir: cwd } : {}),
    timeoutMs: VERIFY_TIMEOUT_MS, signal: exec.signal,
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
  })
  const outcome = await runShell(shell, spec)
  return {
    command,
    exit_code: outcome.exitCode ?? -1,
    timed_out: outcome.timedOut,
    aborted: outcome.aborted,
    started_at,
    finished_at: new Date().toISOString(),
    ...(cwd !== undefined ? { root: cwd } : {}),
    stdout: outcome.stdout?.text ?? '',
    stderr: outcome.stderr?.text ?? '',
    ...(outcome.sandbox ? { sandbox: outcome.sandbox } : {}),
  }
}

const shellQuote = (text: string): string => `'${text.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
const gitTextCommand = (command: string): string => process.platform === 'win32'
  ? `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${command}` : command
const successfulCommand = (receipt: VerificationReceipt): boolean => receipt.exit_code === 0 && !receipt.aborted && !receipt.timed_out
  && !receipt.sandbox?.denied && !receipt.sandbox?.runnerFailed

/** A host may normalize newlines in command output. Accept only a reconstruction matching Git's actual blob OID. */
function verifiedBlobText(raw: string, oid: string): string {
  const candidates = new Set([raw, raw.replace(/\r\n/gu, '\n'), raw.replace(/\r?\n/gu, '\r\n')])
  for (const candidate of [...candidates]) if (candidate.endsWith('\n')) candidates.add(candidate.replace(/\r?\n$/u, ''))
  for (const text of candidates) {
    const bytes = Buffer.from(text)
    if (bytes.length > 262_144 || text.includes('\0')) continue
    const hash = createHash(oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    if (hash === oid) return text
  }
  throw new Error('cannot capture a complete text baseline matching the Git blob (binary, oversized or truncated output)')
}

async function captureDeliveryChanges(ctx: Context, fs: Fs, state: TaskState, changes: DeliveryChangeInput[], exec: ToolRunContext,
  mode: 'workspace-write' | 'danger-full-access'): Promise<DeliveryChange[]> {
  const root = state.root ?? exec.agent?.session.header.cwd
  const head = await runVerificationCommand(ctx, 'git rev-parse HEAD', root, exec)
  const commit = head.stdout.trim().toLowerCase()
  if (!successfulCommand(head) || !isFullOid(commit)) throw new Error('planned deletion/rename requires a readable Git baseline commit')
  const snapshot = async (body: string): Promise<{ path: string; sha256: string }> => {
    if (Buffer.byteLength(body) > 262_144 || body.includes('\0')) throw new Error('planned deletion/rename baseline must be text under 256 KiB')
    const sha256 = hashText(body), path = `.dsh/review-inputs/${sha256}.txt`
    const old = await readText(fs, path, root)
    if (old !== undefined && hashText(old) !== sha256) throw new Error('review baseline cache was modified; restore it before replanning')
    if (old === undefined) await writeText(fs, path, body, root, mode, { kind: 'createIfAbsent' })
    return { path, sha256 }
  }
  const result: DeliveryChange[] = []
  for (const change of changes) {
    const tree = await runVerificationCommand(ctx, gitTextCommand(`git --literal-pathspecs ls-tree -z ${commit} -- ${shellQuote(change.path)}`), root, exec)
    const entry = /^(?:100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0\s*$/u.exec(tree.stdout)
    if (!successfulCommand(tree) || !entry || entry[2] !== change.path) throw new Error(`planned deletion/rename needs a tracked regular-file baseline: ${change.path}`)
    const blob = entry[1]!
    const content = await runVerificationCommand(ctx, gitTextCommand(`git cat-file blob ${blob}`), root, exec)
    if (!successfulCommand(content)) throw new Error(`cannot read Git baseline: ${change.path}`)
    const body = verifiedBlobText(content.stdout, blob)
    const baseline: DeliveryChange['baseline'] = { commit, blob, git: await snapshot(body) }
    const info = await fs.lstat(change.path, root ? { cwd: root } : undefined)
    if (info && info.type !== 'file') throw new Error(`planned old path is not a regular file: ${change.path}`)
    const before = info ? await readText(fs, change.path, root) : undefined
    if (info && before === undefined) throw new Error(`cannot read pre-change worktree content: ${change.path}`)
    if (before !== undefined && before !== body) baseline.before = await snapshot(before)
    result.push({ ...change, baseline })
  }
  return result
}

async function assertDeliveryChanges(fs: Fs, plan: { files: string[]; changes?: DeliveryChange[] }, root?: string): Promise<void> {
  validateDeliveryChanges(plan.changes ?? [], plan.files)
  for (const change of plan.changes ?? []) {
    if (await fs.lstat(change.path, root ? { cwd: root } : undefined)) throw new Error(`planned ${change.kind} old path still exists: ${change.path}`)
    if (change.to && (await fs.lstat(change.to, root ? { cwd: root } : undefined))?.type !== 'file') throw new Error(`rename destination is missing or not a regular file: ${change.to}`)
    for (const snapshot of [change.baseline.git, ...(change.baseline.before ? [change.baseline.before] : [])]) {
      if (!/^[a-f0-9]{64}$/u.test(snapshot.sha256) || snapshot.path !== `.dsh/review-inputs/${snapshot.sha256}.txt`)
        throw new Error('invalid review baseline identity')
      const body = await readText(fs, snapshot.path, root)
      if (body === undefined || hashText(body) !== snapshot.sha256) throw new Error(`review baseline is missing or changed: ${snapshot.path}`)
      if (snapshot === change.baseline.git) verifiedBlobText(body, change.baseline.blob)
    }
  }
}

/** HEAD was checked when recorded; recheck its identity and only the declared delivery paths at close. */
async function assertCommittedContent(ctx: Context, fs: Fs, state: TaskState, exec: ToolRunContext, expectedHash?: string): Promise<string> {
  const root = state.root ?? exec.agent?.session.header.cwd
  const hash = expectedHash ?? state.commits.findLast(commit => commit.hash)?.hash
  const head = await runVerificationCommand(ctx, 'git rev-parse HEAD', root, exec)
  const headHash = head.stdout.trim().toLowerCase()
  if (!successfulCommand(head) || !isFullOid(headHash) || (hash && (!isOidInput(hash) || !headHash.startsWith(hash.toLowerCase())))) throw new Error('recorded delivery commit is no longer HEAD')
  if (hash && hash.length !== headHash.length) {
    const quoted = `'${hash}^{commit}'`
    const resolved = await runVerificationCommand(ctx, `git rev-parse --verify --end-of-options ${quoted}`, root, exec)
    if (!successfulCommand(resolved) || resolved.stdout.trim().toLowerCase() !== headHash)
      throw new Error('commit abbreviation is ambiguous or does not resolve uniquely to HEAD; use its full OID')
  }
  const before = await scopeFingerprint(fs, state, root)
  const paths = state.files.filter(path => !/^\.dsh\/(task-[^/]+\.json|eng\.json|meta\.json)$/u.test(path))
  if (!paths.length) return headHash
  const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`
  // PowerShell and POSIX use different single-quote escapes. Paths have already passed the scope validator.
  const quoted = paths.map(path => process.platform === 'win32' ? `'${path.replaceAll("'", "''")}'` : quote(path)).join(' ')
  const result = await runVerificationCommand(ctx,
    `git --literal-pathspecs -c core.quotepath=false status --porcelain=v1 --untracked-files=all --ignored=matching -- ${quoted}`, root, exec)
  if (result.exit_code !== 0 || result.aborted || result.timed_out || result.sandbox?.denied || result.sandbox?.runnerFailed)
    throw new Error('cannot verify committed delivery content')
  if (result.stdout.trim()) throw new Error('delivery files differ from HEAD or are uncommitted; commit the verified content before recording or archiving')
  const tree = await runVerificationCommand(ctx, `git --literal-pathspecs -c core.quotepath=false ls-tree -r -z ${headHash} -- ${quoted}`, root, exec)
  if (tree.exit_code !== 0 || tree.aborted || tree.timed_out) throw new Error('cannot read delivery commit tree')
  const blobs = new Map<string, { mode: string; oid: string }>()
  for (const record of tree.stdout.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([0-9a-f]+)\t([\s\S]+)$/u.exec(record)
    if (!match) throw new Error('delivery commit contains unsupported file types')
    blobs.set(match[3]!, { mode: match[1]!, oid: match[2]! })
  }
  const present: string[] = []
  for (const path of paths) {
    const info = await fs.lstat(path, root ? { cwd: root } : undefined)
    const blob = blobs.get(path)
    if (!!info !== !!blob) throw new Error(`delivery file missing from commit or worktree: ${path}`)
    if (!info) continue
    if (info.type && info.type !== 'file') throw new Error(`delivery path is not a regular file: ${path}`)
    if (process.platform !== 'win32') {
      try {
        if (((lstatSync(resolve(root ?? '', path)).mode & 0o111) !== 0) !== (blob!.mode === '100755')) throw new Error(`delivery mode differs from commit: ${path}`)
      } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
    }
    present.push(path)
  }
  if (present.length) {
    const quotePath = (path: string) => process.platform === 'win32' ? `'${path.replaceAll("'", "''")}'` : quote(path)
    const objects = await runVerificationCommand(ctx, `git hash-object -- ${present.map(quotePath).join(' ')}`, root, exec)
    const ids = objects.stdout.trim().split(/\r?\n/u)
    if (objects.exit_code !== 0 || objects.aborted || objects.timed_out || ids.length !== present.length
      || present.some((path, index) => blobs.get(path)!.oid !== ids[index]))
      throw new Error('delivery blobs differ from verified worktree content')
  }
  const after = await runVerificationCommand(ctx, 'git rev-parse HEAD', root, exec)
  if (after.exit_code !== 0 || after.stdout.trim() !== headHash || await scopeFingerprint(fs, state, root) !== before)
    throw new Error('delivery changed during commit verification; retry on unchanged content')
  return headHash
}

/** Run a local scanner without putting the credential on a command line or in the task record. */
async function runLocalSonar(ctx: Context, policy: SonarPolicy, token: string, root: string, branch: string,
  exec: ToolRunContext, defaultCommand: string, approvedMode?: 'workspace-write' | 'danger-full-access'): Promise<string> {
  if (!token) throw new Error('SonarQube Token is not configured for this project')
  if (!/^[A-Za-z0-9._/-]+$/u.test(branch) || !policy.reference_branch
    || branch === policy.reference_branch || !/^[A-Za-z0-9._/-]+$/u.test(policy.reference_branch)) {
    throw new Error('local SonarQube scan needs a safe current branch and a different reference branch')
  }
  if (!/^[A-Za-z0-9_.:-]+$/u.test(policy.project_key)) throw new Error('invalid SonarQube project key')
  const shell = ctx.get('shell') as ShellRunner | undefined
  if (!shell) throw new Error('local SonarQube scan needs the host shell service')
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-sonar-'))
  try {
    const metadata = join(temporary, 'report-task.txt')
    const quote = (value: string): string => `'${value.replace(/'/gu, "''")}'`
    const command = [policy.scan_command?.trim() || defaultCommand,
      `-Dsonar.projectKey=${quote(policy.project_key)}`,
      `-Dsonar.branch.name=${quote(branch)}`,
      `-Dsonar.newCode.referenceBranch=${quote(policy.reference_branch)}`,
      `-Dsonar.scanner.metadataFilePath=${quote(metadata)}`,
      '-Dsonar.qualitygate.wait=false'].join(' ')
    const policyService = ctx.get('sandboxPolicy') as { resolve(request: { session?: unknown }): Record<string, unknown> } | undefined
    const standingPolicy = policyService?.resolve({ session: exec.agent?.session })
    const sandboxPolicy = approvedMode === undefined ? standingPolicy : { ...standingPolicy, mode: approvedMode }
    const spec = shell.resolve({ command, workdir: root, timeoutMs: 30 * 60 * 1000, signal: exec.signal,
      env: { SONAR_TOKEN: token, SONAR_HOST_URL: policy.host_url },
      ...(sandboxPolicy ? { sandboxPolicy } : {}) })
    const outcome = await runShell(shell, spec)
    if (outcome.exitCode !== 0 || outcome.aborted || outcome.timedOut || outcome.sandbox?.denied || outcome.sandbox?.runnerFailed) {
      throw new Error(`local SonarQube scanner did not complete (exit ${outcome.exitCode ?? 'unknown'}); inspect scanner output and retry`)
    }
    let report: string
    try { report = readFileSync(metadata, 'utf8') }
    catch { throw new Error('local SonarQube scanner did not write report-task.txt; check scanner metadataFilePath support') }
    const id = /^ceTaskId=(.+)$/mu.exec(report)?.[1]?.trim()
    if (!id || !/^[\w-]{8,120}$/u.test(id)) throw new Error('local SonarQube scanner returned an invalid ceTaskId')
    return id
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function sanitize(id: string): string {
  return id.replace(/[^0-9a-zA-Z_-]/g, '-')
}



/** Hard line cap for the `init`-generated `AGENTS.md` (injected into every session). */
const INIT_MAX_LINES = 200

/** Count physical lines after CRLF normalization; an empty string counts as one. */
function lineCount(text: string): number {
  return text.replace(/\r\n/g, '\n').split('\n').length
}

interface ResolvedWorkflow {
  flow: string
  version: number
  config: WorkflowConfig
  problems: string[]
  source: 'default' | 'project' | 'invalid'
}

/** The standard preset's identity and config; the built-in id always resolves. */
function standardWorkflow(): { flow: string; version: number; config: WorkflowConfig } {
  const standard = resolveFlow('standard')
  if (!standard.ok) throw new Error('built-in "standard" preset is missing')
  return { flow: standard.preset.id, version: standard.preset.version, config: standard.config }
}

/**
 * Resolve the effective workflow, distinguishing a missing config from a bad one.
 *
 * `default` means no `.dsh/eng.json`. `project` means the file names a known
 * flow and a sound binding addition. `invalid` means the file is unparsable,
 * missing a `flow` field, names an unknown flow, or its override fails
 * {@link validateWorkflow}; its problems are surfaced so a misconfigured gate
 * fails closed instead of silently degrading to the standard preset.
 */
async function resolveWorkflow(fs: Fs, cwd?: string): Promise<ResolvedWorkflow> {
  const raw = await readText(fs, '.dsh/eng.json', cwd)
  if (raw === undefined) {
    const standard = standardWorkflow()
    return { ...standard, problems: [], source: 'default' }
  }
  let parsed: ParsedProjectConfig
  try {
    parsed = JSON.parse(raw) as ParsedProjectConfig
  } catch (error) {
    const standard = standardWorkflow()
    return {
      ...standard,
      problems: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
      source: 'invalid',
    }
  }
  if (parsed.flow === undefined || parsed.flow.trim() === '') {
    const standard = standardWorkflow()
    return {
      ...standard,
      problems: ['eng.json exists but is missing a "flow" field — set it to standard|agile|minimal, or delete the file'],
      source: 'invalid',
    }
  }
  let project
  try {
    project = withUserSkillProfiles({
        flow: parsed.flow,
        ...(parsed.stage_bindings !== undefined ? { stage_bindings: parsed.stage_bindings } : {}),
        ...(parsed.skill_profiles !== undefined ? { skill_profiles: parsed.skill_profiles } : {}),
        ...(parsed.commit !== undefined ? { commit: parsed.commit } : {}),
        ...(parsed.artifacts !== undefined ? { artifacts: parsed.artifacts } : {}),
        ...(parsed.review_depth !== undefined ? { review_depth: parsed.review_depth } : {}),
        ...(parsed.commit_required !== undefined ? { commit_required: parsed.commit_required } : {}),
      })
  } catch (error) {
    const standard = standardWorkflow()
    return { ...standard, problems: [`用户级技能规则档案无法读取：${error instanceof Error ? error.message : String(error)}`], source: 'invalid' }
  }
  const resolved = resolveFlow(parsed.flow, project)
  if (!resolved.ok) {
    const standard = standardWorkflow()
    return {
      flow: resolved.flow,
      version: 0,
      config: standard.config,
      problems: [`unknown flow "${resolved.flow}" (known: ${resolved.knownFlows.join(', ')})`],
      source: 'invalid',
    }
  }
  const problems = validateWorkflow(resolved.config)
  return {
    flow: resolved.preset.id,
    version: resolved.preset.version,
    config: resolved.config,
    problems,
    source: problems.length === 0 ? 'project' : 'invalid',
  }
}

/** Resolve the real Git hook directory, including sessions rooted in a monorepo subdirectory. */
function hookPaths(cwd: string | undefined): { repoRoot: string; hooksRel: string; workspaceRel: string } {
  if (!cwd) throw new Error('install_hook requires a project workspace')
  const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  let repoRoot: string
  let hooksDir: string
  try {
    repoRoot = realpathSync.native(resolve(git(['rev-parse', '--show-toplevel'])))
    hooksDir = resolve(git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks']))
  } catch { throw new Error('install_hook requires an accessible Git worktree') }
  let configured = ''
  try { configured = git(['config', '--get', 'core.hooksPath']) }
  catch { /* `git config --get` exits 1 when this optional setting is absent. */ }
  if (configured) throw new Error('Git 配置了 core.hooksPath；请在自定义钩子目录手工组合提交门禁')
  const hooksRel = relative(repoRoot, hooksDir)
  const workspaceRel = relative(repoRoot, realpathSync.native(resolve(cwd)))
  if (!hooksRel || hooksRel.startsWith('..') || isAbsolute(hooksRel)
    || workspaceRel.startsWith('..') || isAbsolute(workspaceRel)) {
    throw new Error('Git hooks or task workspace lie outside the worktree; install_hook cannot safely write there')
  }
  return { repoRoot, hooksRel, workspaceRel: workspaceRel || '.' }
}

/** Install only our hook; preserve an existing unrelated hook for manual composition. */
async function installCommitHook(fs: Fs, cwd: string | undefined, mode: 'workspace-write' | 'danger-full-access'): Promise<void> {
  const { repoRoot, hooksRel, workspaceRel } = hookPaths(cwd)
  const hookPath = join(hooksRel, 'commit-msg')
  const packagePath = join(hooksRel, 'package.json')
  const rootsPath = join(hooksRel, 'dsh-task-roots.json')
  const existing = await readText(fs, hookPath, repoRoot)
  if (existing !== undefined && existing !== HOOK_TEMPLATE
    && !(existing.includes('dsh-task-engine') && existing.includes('commitCheckpoint'))) {
    throw new Error('已有非 dsh-task-engine 的 commit-msg hook；请手工组合两个钩子，安装器不会覆盖它')
  }
  const packageJson = await readText(fs, packagePath, repoRoot)
  if (packageJson !== undefined && packageJson.trim() !== HOOK_PACKAGE_JSON.trim()) {
    throw new Error('Git hook 目录已有不同的 package.json；请手工检查，安装器不会覆盖它')
  }
  const oldRoots = await readText(fs, rootsPath, repoRoot)
  let roots: string[] = []
  if (oldRoots !== undefined) {
    try {
      const parsed = JSON.parse(oldRoots) as { roots?: unknown }
      if (!Array.isArray(parsed.roots) || parsed.roots.some(root => typeof root !== 'string')) throw new Error()
      roots = parsed.roots as string[]
    } catch { throw new Error('Git hook 工作区配置无效；请修复后重试') }
  }
  roots = [...new Set([...roots, workspaceRel])]
  if (existing !== undefined && existing !== HOOK_TEMPLATE) {
    await writeText(fs, `${hookPath}.backup-${Date.now()}`, existing, repoRoot, mode)
  }
  await writeText(fs, hookPath, HOOK_TEMPLATE, repoRoot, mode)
  if (process.platform !== 'win32') {
    const installed = resolve(repoRoot, hookPath)
    chmodSync(installed, statSync(installed).mode | 0o111)
  }
  await writeText(fs, packagePath, HOOK_PACKAGE_JSON, repoRoot, mode)
  await writeText(fs, rootsPath, JSON.stringify({ roots }, null, 2) + '\n', repoRoot, mode)
}



/**
 * Resolve the sandbox mode before this call's writes or verification command. No escalation args:
 * workspace-write. Escalation args must travel as the `sandbox_permissions` ⇔
 * `justification` pair (mirroring the harness escalation contract), and a
 * `danger-full-access` request must earn a one-shot human approval; without an
 * approval service it fails closed.
 */
async function resolveWriteMode(
  ctx: Context,
  args: { sandbox_permissions?: 'workspace-write' | 'danger-full-access'; justification?: string; command?: string },
  exec: ToolRunContext,
): Promise<'workspace-write' | 'danger-full-access'> {
  const mode = args.sandbox_permissions
  const hasJustification = args.justification !== undefined && args.justification.trim() !== ''
  if (mode === undefined) {
    if (hasJustification) {
      throw new Error('invalid escalation: justification is only valid together with sandbox_permissions')
    }
    return 'workspace-write'
  }
  if (!hasJustification) {
    throw new Error('invalid escalation: sandbox_permissions requires a justification')
  }
  if (mode === 'workspace-write') return 'workspace-write'
  const approval = ctx.get('approval') as ApprovalAsk | undefined
  if (approval === undefined) {
    throw new Error(`sandbox escalation to ${mode} requires human approval, but the approval service is unavailable`)
  }
  const workspace = exec.agent?.session.header.cwd ?? '(unknown workspace)'
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: 'dev_task',
    callId: exec.callId,
    reason: args.command !== undefined
      ? `沙箱升级：请确认允许 dev_task 以 ${mode} 模式执行本次验证命令并保存回执（workspace: ${workspace}）。命令：${args.command}\n理由：${args.justification}`
      : `沙箱升级：请确认允许 dev_task 以 ${mode} 模式写任务文件（workspace: ${workspace}）。理由：${args.justification}`,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`sandbox escalation was not approved (${outcome})`)
  }
  return mode
}

/**
 * The workflow a task runs under: its frozen snapshot when present (created
 * 0.18+), otherwise the project's current config re-resolved on demand for
 * pre-snapshot records. A missing snapshot never silently widens a gate — the
 * live config must still resolve cleanly.
 */
async function workflowFor(state: TaskState, fs: Fs, cwd?: string): Promise<WorkflowConfig> {
  if (state.flow !== undefined) return state.flow.config
  const resolved = await resolveWorkflow(fs, cwd)
  if (resolved.problems.length > 0) {
    throw new Error(`invalid .dsh/eng.json — fix the project config first:\n- ${resolved.problems.join('\n- ')}`)
  }
  return resolved.config
}

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Read a rule file with a hard path, or undefined. */
function readAbsRule(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * A rule resolved to its body, with the layer it came from.
 *
 * The source records the exact project, user, or bundled rule selected for this
 * task. A same-named rule from another source does not replace that binding.
 */
interface ResolvedRule {
  name: string
  content: string
  source: ResourceSource
}

/** Read one rule body from a specific layer, so a reference decides where to look. */
async function readRuleAt(source: ResourceSource, name: string, fs: Fs, cwd?: string): Promise<string | undefined> {
  const safe = sanitize(name)
  if (safe === '') return undefined
  switch (source) {
    case 'bundled':
      return readAbsRule(fileURLToPath(new URL(`../rules/${safe}.md`, import.meta.url)))
    case 'project':
      return await readText(fs, `.dsh/rules/${safe}.md`, cwd)
    case 'user':
      return readAbsRule(join(dshHome(), 'rules', `${safe}.md`))
  }
}

/** Bundled skill directory, the only layer whose bodies this process can read without the host registry. */
const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

/**
 * Read one skill body from a layer this process can reach.
 *
 * Project-level skills live under the workspace and are readable through the
 * sandboxed fs; user-level ones sit under the harness home. A skill the host
 * registry resolves but this process cannot read yields undefined, which is
 * reported as unfreezable rather than silently omitted — the task must not claim
 * to have frozen something it did not read.
 * @param ref - the skill reference from a stage binding.
 * @param fs - sandboxed filesystem for the project-level lookup.
 * @returns the SKILL.md body, or undefined when it cannot be read here.
 */
async function readSkillAt(ref: ResourceRef, fs: Fs, cwd?: string): Promise<string | undefined> {
  const safe = sanitize(ref.name)
  if (safe === '') return undefined
  const read = (path: string): string | undefined => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
  }
  switch (ref.source) {
    case 'bundled':
      return read(join(BUNDLED_SKILLS_DIR, safe, 'SKILL.md'))
    case 'project':
      return await readText(fs, '.dsh/skills/' + safe + '/SKILL.md', cwd)
    case 'codex-project':
      return await readText(fs, '.agents/skills/' + safe + '/SKILL.md', cwd)
    case 'user':
      return read(join(dshHome(), 'skills', safe, 'SKILL.md'))
  }
}

const RESOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
interface AdaptiveConfig {
  /** Additional logical Skill names per meta-skill. A same-named project Skill replaces the user/bundled Skill. */
  meta_bindings?: Partial<Record<MetaSkill, string[]>>
  sonar?: { enabled?: boolean; host_url?: string; project_key?: string; mode?: 'branch' | 'pull-request'; token_env?: string;
    source?: 'ci' | 'local' | 'ide-local'; reference_branch?: string; scan_command?: string; include_paths?: string[] }
}

async function readAdaptiveConfig(fs: Fs, cwd?: string): Promise<AdaptiveConfig> {
  const raw = await readText(fs, '.dsh/meta.json', cwd)
  if (raw === undefined) return {}
  let config: AdaptiveConfig
  try { config = JSON.parse(raw) as AdaptiveConfig }
  catch (error) { throw new Error(`invalid .dsh/meta.json: ${error instanceof Error ? error.message : String(error)}`) }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('.dsh/meta.json must be an object')
  if (config.meta_bindings !== undefined) {
    if (config.meta_bindings === null || typeof config.meta_bindings !== 'object' || Array.isArray(config.meta_bindings)) {
      throw new Error('.dsh/meta.json meta_bindings must be an object')
    }
    for (const [meta, names] of Object.entries(config.meta_bindings)) {
      if (!(meta in META_STAGES)) throw new Error(`unknown meta-skill "${meta}" in .dsh/meta.json`)
      if (!Array.isArray(names) || !names.every(name => typeof name === 'string' && RESOURCE_NAME.test(name))) {
        throw new Error(`meta_bindings.${meta} must be an array of simple Skill names`)
      }
    }
  }
  if (config.sonar !== undefined) {
    if (config.sonar === null || typeof config.sonar !== 'object' || Array.isArray(config.sonar)) {
      throw new Error('.dsh/meta.json sonar must be an object')
    }
    if (config.sonar.enabled !== undefined && typeof config.sonar.enabled !== 'boolean') {
      throw new Error('.dsh/meta.json sonar.enabled must be boolean')
    }
  }
  return config
}

function sonarPolicyFor(project: AdaptiveConfig): SonarPolicy | undefined {
  const sonar = project.sonar
  if (sonar?.enabled !== true) return undefined
  const host_url = sonar.host_url ?? process.env.SONAR_HOST_URL
  const project_key = sonar.project_key ?? process.env.SONAR_PROJECT_KEY
  const token_env = sonar.token_env ?? 'SONAR_TOKEN'
  if (!host_url || !/^https?:\/\//u.test(host_url) || !project_key?.trim()
    || !/^[A-Z][A-Z0-9_]*$/u.test(token_env)) {
    throw new Error('enabled SonarQube needs host_url, project_key, and a valid token_env in .dsh/meta.json or environment')
  }
  const parsed = new URL(host_url)
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('SonarQube host_url must not contain credentials, a query, or a fragment')
  }
  const mode = sonar.mode ?? 'branch'
  if (mode !== 'branch' && mode !== 'pull-request') throw new Error('sonar.mode must be branch or pull-request')
  const source = sonar.source ?? 'ide-local'
  if (source !== 'ci' && source !== 'local' && source !== 'ide-local') throw new Error('sonar.source must be ci, local, or ide-local')
  const reference_branch = sonar.reference_branch?.trim() || (source === 'ide-local' ? 'HEAD' : undefined)
  if ((source === 'local' || source === 'ide-local') && (mode !== 'branch' || !reference_branch)) {
    throw new Error('local Sonar review needs branch mode and a reference_branch for new code')
  }
  if (reference_branch && !/^[A-Za-z0-9._/-]+$/u.test(reference_branch)) throw new Error('invalid SonarQube reference_branch')
  if (sonar.scan_command && !validLocalScanCommand(sonar.scan_command)) {
    throw new Error('scan_command must be the pinned Maven Sonar goal or sonar-scanner, with no arbitrary goals or Token arguments')
  }
  if (source === 'ide-local' && sonar.scan_command) throw new Error('ide-local review does not run scan_command')
  if (sonar.include_paths !== undefined && !validAuditIncludePaths(sonar.include_paths)) {
    throw new Error('sonar.include_paths must contain safe project-relative paths')
  }
  if (sonar.include_paths?.length && source !== 'ide-local') throw new Error('sonar.include_paths only applies to ide-local reviews')
  return { enabled: true, host_url, project_key, token_env, mode, source,
    ...(reference_branch ? { reference_branch } : {}),
    ...(sonar.scan_command ? { scan_command: sonar.scan_command } : {}),
    ...(sonar.include_paths?.length ? { include_paths: sonar.include_paths } : {}) }
}

async function resolveLogicalSkill(name: string, fs: Fs, cwd?: string): Promise<ResourceRef> {
  if (!RESOURCE_NAME.test(name)) throw new Error(`invalid Skill name "${name}"`)
  for (const source of ['project', 'codex-project', 'user', 'bundled'] as const) {
    const ref = { source, name }
    if (await readSkillAt(ref, fs, cwd) !== undefined) return ref
  }
  throw new Error(`Skill "${name}" was not found in project, user or bundled sources`)
}

async function profileFor(ref: ResourceRef, fs: Fs, cwd?: string): Promise<SkillProfile | undefined> {
  let raw: string | undefined
  switch (ref.source) {
    case 'project': raw = await readText(fs, `.dsh/skills/${ref.name}/profile.json`, cwd); break
    case 'codex-project': raw = await readText(fs, `.agents/skills/${ref.name}/profile.json`, cwd); break
    case 'user': raw = readAbsRule(join(dshHome(), 'skills', ref.name, 'profile.json')); break
    case 'bundled': raw = readAbsRule(join(BUNDLED_SKILLS_DIR, ref.name, 'profile.json')); break
  }
  if (raw === undefined) return undefined
  let value: SkillProfile
  try { value = JSON.parse(raw) as SkillProfile }
  catch (error) { throw new Error(`invalid profile for ${formatResourceRef(ref)}: ${error instanceof Error ? error.message : String(error)}`) }
  if (!value || !Array.isArray(value.rules) || !value.rules.every(rule =>
    rule && RESOURCE_NAME.test(rule.name) && ['bundled', 'project', 'user'].includes(rule.source))
    || (value.evidence !== undefined && !['command', 'artifact', 'review', 'manual', 'none'].includes(value.evidence))) {
    throw new Error(`invalid profile for ${formatResourceRef(ref)}`)
  }
  return value
}

/** Resolve all bound methods once at task creation; references stay source-qualified afterwards. */
async function resolveAdaptiveWorkflow(grade: Complexity, fs: Fs, cwd?: string, selected?: AdaptiveConfig): Promise<WorkflowConfig> {
  const config = adaptiveWorkflow(grade)
  const project = selected ?? await readAdaptiveConfig(fs, cwd)
  const stage_bindings: NonNullable<WorkflowConfig['stage_bindings']> = {}
  const skill_profiles: NonNullable<WorkflowConfig['skill_profiles']> = {}
  for (const stage of config.stages) {
    const meta = metaForStage(stage)
    if (meta === undefined) continue
    const names = [...new Set([meta, ...(project.meta_bindings?.[meta] ?? [])])]
    const skills = []
    for (const name of names) {
      const ref = await resolveLogicalSkill(name, fs, cwd)
      const profile = await profileFor(ref, fs, cwd) ?? {
        rules: [], evidence: name === meta ? META_EVIDENCE[meta] : 'none',
      }
      skill_profiles[formatResourceRef(ref)] = profile
      skills.push({ skill: ref, rules: profile.rules,
        evidence: profile.evidence ?? (name === meta ? META_EVIDENCE[meta] : 'none') })
    }
    stage_bindings[stage] = { skills }
  }
  config.stage_bindings = stage_bindings
  config.skill_profiles = skill_profiles
  const problems = validateWorkflow(config)
  if (problems.length > 0) throw new Error(`invalid adaptive workflow:\n- ${problems.join('\n- ')}`)
  return config
}

/**
 * Capture every skill and rule body the config resolves to at task creation.
 *
 * The copy is an audit baseline, not the runtime authority: task interactions
 * always read the latest body at the same source-qualified reference. Capturing
 * hashes makes changes visible and rejects an unreadable binding at creation.
 * @param config - the frozen workflow config.
 * @param fs - sandboxed filesystem for project-level lookups.
 * @returns the frozen resources plus the refs that could not be read.
 */
async function freezeResources(
  config: WorkflowConfig,
  fs: Fs,
  cwd?: string,
): Promise<{ resources: FrozenResource[]; unreadable: string[] }> {
  const seen = new Set<string>()
  const resources: FrozenResource[] = []
  const unreadable: string[] = []
  for (const binding of Object.values(config.stage_bindings ?? {})) {
    for (const entry of binding.skills ?? []) {
      const skillKey = 'skill:' + formatResourceRef(entry.skill)
      if (!seen.has(skillKey)) {
        const body = await readSkillAt(entry.skill, fs, cwd)
        if (body === undefined) unreadable.push(skillKey)
        else { seen.add(skillKey); resources.push({ kind: 'skill', ref: entry.skill, hash: hashText(body), content: body }) }
      }
      for (const rule of entry.rules) {
        const key = 'rule:' + formatResourceRef(rule)
        if (seen.has(key)) continue
        const body = await readRuleAt(rule.source, rule.name, fs, cwd)
        if (body === undefined) { unreadable.push(key); continue }
        seen.add(key)
        resources.push({ kind: 'rule', ref: rule, hash: hashText(body), content: body })
      }
    }
  }
  return { resources, unreadable }
}

/**
 * Resolve a bare legacy rule name to the layer that precedence selects.
 *
 * Precedence, unchanged from before: bundled wins over project, which wins over
 * user. A source-qualified reference identifies the intended body even when
 * two resource layers use the same name.
 * @param name - the bare rule name from a legacy config.
 * @param fs - sandboxed filesystem for the project-level lookup.
 * @returns the layer that holds this name, or undefined when none does.
 */
async function resolveLegacyRuleSource(
  name: string,
  fs: Fs,
  cwd?: string,
  frozen?: FrozenResource[],
): Promise<ResourceSource | undefined> {
  // A frozen snapshot answers this without touching the filesystem: the layer a
  // legacy name resolved to at creation is part of what the task froze, so a
  // source deleted afterwards cannot change where it resolves.
  for (const resource of frozen ?? []) {
    if (resource.kind !== 'skill' && resource.ref.name === name) return resource.ref.source
  }
  for (const source of ['bundled', 'project', 'user'] as const) {
    if ((await readRuleAt(source, name, fs, cwd)) !== undefined) return source
  }
  return undefined
}

/**
 * Resolve rule references to their bodies.
 *
 * Each reference names its own layer, so the lookup is exact: no precedence walk
 * is involved and two same-named rules in different layers are distinct
 * resources. A reference that resolves nowhere is reported rather than dropped —
 * omitting it made a deleted file indistinguishable from an unbound one.
 * @param refs - rule references, each with its source layer.
 * @param fs - sandboxed filesystem for the project-level lookup.
 * @returns the resolved rules with bodies and sources, plus the refs not found.
 */
async function resolveRules(
  refs: ResourceRef[],
  fs: Fs,
  cwd?: string,
  frozen?: FrozenResource[],
): Promise<{ resolved: ResolvedRule[]; missing: string[]; stale: string[] }> {
  const resolved: ResolvedRule[] = []
  const missing: string[] = []
  // Creation-time copies are an audit baseline. The source-qualified reference
  // remains stable, while its body is read afresh on each interaction.
  const frozenByRef = new Map<string, FrozenResource>()
  // Pre-0.26 snapshots have no kind. If such a snapshot reused a skill's ref
  // for a rule, its rule was never frozen; fail closed instead of reading the
  // skill body as a rule.
  for (const resource of frozen ?? []) {
    if (resource.kind === 'rule') frozenByRef.set(formatResourceRef(resource.ref), resource)
    else if (resource.kind === undefined && !resource.content.startsWith('---')) {
      frozenByRef.set(formatResourceRef(resource.ref), resource)
    }
  }
  const stale: string[] = []
  for (const ref of refs) {
    const key = formatResourceRef(ref)
    const snapshot = frozenByRef.get(key)
    const content = await readRuleAt(ref.source, ref.name, fs, cwd)
    if (content === undefined) {
      missing.push(key)
      if (snapshot !== undefined) stale.push(key + ' (source deleted)')
      continue
    }
    if (snapshot !== undefined && hashText(content) !== snapshot.hash) stale.push(key + ' (source edited)')
    resolved.push({ name: ref.name, content, source: ref.source })
  }
  return { resolved, missing, stale }
}

/**
 * Every rule that applies at a stage, gathered from the skills bound to it.
 *
 * A stage has no rule list of its own: the rules in force are the ones its skills
 * carry. Both shapes are collected here so a migrated config is not silently
 * weaker than the one it came from — `legacy_rules` still apply until a human
 * assigns them — and the two groups stay distinguishable in the return value so
 * the caller can say which rules still need an owner.
 * @param binding - the stage's binding, if any.
 * @param fs - sandboxed filesystem for project-level lookups.
 * @returns resolved rules, missing refs, and the unassigned legacy names.
 */
async function rulesForBinding(
  binding: StageBinding | undefined,
  fs: Fs,
  cwd?: string,
  frozen?: FrozenResource[],
): Promise<{ resolved: ResolvedRule[]; missing: string[]; legacy: string[]; stale: string[] }> {
  const refs: ResourceRef[] = []
  // Deduplicated by reference: one rule shared by two skills on the same stage is
  // disclosed once, because it is one constraint being followed.
  const seen = new Set<string>()
  for (const skill of binding?.skills ?? []) {
    for (const rule of skill.rules) {
      const key = formatResourceRef(rule)
      if (seen.has(key)) continue
      seen.add(key)
      refs.push(rule)
    }
  }
  const { resolved, missing, stale } = await resolveRules(refs, fs, cwd, frozen)
  const legacy = binding?.legacy_rules ?? []
  const legacyRefs: ResourceRef[] = []
  for (const name of legacy) {
    const source = await resolveLegacyRuleSource(name, fs, cwd, frozen)
    // An unresolvable legacy name is reported through `missing` so it is visible
    // rather than quietly absent.
    if (source === undefined) { missing.push(name); continue }
    const key = formatResourceRef({ source, name })
    if (seen.has(key)) continue
    seen.add(key)
    legacyRefs.push({ source, name })
  }
  const legacyResult = await resolveRules(legacyRefs, fs, cwd, frozen)
  return {
    resolved: [...resolved, ...legacyResult.resolved],
    missing,
    legacy,
    stale: [...stale, ...legacyResult.stale],
  }
}

/** Return current skill instructions at each stable source-qualified reference. */
async function skillBodiesForBinding(
  binding: StageBinding | undefined,
  fs: Fs,
  cwd?: string,
): Promise<{ name: string; source: ResourceSource; content: string }[]> {
  const result: { name: string; source: ResourceSource; content: string }[] = []
  for (const entry of binding?.skills ?? []) {
    const content = await readSkillAt(entry.skill, fs, cwd)
    if (content !== undefined) result.push({ name: entry.skill.name, source: entry.skill.source, content })
  }
  return result
}

/** Missing live skill files cannot be satisfied by the creation-time archive. */
async function missingSkillRefs(binding: StageBinding | undefined, fs: Fs, cwd?: string): Promise<string[]> {
  const missing: string[] = []
  for (const entry of binding?.skills ?? []) {
    if ((await readSkillAt(entry.skill, fs, cwd)) === undefined) missing.push(formatResourceRef(entry.skill))
  }
  return missing
}

function skillResourceBlockers(missing: string[], stage: string): string[] {
  return missing.map(ref => `${stage}: bound skill ${ref} resolves nowhere; restore the file or remove the binding for a new task`)
}

async function changedSkillRefs(binding: StageBinding | undefined, fs: Fs, cwd: string | undefined,
  baseline?: FrozenResource[]): Promise<string[]> {
  const changed: string[] = []
  for (const entry of binding?.skills ?? []) {
    const key = formatResourceRef(entry.skill)
    const original = baseline?.find(resource => (resource.kind === 'skill'
      || (resource.kind === undefined && resource.content.startsWith('---')))
      && formatResourceRef(resource.ref) === key)
    if (original === undefined) continue
    const live = await readSkillAt(entry.skill, fs, cwd)
    if (live === undefined) changed.push(key + ' (source deleted)')
    else if (hashText(live) !== original.hash) changed.push(key + ' (source edited)')
  }
  return changed
}

/**
 * Render a stage's progressive-disclosure payload: skill names to load via the
 * `skill` tool, plus the resolved rule bodies to follow. Empty text means the
 * stage declares no bindings.
 * @param stage - current stage.
 * @param workflow - effective workflow.
 * @param fs - host filesystem for project-rule resolution.
 * @returns the disclosure text, or an empty string.
 */
async function renderBindings(stage: string, workflow: WorkflowConfig, fs: Fs, cwd?: string, frozen?: FrozenResource[]): Promise<string> {
  const binding = bindingsForStage(stage, workflow)
  const skills = binding?.skills ?? []
  if (binding === undefined || (skills.length === 0 && (binding.legacy_rules ?? []).length === 0)) return ''
  const { resolved: rules, missing, legacy } = await rulesForBinding(binding, fs, cwd, frozen)
  const skillPart = skills.length > 0
    ? `skills to load: ${skills.map(skill => formatResourceRef(skill.skill)).join(', ')}  (use dev_task operation=load_skill with the exact source:name)`
    : 'skills to load: none'
  const currentSkills = await skillBodiesForBinding(binding, fs, cwd)
  const skillInstructions = currentSkills.length > 0
    ? `current skill instructions for this task (read at this interaction):\n${currentSkills.map(skill => `### ${skill.source}:${skill.name}\n${skill.content}`).join('\n\n')}`
    : ''
  const rulePart = rules.length > 0
    ? `rules in force at this stage (each belongs to the skill shown by the binding):\n${rules.map(r => `### ${r.source}:${r.name}\n${r.content}`).join('\n\n')}`
    : ''
  // A bound rule that resolves nowhere is stated explicitly. Silently dropping it
  // left the stage looking as if the constraint had never been configured.
  const missingPart = missing.length > 0
    ? `rules in force at this stage but NOT FOUND in their declared layer: ${missing.join(', ')}`
    : ''
  const missingSkillPart = skills.length > currentSkills.length
    ? `bound skills NOT FOUND in their declared layer: ${(await missingSkillRefs(binding, fs, cwd)).join(', ')}`
    : ''
  // Legacy stage-level rules are disclosed (so nothing is lost) but named as
  // unassigned, because a stage-level list never recorded which skill they were
  // meant for and guessing would invent an answer the config did not contain.
  const legacyPart = legacy.length > 0
    ? `UNASSIGNED legacy stage rules: ${legacy.join(', ')} — these belong to the stage, not to any skill. ` +
      'Assign each to the skill that should carry it (or copy the skill and give each copy its own rules) and record it in skill_profiles.'
    : ''
  // The disclosure names the skills that owe a command receipt, honouring each
    // binding's declared evidence kind — a document-producing skill owes an
    // artifact, not a shell command, and saying otherwise would tell the model to
    // run something irrelevant.
    const additional = skills
      .filter(entry => entry.evidence === undefined || entry.evidence === 'command')
      .map(entry => entry.skill.source === 'codex-project' ? formatResourceRef(entry.skill) : entry.skill.name)
      .filter(name => needsSkillReceipt(name))
  const receiptPart = additional.length
    ? `additional skills requiring skill_result command receipts: ${additional.join(', ')}`
    : 'no command skill_result receipt required for this stage; other evidence kinds follow their configured stage operations'
  return [skillPart, skillInstructions, receiptPart, rulePart, missingPart, missingSkillPart, legacyPart].filter(Boolean).join('\n')
}

/** Narrowed view of `defineTool` args (the raw args are a JsonValue record). */
export interface OpArgs {
  operation: string
  intent?: DeliveryIntent
  intent_reason?: string
  delegation_benefit?: DelegationBenefit
  questions?: InvestigationQuestion[]
  concurrency?: number
  conclusion?: string
  proposal?: string
  limitations?: string[]
  source_evidence?: import('./delivery-contract.ts').SourceLocation[]
  plans?: { id: string; title: string; files: string[]; acceptance: string[]; task_boundary: 'local' | 'independent' | 'coupled'; execution_reason: string; delegation_benefit?: DelegationBenefit; depends_on?: string[] }[]
  task_id?: string
  related_task_id?: string
  relation_kind?: 'defect' | 'enhancement' | 'follow_up'
  branch?: string
  title?: string
  work_size?: 'tiny' | 'standard' | 'complex'
  complexity?: Complexity
  complexity_reason?: string
  ce_task_id?: string
  pull_request?: string
  issue_key?: string
  rule_name?: string
  learning_reason?: string
  disposition_reason?: string
  resources?: InitResource[]
  risk_level?: 'standard' | 'high_risk'
  items?: { id?: string; title?: string; status?: 'todo' | 'doing' | 'done' }[]
  items_mode?: 'merge' | 'replace'
  item_id?: string
  description?: string
  execution?: 'direct' | 'spawn' | 'fork'
  execution_policy?: 'auto' | 'main_only'
  execution_reason?: string
  task_boundary?: 'local' | 'independent' | 'coupled'
  context_need?: 'brief' | 'history'
  acceptance?: string[]
  depends_on?: string[]
  changes?: DeliveryChangeInput[]
  verification_group?: string
  item_ids?: string[]
  affected_items?: string[]
  dispatch_role?: 'implementation' | 'review'
  spec_outcome?: 'pass' | 'fail'
  quality_outcome?: 'pass' | 'fail'
  notes?: string[]
  target_stage?: string
  /** Why the task is going back (revise). Decides the invalidation scope. */
  revision_kind?: 'requirement' | 'solution' | 'defect'
  /** What changed, in the author's words (revise). */
  revision_reason?: string
  command?: string
  passed?: boolean
  evidence?: string[]
  outcome?: 'pass' | 'blocked'
  artifact?: string
  fields?: Record<string, string>
  files?: string[]
  message?: string
  hash?: string
  content?: string
  overwrite?: boolean
  expected_hash?: string
  existing_hash?: string
  sandbox_permissions?: 'workspace-write' | 'danger-full-access'
  justification?: string
  phase?: 'inspect' | 'propose' | 'apply'
  skill_name?: string
}

/** Normalize the tool's `items` argument into complete TaskItem records. */
function dispatchHistory(item?: TaskItem): NonNullable<TaskItem['dispatch_history']> {
  return [...(item?.dispatch_history ?? []), ...(item?.dispatch?.run_id ? [item.dispatch] : [])].slice(-20)
    .map(dispatch => ({ ...dispatch, ...(dispatch.output ? { output: dispatch.output.slice(0, 2000) } : {}) }))
}

function normalizeItems(items: { id?: string; title?: string; status?: 'todo' | 'doing' | 'done' }[] | undefined,
  previous: TaskItem[] = [], mode: 'merge' | 'replace' = 'merge'): TaskItem[] {
  const ids = new Set<string>()
  const result = (items ?? []).map(item => {
    const id = String(item.id ?? '').trim()
    const old = previous.find(entry => entry.id === id)
    const title = String(item.title ?? old?.title ?? '').trim()
    if (!id || !title || ids.has(id)) throw new Error('items require non-empty unique id and title')
    ids.add(id)
    const status = item.status ?? old?.status ?? 'todo'
    if (old?.review && old.title !== title && status === 'done') {
      throw new Error(`item "${id}" has a review: omit title to preserve it, or reopen as todo/doing before changing its title and reviewing again`)
    }
    const unchanged = old?.title === title && !(old.status === 'done' && status !== 'done')
    return { ...(unchanged ? old : old ? { dispatch_history: dispatchHistory(old) } : {}), id, title, status }
  })
  // Incremental updates retain all prior items; an explicit replacement may remove only untouched work.
  const merged = mode === 'merge'
    ? [...previous.map(item => result.find(next => next.id === item.id) ?? item),
      ...result.filter(item => !previous.some(old => old.id === item.id))]
    : [...result, ...previous.filter(item => !ids.has(item.id)
      && (item.status === 'done' || item.status === 'doing' || item.dispatch !== undefined || item.review !== undefined))]
  if (merged.filter(item => item.status === 'doing').length > 1) {
    throw new Error('only one implementation item may be doing')
  }
  return merged
}

/** Hash declared deliverables through host FS; task bookkeeping is excluded to avoid self-invalidation. */
export async function scopeFingerprint(fs: Fs, state: TaskState, cwd?: string, includeGovernance = false): Promise<string> {
  const entries = []
  for (const path of [...new Set(state.files)].filter(path => includeGovernance || !/^\.dsh\/(task-[^/]+\.json|eng\.json|meta\.json)$/.test(path)).sort()) {
    assertInsideRoot(state.root ?? cwd ?? '', state.root ?? cwd ?? '', path)
    const root = state.root ?? cwd
    const target = await fs.resolve(path, root === undefined ? undefined : { cwd: root })
    let content: Uint8Array | undefined
    let executable: boolean | null = null
    try {
      const info = await fs.lstat(path, root === undefined ? undefined : { cwd: root })
      if (info !== undefined) {
        if (info.type !== undefined && info.type !== 'file') throw new Error(`task scope contains a non-regular file: ${path}`)
        executable = false
        if (process.platform !== 'win32') {
          try { executable = (lstatSync(resolve(root ?? '', path)).mode & 0o111) !== 0 }
          catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error }
        }
        const reader = fs as unknown as { readBytes?: (target: unknown, signal: AbortSignal | undefined, maxBytes: number) => Promise<Uint8Array>;
          readText: (target: unknown) => Promise<string> }
        content = reader.readBytes ? await reader.readBytes(target, undefined, 100 * 1024 * 1024)
          : Buffer.from(await reader.readText(target), 'utf8')
      }
    } catch (error) {
      if (!['ENOENT', 'FS_NOT_FOUND'].includes((error as { code?: string }).code ?? '')) throw error
    }
    entries.push([path, content === undefined ? null : hashBytes(content), executable])
  }
  return hashText(JSON.stringify(entries))
}

/** Current test inputs, shared with the ledger and checked independently by the hook. */
export async function verificationInputHashes(fs: Fs, state: TaskState, cwd?: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(Object.values(state.verification_groups ?? {}).map(async group =>
    [group.id, await scopeFingerprint(fs, { ...state, files: groupInputs(state, group) }, cwd, true)])))
}

async function itemVerificationBlockers(fs: Fs, state: TaskState, id: string, cwd?: string): Promise<string[]> {
  if (state.verification_version) return groupEvidenceBlockers(state, await verificationInputHashes(fs, state, cwd), id)
  return !state.verification.passed || !state.verification.receipt?.test_summary?.count
    || state.verification.receipt.scope_hash !== await scopeFingerprint(fs, state, cwd)
    ? ['run verify on current task files before accepting item review or marking an item done'] : []
}

async function itemContextScope(fs: Fs, state: TaskState, id: string, cwd?: string): Promise<string> {
  return scopeFingerprint(fs, state.verification_version ? { ...state, files: [...new Set(requiredGroups(state, id).flatMap(group => groupInputs(state, group)))] } : state, cwd)
}

/** A previous pass cannot authorize a changed tree. Commands still need meaningful human-reviewed coverage. */
async function evidenceBlockers(fs: Fs, state: TaskState, workflow: WorkflowConfig, cwd?: string): Promise<string[]> {
  const blockers: string[] = []
  for (const item of state.items) {
    if (state.verification_version && item.review?.verification_key !== undefined && item.review.verification_key !== verificationKey(state, item.id))
      blockers.push(`item ${item.id}: required test receipt changed; review_item again after verification`)
    if (item.review?.scope_hash && item.review.scope_hash !== await scopeFingerprint(fs, { ...state, files: item.execution_plan?.files ?? state.files }, cwd))
      blockers.push(`item ${item.id}: item review is stale after delivery changes; re-verify and review_item`)
    if (item.review?.independent_run_id && item.execution_plan && item.independent_review?.scope_hash
      !== await scopeFingerprint(fs, { ...state, files: item.execution_plan.files }, cwd))
      blockers.push(`item ${item.id}: independent review is stale after delivery changes; re-verify and review_dispatch`)
  }
  const current = await scopeFingerprint(fs, state, cwd)
  blockers.push(...verificationEvidenceBlockers(state, workflow, current, state.verification_version ? await verificationInputHashes(fs, state, cwd) : undefined))
  blockers.push(...reviewEvidenceBlockers(state, current))
  // Staleness is judged on the RECORDED verification, not only on a passing one.
  // Gating this on `passed` meant a re-verification that FAILED removed its own
  // receipt from consideration, so the failure produced no blocker at all —
  // failing verification was strictly weaker than never verifying. A receipt that
  // exists but no longer matches the current tree, or a verification that is not
  // passing while the flow requires it, both belong here.
  const receipt = state.verification.receipt
  if (!state.verification_version && receipt !== undefined && !state.verification.passed && receipt.scope_hash !== current) {
    blockers.push('verification is stale after file/scope changes; rerun verify with a real command')
  } else if (verificationBlockers(state, workflow).length > 0) {
    // Only where the flow actually holds a verification requirement: a task that
    // has not reached a verification gate yet has nothing to re-verify, and
    // reporting it there would block the flow from starting at all.
    blockers.push('verification is not passing; rerun verify with a real command')
  }
  for (const stage of obligationStages(state, workflow)) {
    for (const entry of workflow.stage_bindings?.[stage]?.skills ?? []) {
      const name = formatResourceRef(entry.skill)
      const content = await readSkillAt(entry.skill, fs, cwd)
      const rules = await resolveRules(entry.rules, fs, cwd, state.flow?.resources)
      if (content === undefined || rules.missing.length) continue
      const inputHash = hashText(JSON.stringify([content, rules.resolved.map(rule => [rule.source, rule.name, rule.content])]))
      const loaded = state.skill_loads?.[stage]?.[name]
      const refs = [entry.skill, ...entry.rules]
      const changed = refs.some(ref => {
        const original = state.flow?.resources?.find(resource => formatResourceRef(resource.ref) === formatResourceRef(ref))
        const live = ref === entry.skill ? content : rules.resolved.find(rule => rule.source === ref.source && rule.name === ref.name)?.content
        return original && hashText(live ?? '') !== original.hash
      })
      if ((loaded && loaded.input_hash !== inputHash) || (!loaded && changed))
        blockers.push(`${stage}: Skill/Rule inputs changed; load_skill ${name} again and rerun affected evidence`)
    }
    for (const [name, result] of Object.entries(state.skill_results?.[stage] ?? {})) {
      const binding = (workflow.stage_bindings?.[stage]?.skills ?? []).find(entry =>
        name === entry.skill.name || name === `${entry.skill.source}:${entry.skill.name}`)
      if (!binding || !needsSkillReceipt(name, binding.evidence)) continue
      if (result.receipt?.scope_hash !== current) blockers.push(`skill_result for ${name} is stale after file/scope changes; rerun its validation command`)
    }
  }
  return blockers
}

async function assertFreshEvidence(fs: Fs, state: TaskState, workflow: WorkflowConfig, cwd?: string): Promise<void> {
  const blockers = [...await evidenceBlockers(fs, state, workflow, cwd), ...await sonarBlockers(fs, state, cwd)]
  if (blockers.length) throw new Error(blockers.join('; '))
}

async function sonarBlockers(fs: Fs, state: TaskState, cwd?: string): Promise<string[]> {
  if (state.sonar_policy === undefined || !['代码审核', '完成'].includes(state.stage)) return []
  const current = await scopeFingerprint(fs, state, cwd)
  const commit = state.commits.findLast(entry => entry.hash !== undefined)?.hash
  const blockers = sonarCommitBlockers(state.sonar_policy, state.sonar_audit, current, commit)
  if (state.sonar_policy.source === 'ide-local' && state.sonar_audit && state.root) {
    const updated = lastLocalRuleUpdate(state.sonar_policy, state.root)
    if (updated && updated !== state.sonar_audit.rules_updated_at) blockers.push('project rules were updated; rerun sonar_check and review')
    const rulesHash = localRulesFingerprint(state.sonar_policy, state.root)
    if (rulesHash && rulesHash !== state.sonar_audit.rules_hash) blockers.push('local rule configuration changed; rerun sonar_check and review')
  }
  return blockers
}

/** Explicit item headings in a task plan, for checking plan/ledger consistency. */
export function plannedItemIds(steps: string): string[] {
  return [...new Set(steps.split(/\r?\n/u).flatMap(line => {
    const match = /^\s*(?:[-*+]\s+|#{1,6}\s+)?([A-Za-z][A-Za-z0-9_-]*\d+)\b/u.exec(line)
    return match === null ? [] : [match[1]!]
  }))]
}

function taskPlanItemBlockers(state: TaskState): string[] {
  if (state.stage !== '任务编排' || state.complexity === undefined) return []
  const ids = plannedItemIds(state.artifacts['task-plan']?.steps ?? '')
  if (!ids.length) return ['task-plan.steps must list implementation items on separate lines with stable IDs (for example, - I1 ...); use the same IDs in dev_task items']
  const recorded = new Set(state.items.map(item => item.id))
  const missing = ids.filter(id => !recorded.has(id))
  const unplanned = state.items.filter(item => !ids.includes(item.id)).map(item => item.id)
  return [...(missing.length ? [`task plan items missing from ledger: ${missing.join(', ')}`] : []),
    ...(unplanned.length ? [`ledger items absent from task plan: ${unplanned.join(', ')}`] : []),
    ...(state.delegation_version ? state.items.filter(item => !item.execution_plan).map(item => `item ${item.id}: plan_execution is required before leaving orchestration`) : []), ...executionCoverageBlockers(state)]
}

/** One optional, reviewable learning candidate per server rule, never an automatic Rule. */
function ruleLearningCandidates(state: TaskState): { rule: string; count: number; example: SonarFinding }[] {
  const audits = [...(state.sonar_history ?? []), state.sonar_audit].filter((audit): audit is SonarAudit | SonarHistoryRef => audit !== undefined)
  const learnedKeys = new Set((state.learned_rules ?? []).map(entry => entry.issue_key))
  const eligible = audits.flatMap(audit => unresolvedBlockingFindings(audit))
  const learnedRules = new Set(eligible
    .filter(issue => learnedKeys.has(issue.key)).map(issue => issue.rule))
  const byRule = new Map<string, { rule: string; count: number; example: SonarFinding; keys: Set<string> }>()
  for (const issue of eligible) {
    if (learnedRules.has(issue.rule)) continue
    const candidate = byRule.get(issue.rule) ?? { rule: issue.rule, count: 0, example: issue, keys: new Set<string>() }
    if (!candidate.keys.has(issue.key)) { candidate.keys.add(issue.key); candidate.count++ }
    byRule.set(issue.rule, candidate)
  }
  return [...byRule.values()].map(({ rule, count, example }) => ({ rule, count, example }))
}

function sonarDetailPath(audit: SonarAudit): string {
  if (!audit.report_path?.endsWith('.md')) throw new Error('Sonar report path is missing')
  return audit.report_path.slice(0, -3) + '.json'
}

function fullSonarAudit(entry: SonarAudit | SonarHistoryRef): entry is SonarAudit {
  return Array.isArray((entry as SonarAudit).findings)
}

async function storeSonarDetail(fs: Fs, audit: SonarAudit, cwd: string | undefined,
  mode: 'workspace-write' | 'danger-full-access'): Promise<string> {
  const path = sonarDetailPath(audit)
  const info = await (fs as unknown as WriteFs).lstat(path, cwd === undefined ? undefined : { cwd })
  await writeText(fs, path, JSON.stringify(audit, null, 2) + '\n', cwd, mode,
    info ? { kind: 'replaceIfVersion', version: info.version } : { kind: 'createIfAbsent' })
  return path
}

async function compactSonarHistory(fs: Fs, state: TaskState, cwd: string | undefined,
  mode: 'workspace-write' | 'danger-full-access'): Promise<void> {
  const entries = [...(state.sonar_history ?? []), ...(state.sonar_audit ? [state.sonar_audit] : [])].slice(-20)
  const compact: (SonarAudit | SonarHistoryRef)[] = []
  for (const entry of entries) {
    if (!fullSonarAudit(entry)) { compact.push({ ...entry, blocking: entry.blocking.slice(0, 50),
      ...(entry.dispositions ? { dispositions: entry.dispositions.slice(0, 50) } : {}) }); continue }
    if (!entry.report_path && !state.sonar_policy) { compact.push(entry); continue }
    if (!entry.report_path) await writeSonarReport(fs, state, entry, cwd, mode)
    const detail_path = await storeSonarDetail(fs, entry, cwd, mode)
    compact.push({ checked_at: entry.checked_at, gate: entry.gate, target: entry.target,
      scope_hash: entry.scope_hash, report_path: entry.report_path!, detail_path,
      finding_count: entry.findings.length, blocking_count: entry.blocking.length,
      blocking: entry.blocking.slice(0, 50), ...(entry.dispositions ? { dispositions: entry.dispositions.slice(0, 50) } : {}) })
  }
  state.sonar_history = compact
}

async function writeSonarReport(fs: Fs, state: TaskState, audit: SonarAudit, cwd: string | undefined,
  mode: 'workspace-write' | 'danger-full-access'): Promise<void> {
  if (!state.sonar_policy) throw new Error('SonarQube is not enabled for this task')
  const path = sonarReportPath(state.id, audit)
  await writeText(fs, path, renderSonarReport(state.id, state.sonar_policy, audit), cwd, mode,
    { kind: 'createIfAbsent' })
  audit.report_path = path
  await storeSonarDetail(fs, audit, cwd, mode)
}

async function updateSonarReport(fs: Fs, state: TaskState, audit: SonarAudit, cwd: string | undefined,
  mode: 'workspace-write' | 'danger-full-access'): Promise<void> {
  if (!state.sonar_policy || !audit.report_path) throw new Error('the current Sonar audit has no report to update')
  const info = await (fs as unknown as WriteFs).lstat(audit.report_path, cwd === undefined ? undefined : { cwd })
  if (!info) throw new Error('the current Sonar report is missing; rerun sonar_check')
  await writeText(fs, audit.report_path, renderSonarReport(state.id, state.sonar_policy, audit), cwd, mode,
    { kind: 'replaceIfVersion', version: info.version })
  await storeSonarDetail(fs, audit, cwd, mode)
}

async function inspectCompletedSonar(policy: SonarPolicy, token: string, ceTaskId: string, target: string,
  scopeHash: string, signal: AbortSignal, commit: string): Promise<Awaited<ReturnType<typeof inspectSonar>>> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (signal.aborted) throw new Error('SonarQube audit was cancelled')
    try { return await inspectSonar(policy, token, ceTaskId, target, scopeHash, fetch, true, commit) }
    catch (error) {
      if (!/Compute Engine task is (PENDING|IN_PROGRESS)/u.test(String(error)) || attempt === 59) throw error
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, 5000)
        const onAbort = () => { clearTimeout(timer); reject(new Error('SonarQube audit was cancelled')) }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
  }
  throw new Error('SonarQube analysis did not finish within five minutes')
}

/** Resolve one item by id for the item-scoped audit operations. */
function requireItem(state: TaskState, id: string | undefined): TaskItem {
  if (id === undefined || id === '') throw new Error('dispatch/review_item requires item_id')
  const item = state.items.find(candidate => candidate.id === id)
  if (item === undefined) {
    throw new Error(`unknown item "${id}"; items: ${state.items.map(candidate => candidate.id).join(', ') || 'none'}`)
  }
  return item
}

/** Confirmation gates satisfied by a human approval, never by the task record. */
const CONFIRMATION_GUARDS: readonly GuardName[] = ['requirement_confirmation', 'solution_confirmation']

/** Narrow runtime view of the shared `approval` service (read optionally). */
interface ApprovalAsk {
  request(input: {
    agent: unknown
    toolName: string
    callId?: string
    reason?: string
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

/** Human-readable label for a confirmation gate, used in the approval reason. */
function confirmationLabel(guard: GuardName): string {
  return guard === 'requirement_confirmation' ? '需求' : '方案'
}

/**
 * Ask a human to approve the pending confirmation gates, then re-run the
 * transition check. `'allowed-once'` satisfies the gates; every other outcome
 * (`rejected`/`cancelled`/`unavailable`) leaves them unmet and the advance
 * rejected. The approval audit pair lands on the agent's session log.
 */
export async function approveAdvance(
  ctx: Context,
  state: TaskState,
  target: string,
  workflow: WorkflowConfig,
  confirmations: GuardName[],
  exec: ToolRunContext,
): Promise<Result> {
  const approval = ctx.get('approval') as ApprovalAsk | undefined
  const labels = [...new Set(confirmations.map(confirmationLabel))].join('、')
  if (approval === undefined) {
    return { ok: false, errors: [`${labels}确认需人工批准，但审批服务不可用`] }
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: 'dev_task',
    callId: exec.callId,
    reason: `${labels}确认：请确认「${state.title}」的${labels}已达成，批准后流转到下一阶段。`,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    const verb = outcome === 'rejected' ? '被驳回' : outcome === 'cancelled' ? '已取消' : '无人批准'
    return { ok: false, errors: [`${labels}确认${verb}，流转被拒绝。保持当前阶段；先获取用户的修改意见并修订，不要假定误操作或直接重复申请。`] }
  }
  if (confirmations.includes('requirement_confirmation')) state.requirement_confirmed = true
  if (confirmations.includes('solution_confirmation')) state.solution_confirmed = true
  return assertAdvance(state, target, workflow)
}

const OPERATIONS = ['status', 'assess', 'create', 'plan', 'delegate', 'submit_analysis', 'recover_analysis', 'accept_item', 'load_skill', 'record', 'items', 'scope', 'plan_verification', 'plan_execution', 'dispatch', 'review_dispatch', 'recover_dispatch', 'review_item', 'advance', 'verify', 'sonar_check', 'sonar_disposition', 'learn_rule', 'review', 'commit', 'complete', 'revise', 'config', 'install_hook', 'verify_hook', 'init', 'init_project', 'set_risk', 'skill_result'] as const

const TOOL_DESCRIPTION =
  'First select the user deliverable: diagnosis/proposal creates intent=analysis with task_id, title, intent_reason (branch optional), investigates directly, then submit_analysis accepts exact source_evidence and a conclusion/proposal/limitations in one transaction. ' +
  'Minimal analysis create: {"operation":"create","task_id":"TRACE-1","title":"Trace a missing field","intent":"analysis","intent_reason":"User requested cause and proposal only"}. ' +
  'Use delegate for explicitly beneficial read-only child questions; never call native subagent aliases. Analysis has no implementation/test/Sonar stage. For requested code changes use intent=implementation, plan complete units, verify genuinely, then accept_item. Legacy calls below remain supported. ' +
  'Track engineering delivery in a workspace task record and enforce configured stage guards. Read or create the task record, record a ' +
  'stage artifact, record each implementation item\'s start and two-stage (spec + quality) ' +
  'review audit (the flow decides how many verdicts per item), advance one stage (rejected unless every configured guard already holds, including ' +
  'the stage artifacts; a requirement/solution confirmation guard asks a human to approve instead of ' +
  'being satisfied by the model), record verification or review, and gate a commit on ' +
  'stage/scope/message, and mark the task complete only once its configured finish conditions ' +
    'hold — reaching the last stage is not itself completion. The init operation manages the ' +
    'protected AGENTS.md in three phases ' +
  '(inspect → propose → apply; overwriting an existing file requires human approval) because DSH ' +
  'injects that file into every session. The tool refuses illegal moves ' +
  'instead of degrading — treat a rejection as a fact to fix, not a prompt to retry another way.'

/**
 * Register the `dev_task` tool on the calling scope. Call from an agent-plane
 * plugin (a row in `agent.cordis.yml`) so the tool is filed in that preset's
 * scope layer and only sessions on that preset see it.
 * @param ctx - a scoped context whose `tools` and `fs` resolve to the host registries.
 */
export function registerDevTask(ctx: Context): void {
  installDeliveryAccess(ctx, async agent => {
    const cwd = agent.session.header.cwd
    if (!cwd) return undefined
    const names = await projectProbe(ctx.fs).list?.(cwd, '.dsh') ?? []
    const candidates: TaskState[] = []
    for (const name of names.filter(name => /^task-.+\.json$/u.test(name))) {
      const raw = await readText(ctx.fs, `.dsh/${name}`, cwd)
      if (!raw) continue
      try {
        const task = JSON.parse(raw) as TaskState
        if (task.delivery?.parent_session === agent.session.id) candidates.push(task)
      } catch { /* A bad unrelated record is reported by the ledger, never treated as this session's policy. */ }
    }
    return candidates.sort((a, b) => b.delivery!.created_at.localeCompare(a.delivery!.created_at))[0]
  })
  ctx.tools.register(defineTool({
    name: 'dev_task',
    description: TOOL_DESCRIPTION,
    parameters: {
      operation: { type: 'string', enum: [...OPERATIONS], required: true, description: 'Which task-record action to perform.' },
      intent: { type: 'string', enum: ['analysis', 'implementation'], description: 'create/assess: select what the user asked to receive, before complexity. analysis is a read-only diagnosis/proposal; implementation uses project engineering gates. Omission preserves legacy contracts.' },
      intent_reason: { type: 'string', description: 'Concrete user goal supporting intent (required when intent is supplied).' },
      delegation_benefit: { type: 'string', enum: ['parallel', 'context_isolation', 'independent_check'], description: 'Concrete delegation benefit; independent boundaries alone do not spawn under the new delivery contract.' },
      concurrency: { type: 'integer', description: 'delegate: bounded read-only concurrency 1–4, default 2; code writes remain serial.' },
      plans: { type: 'array', description: 'plan: atomically register implementation units and their execution choices; exact file ownership, dependencies and acceptance. Delete/rename plans use plan_execution.changes.', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, title: { type: 'string', required: true }, files: { type: 'array', items: { type: 'string' }, required: true },
        acceptance: { type: 'array', items: { type: 'string' }, required: true }, task_boundary: { type: 'string', enum: ['local', 'independent', 'coupled'], required: true },
        execution_reason: { type: 'string', required: true }, delegation_benefit: { type: 'string', enum: ['parallel', 'context_isolation', 'independent_check'] },
        depends_on: { type: 'array', items: { type: 'string' } },
      } } },
      questions: { type: 'array', description: 'delegate: concrete independent investigation questions, not implementation tasks.', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, question: { type: 'string', required: true }, references: { type: 'array', items: { type: 'string' } }, depends_on: { type: 'array', items: { type: 'string' } },
      } } },
      conclusion: { type: 'string', description: 'submit_analysis: confirmed causes and their reasoning; report central findings early in conversation.' },
      proposal: { type: 'string', description: 'submit_analysis: actionable proposal; does not authorize implementation.' },
      limitations: { type: 'array', items: { type: 'string' }, description: 'submit_analysis: explicitly unknown or unverified aspects.' },
      source_evidence: { type: 'array', description: 'submit_analysis: relevant current-source locations. Use 1-based ranges, at most 200 lines each. Host always captures the full range and hashes; optional quote only highlights an exact matching substring.', items: { type: 'object', additionalProperties: false, properties: {
        file: { type: 'string', required: true }, start_line: { type: 'integer', required: true }, end_line: { type: 'integer', required: true }, quote: { type: 'string', description: 'Optional exact substring to highlight, without line-number prefixes. The complete source range is saved whether quote is supplied or omitted.' },
      } } },
      task_id: { type: 'string', description: 'Required on create and every task operation except assess/status. Omit on status to discover tasks in the current workspace; optionally filter by branch.' },
      related_task_id: { type: 'string', description: 'Archived source task for a new defect, enhancement or follow-up. New work always gets a new task_id.' },
      relation_kind: { type: 'string', enum: ['defect', 'enhancement', 'follow_up'], description: 'How a newly created task relates to related_task_id.' },
      skill_name: { type: 'string', description: 'Bound skill to load or record. For a codex-project skill, pass codex-project:name to load_skill and skill_result. Command evidence needs a real validation command; manual evidence needs human approval.' },
      branch: { type: 'string', description: 'Current git branch. New intent contracts can omit it; the engine reads Git HEAD or records unversioned. Required only for legacy create.' },
      title: { type: 'string', description: 'Task title (create).' },
      work_size: { type: 'string', enum: ['tiny', 'standard', 'complex'], description: 'Optional workload tier (create), default standard. This is separate from complexity; do not pass low/medium/high here.' },
      complexity: { type: 'string', enum: ['low', 'medium', 'high', 'ultra'], description: 'Task-level complexity (assess/create). Select from requirement scope and implementation dependencies; independent of risk_level. Passing this on create selects the adaptive meta-skill flow.' },
      complexity_reason: { type: 'string', description: 'Evidence-based reason for the selected complexity (create).' },
      ce_task_id: { type: 'string', description: 'SonarQube Compute Engine task id from a CI scan (sonar_check in CI mode). Omit for local mode: the plugin runs the scanner and reads its task id.' },
      pull_request: { type: 'string', description: 'GitLab merge request IID or PR number when SonarQube mode is pull-request (sonar_check).' },
      issue_key: { type: 'string', description: 'A SonarQube finding key: current local audit for sonar_disposition, or audit history for learn_rule.' },
      disposition_reason: { type: 'string', description: 'Specific explanation of why the current local finding is a false positive (sonar_disposition). Requires human approval and supporting evidence.' },
      rule_name: { type: 'string', description: 'New project Rule name (learn_rule).' },
      learning_reason: { type: 'string', description: 'Why this failure generalizes beyond the current line of code (learn_rule).' },
      resources: { type: 'array', description: 'Project Skill/Rule drafts for init_project propose/apply; content is reviewed before creation.',
        items: { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', enum: ['skill', 'rule'] }, name: { type: 'string' }, description: { type: 'string' },
          content: { type: 'string' }, meta_skills: { type: 'array', items: { type: 'string' } },
          rules: { type: 'array', items: { type: 'string' } },
        } } },
      risk_level: { type: 'string', enum: ['standard', 'high_risk'], description: 'Risk tier (create).' },
      items: {
        type: 'array',
        description: 'Implementation items (create/items). items defaults to merge by id, retaining omitted entries. Use items_mode=replace only for deliberate replanning; completed or audited items are still retained. For an existing id, omit title to preserve its title and audit.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string', enum: ['todo', 'doing', 'done'] },
          },
        },
      },
      items_mode: { type: 'string', enum: ['merge', 'replace'], description: 'items operation: merge by id (default) or explicitly replace untouched items and reorder the supplied list.' },
      item_id: { type: 'string', description: 'Item id to start or review (dispatch/review_item).' },
      description: { type: 'string', description: 'Implementation intent (dispatch); the current agent may execute it directly.' },
      execution: { type: 'string', enum: ['direct', 'spawn', 'fork'], description: 'plan_execution: omit for automatic routing; use direct with a concrete cost/benefit reason for very small independent work. dispatch reads the recorded mode; legacy dispatch defaults to direct. Children still need parent verification and review.' },
      execution_policy: { type: 'string', enum: ['auto', 'main_only'], description: 'create: auto (default) chooses from task boundaries and real host capabilities; main_only honors a request to keep work and review in the main session.' },
      execution_reason: { type: 'string', description: 'Required with delegate: explain the concrete benefit of delegating these questions. Also used by plan_execution to explain the task boundary and execution choice. No user reminder is required.' },
      task_boundary: { type: 'string', enum: ['local', 'independent', 'coupled'], description: 'plan_execution: local small change, independent deliverable with explicit acceptance, or tightly coupled work. Do not split work merely to spawn children.' },
      context_need: { type: 'string', enum: ['brief', 'history'], description: 'plan_execution: brief (default) gives a fresh child only its task context; history requests fork only when completed parent history is needed.' },
      acceptance: { type: 'array', items: { type: 'string' }, description: 'plan_execution: concrete acceptance conditions for this item.' },
      depends_on: { type: 'array', items: { type: 'string' }, description: 'plan_execution: earlier registered item IDs that must finish first.' },
      changes: { type: 'array', description: 'plan_execution: explicitly planned delete/rename operations. Keep old paths and rename destinations in files and task scope. The engine captures tracked Git and pre-change worktree text for readonly review.',
        items: { type: 'object', properties: { path: { type: 'string' }, kind: { type: 'string', enum: ['delete', 'rename'] }, to: { type: 'string' } }, additionalProperties: false } },
      verification_group: { type: 'string', description: 'plan_verification/verify: stable test-group ID, for example backend or frontend. Plan each group with command, files including tests/configuration, and item_ids. Verify executes its declared command; no group is inferred from printed output.' },
      item_ids: { type: 'array', items: { type: 'string' }, description: 'plan_verification: implementation items validated by this group. Each item includes its own implementation and tests, never a later test item depending on its completion.' },
      affected_items: { type: 'array', items: { type: 'string' }, description: 'revise(defect): explicit affected item IDs. Shared files and downstream consumers also reopen. Omit for unknown or task-wide impact. Requirements/solution revisions remain task-wide.' },
      dispatch_role: { type: 'string', enum: ['implementation', 'review'], description: 'recover_dispatch: which interrupted child to recover; default implementation.' },
      spec_outcome: { type: 'string', enum: ['pass', 'fail'], description: 'Specification-conformance verdict (review_item).' },
      quality_outcome: { type: 'string', enum: ['pass', 'fail'], description: 'Code-quality verdict (review_item).' },
      notes: { type: 'array', items: { type: 'string' }, description: 'Findings or defects (review_item).' },
      target_stage: { type: 'string', description: 'Stage to advance to (advance), a bound stage for skill_result, or the stage to return to (revise). A defect can also reopen the current implementation stage. Other revisions must return to an earlier relevant stage. Current/upcoming terminal skill binding stage for skill_result.' },
      command: { type: 'string', description: 'Real acceptance command for verify or a command-evidence skill_result. New task verification requires a command receipt; other skills follow their configured evidence kind. Propagate failures when composing shell commands.' },
      passed: { type: 'boolean', description: 'Deprecated input; verification requires a real command and test result receipt.' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Supplementary verification evidence (verify).' },
      outcome: { type: 'string', enum: ['pass', 'blocked'], description: 'Review outcome (review).' },
      artifact: { type: 'string', description: 'Artifact id from status.artifact_requirements for the current stage (record).' },
      fields: {
        type: 'object',
        description: 'Field values using only keys listed by status.artifact_requirements (record). Put questions and tradeoffs inside an allowed text field, not new keys. Allowed fields come from the frozen workflow and may differ between presets.',
        additionalProperties: true,
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Repo-relative paths in scope (create/scope) or being committed (commit).',
      },
      message: { type: 'string', description: 'Commit summary to validate (commit).' },
      revision_kind: { type: 'string', enum: ['requirement', 'solution', 'defect'], description: 'Why the task is going back (revise). Decides which conclusions are invalidated: requirement clears its confirmation and everything downstream; solution keeps the requirement agreed; defect clears only the evidence about the old implementation.' },
      revision_reason: { type: 'string', description: 'What changed, in the author\'s words (revise).' },
      hash: { type: 'string', description: 'Commit hash to record after the git commit (commit).' },
      content: { type: 'string', description: 'Full AGENTS.md body (init propose/apply). Inspect the existing file first via init phase=inspect.' },
      overwrite: { type: 'boolean', description: 'Allow replacing an existing AGENTS.md (init apply); triggers human approval.' },
      expected_hash: { type: 'string', description: 'The content hash returned by init phase=propose; apply is rejected without it, or with a different hash (init apply).' },
      existing_hash: { type: 'string', description: 'The existing-file hash returned by init phase=propose; when the current AGENTS.md exists, a mismatching existing_hash proves it changed during review (init apply).' },
      sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: 'Sandbox mode for this call\'s file writes and verify/skill_result/local Sonar scanner command. Commands otherwise use the session policy. Retry a denied command with justification; danger-full-access requires approval before execution and applies only to this call.' },
      justification: { type: 'string', description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact operation needs the wider access.' },
      phase: { type: 'string', enum: ['inspect', 'propose', 'apply'], description: 'init phase: inspect (read-only), propose (preview draft, no write), apply (write; overwriting an existing file requires human approval).' },
    },
    output: {
      schema: { type: 'string' },
      render(_args: unknown, value: string) {
        return [{ type: 'text', text: value }]
      },
    },
    async execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<string> {
      const a = args as unknown as OpArgs
      const fs = ctx.fs
      // Task governance stays anchored to the original project. Native-tool cd does
      // not move its ledger or grant another root; child/check commands use task.root explicitly.
      const executionDirectory = exec.agent ? await ctx.get('workingDirectory')?.ensure(exec.agent, exec.signal) : undefined
      const cwd = exec.agent?.session.header.cwd ?? executionDirectory
      const session = exec.agent?.session as unknown as SkillSession | undefined
      const mutationPath = a.task_id ? (process.platform === 'win32' ? resolve(cwd ?? process.cwd(), taskPath(a.task_id)).toLowerCase() : resolve(cwd ?? process.cwd(), taskPath(a.task_id))) : undefined
      const release = mutationPath && !['status', 'config', 'assess', 'delegate'].includes(a.operation)
        ? acquireTaskMutation(process.platform === 'win32' ? mutationPath.toLowerCase() : mutationPath) : undefined
      try {

      if (a.operation === 'status' && !a.task_id) {
        const tasks: { id: string; title: string; branch: string; stage: string; lifecycle: 'active' | 'ready_to_close' | 'archived'; completed_at?: string; complexity?: Complexity }[] = []
        const names = await projectProbe(fs).list?.(cwd ?? '', '.dsh') ?? []
        for (const name of names.filter(name => /^task-.+\.json$/.test(name))) {
          const raw = await readText(fs, `.dsh/${name}`, cwd)
          if (!raw) continue
          const task = JSON.parse(raw) as TaskState
          if (!a.branch || task.branch === a.branch) tasks.push({ id: task.id, title: task.title, branch: task.branch, stage: task.stage,
            lifecycle: task.completed ? 'archived' : task.stage === task.flow?.config.stages.at(-1) ? 'ready_to_close' : 'active',
            ...(task.completed ? { completed_at: task.completed.at } : {}),
            ...(task.complexity !== undefined ? { complexity: task.complexity } : {}) })
        }
        return JSON.stringify({ tasks, required_create_fields: ['task_id', 'title', 'intent', 'intent_reason'], next_action: tasks.length ? 'Archived tasks are read-only. Create a new task for a new requirement or post-delivery feedback; continue an active task only for the same unfinished requirement. Ask the user only when ownership is ambiguous.' : 'No task found. Create with task_id, title, intent=analysis|implementation and intent_reason. New contracts read the Git branch automatically; implementation should include the assessed complexity and complexity_reason.' }, null, 2)
      }

      if (a.operation === 'config') {
        const resolved = await resolveWorkflow(fs, cwd)
        return JSON.stringify({
          source: resolved.source,
          valid: resolved.problems.length === 0,
          problems: resolved.problems,
          workflow: resolved.config,
          adaptive: { grades: COMPLEXITY_OPTIONS, config_path: '.dsh/meta.json', task_selected: true },
        }, null, 2)
      }

      if (a.operation === 'assess') {
        if (a.intent === 'analysis') return JSON.stringify({ intent: 'analysis', stages: analysisWorkflow().stages,
          instruction: 'Investigate directly; no implementation items, synthetic tests or Sonar required. Create with intent=analysis and intent_reason. Delegate read-only questions only when it has a concrete benefit.' })
        if (a.complexity === undefined) {
          return JSON.stringify({ grades: COMPLEXITY_OPTIONS,
            instruction: 'Analyze the requirement, choose one grade, then call assess with complexity to preview its stages and effective Skill sources. Record the reason on create. Risk is assessed separately.' }, null, 2)
        }
        if (!isComplexity(a.complexity)) throw new Error(`unknown complexity "${String(a.complexity)}"`)
        const config = await resolveAdaptiveWorkflow(a.complexity, fs, cwd)
        return JSON.stringify({ complexity: a.complexity, stages: config.stages,
          meta_skills: Object.fromEntries(Object.entries(config.stage_bindings ?? {}).map(([stage, binding]) =>
            [stage, (binding.skills ?? []).map(entry => ({ logical_name: entry.skill.name, effective_source: entry.skill.source,
              rules: entry.rules }))])),
          artifacts: config.artifacts, review_depth: config.review_depth }, null, 2)
      }

      if (a.operation === 'install_hook') {
        await installCommitHook(fs, cwd, await resolveWriteMode(ctx, a, exec))
        return 'installed commit-msg hook in the Git worktree and registered this task workspace'
      }

      if (a.operation === 'verify_hook') {
        const { repoRoot, hooksRel, workspaceRel } = hookPaths(cwd)
        const installed = await readText(fs, join(hooksRel, 'commit-msg'), repoRoot)
        if (installed === undefined) {
          return 'no .git/hooks/commit-msg installed — run install_hook first'
        }
        const roots = await readText(fs, join(hooksRel, 'dsh-task-roots.json'), repoRoot)
        if (hashText(installed) === hashText(HOOK_TEMPLATE)
          && (workspaceRel === '.' || (roots !== undefined && (JSON.parse(roots) as { roots?: string[] }).roots?.includes(workspaceRel)))) {
          if (process.platform !== 'win32' && (statSync(resolve(repoRoot, hooksRel, 'commit-msg')).mode & 0o111) === 0) {
            throw new Error('hook integrity FAILED — commit-msg 缺少执行权限；重新运行 install_hook')
          }
          return 'hook integrity OK — installed commit-msg matches the bundled gate and this workspace is registered'
        }
        throw new Error('hook integrity FAILED — hook differs from the bundle or this workspace is not registered; run install_hook')
      }

      if (a.operation === 'init_project') {
        const root = await detectRoot(projectProbe(fs), cwd ?? '')
        if (!cwd || resolve(root) !== resolve(cwd)) {
          throw new Error('init_project must run with the project root as the session workspace')
        }
        const phase = a.phase ?? 'inspect'
        const inventory = await scanProject(projectProbe(fs), root)
        if (phase === 'inspect') return JSON.stringify(inventory, null, 2)
        if (phase !== 'propose' && phase !== 'apply') throw new Error('init_project phase must be inspect, propose, or apply')
        const resources = validateInitResources(a.resources)
        const existingMetaSkills = new Set<string>()
        for (const { name } of projectMetaSkillTargets(inventory.project_name)) {
          if (await readText(fs, `.dsh/skills/${name}/SKILL.md`, cwd) !== undefined) existingMetaSkills.add(name)
        }
        for (const resource of resources) {
          if (resource.kind !== 'skill' || resource.name !== `${inventory.project_name}-project-map`) continue
          const gaps = projectMapCoverageGaps(resource.content, inventory)
          if (gaps.length) throw new Error(`project map omits repository-wide evidence: ${gaps.join(', ')}. Describe each discovered module or manifest in the reusable project map; keep feature-specific findings in task artifacts.`)
        }
        const metaRaw = await readText(fs, '.dsh/meta.json', cwd)
        const meta = await readAdaptiveConfig(fs, cwd)
        const createdRules = new Set(resources.filter(resource => resource.kind === 'rule').map(resource => resource.name))
        const paths: string[] = []
        for (const resource of resources) {
          const path = resource.kind === 'rule' ? `.dsh/rules/${resource.name}.md` : `.dsh/skills/${resource.name}/SKILL.md`
          assertInsideRoot(root, cwd, path)
          if (await readText(fs, path, cwd) !== undefined) throw new Error(`init_project will not overwrite ${path}`)
          paths.push(path)
          if (resource.kind === 'skill') {
            const profilePath = `.dsh/skills/${resource.name}/profile.json`
            if (await readText(fs, profilePath, cwd) !== undefined) throw new Error(`init_project will not overwrite ${profilePath}`)
            paths.push(profilePath)
            for (const rule of resource.rules ?? []) {
              if (!createdRules.has(rule) && await readText(fs, `.dsh/rules/${rule}.md`, cwd) === undefined) {
                throw new Error(`Skill ${resource.name} references missing project Rule ${rule}`)
              }
            }
          }
        }
        const metaHash = hashText(metaRaw ?? '')
        const inventoryHash = hashText(JSON.stringify(inventory))
        const proposalHash = hashText(JSON.stringify(resources) + '\n' + metaHash + '\n' + inventoryHash)
        if (phase === 'propose') return JSON.stringify({ inventory, resources, files_to_create: paths,
          project_map_coverage: projectMapCoveragePaths(inventory),
          meta_config: '.dsh/meta.json', existing_hash: metaHash, expected_hash: proposalHash,
          instruction: 'Review each project-specific claim against the listed evidence. A *-project-map Skill must describe the whole repository and remain useful across unrelated requirements; move current-feature details to task artifacts or a separately named feature Skill. Apply with identical resources and expected_hash; existing files are protected.' }, null, 2)
        if (a.expected_hash !== proposalHash || a.existing_hash !== metaHash) {
          throw new Error('init_project draft or meta config changed since propose; inspect and propose again')
        }
        const writeMode = await resolveWriteMode(ctx, a, exec)
        // Publish rules first, then Skills/profiles, then the binding map. A failed final
        // write can leave unbound resources, but never a live binding to an absent Rule.
        for (const resource of resources.filter(resource => resource.kind === 'rule')) {
          await writeText(fs, `.dsh/rules/${resource.name}.md`, resource.content.trimEnd() + '\n', cwd,
            writeMode, { kind: 'createIfAbsent' })
        }
        for (const resource of resources.filter(resource => resource.kind === 'skill')) {
          const description = resource.description!.replace(/[\r\n]+/gu, ' ').trim()
          const body = `---\nname: ${resource.name}\ndescription: ${description}\n---\n\n${resource.content.trimEnd()}\n`
          await writeText(fs, `.dsh/skills/${resource.name}/SKILL.md`, body, cwd,
            writeMode, { kind: 'createIfAbsent' })
          const profile: SkillProfile = { rules: (resource.rules ?? []).map(name => ({ source: 'project', name })), evidence: 'none' }
          await writeText(fs, `.dsh/skills/${resource.name}/profile.json`, JSON.stringify(profile, null, 2) + '\n', cwd,
            writeMode, { kind: 'createIfAbsent' })
        }
        const bindings: NonNullable<AdaptiveConfig['meta_bindings']> = { ...meta.meta_bindings }
        for (const { meta: stage, name } of projectMetaSkillTargets(inventory.project_name)) {
          if (existingMetaSkills.has(name)) bindings[stage] = [...new Set([...(bindings[stage] ?? []), name])]
        }
        for (const resource of resources.filter(resource => resource.kind === 'skill')) {
          for (const skill of resource.meta_skills ?? []) {
            bindings[skill] = [...new Set([...(bindings[skill] ?? []), resource.name])]
          }
        }
        const info = await (fs as unknown as WriteFs).lstat('.dsh/meta.json', { cwd })
        await writeText(fs, '.dsh/meta.json', JSON.stringify({ ...meta, meta_bindings: bindings }, null, 2) + '\n', cwd,
          writeMode, info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version })
        return JSON.stringify({ created: [...paths, '.dsh/meta.json'], bindings,
          team_files: [...paths, '.dsh/meta.json'],
          next_action: 'Review and commit the generated .dsh/skills, .dsh/rules and .dsh/meta.json as team configuration. Call assess to inspect the effective project Skills before creating a task.' }, null, 2)
      }

      if (a.operation === 'init') {
        const phase = a.phase ?? 'inspect'
        const existing = await readText(fs, 'AGENTS.md', cwd)

        if (phase === 'inspect') {
          const root = await detectRoot(projectProbe(fs), cwd ?? '')
          const type = await detectType(projectProbe(fs), root)
          const verifyCommand = defaultVerifyCommand(type)
          const others = (await presentGovernanceFiles(projectProbe(fs), root)).filter(name => name !== 'AGENTS.md')
          const projectRules = await listProjectRules(projectProbe(fs), root)
          const projectSkills = await listProjectSkills(projectProbe(fs), root)
          const summary = [
            `project root: ${root}`,
            `language stack: ${type}${verifyCommand !== undefined ? ` — default verify command: ${verifyCommand}` : ''}`,
            others.length > 0 ? `other governance files in effect: ${others.join(', ')} — read them and keep their conventions; init manages only AGENTS.md` : undefined,
            `project-level bindings: rules [${projectRules.join(', ') || 'none'}] · skills [${projectSkills.join(', ') || 'none'}] (convention: .dsh/rules/*.md, .dsh/skills/<name>/SKILL.md)`,
          ].filter(line => line !== undefined).join('\n')
          if (existing === undefined) {
            return `no AGENTS.md yet — scan the project (structure, stack, build/run, conventions, redlines) and call init phase=propose with content: a Markdown body of at most ${INIT_MAX_LINES} lines.\n${summary}`
          }
          return `existing AGENTS.md (${lineCount(existing)} lines, cap ${INIT_MAX_LINES}) is already injected into every session in this workspace. Reuse it as-is, or rewrite it via init phase=propose then phase=apply (overwriting requires human approval):\n---\n${existing}\n---\n${summary}`
        }

        const content = a.content
        if (content === undefined || content.trim() === '') {
          throw new Error(`init phase=${phase} requires non-empty content`)
        }
        const lines = lineCount(content)
        if (lines > INIT_MAX_LINES) {
          throw new Error(`AGENTS.md is ${lines} lines; the cap is ${INIT_MAX_LINES}. Trim to the essentials (what the project is, how to run/build it, structure, conventions, redlines) and retry.`)
        }

        if (phase === 'propose') {
          const action = existing === undefined ? 'create' : 'overwrite'
          const existingHash = existing === undefined ? undefined : hashText(existing)
          return `proposed ${action} ./AGENTS.md (${lines} lines, cap ${INIT_MAX_LINES}). No file was written — review the draft, then call init phase=apply${existing !== undefined ? ' (overwriting requires human approval)' : ''} with the same content:\n---\n${content}\n---\n(content hash: ${hashText(content)} — pass it back as expected_hash on apply to prove the content is unchanged${existingHash !== undefined ? `; existing hash: ${existingHash} — pass it back as existing_hash on apply to prove the file has not changed during review` : ''})`
        }

        if (phase === 'apply') {
          if (a.expected_hash === undefined) {
            throw new Error('init apply requires expected_hash returned by propose — re-propose to obtain it')
          }
          if (a.expected_hash !== hashText(content)) {
            throw new Error(`init content changed since propose (expected_hash mismatch) — resubmit the identical proposed content`)
          }
          if (existing !== undefined) {
            if (a.existing_hash === undefined) {
              throw new Error('init apply requires existing_hash returned by propose when AGENTS.md exists — re-propose to obtain it')
            }
            if (a.existing_hash !== hashText(existing)) {
              throw new Error('AGENTS.md changed since propose (existing_hash mismatch) — re-inspect and re-propose before overwriting')
            }
          }
          if (existing !== undefined && a.overwrite !== true) {
            throw new Error(`AGENTS.md already exists (${lineCount(existing)} lines) and is protected. Inspect via init phase=inspect, merge, then resubmit with phase=apply plus overwrite: true (human approval).`)
          }
          if (existing !== undefined) {
            const approval = ctx.get('approval') as ApprovalAsk | undefined
            if (approval === undefined) {
              throw new Error('overwriting the protected AGENTS.md requires human approval, but the approval service is unavailable')
            }
            const outcome = await approval.request({
              agent: exec.agent,
              toolName: 'dev_task',
              callId: exec.callId,
              reason: `init 覆盖：请确认允许覆盖工作区已有 AGENTS.md（${lineCount(existing)} 行）`,
              signal: exec.signal,
            })
            if (outcome !== 'allowed-once') {
              throw new Error(`overwriting AGENTS.md was not approved (${outcome}); nothing was written`)
            }
          }
          const initRoot = await detectRoot(projectProbe(fs), cwd ?? '')
          assertInsideRoot(initRoot, cwd ?? '', 'AGENTS.md')
          await writeText(fs, 'AGENTS.md', content, cwd, await resolveWriteMode(ctx, a, exec))
          return `wrote ./AGENTS.md (${lines} lines, cap ${INIT_MAX_LINES}). DSH injects it into every session in this workspace from now on.`
        }

        throw new Error(`unknown init phase "${phase}" (expected inspect|propose|apply)`)
      }

      if (a.operation === 'create') {
        const required: ('task_id' | 'title' | 'branch' | 'intent_reason')[] = a.intent ? ['task_id', 'title', 'intent_reason'] : ['task_id', 'title', 'branch']
        const missing = required.filter(field => !a[field]?.trim())
        if (!a.task_id || !a.title || missing.length) {
          throw new Error(`create requires ${required.join(', ')}; missing: ${missing.join(', ')}. New-contract example: ${JSON.stringify({ operation: 'create', task_id: 'TASK-1', title: 'Concrete user goal', intent: a.intent === 'analysis' ? 'analysis' : 'implementation', intent_reason: 'What the user asked to receive' })}. Branch is optional when intent is supplied.`)
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(a.task_id)) {
          throw new Error('task_id must be 1–64 ASCII letters, digits, hyphens or underscores, starting with a letter or digit')
        }
        if (await fs.lstat(taskPath(a.task_id), cwd === undefined ? undefined : { cwd }) !== undefined) throw new Error('task_id already exists; inspect status and continue it, or use a new task_id. Existing records are never replaced by create.')
        if (a.complexity !== undefined && !isComplexity(a.complexity)) throw new Error(`unknown complexity "${String(a.complexity)}"`)
        if ((a.related_task_id === undefined) !== (a.relation_kind === undefined)) throw new Error('related_task_id and relation_kind must be provided together')
        if (a.related_task_id === a.task_id) throw new Error('a follow-up task needs its own task_id')
        if (a.related_task_id !== undefined) {
          const related = await loadTask(fs, a.related_task_id, cwd)
          if (related.completed === undefined) throw new Error('related source task must be archived before creating a post-delivery follow-up')
        }
        if (a.complexity !== undefined && !a.complexity_reason?.trim()) {
          throw new Error('adaptive create requires complexity_reason explaining the requirement evidence for this grade')
        }
        const adaptiveConfig = a.complexity === undefined ? undefined : await readAdaptiveConfig(fs, cwd)
        const resolved = a.intent === 'analysis'
          ? { flow: 'analysis-v1', version: 1, config: analysisWorkflow(), problems: [] }
          : a.complexity !== undefined
          ? { flow: `adaptive-${a.complexity}`, version: ADAPTIVE_VERSION,
              config: await resolveAdaptiveWorkflow(a.complexity, fs, cwd, adaptiveConfig), problems: [] }
          : await resolveWorkflow(fs, cwd)
        if (resolved.problems.length > 0) {
          throw new Error(`invalid .dsh/eng.json — fix the project config first:\n- ${resolved.problems.join('\n- ')}`)
        }
        const risk = a.risk_level ?? 'standard'
        if (a.intent !== 'analysis' && risk === 'high_risk' && !workflowSatisfies(resolved.config, HIGH_RISK_REQUIRED_CAPABILITIES)) {
          throw new Error(
            `high_risk task cannot run on flow "${resolved.flow}" — it lacks the required capabilities ` +
            `(${HIGH_RISK_REQUIRED_CAPABILITIES.join(', ')}). Use the standard flow or lower the task risk.`,
          )
        }
        const sonarPolicy = a.intent === 'analysis' || adaptiveConfig === undefined ? undefined : sonarPolicyFor(adaptiveConfig)
        if (sonarPolicy?.source === 'ide-local' && resolved.config.stages.includes('代码审核')) {
          resolved.config.commit = { ...resolved.config.commit, checkpoints: ['代码审核'] }
        }
          // Freeze the resolved skill and rule bodies now. A name alone cannot keep an
          // in-flight task stable: editing a rule the task uses would otherwise change
          // what the task is doing without the task saying so.
          const frozen = await freezeResources(resolved.config, fs, cwd)
          if (frozen.unreadable.length > 0) {
            throw new Error(`cannot create task with unreadable bound resources: ${frozen.unreadable.join(', ')}`)
          }
        const flow: FlowSnapshot = {
          flow: resolved.flow,
          version: resolved.version,
          config: resolved.config,
          hash: hashConfig(resolved.config),
            resources: frozen.resources,
        }
        const root = await detectRoot(projectProbe(fs), cwd ?? '')
        let branch = a.branch?.trim()
        if (!branch) {
          let head = await readText(fs, '.git/HEAD', root)
          if (head === undefined) {
            const gitDir = (await readText(fs, '.git', root))?.match(/^gitdir:\s*(.+)\s*$/u)?.[1]?.trim()
            if (gitDir) head = await readText(fs, resolve(root, gitDir, 'HEAD'), root)
          }
          branch = head?.trim().match(/^ref:\s*refs\/heads\/(\S+)$/u)?.[1]
            ?? (head && /^[a-f0-9]{40,64}$/iu.test(head.trim()) ? `detached@${head.trim().slice(0,12)}` : 'unversioned')
        }
        const state = newTask({
          id: a.task_id,
          title: a.title,
          branch,
          work_size: a.work_size ?? 'standard',
          risk_level: risk,
          ...(a.complexity !== undefined ? { complexity: a.complexity, complexity_reason: a.complexity_reason!.trim() } : {}),
          ...(sonarPolicy !== undefined ? { sonar_policy: sonarPolicy } : {}),
          flow,
          root,
          project_type: await detectType(projectProbe(fs), root),
        })
        if (a.related_task_id !== undefined) state.related_task = { id: a.related_task_id, kind: a.relation_kind! }
        if (a.intent !== undefined) {
          state.delivery = deliveryContract(a.intent, a.intent_reason ?? '')
          if (session?.id) state.delivery.parent_session = session.id
          const events = (session?.snapshotEvents() ?? []) as readonly { type: string; time?: number; data: { source?: { kind?: string } } }[]
          const request = [...events].reverse().find(event => event.type === 'user/message' && event.data.source?.kind === 'user' && typeof event.time === 'number')
          if (request?.time !== undefined) state.delivery.requested_at = new Date(request.time).toISOString()
        }
        state.items = normalizeItems(a.items)
        state.execution_version = 1
        if (state.complexity !== undefined && !isAnalysis(state)) { state.delegation_version = 1; state.verification_version = 1; state.execution_policy = a.execution_policy ?? 'auto' }
        if (isAnalysis(state)) {
          if (state.items.length) throw new Error('analysis does not use implementation items; create without items, then investigate directly or delegate questions')
          if (a.files?.length) state.delivery!.references = a.files
          state.execution_policy = a.execution_policy ?? 'auto'
        }
        state.files = isAnalysis(state) ? [] : a.files ?? []
        let baselineNotice = ''
        if (sonarPolicy?.source === 'ide-local') {
          try { state.sonar_baseline = await captureLocalAuditBaseline(root, sonarPolicy.reference_branch ?? 'HEAD') }
          catch { baselineNotice = '\nExisting changes baseline unavailable; local audit will conservatively require every changed code file in the task scope.' }
        }
        assertInsideRoot(root, cwd ?? '', taskPath(state.id))
        await writeTask(fs, state, cwd, await resolveWriteMode(ctx, a, exec))
        bindDeliveryIntent(exec.agent, state.delivery?.intent)
        if (isAnalysis(state)) return JSON.stringify({ created: state.id, delivery: deliveryView(state),
          instruction: 'Read source and return findings early. Finish with submit_analysis; no synthetic implementation items, tests or commits. Project Skills are available as relevant investigation context.' })
        return `created ${state.id} at stage ${state.stage}; legal next: ${legalTargets(state.stage, flow.config).join(', ') || 'none'}\n${await renderBindings(state.stage, flow.config, fs, cwd, flow.resources)}\nBefore advance, load all bound skills${state.complexity !== undefined ? ' with dev_task load_skill and exact source:name' : ''}. Record each skill's declared evidence. Terminal bindings must finish before entering the terminal stage.${baselineNotice}`
      }

      if (!a.task_id) throw new Error('task_id is required for this operation')
      const state = await loadTask(fs, a.task_id, cwd)
      bindDeliveryIntent(exec.agent, state.delivery?.intent)
      const workflow = await workflowFor(state, fs, cwd)
      if (state.completed !== undefined && a.operation === 'complete') {
        return `task already completed at ${state.completed.at}`
      }
      if (state.completed !== undefined && a.operation !== 'status') {
        throw new Error('task is archived and read-only; create a new task_id and link it with related_task_id for follow-up work')
      }

      if (isAnalysis(state) && a.operation !== 'status') return await executeAnalysisCommand(a, {
        ctx, exec, fs, state, cwd, session, mutationPath: mutationPath!, writeMode: () => resolveWriteMode(ctx, a, exec),
      })
      if (state.items.some(item => [item.dispatch, item.independent_review].some(run => ['starting', 'running'].includes(run?.status ?? '')))
        && a.operation !== 'status' && a.operation !== 'recover_dispatch') {
        throw new Error('a child dispatch is still active; wait or recover it before changing the parent task')
      }

      if (a.operation === 'load_skill') {
        const stage = a.target_stage ?? state.stage
        if (!obligationStages(state, workflow).includes(stage)) throw new Error(`stage "${stage}" is not currently actionable; current stage is "${state.stage}". Load its bound skills now; use advance only after its gates pass, then load the next stage's skills.`)
        const entry = (workflow.stage_bindings?.[stage]?.skills ?? [])
          .find(binding => formatResourceRef(binding.skill) === a.skill_name)
        if (!entry) throw new Error('load_skill requires an exact source:name bound at the current or upcoming terminal stage')
        const content = await readSkillAt(entry.skill, fs, cwd)
        if (content === undefined) throw new Error(`bound skill ${a.skill_name} cannot be read`)
        const { resolved, missing } = await resolveRules(entry.rules, fs, cwd, state.flow?.resources)
        if (missing.length) throw new Error(`bound rule for ${a.skill_name} cannot be read: ${missing.join(', ')}`)
        const inputHash = hashText(JSON.stringify([content, resolved.map(rule => [rule.source, rule.name, rule.content])]))
        const previous = state.skill_loads?.[stage]?.[a.skill_name!]
        const changedSinceCreation = [entry.skill, ...entry.rules].some(ref => {
          const original = state.flow?.resources?.find(resource => formatResourceRef(resource.ref) === formatResourceRef(ref))
          const live = ref === entry.skill ? content : resolved.find(rule => rule.source === ref.source && rule.name === ref.name)?.content
          return original && hashText(live ?? '') !== original.hash
        })
        if ((previous && previous.input_hash !== inputHash) || (!previous && changedSinceCreation)) {
          state.verification = { passed: false, evidence: [] }
          state.review = { outcome: 'pending' }
          delete state.skill_results?.[stage]?.[a.skill_name!]
          delete state.skill_results?.[stage]?.[entry.skill.name]
          if (entry.evidence === 'artifact') for (const artifact of workflow.artifacts.filter(artifact => artifact.stage === stage)) delete state.artifacts[artifact.id]
        }
        state.skill_loads ??= {}
        state.skill_loads[stage] ??= {}
        state.skill_loads[stage]![a.skill_name!] = { input_hash: inputHash, session_id: session?.id ?? '', at: new Date().toISOString() }
        await writeTask(fs, state, cwd, await resolveWriteMode(ctx, a, exec))
        return [`skill: ${a.skill_name}`, `current skill instructions:\n${content}`,
          resolved.length ? `rules attached to this skill:\n${resolved.map(rule => `### ${rule.source}:${rule.name}\n${rule.content}`).join('\n\n')}` : 'rules attached to this skill: none'].join('\n\n')
      }

      if (a.operation === 'status') {
        if (isAnalysis(state)) return JSON.stringify({ id: state.id, stage: state.stage, lifecycle: state.completed ? 'archived' : 'active', delivery: deliveryView(state) })
        const binding = bindingsForStage(state.stage, workflow)
        const {
          resolved: rules,
          missing: missingRules,
          legacy: legacyRules,
          stale: staleRules,
        } = await rulesForBinding(binding, fs, cwd, state.flow?.resources)
        const missingSkillFiles = await missingSkillRefs(binding, fs, cwd)
        const changedSkillFiles = await changedSkillRefs(binding, fs, cwd, state.flow?.resources)
        const missingSkills = skillBlockers(state, workflow, session)
        const staleEvidence = await evidenceBlockers(fs, state, workflow, cwd)
        const checkpoint = commitCheckpoint(state, workflow)
        // The flow's verification requirement is reported separately from staleness:
        // one says the receipt no longer matches the tree, the other says the flow
        // needs a passing verification and does not have one. Callers act on both.
        const verification = verificationBlockers(state, workflow)
        const commitBlockers = [...staleEvidence, ...missingSkills,
          ...skillResourceBlockers(missingSkillFiles, state.stage), ...verification]
        const completionIssues = state.completed === undefined
          ? [...completionBlockers(state, workflow), ...missingSkills,
            ...skillResourceBlockers(missingSkillFiles, state.stage),
            ...resourceBlockers(missingRules, state.stage), ...staleEvidence, ...await sonarBlockers(fs, state, cwd)]
          : []
        const planItemBlockers = taskPlanItemBlockers(state)
        return JSON.stringify({
          id: state.id,
          stage: state.stage,
          flow: state.flow !== undefined ? { flow: state.flow.flow, version: state.flow.version } : null,
          ...(state.delivery ? { delivery: deliveryView(state) } : {}),
          risk_level: state.risk_level,
          complexity: state.complexity ?? null,
          complexity_reason: state.complexity_reason ?? null,
          completed: state.completed ?? null,
          lifecycle: state.completed ? 'archived' : state.stage === workflow.stages.at(-1) ? 'ready_to_close' : 'active',
          related_task: state.related_task ?? null,
          completion_blockers: completionIssues,
          work_size: state.work_size,
          requirement_confirmed: state.requirement_confirmed,
          solution_confirmed: state.solution_confirmed,
          items_done: `${state.items.filter(i => i.status === 'done').length}/${state.items.length}`,
          items: state.items,
          execution_policy: state.execution_policy ?? 'legacy-direct',
          subagent_capabilities: executionCapabilities(ctx, !!exec.agent),
          execution_planning: state.delegation_version ? { required: true, operation: 'plan_execution',
            instruction: 'For every item record boundary, files, acceptance and execution_reason in orchestration or before implementation. Omit execution to route automatically. dispatch then uses the recorded plan; independent review uses review_dispatch before review_item.' } : { required: false },
          verification_planning: { required: !!state.verification_version, operation: 'plan_verification',
            blockers: groupPlanningBlockers(state), groups: state.verification_groups ?? {},
            example: { operation: 'plan_verification', verification_group: 'backend', item_ids: ['BE'], files: ['src/service.java', 'test/service.test.java', 'pom.xml'], command: 'mvn test' },
            instruction: 'One item includes implementation and its necessary tests. Declare every required test group before dispatch; verify one group at a time. No test-count or coverage claims are inferred from model text.' },
          verification_runs: (state.verification_runs ?? []).map(run => ({ id: run.id, group_id: run.group_id,
            command: run.receipt.command, finished_at: run.receipt.finished_at, exit_code: run.receipt.exit_code,
            test_count: run.receipt.test_summary?.count ?? null, passed: run.passed, invalidated_reason: run.invalidated_reason })),
          task_plan_item_blockers: planItemBlockers,
          skill_obligations: obligationStages(state, workflow).map(stage => {
            const bindings = workflow.stage_bindings?.[stage]?.skills ?? []
            const skills = bindings.map(entry => state.complexity !== undefined || entry.skill.source === 'codex-project'
              ? formatResourceRef(entry.skill) : entry.skill.name)
            // Only bindings whose evidence is a command owe a command receipt, so a
            // document-producing skill is not told to run something irrelevant.
            const command_receipts_required = bindings
              .filter(entry => entry.evidence === undefined || entry.evidence === 'command')
              .map(entry => state.complexity !== undefined || entry.skill.source === 'codex-project'
                ? formatResourceRef(entry.skill) : entry.skill.name)
              .filter(name => needsSkillReceipt(name))
            return { stage, skills, command_receipts_required }
          }),
          skill_blockers: missingSkills,
          evidence_blockers: staleEvidence,
          verification_blockers: verification,
          // Rules in force here, each named with the layer it came from, plus the
          // ones that could not be found and the legacy stage-level names still
          // awaiting an owner. A skill's own list is the complete answer to what it
          // runs under, and this mirrors that list for the current stage.
          missing_rules: missingRules,
          missing_skills: missingSkillFiles,
          changed_source_skills: changedSkillFiles,
          rules: rules.map(rule => ({ name: rule.name, source: rule.source })),
          // Rules that differ from the creation-time audit copy. Edited bodies
          // are already in force; deleted sources are reported as missing.
          stale_source_rules: staleRules,
          resource_update_notice: changedSkillFiles.length || staleRules.length
            ? 'Skill/Rule source changed since task creation; the current source body is in force. Recheck prior evidence against the updated instructions.'
            : undefined,
          unassigned_legacy_rules: legacyRules,
          skill_results: state.skill_results ?? {},
          commits: state.commits,
          verification: state.verification,
          review: state.review,
          sonar: state.sonar_policy === undefined ? { enabled: false } : {
            enabled: true, mode: state.sonar_policy.mode, project_key: state.sonar_policy.project_key,
            source: state.sonar_policy.source ?? 'ci', reference_branch: state.sonar_policy.reference_branch,
            audit: state.sonar_audit ?? null, blockers: await sonarBlockers(fs, state, cwd),
            prior_audits: state.sonar_history?.length ?? 0,
          },
          learned_rules: state.learned_rules ?? [],
          rule_learning_candidates: ruleLearningCandidates(state),
          artifact_requirements: workflow.artifacts.filter(def => def.stage === state.stage).map(def => ({
            id: def.id, name: def.name, fields: def.fields,
            missing_fields: def.fields.filter(field => !(state.artifacts[def.id]?.[field] ?? '').trim()),
          })),
          artifacts: state.artifacts,
          files: state.files,
          legal_next: legalTargets(state.stage, workflow),
          actionable_operations: ['status', 'load_skill', 'record', 'scope', 'items', 'plan_verification', 'verify', 'revise',
            ...(['任务编排', '开发', '代码开发'].includes(state.stage) ? ['plan_execution'] : []),
            ...(['开发', '代码开发'].includes(state.stage) ? ['dispatch', 'review_item', 'review_dispatch'] : []),
            ...(state.stage === '代码审核' ? ['sonar_check', 'review'] : []), 'advance'],
          commit: checkpoint.allowed && commitBlockers.length
            ? { ...checkpoint, allowed: false, reason: commitBlockers.join('; ') }
            : checkpoint,
          bindings: {
            skills: binding?.skills ?? [],
            skill_contents: await skillBodiesForBinding(binding, fs, cwd),
            // The layer is disclosed with each rule, because two same-named rules in
            // different layers are distinct resources and the caller needs to know
            // which one is actually in force. Reporting only the name made them
            // indistinguishable in exactly the case where the distinction matters.
            rules: rules.map(r => ({ name: r.name, source: r.source, content: r.content })),
          },
          risk_downgrades: state.risk_downgrades ?? [],
          risk_changes: state.risk_changes ?? [],
        }, null, 2)
      }

      if (a.operation === 'sonar_check') {
        if (!state.sonar_policy) throw new Error('SonarQube is not enabled for this task')
        if (state.stage !== '代码审核') throw new Error('sonar_check runs only in the 代码审核 stage')
        const functionalProblems = await evidenceBlockers(fs, state, workflow, cwd)
        if (!state.verification.passed || functionalProblems.length) {
          throw new Error(`functional verification must pass on the current files before sonar_check; ${[...functionalProblems, ...(state.verification.problems ?? [])].join('; ') || 'run verify with the required real test command'}`)
        }
        if (state.sonar_policy.source !== 'ide-local' && !state.commits.some(commit => commit.hash !== undefined)) {
          throw new Error('sonar_check requires a recorded Git commit at the 测试 checkpoint; CI mode also requires a push')
        }
        if (state.sonar_policy.source !== 'ide-local') {
          const recorded = state.commits.findLast(commit => commit.hash !== undefined)!
          if (!isFullOid(recorded.hash!)) {
            const canonical = await assertCommittedContent(ctx, fs, state, exec, recorded.hash)
            recorded.provided_hash = recorded.hash!
            recorded.hash = canonical
          }
        }
        const target = state.sonar_policy.mode === 'branch' ? state.branch : a.pull_request
        if (!target) throw new Error('pull-request SonarQube audit requires pull_request')
        const credentialProvider = ctx.get('credentials') as SonarCredentialProvider | undefined
        const token = await resolveSonarToken(credentialProvider, state.root,
          state.sonar_policy.host_url, state.sonar_policy.project_key, process.env[state.sonar_policy.token_env])
        const scopeBefore = await scopeFingerprint(fs, state, cwd)
        if (state.sonar_policy.source === 'ide-local') {
          if (a.ce_task_id) throw new Error('本地规则审核不使用 CI ce_task_id')
          if (!state.files.length) throw new Error('本地规则审核需要先登记当前任务的文件范围')
          const root = state.root ?? cwd
          if (!root) throw new Error('本地规则审核需要项目工作区')
          const audit = await inspectLocalRules(state.sonar_policy, token, root, scopeBefore, exec.signal, state.files,
            false, undefined, state.sonar_baseline)
          if (await scopeFingerprint(fs, state, cwd) !== scopeBefore) {
            throw new Error('本地规则审核期间代码发生变化，请重新测试和审核')
          }
          const mode = await resolveWriteMode(ctx, a, exec)
          await compactSonarHistory(fs, state, cwd, mode)
          state.sonar_audit = audit
          state.review.outcome = 'pending'
          await writeSonarReport(fs, state, audit, cwd, mode)
          await writeTask(fs, state, cwd, mode)
          return JSON.stringify({ gate: audit.gate, blocking: audit.blocking, findings: audit.findings,
            uncovered_files: audit.uncovered_files ?? [], report_path: audit.report_path,
            rule_learning_candidates: ruleLearningCandidates(state),
            next_action: audit.gate === 'OK' ? '继续代码审核；检查历史阻断问题是否有可复用的修复经验，再决定是否通过 learn_rule 提议项目 Rule。误报或一次性问题不要沉淀。'
              : '修复新增代码问题，并处理未覆盖文件；重新测试后再次运行 sonar_check。' }, null, 2)
        }
        let ceTaskId = a.ce_task_id
        if (state.sonar_policy.source === 'local') {
          if (ceTaskId) throw new Error('local sonar_check runs a fresh scan; do not provide a CI ce_task_id')
          const root = state.root ?? cwd
          if (!root) throw new Error('local SonarQube scan needs a project workspace')
          const head = await runVerificationCommand(ctx, 'git rev-parse HEAD', root, exec)
          const branch = await runVerificationCommand(ctx, 'git branch --show-current', root, exec)
          const status = await runVerificationCommand(ctx, 'git status --porcelain --untracked-files=all', root, exec)
          const lastCommit = state.commits.findLast(entry => entry.hash !== undefined)?.hash
          if (head.exit_code !== 0 || branch.exit_code !== 0 || status.exit_code !== 0 || !lastCommit
            || !head.stdout.trim().startsWith(lastCommit) || branch.stdout.trim() !== state.branch) {
            throw new Error('local SonarQube scan requires the recorded commit checked out on the task branch')
          }
          const dirty = status.stdout.split(/\r?\n/u).filter(line => line.trim() && !/^..\s+\.dsh[\\/]/u.test(line))
          if (dirty.length) throw new Error('local SonarQube scan requires a clean working tree outside .dsh; commit or remove unrecorded changes first')
          await assertLocalSonarReady(state.sonar_policy, token)
          const defaultCommand = await readText(fs, 'pom.xml', root) === undefined ? 'sonar-scanner'
            : 'mvn org.sonarsource.scanner.maven:sonar-maven-plugin:5.5.0.6356:sonar'
          const approvedMode = a.sandbox_permissions === undefined ? undefined : await resolveWriteMode(ctx,
            { ...a, command: state.sonar_policy.scan_command?.trim() || defaultCommand }, exec)
          ceTaskId = await runLocalSonar(ctx, state.sonar_policy, token, root, state.branch, exec, defaultCommand, approvedMode)
        }
        if (!ceTaskId) throw new Error('sonar_check requires ce_task_id from this task\'s completed CI scan')
        if (state.sonar_policy.source === 'local' && await scopeFingerprint(fs, state, cwd) !== scopeBefore) {
          throw new Error('local SonarQube scan changed task files; rerun functional verification before auditing')
        }
        const audit = await inspectCompletedSonar(state.sonar_policy, token, ceTaskId, target,
          scopeBefore, exec.signal, state.commits.findLast(entry => entry.hash !== undefined)!.hash!)
        if (await scopeFingerprint(fs, state, cwd) !== scopeBefore) throw new Error('task files changed during Sonar audit; rerun verification and analysis')
        const mode = await resolveWriteMode(ctx, a, exec)
        await compactSonarHistory(fs, state, cwd, mode)
        state.sonar_audit = audit
        state.review.outcome = 'pending'
        await writeSonarReport(fs, state, audit, cwd, mode)
        await writeTask(fs, state, cwd, mode)
        return JSON.stringify({ gate: audit.gate, ...(audit.server_gate ? { server_gate: audit.server_gate } : {}),
          blocking: audit.blocking, findings: audit.findings, report_path: audit.report_path,
          rule_learning_candidates: ruleLearningCandidates(state),
          analysis_id: audit.analysis_id, next_action: audit.gate === 'OK' && audit.blocking.length === 0
            ? 'Review prior blocking issues for reusable fixes with learn_rule; do not learn false positives. Continue code review, then record review pass.'
            : 'Record review blocked, fix findings, rerun tests and the scan, then call sonar_check again.' }, null, 2)
      }

      if (a.operation === 'sonar_disposition') {
        if (state.stage !== '代码审核' || state.sonar_policy?.source !== 'ide-local' || !state.sonar_audit) {
          throw new Error('sonar_disposition only applies to the current ide-local audit in the 代码审核 stage')
        }
        if (state.sonar_audit.scope_hash !== await scopeFingerprint(fs, state, cwd)) {
          throw new Error('the local audit is stale after code changes; rerun verification and sonar_check')
        }
        const issue = state.sonar_audit.blocking.find(entry => entry.key === a.issue_key)
        if (!issue) throw new Error('issue_key must identify a blocking finding in the current local audit')
        if (state.sonar_audit.dispositions?.some(entry => entry.issue_key === issue.key)) {
          throw new Error('this finding already has an approved disposition')
        }
        if (!a.disposition_reason?.trim() || a.disposition_reason.trim().length < 30
          || a.disposition_reason.length > 2000 || !a.evidence?.length || a.evidence.length > 6
          || a.evidence.some(item => !item.trim() || item.length > 500)) {
          throw new Error('false-positive disposition needs a specific reason of at least 30 characters and non-empty supporting evidence')
        }
        const approval = ctx.get('approval') as ApprovalAsk | undefined
        if (!approval || !exec.agent) throw new Error('false-positive disposition requires the human approval service')
        const outcome = await approval.request({ agent: exec.agent, toolName: 'dev_task', callId: exec.callId,
          reason: `本地 Sonar 误报复核：${issue.rule} · ${issue.file}${issue.line === undefined ? '' : `:${issue.line}`}（${issue.key}）。\n原因：${a.disposition_reason.trim()}\n证据：${a.evidence.join('；')}\n仅对此次未变化的本地审核结果有效，不修改服务端规则或原始结果。是否批准？`,
          signal: exec.signal })
        if (outcome !== 'allowed-once') throw new Error(`false-positive disposition was not approved (${outcome})`)
        if (state.sonar_audit.scope_hash !== await scopeFingerprint(fs, state, cwd)) {
          throw new Error('code changed during false-positive approval; rerun verification and sonar_check')
        }
        state.sonar_audit.dispositions = [...(state.sonar_audit.dispositions ?? []), {
          issue_key: issue.key, kind: 'false_positive', reason: a.disposition_reason.trim(),
          evidence: a.evidence, approved_at: new Date().toISOString(),
        }]
        state.review.outcome = 'pending'
        const mode = await resolveWriteMode(ctx, a, exec)
        await updateSonarReport(fs, state, state.sonar_audit, cwd, mode)
        await writeTask(fs, state, cwd, mode)
        return JSON.stringify({ approved_issue: issue.key, raw_gate: state.sonar_audit.gate,
          review_gate: localReviewGate(state.sonar_audit),
          unresolved_blocking: unresolvedBlockingFindings(state.sonar_audit).length,
          report_path: state.sonar_audit.report_path,
          next_action: '其余问题仍需修复或逐项复核；代码或规则变化后重新测试并运行 sonar_check。' }, null, 2)
      }

      if (a.operation === 'learn_rule') {
        let issue = [state.sonar_audit, ...(state.sonar_history ?? [])].filter((entry): entry is SonarAudit | SonarHistoryRef => entry !== undefined)
          .flatMap(entry => unresolvedBlockingFindings(entry)).find(entry => entry.key === a.issue_key)
        if (!issue) for (const entry of state.sonar_history ?? []) {
          if (fullSonarAudit(entry)) continue
          if (!entry.detail_path.startsWith(`.dsh/reviews/${state.id}/`) || !entry.detail_path.endsWith('.json'))
            throw new Error('invalid Sonar history detail path')
          assertInsideRoot(state.root ?? cwd ?? '', state.root ?? cwd ?? '', entry.detail_path)
          const raw = await readText(fs, entry.detail_path, cwd)
          if (!raw) throw new Error('Sonar history detail is unavailable; restore the archived audit')
          issue = unresolvedBlockingFindings(JSON.parse(raw) as SonarAudit).find(finding => finding.key === a.issue_key)
          if (issue) break
        }
        if (!issue) throw new Error('learn_rule requires a blocking issue_key recorded by this task\'s SonarQube audit')
        if (!a.rule_name || !RESOURCE_NAME.test(a.rule_name) || !a.content?.trim() || a.content.trim().length < 40
          || !a.learning_reason?.trim()) {
          throw new Error('learn_rule needs a new kebab-case rule_name, actionable content of at least 40 characters, and learning_reason')
        }
        const codeSkills = workflow.stage_bindings?.['代码开发']?.skills ?? []
        const binding = codeSkills.find(entry => formatResourceRef(entry.skill) === a.skill_name || entry.skill.name === a.skill_name)
        if (!binding) throw new Error('learn_rule requires a Skill bound to the 代码开发 meta-skill')
        const rulePath = `.dsh/rules/${a.rule_name}.md`
        const skillPath = `.dsh/skills/${binding.skill.name}/SKILL.md`
        const profilePath = `.dsh/skills/${binding.skill.name}/profile.json`
        const root = state.root ?? cwd ?? ''
        if (!cwd || resolve(root) !== resolve(cwd)) throw new Error('learn_rule must run with the task project root as the session workspace')
        for (const path of [rulePath, skillPath, profilePath]) assertInsideRoot(root, cwd ?? root, path)
        if (await readText(fs, rulePath, cwd) !== undefined) throw new Error(`project Rule ${a.rule_name} already exists; edit it through the Rule editor instead`)
        const projectSkill = await readText(fs, skillPath, cwd)
        const sourceSkill = projectSkill ?? await readSkillAt(binding.skill, fs, cwd)
        if (sourceSkill === undefined) throw new Error(`Skill ${formatResourceRef(binding.skill)} cannot be read`)
        const profileRaw = await readText(fs, profilePath, cwd)
        const baseProfile = projectSkill === undefined ? { rules: binding.rules, evidence: binding.evidence }
          : await profileFor({ source: 'project', name: binding.skill.name }, fs, cwd) ?? { rules: [], evidence: binding.evidence }
        const profile: SkillProfile = { rules: [...baseProfile.rules, { source: 'project', name: a.rule_name }],
          ...(baseProfile.evidence !== undefined ? { evidence: baseProfile.evidence } : {}) }
        const ruleBody = `# ${a.rule_name}\n\n${a.content.trimEnd()}\n\n` +
          `> 来源：SonarQube 规则 ${issue.rule}、问题 ${issue.key}。可复用原因：${a.learning_reason.trim()}\n`
        const proposalHash = hashText(JSON.stringify({ issue: issue.key, skill: binding.skill, name: a.rule_name,
          body: ruleBody, profile, profile_hash: hashText(profileRaw ?? '') }))
        const phase = a.phase ?? 'propose'
        if (phase === 'propose') return JSON.stringify({ issue, target_skill: binding.skill,
          project_override: projectSkill === undefined, rule_path: rulePath, rule_body: ruleBody,
          profile_path: profilePath, profile, expected_hash: proposalHash,
          instruction: 'Review the example and generality before apply. The project Rule will affect future tasks; current task bindings remain frozen.' }, null, 2)
        if (phase !== 'apply' || a.expected_hash !== proposalHash) throw new Error('learn_rule apply requires the unchanged expected_hash from propose')
        const mode = await resolveWriteMode(ctx, a, exec)
        await writeText(fs, rulePath, ruleBody, cwd, mode, { kind: 'createIfAbsent' })
        if (projectSkill === undefined) {
          await writeText(fs, skillPath, sourceSkill, cwd, mode, { kind: 'createIfAbsent' })
        }
        const info = await (fs as unknown as WriteFs).lstat(profilePath, { cwd })
        await writeText(fs, profilePath, JSON.stringify(profile, null, 2) + '\n', cwd, mode,
          info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version })
        state.learned_rules = [...(state.learned_rules ?? []), { issue_key: issue.key, rule_name: a.rule_name,
          skill_name: binding.skill.name, at: new Date().toISOString() }]
        await writeTask(fs, state, cwd, mode)
        return JSON.stringify({ created_rule: rulePath, attached_to: `project:${binding.skill.name}`,
          next_action: 'Review this file in Git. New adaptive tasks resolve the project Skill and its Rule automatically.' }, null, 2)
      }

      if (a.operation === 'commit') {
        await assertFreshEvidence(fs, state, workflow, cwd)
        const missingSkills = skillBlockers(state, workflow, session)
        if (missingSkills.length) throw new Error(missingSkills.join('; '))
        const checkpoint = commitCheckpoint(state, workflow)
        if (!checkpoint.allowed) throw new Error(checkpoint.reason ?? 'no commit is due')
        if (workflow.commit.file_scope) {
          if (!a.files || a.files.length === 0) {
            throw new Error('commit requires files (the repo-relative paths being committed) when file_scope is on')
          }
          const scope = checkFileScope(state, a.files, workflow)
          if (!scope.ok) {
            throw new Error(scope.noScope
              ? 'task declares no file scope; record files first (create files=... or scope files=...)'
              : `commit touches files outside the task scope: ${scope.outside.join(', ')}`)
          }
        }
        const riskReceipt = state.verification.receipt
        const riskApproved = state.risk_level === 'high_risk' && riskReceipt !== undefined
          && riskReceipt.exit_code === 0 && !riskReceipt.timed_out && !riskReceipt.aborted
          && !riskReceipt.sandbox?.denied && !riskReceipt.sandbox?.runnerFailed
        if ((a.files ?? []).some(isSensitivePath) && !riskApproved) {
          throw new Error('敏感路径提交要求 high_risk 任务和有效的真实验证回执')
        }
        const message = validateCommitMessage(a.message ?? '', workflow)
        if (!message.ok) throw new Error(message.errors!.join('; '))
        const committedId = taskIdFromMessage(a.message ?? '', workflow)
        if (committedId !== undefined && committedId !== state.id) {
          throw new Error(`commit summary names task "${committedId}" but this operation targets "${state.id}" — put the target task id in the summary`)
        }
        if (a.hash) {
          if (!isOidInput(a.hash)) throw new Error('commit hash must be a Git object id')
          const receipt = await runVerificationCommand(ctx, 'git -c core.quotepath=false log -1 --format=%H%n%s%n --name-only HEAD', state.root ?? cwd, exec)
          if (receipt.exit_code !== 0 || receipt.aborted || receipt.timed_out || receipt.sandbox?.denied || receipt.sandbox?.runnerFailed) throw new Error('cannot verify the recorded Git commit')
          const lines = receipt.stdout.trim().split(/\r?\n/)
          if (!lines[0]?.toLowerCase().startsWith(a.hash.toLowerCase()) || lines[1] !== a.message) throw new Error('Git commit does not match the approved hash and summary')
          const paths = lines.slice(2).map(line => line.trim()).filter(Boolean)
          if (!paths.length || (workflow.commit.file_scope && !checkFileScope(state, paths, workflow).ok)) throw new Error('actual committed files do not match the task scope')
          if (paths.some(isSensitivePath) && !riskApproved) throw new Error('实际提交触及敏感路径，但任务缺少 high_risk 验证回执')
          const canonical = await assertCommittedContent(ctx, fs, state, exec, a.hash)
          const existing = state.commits.find(entry => entry.hash === canonical || entry.hash === a.hash)
          if (existing) { existing.hash = canonical; existing.provided_hash ??= a.hash }
          else state.commits.push({ label: checkpoint.label!, hash: canonical, provided_hash: a.hash })
        }
        await writeTask(fs, state, cwd, await resolveWriteMode(ctx, a, exec))
        if (a.hash) return `commit recorded (${checkpoint.label ?? ''}): ${a.hash}; use status to inspect remaining gates, then advance`
        return `commit approved (${checkpoint.label ?? ''}) — git add ${(a.files ?? []).join(' ')}; git commit -m "${a.message ?? ''}"`
      }

        if (a.operation === 'complete') {
          // Completion is recorded, not inferred from standing on the last stage.
          // A flow whose final stage is also its commit checkpoint used to reach
          // that stage with no delivery record at all, because the "commit before
          // leaving a checkpoint" rule fires on the way OUT of a stage and a
          // terminal stage has no way out.
          await assertFreshEvidence(fs, state, workflow, cwd)
          const missingSkills = skillBlockers(state, workflow, session)
          const currentBinding = bindingsForStage(state.stage, workflow)
          const missingSkillFiles = await missingSkillRefs(currentBinding, fs, cwd)
          const unresolvedRules = (await rulesForBinding(currentBinding, fs, cwd, state.flow?.resources)).missing
          const blockers = [
            ...completionBlockers(state, workflow),
            ...missingSkills,
            ...skillResourceBlockers(missingSkillFiles, state.stage),
            ...resourceBlockers(unresolvedRules, state.stage),
          ]
          if (blockers.length > 0) throw new Error(`cannot complete: ${blockers.join('; ')}`)
          if (state.commits.some(commit => commit.hash)) await assertCommittedContent(ctx, fs, state, exec)
          const hash = state.commits.findLast(commit => commit.hash !== undefined)?.hash
          state.completed = hash === undefined
            ? { at: new Date().toISOString() }
            : { at: new Date().toISOString(), commit_hash: hash }
          if (state.delivery) state.delivery.metrics = parentMetrics(session, Date.parse(state.delivery.requested_at ?? state.delivery.created_at))
          await writeTask(fs, state, cwd, await resolveWriteMode(ctx, a, exec))
          return hash === undefined
            ? `task archived at "${state.stage}"; the record is now read-only`
            : `task archived at "${state.stage}" (commit ${hash}); the record is now read-only`
        }
          if (a.operation === 'revise') {
            // The graph has only forward edges, but the work does not: a requirement can
            // change after implementation started. Before this, going back meant hand-
            // editing the record, which left every downstream conclusion looking intact
            // even though it described a superseded tree.
            const kind = a.revision_kind
            if (kind !== 'requirement' && kind !== 'solution' && kind !== 'defect') {
              throw new Error('revise requires revision_kind: one of requirement, solution, defect')
            }
            if (!a.revision_reason?.trim()) throw new Error('revise requires revision_reason describing what changed')
            const target = a.target_stage
            if (target === undefined || !workflow.stages.includes(target)) {
              throw new Error('revise requires target_stage naming a stage of this flow: ' + workflow.stages.join(', '))
            }
            if (target === state.stage && !(kind === 'defect' && ['开发', '代码开发'].includes(target)))
              throw new Error('same-stage revise is supported only for a defect in the implementation stage; otherwise choose an earlier target_stage')
            // Which stages are reachable backwards is a property of the flow, not of the
            // tool: any earlier stage is a legal place to resume from.
            if (workflow.stages.indexOf(target) > workflow.stages.indexOf(state.stage)) {
              throw new Error('revise goes backwards only; "' + target + '" comes after "' + state.stage + '" in this flow')
            }
            const implementationIndex = workflow.stages.findIndex(stage => stage === '开发' || stage === '代码开发')
            if (state.items.length && implementationIndex >= 0 && workflow.stages.indexOf(target) > implementationIndex)
              throw new Error('revise clears implementation audits; return to the implementation stage or earlier. To refresh only evidence, rerun verify/sonar_check/review in place.')
            if (state.items.some(item => ['running', 'starting'].includes(item.dispatch?.status ?? '')))
              throw new Error('a child dispatch is still active; wait or recover it before revising')
            let impact = kind === 'defect' && state.verification_version && a.affected_items?.length ? affectedItems(state, a.affected_items) : undefined
            if (impact) {
              const hashes = await verificationInputHashes(fs, state, cwd)
              for (const group of Object.values(state.verification_groups ?? {})) {
                const run = latestGroupRun(state, group.id)
                if (run && run.receipt.scope_hash !== hashes[group.id]) impact.push(...group.item_ids)
              }
              for (const [stage, entries] of Object.entries(state.skill_loads ?? {})) for (const binding of workflow.stage_bindings?.[stage]?.skills ?? []) {
                const loaded = entries[formatResourceRef(binding.skill)]
                if (!loaded) continue
                const content = await readSkillAt(binding.skill, fs, cwd)
                const rules = await resolveRules(binding.rules, fs, cwd, state.flow?.resources)
                const currentKey = hashText(JSON.stringify([content, rules.resolved.map(rule => [rule.source, rule.name, rule.content])]))
                if (content === undefined || rules.missing.length || currentKey !== loaded.input_hash) impact = state.items.map(item => item.id)
              }
              impact = affectedItems(state, [...new Set(impact)])
            }
            const outcome = applyRevision(state, {
              kind, reason: a.revision_reason.trim(), to: target, from: state.stage,
              at: new Date().toISOString(), invalidated: invalidatedBy(kind),
              ...(impact ? { affected_items: impact } : {}),
            })
            const mode = await resolveWriteMode(ctx, a, exec)
            await compactSonarHistory(fs, state, cwd, mode)
            delete state.sonar_audit
            await writeTask(fs, state, cwd, mode)
            return 'revised (' + kind + ') back to "' + outcome.stage + '"; invalidated: ' + outcome.invalidated.join(', ')
              + '; affected_items: ' + (impact ?? state.items.map(item => item.id)).join(', ')
              + '; preserved_items: ' + state.items.filter(item => impact?.length && !impact.includes(item.id)).map(item => item.id).join(', ')
              + '. Re-establish affected evidence before advancing; unchanged item evidence is preserved, history is kept. Read status for current gates.'
          }


      let note: string | undefined
      let approvedWriteMode: 'workspace-write' | 'danger-full-access' | undefined
      switch (a.operation) {
        case 'plan': {
          if (!state.delivery || !['任务编排', '代码开发', '开发'].includes(state.stage)) throw new Error('plan requires a new implementation contract in orchestration or development')
          if (!a.plans?.length) throw new Error('plan requires complete plans')
          state.items = normalizeItems(a.plans.map(plan => ({ id: plan.id, title: plan.title })), state.items)
          for (const plan of a.plans) for (const file of plan.files) {
            assertInsideRoot(state.root!, state.root!, file)
            if (isSensitivePath(file)) throw new Error(`sensitive delivery path: ${file}`)
            const info = await fs.lstat(file, { cwd: state.root! })
            if (info && info.type !== 'file') throw new Error(`plan contains a non-regular file: ${file}`)
          }
          state.files = [...new Set([...state.files, ...a.plans.flatMap(plan => plan.files)])]
          for (const input of a.plans) {
            const item = requireItem(state, input.id)
            if (item.dispatch || item.review) throw new Error('plan cannot replace started work; revise/replan the affected item explicitly')
            item.execution_plan = makeExecutionPlan(state, item, input, executionCapabilities(ctx, !!exec.agent))
          }
          note = JSON.stringify({ items: state.items.map(item => ({ id: item.id, plan: item.execution_plan })), next_action: 'Declare necessary verification groups, record the required task-plan artifact if in orchestration, then advance. Direct items need no child; accept_item performs review and done atomically after genuine verification.' })
          break
        }
        case 'record': {
          if (!a.artifact) throw new Error('record requires artifact (the artifact id)')
          const def = workflow.artifacts.find(artifact => artifact.id === a.artifact)
          if (!def) {
            throw new Error(`unknown artifact "${a.artifact}"; declared: ${workflow.artifacts.map(x => x.id).join(', ') || 'none'}`)
          }
          if (def.stage !== state.stage) {
            throw new Error(`artifact "${def.id}" belongs to stage "${def.stage}", but the task is at "${state.stage}" — record it at its owning stage`)
          }
          const merged = { ...(state.artifacts[def.id] ?? {}) }
          for (const [field, value] of Object.entries(a.fields ?? {})) {
            if (!def.fields.includes(field)) {
              throw new Error(`artifact "${def.id}" has no field "${field}"; fields: ${def.fields.join(', ')}. Read status.artifact_requirements and put additional questions or tradeoffs inside an allowed text field, not a new key. No changes were saved.`)
            }
            merged[field] = value === undefined || value === null ? '' : String(value)
          }
          state.artifacts[def.id] = merged
          const missing = def.fields.filter(field => !merged[field] || merged[field].trim() === '')
          note = missing.length === 0
            ? `recorded ${def.name} ("${def.id}") — all required fields present`
            : `recorded ${def.name} ("${def.id}"); still missing: ${missing.join(', ')}`
          break
        }
        case 'scope':
          state.files = a.files ?? []
          note = `file scope set to ${state.files.length} files${state.files.length > 0 ? ': ' + state.files.join(', ') : ' (empty — commits are blocked until files are declared)'}`
          break
        case 'plan_verification': {
          if (!a.verification_group || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(a.verification_group)) throw new Error('plan_verification requires verification_group, e.g. backend')
          if (!a.command?.trim() || !a.files?.length || !a.item_ids) throw new Error('plan_verification requires command, files (implementation + tests + relevant configuration), and item_ids (empty for task-level integration checks)')
          const problem = validationCommandProblem(a.command)
          if (problem) throw new Error(problem)
          for (const file of a.files) {
            assertInsideRoot(state.root ?? cwd ?? '', state.root ?? cwd ?? '', file)
            if (/^\.dsh[\\/]task-[^/\\]+\.json$/u.test(file)) throw new Error('a test group cannot include its own changing task ledger')
          }
          for (const id of a.item_ids) requireItem(state, id)
          if (state.items.some(item => ['running', 'starting'].includes(item.dispatch?.status ?? ''))) throw new Error('wait for active children before changing verification plans')
          const group = { id: a.verification_group, command: a.command.trim(), files: [...new Set(a.files)], item_ids: [...new Set(a.item_ids)], key: '', at: new Date().toISOString() }
          group.key = groupKey(group)
          const previous = Object.hasOwn(state.verification_groups ?? {}, group.id) ? state.verification_groups![group.id] : undefined
          if (previous?.key === group.key) { note = 'verification group unchanged'; break }
          preserveVerification(state)
          if (previous) (state.verification_group_history ??= []).push(previous)
          state.verification_version = 1
          ;(state.verification_groups ??= {})[group.id] = group
          state.review = { outcome: 'pending' }
          await refreshVerification(state, await verificationInputHashes(fs, state, cwd), await scopeFingerprint(fs, state, cwd))
          note = JSON.stringify({ group, blockers: groupPlanningBlockers(state), next_action: `Implement this complete unit, then verify verification_group=${group.id}; a later test item must not depend on this unit being done.` })
          break
        }
        case 'items':
          state.items = normalizeItems(a.items, state.items, a.items_mode ?? 'merge')
          for (const item of state.items.filter(entry => entry.status === 'done' && a.items?.some(update => update.id === entry.id))) {
            const blockers = executionItemBlockers(state, item)
            if (blockers.length) throw new Error(blockers.join('; '))
            if (state.delegation_version) {
              const problems = await itemVerificationBlockers(fs, state, item.id, cwd)
              if (problems.length) throw new Error(problems.join('; '))
              if (state.verification_version && item.review?.verification_key !== verificationKey(state, item.id)) throw new Error('item review is stale after its required test receipts changed; review_item again')
              if (item.review?.scope_hash !== await scopeFingerprint(fs, { ...state, files: item.execution_plan?.files ?? state.files }, cwd)) throw new Error('item review is missing or stale; review_item before done')
            }
          }
          note = `items set: ${state.items.map(i => `${i.id}:${i.status}`).join(', ') || 'none'}`
          break
        case 'plan_execution': {
          if (!['任务编排', '开发', '代码开发'].includes(state.stage)) throw new Error('plan_execution runs in orchestration or implementation stage')
          const item = requireItem(state, a.item_id)
          if (item.status !== 'todo') throw new Error('reopen the item as todo before replanning execution')
          for (const path of a.files ?? []) assertInsideRoot(state.root ?? cwd ?? '', state.root ?? cwd ?? '', path)
          const plan = makeExecutionPlan(state, item, a, executionCapabilities(ctx, !!exec.agent))
          validateDeliveryChanges(a.changes ?? [], plan.files)
          if (a.changes?.length) plan.changes = await captureDeliveryChanges(ctx, fs, state, a.changes, exec, await resolveWriteMode(ctx, a, exec))
          item.execution_plan = plan
          delete item.independent_review
          delete item.review
          note = JSON.stringify({ item_id: item.id, execution_plan: item.execution_plan,
            next_action: 'Dispatch with item_id only; the engine uses this plan. Complete dependencies first. Parent verifies delivery and executes the recorded review strategy.' })
          break
        }
        case 'dispatch': {
          const item = requireItem(state, a.item_id)
          const plan = item.execution_plan
          if (state.delegation_version && !plan) throw new Error('call plan_execution before dispatch; record boundary, files, acceptance and reason')
          if (plan) {
            if (a.execution && a.execution !== plan.mode) throw new Error('dispatch mode conflicts with recorded execution plan; replan with a reason first')
            if (plan.depends_on.some(id => state.items.find(entry => entry.id === id)?.status !== 'done')) throw new Error('implementation dependencies are not done')
            if (plan.files.some(path => !state.files.includes(path))) throw new Error('planned files are outside current task scope; replan before dispatch')
          }
          const execution = plan?.mode ?? a.execution ?? 'direct'
          const coverage = executionCoverageBlockers(state)
          if (coverage.length) throw new Error(coverage.join('; '))
          const testPlanning = groupPlanningBlockers(state)
          if (testPlanning.length) throw new Error(testPlanning.join('; '))
          if (!['开发', '代码开发'].includes(state.stage)) throw new Error('dispatch runs only in implementation stage')
          if (item.dispatch?.status === 'running' || item.dispatch?.status === 'starting') throw new Error('delegation already in progress; inspect status before retrying')
          if (state.items.some(other => other.id !== item.id && other.status === 'doing')) throw new Error('finish or pause the current doing item before dispatching another item; review_item records verdicts only, then use items to set its status to done')
          if (execution !== 'direct' && !executionCapabilities(ctx, !!exec.agent)[execution])
            throw new Error(`requested ${execution} provider or required depthLimit capability is unavailable; replan before dispatch; no child was started`)
          item.status = 'doing'
          delete item.review
          delete item.independent_review
          item.dispatch_history = dispatchHistory(item)
          item.dispatch = { description: a.description ?? plan?.reason ?? '', at: new Date().toISOString(), execution }
          if (execution !== 'direct') {
            if (!exec.agent) throw new Error('delegation requires the live parent agent')
            const runtime = taskSubagents(ctx)
            if (!runtime?.startActivation) throw new Error('DSH subagents service is unavailable; no child was started')
            const mode = await resolveWriteMode(ctx, a, exec)
            item.dispatch.provider = execution
            item.dispatch.parent_session = session?.id ?? ''
            item.dispatch.status = 'starting'
            await writeTask(fs, state, cwd, mode)
            const prompt = `You are the implementation worker, not the workflow controller. Do not call dev_task or delegate further.\nTask ${state.id}: ${state.title}\nItem ${item.id}: ${item.title}\n${a.description ?? ''}\nExecution brief:\n${JSON.stringify(plan ?? {})}\nAllowed delivery paths: ${(plan?.files ?? state.files).join(', ')}\nWork in ${state.root ?? cwd}. Preserve existing worktree changes. Follow the parent task instructions below. Do not change the parent task ledger, commit or archive. Return changed files, actual checks and remaining issues; report BLOCKED if context is insufficient.\nTask artifacts and acceptance context:\n${JSON.stringify(state.artifacts)}\n${await renderBindings(state.stage, workflow, fs, cwd, state.flow?.resources)}`
            let run: TaskActivation | undefined
            try {
              run = ownActivation(await runtime.startActivation({ provider: execution, label: `${state.id}/${item.id}`, delivery: 'caller', signal: exec.signal,
                request: { parent: exec.agent, cwd: state.root ?? cwd!, prompt: [{ type: 'text', text: prompt }], maxDepth: 3 } }), exec.signal)
              item.dispatch.run_id = run.childId
              item.dispatch.status = 'running'
              await writeTask(fs, state, cwd, mode)
              const result = await run.result
              item.dispatch.output = result.output.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').slice(0, 24_000)
              item.dispatch.status = result.stopReason === 'completed' ? 'completed' : 'failed'
              if (result.stopReason !== 'completed') item.dispatch.error = result.diagnostic ?? result.stopReason
            } catch (error) {
              item.dispatch.status = 'failed'
              item.dispatch.error = error instanceof Error ? error.message : String(error)
            } finally {
              item.dispatch.metrics = unknownMetrics(Date.parse(item.dispatch.at))
              if (run) {
                try { item.dispatch.metrics = runMetrics(await reviewerEvents(ctx, run.childId, exec.signal), Date.parse(item.dispatch.at)) } catch {}
                try { await run.dispose() }
                catch (error) { item.dispatch.status = 'running'; item.dispatch.error = `child disposal failed; inspect host state and recover_dispatch before retrying: ${String(error)}` }
              }
            }
            if (item.dispatch.status !== 'running') item.dispatch.finished_at = new Date().toISOString()
            await writeTask(fs, state, cwd, mode)
            return JSON.stringify({ item_id: item.id, dispatch: item.dispatch,
              next_action: 'Parent must inspect the delivery, run verify, review_item and mark done. Child completion does not satisfy task evidence.' })
          }
          note = `item "${item.id}" is doing; implementation intent recorded: ${item.dispatch.description || '(no description)'}. Implement it directly or with help, then review_item and mark it done.`
          break
        }
        case 'review_dispatch': {
          if (!['开发', '代码开发'].includes(state.stage)) throw new Error('review_dispatch runs in implementation stage')
          const item = requireItem(state, a.item_id)
          const plan = item.execution_plan
          if (!plan || plan.review !== 'independent') throw new Error('item has no independent review plan')
          const coverage = executionCoverageBlockers(state)
          if (coverage.length) throw new Error(coverage.join('; '))
          if (state.items.some(other => other.id !== item.id && other.status === 'doing')) throw new Error('finish or pause the current doing item before reviewing another item')
          if (!item.dispatch || (item.dispatch.status && item.dispatch.status !== 'completed')) throw new Error('implementation must finish before independent review')
          if (!exec.agent || !executionCapabilities(ctx, true).reviewer) throw new Error('independent readonly reviewer is unavailable; no verdict was recorded')
          const runtime = taskSubagents(ctx)!
          const structuredReview = runtime.getProvider!('spawn')!.capabilities.outputSchema === true
          const verificationProblems = await itemVerificationBlockers(fs, state, item.id, cwd)
          if (verificationProblems.length) throw new Error(verificationProblems.join('; '))
          await assertDeliveryChanges(fs, plan, state.root ?? cwd)
          const current = await itemContextScope(fs, state, item.id, cwd)
          const scope = await scopeFingerprint(fs, { ...state, files: plan.files }, cwd)
          const reviewConstraints = [await renderBindings(state.stage, workflow, fs, cwd, state.flow?.resources),
            workflow.stages.includes('代码审核') ? await renderBindings('代码审核', workflow, fs, cwd, state.flow?.resources) : ''].filter(Boolean).join('\n\n')
          const contextHash = hashText(JSON.stringify({ plan, risk_level: state.risk_level, artifacts: state.artifacts, constraints: reviewConstraints, scope: current,
            ...(state.verification_version ? { checks: requiredGroups(state, item.id).map(group => group.key) } : {}) }))
          const previous = item.independent_review
          const history = [...(item.independent_review_history ?? []), ...(previous ? [previous] : [])].slice(-10)
          if (history.filter(review => review.status === 'completed' && review.spec && review.quality
            && review.scope_hash === scope && review.plan_key === executionPlanKey(plan)
            && review.dispatch_at === item.dispatch!.at && review.context_hash === contextHash).length >= 3)
            throw new Error('three completed reviewer verdicts already cover this code and review context; fix the findings before another review')
          item.independent_review_history = history
          delete item.review
          item.status = 'doing'
          const review: NonNullable<TaskItem['independent_review']> = { status: 'starting', at: new Date().toISOString(),
            parent_session: session?.id ?? '', scope_hash: scope, plan_key: executionPlanKey(plan),
            dispatch_at: item.dispatch.at, verification_at: verificationTime(state, item.id)!, context_hash: contextHash }
          item.independent_review = review
          const mode = await resolveWriteMode(ctx, a, exec)
          await writeTask(fs, state, cwd, mode)
          let run: TaskActivation | undefined
          try {
            run = ownActivation(await runtime.startActivation({ provider: 'spawn', label: `${state.id}/${item.id}/review`, delivery: 'caller', signal: exec.signal,
              request: { parent: exec.agent, cwd: state.root ?? cwd!, agentPreset: REVIEW_PRESET,
              ...structuredReview ? { outputSchema: REVIEW_OUTPUT_SCHEMA } : {},
              maxDepth: 3, prompt: [{ type: 'text', text:
                `You are the independent task reviewer. Your work capability is read; do not edit, run commands, delegate or call dev_task.\nReview ${state.id}/${item.id}: ${item.title}.\nCurrent task risk: ${state.risk_level}. Read every delivery file in this brief in ${state.root ?? cwd}; use line windows to read past truncation. Do not trust implementer claims. Check concrete acceptance and relevant edge cases, then code quality. Cite file:line evidence.\nPlanned changes: for delete/rename, verify the old path is absent and read baseline.git.path (committed old content) and baseline.before.path if present (pre-change worktree content). For rename, also read the new destination. Required complete reads: ${JSON.stringify(requiredReviewPaths(plan))}.\nBrief: ${JSON.stringify(plan)}\nTask artifacts: ${JSON.stringify(state.artifacts)}\nApplicable project Skills and Rules (apply their code constraints; workflow actions belong to the parent):\n${reviewConstraints}\nImplementer report (unverified): ${item.dispatch.output ?? item.dispatch.description}\nActual parent test receipts: ${JSON.stringify(state.verification_version ? requiredGroups(state, item.id).map(group => ({ group: group.id, run: latestGroupRun(state, group.id) })) : state.verification.receipt)}\n${structuredReview ? 'Finish by calling the host structured_output tool with' : 'Return ONLY JSON'} {"spec":"pass"|"fail","quality":"pass"|"fail","notes":["file:line evidence and findings"]}. Return fail if required evidence cannot be read. Do not claim to run tests; the parent owns command verification.` }] } }), exec.signal)
            review.run_id = run.childId
            review.status = 'running'
            await writeTask(fs, state, cwd, mode)
            const result = await run.result
            review.output = result.output.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').slice(0, 24000)
            if (result.stopReason !== 'completed') throw new Error(result.diagnostic ?? result.stopReason)
            review.policy = reviewerProof(ctx, run.childId, structuredReview)
            const verdict = structuredReview ? validateIndependentReview(result.structured) : parseIndependentReview(review.output)
            const sources = await Promise.all(requiredReviewPaths(plan).map(async file => {
              const content = await readText(fs, file, state.root ?? cwd)
              if (content === undefined) throw new Error(`review delivery is missing: ${file}`)
              return { file, content }
            }))
            const readKey = (path: string): string => process.platform === 'win32' ? resolve(state.root ?? cwd ?? '', path).toLowerCase() : resolve(state.root ?? cwd ?? '', path)
            review.read_coverage = fullReadCoverage(await reviewerEvents(ctx, run.childId, exec.signal), sources, readKey)
            review.read_files = review.read_coverage.map(entry => entry.file)
            if (!hasFullReadCoverage(review, requiredReviewPaths(plan))) throw new Error('reviewer did not successfully read every planned delivery file in full; read missing windows or untruncated lines, then retry; no independent verdict is accepted')
            Object.assign(review, verdict)
            if (structuredReview) review.output = JSON.stringify(verdict)
            if (scope !== await scopeFingerprint(fs, { ...state, files: plan.files }, cwd)) throw new Error('delivery changed during independent review')
            await assertDeliveryChanges(fs, plan, state.root ?? cwd)
            review.status = 'completed'
          } catch (error) { review.status = 'failed'; review.error = error instanceof Error ? error.message : String(error) }
          finally {
            review.metrics = unknownMetrics(Date.parse(review.at))
            if (run) try { review.metrics = runMetrics(await reviewerEvents(ctx, run.childId, exec.signal), Date.parse(review.at)) } catch {}
            if (run) try { await run.dispose() }
            catch (error) { review.status = 'running'; review.error = `reviewer disposal failed; inspect host and recover_dispatch dispatch_role=review: ${String(error)}` }
          }
          if (review.status !== 'running') review.finished_at = new Date().toISOString()
          await writeTask(fs, state, cwd, mode)
          return JSON.stringify({ item_id: item.id, independent_review: review,
            next_action: 'Parent inspects this verdict. Fix any failure, re-verify and re-review; otherwise review_item must accept these exact outcomes before items marks done.' })
        }
        case 'recover_dispatch': {
          const item = requireItem(state, a.item_id)
          const recoveringReview = a.dispatch_role === 'review'
          const dispatch = recoveringReview ? item.independent_review : item.dispatch
          if (!dispatch || !['starting', 'running'].includes(dispatch.status ?? '')) throw new Error('no interrupted dispatch to recover')
          if (!session?.id || dispatch.parent_session !== session.id) throw new Error('recover_dispatch requires the original parent session')
          const runtime = ctx.get('subagents') as { listDescendants?: (parent: string, signal: AbortSignal) => Promise<{
            id: string; kind: string; activity?: string; parentId: string; depth: number
          }[]> } | undefined
          if (!runtime?.listDescendants) throw new Error('cannot establish child liveness; restore a DSH subagents service with listDescendants first')
          // listChildren is a durable identity catalog, without activity. The recursive
          // projection includes activity and diagnostics for the child and its descendants.
          const children = await runtime.listDescendants(session.id, exec.signal)
          const index = dispatch.run_id ? children.findIndex(child => child.id === dispatch.run_id && child.parentId === session.id) : -1
          if (dispatch.run_id && index < 0) throw new Error('cannot establish child liveness; recorded run is missing from the host catalog')
          const end = index < 0 ? -1 : children.findIndex((child, i) => i > index && child.depth <= children[index]!.depth)
          const candidates = index < 0 ? children : children.slice(index, end < 0 ? undefined : end)
          if (candidates.some(child => child.kind !== 'child' || child.activity !== 'inactive'))
            throw new Error('child may still be running or unavailable; stop it with the host controls before recovery')
          dispatch.status = 'failed'
          dispatch.error = 'Parent recovered an interrupted dispatch; child success is unproven. Dispatch again and verify the delivery.'
          dispatch.finished_at = new Date().toISOString()
          if (!recoveringReview) { item.status = 'todo'; delete item.independent_review }
          delete item.review
          note = dispatch.error
          break
        }
        case 'accept_item':
        case 'review_item': {
          const item = requireItem(state, a.item_id)
          if (a.operation === 'accept_item') {
            if (!state.delivery || !item.execution_plan) throw new Error('accept_item requires a new implementation contract and execution plan')
            if (item.execution_plan.depends_on.some(id => state.items.find(other => other.id === id)?.status !== 'done')) throw new Error('item dependencies are not accepted')
            if (!item.dispatch && item.execution_plan.mode === 'direct') item.dispatch = { execution: 'direct', description: 'Main-session delivery submitted for acceptance', at: new Date().toISOString() }
          }
          if (!['开发', '代码开发'].includes(state.stage)) throw new Error('review_item runs only in implementation stage')
          if (item.dispatch?.status && item.dispatch.status !== 'completed') throw new Error('delegated item has not completed successfully')
          if (a.spec_outcome !== 'pass' && a.spec_outcome !== 'fail') throw new Error('review_item requires spec_outcome: pass|fail')
          if (a.quality_outcome !== 'pass' && a.quality_outcome !== 'fail') throw new Error('review_item requires quality_outcome: pass|fail')
          if (item.execution_plan) await assertDeliveryChanges(fs, item.execution_plan, state.root ?? cwd)
          if (item.execution_plan?.review === 'independent') {
            const review = item.independent_review
            if (review?.status !== 'completed' || !review.run_id
              || !validReviewPolicy(review.policy, review.run_id)
              || review.plan_key !== executionPlanKey(item.execution_plan) || review.dispatch_at !== item.dispatch?.at
              || !hasFullReadCoverage(review, requiredReviewPaths(item.execution_plan))
              || review.scope_hash !== await scopeFingerprint(fs, { ...state, files: item.execution_plan.files }, cwd))
              throw new Error('independent review is missing or stale; run review_dispatch on the current verified delivery')
            if (a.spec_outcome !== review.spec || a.quality_outcome !== review.quality) throw new Error('parent verdict cannot override independent findings; fix and re-review first')
            const constraints = [await renderBindings(state.stage, workflow, fs, cwd, state.flow?.resources),
              workflow.stages.includes('代码审核') ? await renderBindings('代码审核', workflow, fs, cwd, state.flow?.resources) : ''].filter(Boolean).join('\n\n')
            const contextHash = hashText(JSON.stringify({ plan: item.execution_plan, risk_level: state.risk_level, artifacts: state.artifacts, constraints,
              scope: await itemContextScope(fs, state, item.id, cwd),
              ...(state.verification_version ? { checks: requiredGroups(state, item.id).map(group => group.key) } : {}) }))
            if (review.context_hash !== contextHash) throw new Error('independent review context changed; rerun review_dispatch before accepting new requirements or rules')
          }
          if (state.delegation_version && a.spec_outcome === 'pass' && a.quality_outcome === 'pass') {
            const problems = await itemVerificationBlockers(fs, state, item.id, cwd)
            if (problems.length) throw new Error(problems.join('; '))
          }
          const auditNotes = a.notes === undefined ? {} : { notes: a.notes }
          item.review = {
            ...(state.verification_version ? { verification_key: verificationKey(state, item.id)! } : {}),
            scope_hash: await scopeFingerprint(fs, { ...state, files: item.execution_plan?.files ?? state.files }, cwd),
            ...(item.execution_plan?.review === 'independent' ? { independent_run_id: item.independent_review!.run_id } : {}),
            spec: { outcome: a.spec_outcome, ...auditNotes },
            quality: { outcome: a.quality_outcome, ...auditNotes },
          }
          if (a.operation === 'accept_item') {
            const blockers = executionItemBlockers(state, item)
            if (blockers.length) throw new Error(blockers.join('; '))
            item.status = 'done'
          }
          note = `reviewed item "${item.id}": spec=${a.spec_outcome}, quality=${a.quality_outcome}; item status remains ${item.status}. ${a.spec_outcome === 'pass' && a.quality_outcome === 'pass' ? 'If implementation is complete, use items with this id and status=done before dispatching another item.' : 'Fix the findings before marking this item done.'}`
          break
        }
        case 'advance': {
          const target = a.target_stage ?? ''
          if (!target.trim()) throw new Error(`advance requires target_stage; legal next: ${legalTargets(state.stage, workflow).join(', ') || 'none'}`)
          const planItemBlockers = taskPlanItemBlockers(state)
          if (planItemBlockers.length) throw new Error(planItemBlockers.join('; '))
          await assertFreshEvidence(fs, state, workflow, cwd)
          const missingSkills = skillBlockers(state, workflow, session)
          if (missingSkills.length) throw new Error(missingSkills.join('; '))
          const missingSkillFiles = await missingSkillRefs(bindingsForStage(state.stage, workflow), fs, cwd)
          const missingSkillIssues = skillResourceBlockers(missingSkillFiles, state.stage)
          if (missingSkillIssues.length) throw new Error(missingSkillIssues.join('; '))
          // A stage whose rules cannot be resolved must not be passable. This was
          // reported in status and never enforced, so deleting a bound rule still let the
          // task advance — the stage ran without the constraints it was configured with
          // while the record looked fine.
          const unresolvedRules = (await rulesForBinding(bindingsForStage(state.stage, workflow), fs, cwd, state.flow?.resources)).missing
          const resourceIssues = resourceBlockers(unresolvedRules, state.stage)
          if (resourceIssues.length) throw new Error(resourceIssues.join('; '))
          let result = assertAdvance(state, target, workflow)
          if (!result.ok) {
            const unmet = unmetGuards(state, target, workflow)
            const confirmations = unmet.filter(guard => CONFIRMATION_GUARDS.includes(guard))
            const others = unmet.filter(guard => !CONFIRMATION_GUARDS.includes(guard))
            // Confirmation gates are satisfied by a human approval, not the record.
            if (confirmations.length > 0 && others.length === 0 && exec.agent !== undefined) {
              result = await approveAdvance(ctx, state, target, workflow, confirmations, exec)
            }
          }
          if (!result.ok) throw new Error(result.errors!.join('; '))
          state.stage = target
          const disclosure = await renderBindings(state.stage, workflow, fs, cwd, state.flow?.resources)
          const terminalObligations = obligationStages(state, workflow).filter(stage => stage !== state.stage)
          const terminalDisclosure = await Promise.all(terminalObligations.map(async stage => `Before entering ${stage}, execute its bindings now:\n${await renderBindings(stage, workflow, fs, cwd, state.flow?.resources)}`))
          note = [`advanced to ${state.stage}`, disclosure, ...terminalDisclosure].filter(Boolean).join('\n')
          break
        }
        case 'set_risk': {
          const target = a.risk_level
          if (target !== 'high_risk' && target !== 'standard') {
            throw new Error('set_risk requires risk_level: high_risk|standard')
          }
          if (target === state.risk_level) {
            note = `risk already ${target}`
            break
          }
          if (target === 'high_risk') {
            if (state.flow === undefined) {
              throw new Error(
                'legacy task has no frozen workflow snapshot — recreate (or migrate) the task before raising risk to high_risk; ' +
                'a task without a frozen snapshot cannot prove its flow carries the high-risk capabilities',
              )
            }
            if (!workflowSatisfies(workflow, HIGH_RISK_REQUIRED_CAPABILITIES)) {
              throw new Error(
                `cannot raise risk to high_risk on flow "${state.flow.flow}" — it lacks the required capabilities ` +
                `(${HIGH_RISK_REQUIRED_CAPABILITIES.join(', ')}). Use the standard flow.`,
              )
            }
          }
          if (state.risk_level === 'high_risk' && target === 'standard') {
            const approval = ctx.get('approval') as ApprovalAsk | undefined
            if (approval === undefined) {
              throw new Error('downgrading a high_risk task requires human approval, but the approval service is unavailable')
            }
            const outcome = await approval.request({
              agent: exec.agent,
              toolName: 'dev_task',
              callId: exec.callId,
              reason: `风险降级：请确认允许把任务 ${state.id} 的 risk_level 从 high_risk 降为 standard（降级后高风险验证回执门不再适用）`,
              signal: exec.signal,
            })
            if (outcome !== 'allowed-once') {
              throw new Error(`risk downgrade was not approved (${outcome}); risk_level unchanged`)
            }
          }
          const previousRisk = state.risk_level, stageBefore = state.stage, at = new Date().toISOString()
          if (previousRisk === 'high_risk' && target === 'standard') (state.risk_downgrades ??= []).push({ from: previousRisk, to: target, at })
          state.risk_level = target
          const reviewItems: string[] = []
          if (target === 'high_risk') {
            const capabilities = executionCapabilities(ctx, !!exec.agent)
            for (const item of state.items) {
              if (item.execution_plan) {
                Object.assign(item.execution_plan, reviewStrategy(state, item.execution_plan.mode, capabilities), { capabilities, at })
                reviewItems.push(item.id)
              }
              if (item.independent_review) item.independent_review_history = [...(item.independent_review_history ?? []), item.independent_review].slice(-10)
              delete item.independent_review
              delete item.review
              if (item.status === 'done') item.status = 'todo'
            }
            state.review = { outcome: 'pending' }
            const implementation = workflow.stages.find(stage => stage === '开发' || stage === '代码开发')
            if (state.items.length && implementation && workflow.stages.indexOf(state.stage) > workflow.stages.indexOf(implementation)) state.stage = implementation
            const index = workflow.stages.indexOf(implementation ?? state.stage)
            for (const stage of Object.keys(state.skill_results ?? {})) if (workflow.stages.indexOf(stage) >= index) delete state.skill_results![stage]
          }
          ;(state.risk_changes ??= []).push({ from: previousRisk, to: target, at, review_items: reviewItems, stage_before: stageBefore, stage_after: state.stage })
          note = `risk_level set to ${target}; recorded in risk_changes. Stage: ${state.stage}. ${reviewItems.length ? `Re-review items ${reviewItems.join(', ')} using their updated review strategy; unchanged implementation and test receipts are retained. Read status before advancing.` : 'Read status for current evidence requirements.'}`
          break
        }
        case 'verify': {
          const groups = Object.values(state.verification_groups ?? {})
          const groupId = a.verification_group ?? (groups.length === 1 ? groups[0]!.id : '')
          const group = state.verification_version && Object.hasOwn(state.verification_groups ?? {}, groupId) ? state.verification_groups![groupId] : undefined
          if (state.verification_version) {
            const planning = groupPlanningBlockers(state)
            if (planning.length) throw new Error(planning.join('; '))
            if (!group) throw new Error(`verify requires verification_group; planned groups: ${groups.map(entry => entry.id).join(', ')}`)
            if (a.command?.trim() && a.command.trim() !== group.command) throw new Error(`command differs from group ${group.id}; use plan_verification to record the changed test command first`)
          }
          const explicit = a.command !== undefined && a.command.trim() !== ''
          // Verification always runs in the task's recorded project root, not
          // the session cwd: in a monorepo the session may sit in a subdirectory
          // while `npm test`/`mvn test` must run where the manifest lives.
          const verifyRoot = state.root ?? cwd
          const command = group?.command ?? (explicit ? a.command!.trim() : await resolveVerifyCommand(fs, verifyRoot))
          if (command !== undefined) {
            const problem = validationCommandProblem(command)
            if (problem) throw new Error(problem)
            const testFiles = group ? groupInputs(state, group) : state.files
            const testScope = { ...state, files: testFiles }
            const scopeBefore = await scopeFingerprint(fs, testScope, cwd, !!group)
            approvedWriteMode = await resolveWriteMode(ctx, { ...a, command }, exec)
            const gradleBefore = verifyRoot && isGradleTestCommand(command) ? snapshotGradleReports(verifyRoot) : undefined
            const receipt = await runVerificationCommand(ctx, command, verifyRoot, exec, a.sandbox_permissions === undefined ? undefined : approvedWriteMode)
            if (gradleBefore && verifyRoot) {
              const report = freshGradleReportSummary(gradleBefore, snapshotGradleReports(verifyRoot))
              if (report) receipt.gradle_report = report
            }
            receipt.scope_hash = scopeBefore
            const scopeAfter = await scopeFingerprint(fs, testScope, cwd, !!group)
            if (scopeBefore !== scopeAfter) receipt.scope_changed_during_run = true
            if (receipt.root !== undefined && receipt.root !== verifyRoot) {
              throw new Error(`verification receipt root mismatch: ${receipt.root} vs task root ${String(verifyRoot)}`)
            }
            const testSummary = receipt.gradle_report
              ? { count: receipt.gradle_report.count }
              : testEvidence(command, `${receipt.stdout}\n${receipt.stderr}`)
            receipt.test_summary = testSummary
            preserveVerification(state)
            const problems = receiptProblems(receipt)
            ;(state.verification_runs ??= []).push({ id: randomUUID(), ...(group ? { group_id: group.id, plan_key: group.key } : {}),
              files: [...testFiles], receipt: structuredClone(receipt), evidence: a.evidence ?? [], passed: problems.length === 0 })
            state.verification = {
              passed: problems.length === 0,
              evidence: a.evidence ?? [],
              receipt,
              problems,
            }
            if (state.verification_version) refreshVerification(state, await verificationInputHashes(fs, state, cwd), await scopeFingerprint(fs, state, cwd))
          } else {
            throw new Error('verify requires a real validation command; pass command explicitly for this project')
          }
          const views = state.verification_version ? verificationGroupViews(state, await verificationInputHashes(fs, state, cwd)) : []
          const selected = group ? views.find(view => view.id === group.id) : undefined
          note = JSON.stringify({ ok: state.verification.passed, task_verified: state.verification.passed,
            ...(selected ? { group_result: selected } : {}), stage: state.stage, verification: state.verification,
            diagnostics: state.verification_version
              ? views.flatMap(view => view.problems.map(reason => ({ group_id: view.id, code: reason.split(':', 1)[0], reason })))
              : (state.verification.problems ?? []).map(reason => ({ code: reason.split(':', 1)[0], reason })),
            next_action: selected?.status === 'passed'
              ? `Group ${selected.id} passed. Review its validated implementation item before marking it done.${state.verification.passed ? ' All required groups passed.' : ' Task-level verification is pending: ' + state.verification.problems?.join('; ')}`
              : state.verification.problems?.length ? state.verification.problems.join('; ') : 'Review the validated implementation item before marking it done.' }, null, 2)
          break
        }
        case 'skill_result': {
          const stage = a.target_stage ?? state.stage
          const entry = (workflow.stage_bindings?.[stage]?.skills ?? []).find(binding =>
            (state.complexity !== undefined || binding.skill.source === 'codex-project'
              ? formatResourceRef(binding.skill) : binding.skill.name) === a.skill_name)
          if (!obligationStages(state, workflow).includes(stage) || !entry) throw new Error('skill_result requires a skill bound to this stage or its upcoming terminal stage')
          if ((await readSkillAt(entry.skill, fs, cwd)) === undefined) {
            throw new Error(`bound skill ${formatResourceRef(entry.skill)} resolves nowhere; restore its source before recording a result`)
          }
          const unresolvedForSkill = (await resolveRules(entry.rules, fs, cwd, state.flow?.resources)).missing
          if (unresolvedForSkill.length > 0) {
            throw new Error(`bound rule for ${formatResourceRef(entry.skill)} resolves nowhere: ${unresolvedForSkill.join(', ')}`)
          }
          const exactLoadKey = `${state.id}#${formatResourceRef(entry.skill)}`
          const loaded = loadedSkills(session)
          const loadCall = loaded.get(exactLoadKey) ?? (state.complexity === undefined && entry.skill.source !== 'codex-project'
            ? loaded.get(entry.skill.name) : undefined)
          if (!loadCall) throw new Error(state.complexity !== undefined || entry.skill.source === 'codex-project'
            ? `load skill "${a.skill_name}" with dev_task operation=load_skill before recording execution`
            : `load skill "${a.skill_name}" successfully before recording execution`)
          if (entry.evidence === 'manual') {
            if (!a.evidence?.length || a.evidence.some(value => !value.trim())) throw new Error('manual skill_result requires non-empty evidence')
            const approval = ctx.get('approval') as ApprovalAsk | undefined
            if (approval === undefined || exec.agent === undefined) throw new Error('manual skill_result requires the human approval service')
            const outcome = await approval.request({ agent: exec.agent, toolName: 'dev_task', callId: exec.callId,
              reason: `请确认技能 ${a.skill_name} 在 ${stage} 的人工结果：${a.evidence.join('；')}`, signal: exec.signal })
            if (outcome !== 'allowed-once') throw new Error(`manual skill_result was not approved (${outcome})`)
            state.skill_results ??= {}
            state.skill_results[stage] ??= {}
            state.skill_results[stage]![a.skill_name!] = { session_id: session?.id ?? '', load_call_id: loadCall, evidence: a.evidence, approved: true }
            note = JSON.stringify({ skill: a.skill_name, stage, approved: true }, null, 2)
            break
          }
          if (entry.evidence === 'artifact' || entry.evidence === 'review' || entry.evidence === 'none') {
            throw new Error(`${entry.evidence} skill evidence is recorded by its node operation; skill_result is only for command or manual evidence`)
          }
          if (!a.command?.trim() || !a.evidence?.length || a.evidence.some(value => !value.trim())) throw new Error('skill_result requires a real validation command and non-empty evidence describing executed scenarios and results')
          const commandProblem = skillCommandProblem(a.command)
          if (commandProblem) throw new Error(commandProblem)
          const scopeBefore = await scopeFingerprint(fs, state, cwd)
          approvedWriteMode = await resolveWriteMode(ctx, a, exec)
          const receipt = await runVerificationCommand(ctx, a.command, state.root ?? cwd, exec, a.sandbox_permissions === undefined ? undefined : approvedWriteMode)
          receipt.scope_hash = scopeBefore
          if (await scopeFingerprint(fs, state, cwd) !== scopeBefore) {
            throw new Error('task files changed while skill_result command ran; rerun validation on the current files')
          }
          state.skill_results ??= {}
          state.skill_results[stage] ??= {}
          state.skill_results[stage]![a.skill_name!] = { session_id: session?.id ?? '', load_call_id: loadCall, evidence: a.evidence, receipt }
          note = JSON.stringify({ skill: a.skill_name, stage, receipt }, null, 2)
          break
        }
        case 'review': {
          if (a.outcome !== 'pass' && a.outcome !== 'blocked') throw new Error('review requires outcome: pass|blocked')
          const reviewStage = workflow.transitions.some(edge => edge.from === state.stage && edge.requires?.includes('review_passed'))
            || terminalRequirements(workflow).includes('review_passed') && state.stage === workflow.stages.at(-1)
          if (!reviewStage) throw new Error('review runs only in a workflow review stage')
          if (a.outcome === 'pass') {
            const verification = await evidenceBlockers(fs, { ...state, review: { outcome: 'pending' } }, workflow, cwd)
            if (verification.length) throw new Error(verification.join('; '))
            const sonar = await sonarBlockers(fs, state, cwd)
            if (sonar.length) throw new Error(sonar.join('; '))
          }
          state.review = { outcome: a.outcome, scope_hash: await scopeFingerprint(fs, state, cwd),
            checked_at: new Date().toISOString(),
            ...(verificationTime(state) ? { verification_at: verificationTime(state)! } : {}),
            ...(state.verification_version ? { verification_key: verificationKey(state)! } : {}) }
          break
        }
        default:
          throw new Error(`unknown operation ${a.operation}`)
      }

      await writeTask(fs, state, cwd, approvedWriteMode ?? await resolveWriteMode(ctx, a, exec))
      return note ?? `ok (stage ${state.stage})`
      } finally { release?.() }
    },
  }))
}
