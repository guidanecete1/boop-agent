import { describe, it, expect } from 'vitest'
import { clampAllowedTools } from './permission-clamp.js'

describe('clampAllowedTools', () => {
  it('passes through unchanged for full permission', () => {
    const requested = 'Skill,Read,Write,Edit,Bash(git push),Bash(gh pr create)'
    expect(clampAllowedTools(requested, 'full')).toBe(requested)
  })

  it('strips Write/Edit for read-only permission', () => {
    const out = clampAllowedTools('Skill,Read,Write,Edit,Grep', 'read-only')
    expect(out).toContain('Skill')
    expect(out).toContain('Read')
    expect(out).toContain('Grep')
    expect(out).not.toContain('Write')
    expect(out).not.toContain('Edit')
  })

  it('keeps inspection bash for read-only', () => {
    const out = clampAllowedTools(
      'Skill,Read,Bash(echo:*),Bash(ls:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*)',
      'read-only',
    )
    expect(out).toContain('Bash(echo:*)')
    expect(out).toContain('Bash(ls:*)')
    expect(out).toContain('Bash(git status:*)')
    expect(out).toContain('Bash(git diff:*)')
    expect(out).toContain('Bash(git log:*)')
  })

  it('strips destructive bash for read-only', () => {
    const out = clampAllowedTools(
      'Skill,Read,Bash(git push:*),Bash(rm -rf),Bash(curl:*)',
      'read-only',
    )
    expect(out).not.toContain('git push')
    expect(out).not.toContain('rm -rf')
    expect(out).not.toContain('curl')
  })

  it('strips network/destructive bash for read-write but keeps Write/Edit', () => {
    const out = clampAllowedTools(
      'Skill,Read,Write,Edit,Bash(git push:*),Bash(gh pr create),Bash(curl:*),Bash(npm publish:*)',
      'read-write',
    )
    expect(out).toContain('Write')
    expect(out).toContain('Edit')
    expect(out).not.toContain('git push')
    expect(out).not.toContain('gh pr create')
    expect(out).not.toContain('curl')
    expect(out).not.toContain('npm publish')
  })

  it('always preserves the Skill tool regardless of permission', () => {
    expect(clampAllowedTools('Skill,Read', 'read-only')).toContain('Skill')
    expect(clampAllowedTools('Skill,Write', 'read-write')).toContain('Skill')
  })

  it('handles whitespace and empty entries gracefully', () => {
    expect(clampAllowedTools(' Skill , Read ,, Write ', 'read-only')).toBe('Skill,Read')
  })
})
