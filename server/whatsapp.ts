import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import {
  e164ToJid,
  jidToE164,
  isGroupJid,
  isAllowed,
  detectLanguage,
  createDedup,
} from './whatsapp-utils.js'

export type Language = 'es' | 'en' | 'unknown'

export type IncomingMessage = {
  fromE164: string
  fromJid: string
  text: string
  messageId: string
  timestampMs: number
  language: Language
}

export type WhatsAppClient = {
  send: (toE164: string, text: string) => Promise<void>
  setTyping: (toE164: string, on: boolean) => Promise<void>
  onMessage: (handler: (msg: IncomingMessage) => Promise<void> | void) => void
  isReady: () => boolean
}

const MAX_CHUNK = 4000 // WhatsApp's per-message text limit is 4096

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text]
  const out: string[] = []
  let buf = ''
  for (const line of text.split(/\n/)) {
    if ((buf + '\n' + line).length > size) {
      if (buf) out.push(buf)
      buf = line
    } else {
      buf = buf ? buf + '\n' + line : line
    }
  }
  if (buf) out.push(buf)
  return out
}

function extractText(message: proto.IMessage | null | undefined): string {
  if (!message) return ''
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ''
  )
}

export async function initWhatsApp(opts: {
  sessionDir: string
  allowedNumbers: string[]
  logger?: pino.Logger
}): Promise<WhatsAppClient> {
  const logger =
    opts.logger ??
    pino({ level: process.env.WHATSAPP_LOG_LEVEL ?? 'warn' })

  const handlers: Array<(msg: IncomingMessage) => Promise<void> | void> = []
  const dedup = createDedup({ ttlMs: 5 * 60 * 1000 })

  let sock: WASocket | null = null
  let ready = false
  let reconnectAttempt = 0

  async function connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(opts.sessionDir)
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { qr, connection, lastDisconnect } = update
      if (qr) {
        console.log('\n[whatsapp] scan this QR with the agent\'s WhatsApp:\n')
        qrcode.generate(qr, { small: true })
      }
      if (connection === 'open') {
        ready = true
        reconnectAttempt = 0
        console.log('[whatsapp] connected')
      }
      if (connection === 'close') {
        ready = false
        const status = (
          lastDisconnect?.error as
            | { output?: { statusCode?: number } }
            | undefined
        )?.output?.statusCode
        const loggedOut = status === DisconnectReason.loggedOut
        if (loggedOut) {
          console.error(
            '[whatsapp] logged out — delete the session dir and re-scan QR',
          )
          return
        }
        const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempt)
        reconnectAttempt += 1
        console.warn(
          `[whatsapp] connection closed (status=${status}); reconnecting in ${delay}ms`,
        )
        setTimeout(() => {
          connect().catch((err) =>
            console.error('[whatsapp] reconnect failed', err),
          )
        }, delay)
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const m of messages) {
        try {
          if (m.key.fromMe) continue
          const rawJid = m.key.remoteJid
          if (!rawJid || isGroupJid(rawJid)) continue
          // WhatsApp now delivers many inbound messages with a LID-format JID
          // (`<numeric>@lid`). The phone-number JID lives in `remoteJidAlt`.
          // Prefer that when available; fall back to `remoteJid` for legacy
          // `@s.whatsapp.net` deliveries.
          const keyAny = m.key as unknown as { remoteJidAlt?: string }
          const jid =
            rawJid.endsWith('@lid') && keyAny.remoteJidAlt
              ? keyAny.remoteJidAlt
              : rawJid
          const fromE164 = jidToE164(jid)
          if (!fromE164) {
            console.log(
              `[whatsapp] dropped — could not resolve sender JID (raw=${rawJid}, alt=${keyAny.remoteJidAlt ?? 'none'})`,
            )
            continue
          }
          if (!isAllowed(fromE164, opts.allowedNumbers)) {
            console.log(`[whatsapp] dropped non-allowlisted sender ${fromE164}`)
            continue
          }
          const text = extractText(m.message).trim()
          if (!text) continue
          const messageId = m.key.id ?? ''
          if (!messageId || !dedup.claim(messageId)) continue
          const lang = detectLanguage(text)
          const msg: IncomingMessage = {
            fromE164,
            fromJid: jid,
            text,
            messageId,
            timestampMs: Number(m.messageTimestamp ?? Date.now() / 1000) * 1000,
            language: lang,
          }
          for (const h of handlers) {
            try {
              await h(msg)
            } catch (err) {
              console.error('[whatsapp] handler threw', err)
            }
          }
        } catch (err) {
          console.error('[whatsapp] error processing message', err)
        }
      }
    })
  }

  await connect()

  function requireSocket(): WASocket {
    if (!sock) throw new Error('whatsapp socket not initialized')
    return sock
  }

  return {
    async send(toE164, text) {
      const jid = e164ToJid(toE164)
      for (const part of chunk(text)) {
        await requireSocket().sendMessage(jid, { text: part })
      }
    },
    async setTyping(toE164, on) {
      const jid = e164ToJid(toE164)
      try {
        await requireSocket().sendPresenceUpdate(on ? 'composing' : 'paused', jid)
      } catch {
        /* presence updates are best-effort */
      }
    },
    onMessage(handler) {
      handlers.push(handler)
    },
    isReady() {
      return ready
    },
  }
}
