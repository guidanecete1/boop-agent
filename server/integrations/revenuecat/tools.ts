import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  createRevenueCatClient,
  RevenueCatAuthError,
  RevenueCatNotFoundError,
  type RevenueCatClient,
} from './client.js'

function resolveApiKey(envVarName: string): string {
  const value = process.env[envVarName]
  if (!value) {
    throw new Error(
      `RevenueCat env var "${envVarName}" is not set. Add it to .env.local (e.g. ${envVarName}=sk_...).`,
    )
  }
  return value
}

function describeError(err: unknown): string {
  if (err instanceof RevenueCatAuthError) return err.message
  if (err instanceof RevenueCatNotFoundError) return err.message
  if (err instanceof Error) return `RevenueCat call failed: ${err.message}`
  return `RevenueCat call failed: ${String(err)}`
}

export function createRevenueCatMcp(injectedClient?: RevenueCatClient) {
  // One client (and one project_id cache) per MCP-server instance — usually
  // one per executor turn. Tests can inject a stub.
  const client = injectedClient ?? createRevenueCatClient()
  return createSdkMcpServer({
    name: 'boop-revenuecat',
    version: '0.1.0',
    tools: [
      tool(
        'list_subscriptions',
        `List subscriptions for a RevenueCat app. Read-only.

Required: api_key_env (the env var NAME from the project's metadata.revenuecat_api_key_env, e.g. "REVENUECAT_API_KEY_MILA"), app_id (from metadata.revenuecat_app_id).
Optional: status ("active" | "expired" | "all"), limit (default 20).`,
        {
          api_key_env: z.string(),
          app_id: z.string(),
          status: z.enum(['active', 'expired', 'all']).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        async (args) => {
          try {
            const apiKey = resolveApiKey(args.api_key_env)
            const data = await client.listSubscriptions(apiKey, args.app_id, {
              status: args.status,
              limit: args.limit,
            })
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: describeError(err) }] }
          }
        },
      ),
      tool(
        'list_purchases',
        `List recent purchases for a RevenueCat app. Read-only.

Required: api_key_env (env var NAME, e.g. "REVENUECAT_API_KEY_MILA"), app_id (from metadata.revenuecat_app_id).
Optional: since (ISO date, e.g. "2026-04-01T00:00:00Z"), limit (default 20).`,
        {
          api_key_env: z.string(),
          app_id: z.string(),
          since: z.string().datetime().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        async (args) => {
          try {
            const apiKey = resolveApiKey(args.api_key_env)
            const data = await client.listPurchases(apiKey, args.app_id, {
              since: args.since,
              limit: args.limit,
            })
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: describeError(err) }] }
          }
        },
      ),
      tool(
        'get_customer',
        `Get full customer detail (subscriptions, entitlements, attributes) by app_user_id. Read-only.

Required: api_key_env (env var NAME), app_id (from metadata.revenuecat_app_id), app_user_id.`,
        {
          api_key_env: z.string(),
          app_id: z.string(),
          app_user_id: z.string(),
        },
        async (args) => {
          try {
            const apiKey = resolveApiKey(args.api_key_env)
            const data = await client.getCustomer(apiKey, args.app_id, args.app_user_id)
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: describeError(err) }] }
          }
        },
      ),
      tool(
        'get_app_metrics',
        `Get MRR / ARR / active-subs / churn snapshot for a RevenueCat app. Read-only.

Required: api_key_env (env var NAME), app_id (from metadata.revenuecat_app_id).
Optional: period ("day" | "week" | "month"; default month).`,
        {
          api_key_env: z.string(),
          app_id: z.string(),
          period: z.enum(['day', 'week', 'month']).optional(),
        },
        async (args) => {
          try {
            const apiKey = resolveApiKey(args.api_key_env)
            const data = await client.getAppMetrics(apiKey, args.app_id, {
              period: args.period,
            })
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: describeError(err) }] }
          }
        },
      ),
    ],
  })
}
