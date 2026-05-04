import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import * as fs from 'node:fs'
import {
  createAscClient,
  AscAuthError,
  AscNotFoundError,
  type AscClient,
} from './client.js'

function describeError(err: unknown): string {
  if (err instanceof AscAuthError) return err.message
  if (err instanceof AscNotFoundError) return err.message
  if (err instanceof Error) return `ASC call failed: ${err.message}`
  return `ASC call failed: ${String(err)}`
}

function readEnv(): { keyId: string; issuerId: string; privateKeyPem: string } {
  const keyId = process.env.ASC_API_KEY_ID
  const issuerId = process.env.ASC_ISSUER_ID
  const keyPath = process.env.ASC_API_KEY_PATH
  if (!keyId || !issuerId || !keyPath) {
    throw new Error(
      'ASC credentials missing — set ASC_API_KEY_ID, ASC_ISSUER_ID, ASC_API_KEY_PATH in .env.local.',
    )
  }
  let pem: string
  try {
    pem = fs.readFileSync(keyPath, 'utf8')
  } catch (err) {
    throw new Error(`Could not read ASC private key at ${keyPath}: ${(err as Error).message}`)
  }
  return { keyId, issuerId, privateKeyPem: pem }
}

export function createAscMcp(injectedClient?: AscClient) {
  // One client (and one JWT cache) per MCP-server instance — usually one
  // per executor turn. Tests can inject a stub.
  const client = injectedClient ?? createAscClient(readEnv())
  return createSdkMcpServer({
    name: 'boop-asc',
    version: '0.1.0',
    tools: [
      tool(
        'list_apps',
        `List all apps in the ASC team. Read-only. Useful for resolving bundle IDs or showing the user what's available.`,
        {},
        async () => {
          try {
            const data = await client.listApps()
            return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: describeError(err) }] }
          }
        },
      ),
      tool(
        'list_builds',
        `List recent builds for an app. Read-only.

Required: bundle_id (e.g. "com.alfredo.mila").
Optional: limit (default 10), processing_state ("PROCESSING" | "VALID" | "INVALID" | "FAILED").`,
        {
          bundle_id: z.string(),
          limit: z.number().int().min(1).max(200).optional(),
          processing_state: z.enum(['PROCESSING', 'VALID', 'INVALID', 'FAILED']).optional(),
        },
        async (args) => {
          try {
            const data = await client.listBuilds(args.bundle_id, {
              limit: args.limit,
              processing_state: args.processing_state,
            })
            return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: describeError(err) }] }
          }
        },
      ),
      tool(
        'get_build',
        `Get full detail for a specific build. Read-only.

Required: bundle_id, build_id.`,
        {
          bundle_id: z.string(),
          build_id: z.string(),
        },
        async (args) => {
          try {
            const data = await client.getBuild(args.bundle_id, args.build_id)
            return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: describeError(err) }] }
          }
        },
      ),
      tool(
        'get_latest_build',
        `Get the most recent build for an app, optionally filtered by processing state. Read-only.
Useful for "did the just-uploaded TestFlight build finish processing?" — pass processing_state="VALID".

Required: bundle_id.
Optional: processing_state.`,
        {
          bundle_id: z.string(),
          processing_state: z.enum(['PROCESSING', 'VALID', 'INVALID', 'FAILED']).optional(),
        },
        async (args) => {
          try {
            const data = await client.getLatestBuild(args.bundle_id, {
              processing_state: args.processing_state,
            })
            return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: describeError(err) }] }
          }
        },
      ),
    ],
  })
}
