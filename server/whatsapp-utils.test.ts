import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  normalizeE164,
  e164ToJid,
  jidToE164,
  isAllowed,
  isGroupJid,
  detectLanguage,
  createDedup,
} from './whatsapp-utils.js'

describe('normalizeE164', () => {
  it('returns +-prefixed numbers unchanged', () => {
    expect(normalizeE164('+541123867005')).toBe('+541123867005')
  })
  it('adds + to bare 11-15 digit numbers', () => {
    expect(normalizeE164('541123867005')).toBe('+541123867005')
  })
  it('returns input unchanged when malformed', () => {
    expect(normalizeE164('hello')).toBe('hello')
  })
  it('handles undefined', () => {
    expect(normalizeE164(undefined)).toBeUndefined()
  })
})

describe('e164ToJid / jidToE164', () => {
  it('converts E.164 to a Baileys individual JID', () => {
    expect(e164ToJid('+541123867005')).toBe('541123867005@s.whatsapp.net')
  })
  it('converts JID back to E.164', () => {
    expect(jidToE164('541123867005@s.whatsapp.net')).toBe('+541123867005')
  })
  it('jidToE164 returns null for unknown JID shapes', () => {
    expect(jidToE164('foo')).toBeNull()
    expect(jidToE164('123@g.us')).toBeNull() // group JID not converted
  })
})

describe('isGroupJid', () => {
  it('identifies group JIDs', () => {
    expect(isGroupJid('1234567890-abc@g.us')).toBe(true)
  })
  it('rejects individual JIDs', () => {
    expect(isGroupJid('541123867005@s.whatsapp.net')).toBe(false)
  })
})

describe('isAllowed', () => {
  it('passes when sender is in the allowlist (E.164 form)', () => {
    expect(isAllowed('+541123867005', ['+541123867005'])).toBe(true)
  })
  it('passes when sender is in the allowlist (bare digits, gets normalized)', () => {
    expect(isAllowed('541123867005', ['+541123867005'])).toBe(true)
  })
  it('rejects when sender is not in the allowlist', () => {
    expect(isAllowed('+12025550123', ['+541123867005'])).toBe(false)
  })
  it('rejects when allowlist is empty', () => {
    expect(isAllowed('+541123867005', [])).toBe(false)
  })
})

describe('detectLanguage', () => {
  it('identifies Spanish', () => {
    expect(detectLanguage('Hola, ¿cómo estás? Necesito que me ayudes con esto.')).toBe('es')
  })
  it('identifies English', () => {
    expect(detectLanguage('Hello, can you help me with this please?')).toBe('en')
  })
  it('returns "unknown" for very short / ambiguous text', () => {
    expect(detectLanguage('ok')).toBe('unknown')
    expect(detectLanguage('👍')).toBe('unknown')
  })
})

describe('createDedup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('claims a fresh id', () => {
    const d = createDedup({ ttlMs: 1000 })
    expect(d.claim('msg-1')).toBe(true)
  })
  it('rejects a duplicate id within TTL', () => {
    const d = createDedup({ ttlMs: 1000 })
    expect(d.claim('msg-1')).toBe(true)
    expect(d.claim('msg-1')).toBe(false)
  })
  it('re-claims after TTL expires', () => {
    const d = createDedup({ ttlMs: 1000 })
    expect(d.claim('msg-1')).toBe(true)
    vi.advanceTimersByTime(1500)
    expect(d.claim('msg-1')).toBe(true)
  })
})
