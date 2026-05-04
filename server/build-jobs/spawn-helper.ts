import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Spawn a build command in a project's directory, detached from this process,
 * with stdout/stderr captured to a log file and final exit code recorded
 * to a sidecar file.
 *
 * The resulting pid is durable in the sense that it keeps running even if
 * the agent / orchestrator turn finishes. The buildJobs tick later reads
 * the sidecar to detect completion.
 *
 * Returns immediately with the spawned PID (does NOT wait for exit).
 */
export interface SpawnResult {
  pid: number
  logPath: string
  exitPath: string
}

export interface SpawnOpts {
  /** Absolute path to run in (the build_root). */
  cwd: string
  /** Command + args, e.g. ['fastlane', 'beta'] or ['eas', 'build', '--profile', 'production', ...]. */
  argv: string[]
  /** Job id used to name sidecar files. */
  jobId: string
  /** Extra environment variables to merge over process.env. */
  env?: Record<string, string>
}

const TMP_DIR = join(tmpdir(), 'boop-buildjobs')

function ensureTmpDir(): void {
  try {
    mkdirSync(TMP_DIR, { recursive: true })
  } catch {
    // ignore EEXIST
  }
}

export function spawnBuildProcess(opts: SpawnOpts): SpawnResult {
  ensureTmpDir()
  const logPath = join(TMP_DIR, `${opts.jobId}.log`)
  const exitPath = join(TMP_DIR, `${opts.jobId}.exit`)

  // We wrap argv in `bash -c '<cmd> > <log> 2>&1; echo $? > <exit>'` so the
  // exit code lands in the sidecar regardless of the command's own exit
  // behavior. argv items are individually shell-escaped so values with
  // spaces don't break.
  const escape = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const cmdLine = opts.argv.map(escape).join(' ')
  const wrapped = `${cmdLine} > ${escape(logPath)} 2>&1; echo $? > ${escape(exitPath)}`

  const child = spawn('bash', ['-c', wrapped], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    detached: true,
    stdio: 'ignore',
  })
  // Detach so the parent process can exit without killing the build.
  child.unref()

  if (child.pid === undefined) {
    throw new Error(`spawnBuildProcess: child PID is undefined for jobId ${opts.jobId}`)
  }

  return { pid: child.pid, logPath, exitPath }
}

/**
 * Test if a process with the given PID is still running. Uses signal 0
 * (no signal, just permission probe). Returns false if the process has
 * exited or doesn't exist.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function buildJobTmpPaths(jobId: string): { logPath: string; exitPath: string } {
  return {
    logPath: join(TMP_DIR, `${jobId}.log`),
    exitPath: join(TMP_DIR, `${jobId}.exit`),
  }
}
