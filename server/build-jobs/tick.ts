import { readFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { api } from '../../convex/_generated/api.js'
import { convex } from '../convex-client.js'
import { sendMessage, isMessagingReady } from '../messaging.js'
import { isPidAlive, buildJobTmpPaths, spawnBuildProcess } from './spawn-helper.js'

const TICK_INTERVAL_MS = 30_000
const HEARTBEAT_AFTER_MS = 5 * 60 * 1000 // 5 min
const FASTLANE_TIMEOUT_MS = 30 * 60 * 1000 // 30 min
const EAS_TIMEOUT_MS = 45 * 60 * 1000 // 45 min

let tickHandle: ReturnType<typeof setInterval> | null = null

interface ConversationLookup {
  // Maps conversationId to the user's E.164 phone (extracted from the
  // conversation prefix "wa:+5491..." in Spec 1's transport).
  resolveRecipient: (conversationId: string) => string | undefined
}

let conversationLookup: ConversationLookup | null = null

export function setBuildJobsConversationLookup(lookup: ConversationLookup): void {
  conversationLookup = lookup
}

async function sendBuildPing(conversationId: string, text: string): Promise<void> {
  if (!isMessagingReady()) {
    console.warn(`[buildJobs] messenger not ready, dropping ping for ${conversationId}: ${text.slice(0, 80)}`)
    return
  }
  if (!conversationLookup) {
    console.warn(`[buildJobs] conversation lookup not registered, cannot route ping for ${conversationId}`)
    return
  }
  const recipient = conversationLookup.resolveRecipient(conversationId)
  if (!recipient) {
    console.warn(`[buildJobs] no recipient for conversationId ${conversationId}, dropping ping`)
    return
  }
  await sendMessage(recipient, text)
}

interface RunningJob {
  jobId: string
  executorRunId: string
  conversationId: string
  kind: 'fastlane_lane' | 'eas_build' | 'eas_submit' | 'eas_update'
  projectSlug: string
  args: string
  pid?: number
  remoteId?: string
  startedAt: number
  heartbeatSentAt?: number
  chainTo?: string
}

async function checkLocalProcess(job: RunningJob): Promise<{ done: boolean; succeeded?: boolean; errorTail?: string }> {
  if (job.pid === undefined) return { done: false }
  if (isPidAlive(job.pid)) return { done: false }
  const { logPath, exitPath } = buildJobTmpPaths(job.jobId)
  if (!existsSync(exitPath)) {
    // PID gone but no exit sidecar — likely killed externally or Boop restart.
    return { done: true, succeeded: false, errorTail: 'Build process exited without writing exit code (Boop may have restarted, or process was killed externally).' }
  }
  let exitCodeStr = '?'
  try {
    exitCodeStr = readFileSync(exitPath, 'utf8').trim()
  } catch {
    // ignore
  }
  const succeeded = exitCodeStr === '0'
  let errorTail: string | undefined
  if (!succeeded && existsSync(logPath)) {
    try {
      const logContent = readFileSync(logPath, 'utf8')
      errorTail = logContent.slice(-500)
    } catch {
      errorTail = `Build failed (exit ${exitCodeStr}); log not readable.`
    }
  }
  return { done: true, succeeded, errorTail }
}

async function checkEasRemote(job: RunningJob): Promise<{ done: boolean; succeeded?: boolean; errorTail?: string }> {
  if (!job.remoteId) {
    // EAS build that didn't capture a remote id — treat as failed setup.
    return { done: true, succeeded: false, errorTail: 'EAS build started but no remote build id was captured.' }
  }
  // Shell out to `eas build:view <remoteId> --json` (cheap, hits EAS API).
  // We need the project's path for cwd; pull from registry.
  const project = await convex.query(api.projects.getBySlug, { slug: job.projectSlug })
  if (!project?.path) {
    return { done: true, succeeded: false, errorTail: `No registered path for project ${job.projectSlug}.` }
  }
  return new Promise((resolve) => {
    const cmd = job.kind === 'eas_submit' ? 'submission' : 'build'
    const child = spawn('eas', [cmd, 'view', job.remoteId!, '--json'], { cwd: project.path })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ done: true, succeeded: false, errorTail: stderr.slice(-500) || `eas ${cmd}:view exit ${code}` })
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        const status = parsed.status as string
        if (status === 'FINISHED') {
          resolve({ done: true, succeeded: true })
        } else if (status === 'ERRORED' || status === 'CANCELED') {
          resolve({ done: true, succeeded: false, errorTail: `EAS ${cmd} status: ${status}` })
        } else {
          // IN_QUEUE, IN_PROGRESS, etc.
          resolve({ done: false })
        }
      } catch (err) {
        resolve({ done: true, succeeded: false, errorTail: `eas ${cmd}:view JSON parse error: ${(err as Error).message}` })
      }
    })
  })
}

function shortKind(kind: RunningJob['kind']): string {
  switch (kind) {
    case 'fastlane_lane': return 'Fastlane'
    case 'eas_build': return 'EAS build'
    case 'eas_submit': return 'EAS submit'
    case 'eas_update': return 'EAS update'
  }
}

function timeoutFor(kind: RunningJob['kind']): number {
  return kind === 'fastlane_lane' ? FASTLANE_TIMEOUT_MS : EAS_TIMEOUT_MS
}

async function maybeChainNextJob(parent: RunningJob): Promise<void> {
  if (!parent.chainTo) return
  let chain: { kind: string; args: Record<string, unknown> }
  try {
    chain = JSON.parse(parent.chainTo)
  } catch {
    return
  }
  const childJobId = `buildjob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  if (chain.kind === 'eas_submit') {
    const project = await convex.query(api.projects.getBySlug, { slug: parent.projectSlug })
    if (!project?.path) return
    // Compose argv for eas submit, defaulting to --latest. If the parent
    // was an eas_build that succeeded, EAS submit picks up the right build
    // automatically via --latest. Optionally we could pass the parent's
    // remoteId via --id, but --latest is simpler and works.
    const platform = (chain.args.platform as string) ?? 'ios'
    const argv = ['eas', 'submit', '--platform', platform, '--latest', '--non-interactive']
    const result = spawnBuildProcess({
      cwd: project.path,
      argv,
      jobId: childJobId,
    })
    await convex.mutation(api.buildJobs.create, {
      jobId: childJobId,
      executorRunId: parent.executorRunId,
      conversationId: parent.conversationId,
      kind: 'eas_submit',
      projectSlug: parent.projectSlug,
      args: JSON.stringify({ platform }),
      pid: result.pid,
    })
    console.log(`[buildJobs] chained eas_submit ${childJobId} after ${parent.jobId}`)
  }
  // Other chain types could be added here.
}

async function processOne(job: RunningJob): Promise<void> {
  const now = Date.now()
  const elapsed = now - job.startedAt

  // Hard timeout
  if (elapsed > timeoutFor(job.kind)) {
    await convex.mutation(api.buildJobs.markCompleted, {
      jobId: job.jobId,
      status: 'failed',
      resultText: `❌ ${shortKind(job.kind)} timeout (${Math.round(elapsed / 60000)} min). Check ASC / EAS dashboard manually.`,
    })
    await sendBuildPing(
      job.conversationId,
      `❌ ${shortKind(job.kind)} timeout for ${job.projectSlug} (${Math.round(elapsed / 60000)} min). Revisar ASC / EAS dashboard.`,
    )
    return
  }

  // Completion check per kind
  const check = job.kind === 'fastlane_lane' || job.kind === 'eas_update'
    ? await checkLocalProcess(job)
    : await checkEasRemote(job)

  if (check.done) {
    if (check.succeeded) {
      const resultText = `✅ ${shortKind(job.kind)} succeeded for ${job.projectSlug} (${Math.round(elapsed / 1000)}s)`
      await convex.mutation(api.buildJobs.markCompleted, {
        jobId: job.jobId,
        status: 'succeeded',
        resultText,
      })
      await sendBuildPing(job.conversationId, resultText)
      // Chain next job if any
      await maybeChainNextJob(job)
    } else {
      const resultText = `❌ ${shortKind(job.kind)} failed for ${job.projectSlug}`
      await convex.mutation(api.buildJobs.markCompleted, {
        jobId: job.jobId,
        status: 'failed',
        resultText,
        errorTail: check.errorTail,
      })
      const tailLine = check.errorTail ? `\n\n\`\`\`\n${check.errorTail.slice(-300)}\n\`\`\`` : ''
      await sendBuildPing(job.conversationId, `${resultText}.${tailLine}`)
    }
    return
  }

  // Heartbeat?
  if (!job.heartbeatSentAt && elapsed >= HEARTBEAT_AFTER_MS) {
    await convex.mutation(api.buildJobs.setHeartbeat, { jobId: job.jobId })
    await sendBuildPing(
      job.conversationId,
      `🛠️ ${shortKind(job.kind)} en curso para ${job.projectSlug} (~${Math.round(elapsed / 60000)} min). Sigo monitoreando.`,
    )
  }
}

export async function tickOnce(): Promise<void> {
  let running: unknown
  try {
    running = await convex.query(api.buildJobs.listRunning, {})
  } catch (err) {
    console.warn(`[buildJobs] tick query failed: ${(err as Error).message}`)
    return
  }
  for (const r of running as RunningJob[]) {
    try {
      await processOne(r)
    } catch (err) {
      console.warn(`[buildJobs] processOne ${r.jobId} threw: ${(err as Error).message}`)
    }
  }
}

export function startBuildJobsTick(): void {
  if (tickHandle) return
  console.log(`[buildJobs] tick starting (interval=${TICK_INTERVAL_MS}ms)`)
  // Run immediately so a fresh boot reaps any orphaned jobs from a previous
  // server lifetime; then on interval.
  void tickOnce()
  tickHandle = setInterval(() => {
    void tickOnce()
  }, TICK_INTERVAL_MS)
  tickHandle.unref?.()
}

export function stopBuildJobsTick(): void {
  if (tickHandle) {
    clearInterval(tickHandle)
    tickHandle = null
  }
}
