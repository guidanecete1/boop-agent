export type Permission = 'read-only' | 'read-write' | 'full'

const READ_ONLY_BANNED = [
  /^Write$/i,
  /^Edit$/i,
  // Bash is allowed only for a curated set of inspection commands
  /^Bash$/i,
  /^Bash\(((?!echo:|ls:|grep:|cat:|head:|tail:|wc:|find:|git status|git log|git diff)).+\)$/i,
]

const READ_WRITE_BANNED = [
  /^Bash\(curl/i,
  /^Bash\(wget/i,
  /^Bash\(git push/i,
  /^Bash\(gh pr create/i,
  /^Bash\(gh release/i,
  /^Bash\(npm publish/i,
  /^Bash\(eas submit/i,
  /^Bash\(eas build.*--non-interactive.*--auto-submit/i,
]

const BANNED_BY_PERMISSION: Record<Permission, RegExp[]> = {
  'read-only': READ_ONLY_BANNED,
  'read-write': READ_WRITE_BANNED,
  full: [],
}

/**
 * Clamp the LLM-requested allowed_tools string against the project's permission.
 * Skill tool is ALWAYS preserved.
 *
 * Input: comma-separated tool names like "Skill,Read,Write,Bash(git push)"
 * Output: same shape, banned entries stripped.
 */
export function clampAllowedTools(requested: string, permission: Permission): string {
  const banned = BANNED_BY_PERMISSION[permission]
  return requested
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => {
      if (t === 'Skill') return true
      return !banned.some((re) => re.test(t))
    })
    .join(',')
}
