import { spawn } from 'node:child_process'

export interface RunCcSubprocessOptions {
  cwd: string
  task: string
  allowedTools: string
  timeoutMs: number
}

export interface CcSubprocessResult {
  exitCode: number
  output: string
  error?: string
  costUsd?: number
}

const COST_RE = /Total cost:\s*\$?([0-9]*\.?[0-9]+)/i

export async function runCcSubprocess(
  opts: RunCcSubprocessOptions,
): Promise<CcSubprocessResult> {
  return new Promise<CcSubprocessResult>((resolve) => {
    const child = spawn(
      'claude',
      ['-p', opts.task, '--allowed-tools', opts.allowedTools],
      { cwd: opts.cwd },
    )

    let output = ''
    let errBuf = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* already exited */
      }
    }, opts.timeoutMs)

    child.stdout.on('data', (d: Buffer) => {
      output += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      errBuf += d.toString('utf8')
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        resolve({
          exitCode: -1,
          output,
          error: `timeout after ${opts.timeoutMs}ms${errBuf ? ` — ${errBuf}` : ''}`,
        })
        return
      }
      const costMatch = COST_RE.exec(output)
      const costUsd = costMatch ? Number(costMatch[1]) : undefined
      resolve({
        exitCode: code ?? -1,
        output,
        error: errBuf || undefined,
        costUsd,
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        exitCode: -1,
        output,
        error: String(err),
      })
    })
  })
}
