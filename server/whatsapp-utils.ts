import { franc } from 'franc-min'

/**
 * Normalize a phone number to E.164 form (+<digits>). Returns input unchanged
 * if it doesn't look like a phone number.
 */
export function normalizeE164(n: string | undefined): string | undefined {
  if (n === undefined) return undefined
  const trimmed = n.trim()
  if (!trimmed) return trimmed
  if (trimmed.startsWith('+')) return trimmed
  if (/^\d{11,15}$/.test(trimmed)) return `+${trimmed}`
  return trimmed
}

/**
 * Convert an E.164 number ("+541123867005") to a Baileys individual JID
 * ("541123867005@s.whatsapp.net").
 */
export function e164ToJid(e164: string): string {
  const digits = e164.replace(/^\+/, '')
  return `${digits}@s.whatsapp.net`
}

/**
 * Convert a Baileys individual JID back to E.164, or null if the JID is
 * not an individual (e.g. group `@g.us`).
 */
export function jidToE164(jid: string): string | null {
  const m = /^(\d{8,15})@s\.whatsapp\.net$/.exec(jid)
  if (!m) return null
  return `+${m[1]}`
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us')
}

/**
 * True iff `sender` (E.164 or bare digits) is in `allowed` (E.164 list).
 */
export function isAllowed(sender: string, allowed: string[]): boolean {
  const norm = normalizeE164(sender)
  if (!norm) return false
  return allowed.some((a) => normalizeE164(a) === norm)
}

/**
 * Heuristic language detection. Returns 'es' | 'en' | 'unknown'.
 *
 * Uses franc-min for ISO-639-3 detection then maps to our two-language space.
 * Falls back to 'unknown' for very short or low-confidence input.
 */
export function detectLanguage(text: string): 'es' | 'en' | 'unknown' {
  const trimmed = text.trim()
  // franc-min needs a minimum number of "real" characters to give a useful answer.
  // Empirically below ~15 letters its outputs are noise.
  const letterCount = (trimmed.match(/[A-Za-zÀ-ÿ]/g) ?? []).length
  if (letterCount < 15) return 'unknown'
  const code = franc(trimmed, { only: ['spa', 'eng'] })
  if (code === 'spa') return 'es'
  if (code === 'eng') return 'en'
  return 'unknown'
}

/**
 * Simple in-memory message-id deduper with TTL. Used to drop WhatsApp
 * duplicate deliveries (which can happen on reconnect).
 */
export function createDedup(opts: { ttlMs: number }) {
  const seen = new Map<string, number>()

  function purge(now: number) {
    for (const [k, t] of seen) {
      if (now - t > opts.ttlMs) seen.delete(k)
    }
  }

  return {
    /**
     * Returns true the first time `id` is claimed within the TTL window,
     * false on subsequent claims (until expiry).
     */
    claim(id: string): boolean {
      const now = Date.now()
      purge(now)
      if (seen.has(id)) return false
      seen.set(id, now)
      return true
    },
    size(): number {
      return seen.size
    },
  }
}
