import type { WhatsAppClient } from './whatsapp.js'

let client: WhatsAppClient | null = null

/**
 * Register the active outbound messenger. Called once from `server/index.ts`
 * after `initWhatsApp(...)` resolves. Other modules then use `sendMessage`
 * without importing the WhatsApp transport directly.
 */
export function setMessenger(c: WhatsAppClient): void {
  client = c
}

/**
 * Send `text` to `toE164`. If the messenger is not yet initialized
 * (e.g., during startup or after a connection drop), the call is logged
 * and dropped — never thrown. Boop's heartbeat will recover the connection.
 */
export async function sendMessage(toE164: string, text: string): Promise<void> {
  if (!client) {
    console.warn(
      `[messaging] outbound message dropped — messenger not initialized (to=${toE164}, len=${text.length})`,
    )
    return
  }
  await client.send(toE164, text)
}

export function isMessagingReady(): boolean {
  return client !== null
}
