import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { runCcSubprocess } from './cc-subprocess.js'

let mockSpawn: ReturnType<typeof vi.fn>
let mockChild: EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
  killed: boolean
}

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}))

beforeEach(() => {
  mockChild = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    killed: false,
  })
  mockSpawn = vi.fn(() => mockChild as unknown as ChildProcess)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('runCcSubprocess', () => {
  it('spawns claude -p with cwd, allowed-tools, and the task prompt', async () => {
    const promise = runCcSubprocess({
      cwd: '/some/project',
      task: 'Audit README and summarize.',
      allowedTools: 'Skill,Read,Grep',
      timeoutMs: 60_000,
    })
    expect(mockSpawn).toHaveBeenCalledOnce()
    const [cmd, args, opts] = mockSpawn.mock.calls[0] as [string, string[], { cwd: string }]
    expect(cmd).toBe('claude')
    expect(args).toContain('-p')
    expect(args).toContain('Audit README and summarize.')
    expect(args).toContain('--allowed-tools')
    expect(args).toContain('Skill,Read,Grep')
    expect(opts.cwd).toBe('/some/project')
    // Drive the child to completion so the promise resolves.
    mockChild.stdout.emit('data', Buffer.from('Done.'))
    mockChild.emit('exit', 0)
    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('Done.')
  })

  it('captures stdout and stderr', async () => {
    const promise = runCcSubprocess({
      cwd: '/x',
      task: 't',
      allowedTools: 'Read',
      timeoutMs: 60_000,
    })
    mockChild.stdout.emit('data', Buffer.from('hello '))
    mockChild.stdout.emit('data', Buffer.from('world'))
    mockChild.stderr.emit('data', Buffer.from('warning: x'))
    mockChild.emit('exit', 0)
    const result = await promise
    expect(result.output).toBe('hello world')
    expect(result.error).toContain('warning: x')
  })

  it('kills the child and returns timeout when timeoutMs elapses', async () => {
    const promise = runCcSubprocess({
      cwd: '/x',
      task: 't',
      allowedTools: 'Read',
      timeoutMs: 1000,
    })
    vi.advanceTimersByTime(1500)
    expect(mockChild.kill).toHaveBeenCalled()
    // Simulate the kill landing
    mockChild.emit('exit', null, 'SIGTERM')
    const result = await promise
    expect(result.exitCode).toBe(-1)
    expect(result.error).toMatch(/timeout/i)
  })

  it('returns non-zero exitCode on failure', async () => {
    const promise = runCcSubprocess({
      cwd: '/x',
      task: 't',
      allowedTools: 'Read',
      timeoutMs: 60_000,
    })
    mockChild.stderr.emit('data', Buffer.from('boom'))
    mockChild.emit('exit', 2)
    const result = await promise
    expect(result.exitCode).toBe(2)
    expect(result.error).toContain('boom')
  })

  it('extracts costUsd if present in claude output (best effort)', async () => {
    const promise = runCcSubprocess({
      cwd: '/x',
      task: 't',
      allowedTools: 'Read',
      timeoutMs: 60_000,
    })
    mockChild.stdout.emit(
      'data',
      Buffer.from('result\nTotal cost: $0.0234\n'),
    )
    mockChild.emit('exit', 0)
    const result = await promise
    expect(result.costUsd).toBeCloseTo(0.0234, 4)
  })
})
