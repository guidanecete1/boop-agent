import { query } from '@anthropic-ai/claude-agent-sdk'
import { api } from '../../convex/_generated/api.js'
import { convex } from '../convex-client.js'
import { broadcast } from '../broadcast.js'
import { createDraftStagingMcp } from '../draft-tools.js'
import { createProjectsMcp } from '../integrations/projects/tools.js'
import { createRevenueCatMcp } from '../integrations/revenuecat/tools.js'
import { buildMcpServersForIntegrations } from '../integrations/registry.js'
import { aggregateUsageFromResult, EMPTY_USAGE, type UsageTotals } from '../usage.js'
import { getRuntimeModel } from '../runtime-config.js'
import type { ExecutorOpts, ExecutorResult } from './types.js'

const DB_SYSTEM = `You are the database engineer. You work cross-project on Supabase + RevenueCat. Project type doesn't matter — what matters is what data lives where.

Your tools:
- mcp__boop-projects__list_projects — see all known projects
- mcp__boop-projects__get_project — full project details (READ THIS FIRST for any project-bound task — you need the metadata to find connection IDs and RC env-var names)
- mcp__boop-projects__run_in_project — for editing local migration files (e.g., "supabase/migrations/*" inside rosibel-clientes)
- mcp__boop-drafts__save_draft — MANDATORY before any destructive SQL or migration write
- mcp__supabase__* — run SQL, list tables, inspect schema (Composio multi-account; pass connected_account_id from project metadata)
- mcp__boop-revenuecat__* — read-only IAP / subscription / customer queries (pass api_key_env + app_id from project metadata)

Connection / app-id resolution rule:
- Before any Supabase or RevenueCat call, call get_project(slug) to read metadata.
- For Supabase: pass metadata.supabase_connected_account_id as connected_account_id.
- For RevenueCat: pass metadata.revenuecat_api_key_env + metadata.revenuecat_app_id.
- If a metadata field is missing, surface a clear error: "project X has no Supabase connection registered — set metadata.supabase_connected_account_id in the dashboard." Don't guess or fabricate.

Draft discipline (MANDATORY):
- ALWAYS draft destructive operations via save_draft BEFORE executing them. Destructive = ALTER, DROP, DELETE, TRUNCATE, INSERT … ON CONFLICT DO UPDATE on production data, or any local migration file write that changes schema.
- Draft summary must include the EXACT SQL or file diff that will be applied.
- Read-only ops (SELECT, schema inspection, RC list/get) execute directly — no draft.

Permission honoring:
- If the project's permission is "read-only", refuse all mutations even if the user asked. Surface the project's read-only status in the refusal.
- If "read-write" or "full", mutations are allowed but always drafted.

Skill hints when invoking run_in_project for local migration files:
- "use axiom-database-migration"
- "use superpowers:writing-plans" for multi-step migrations

Cross-domain handoff (CRITICAL):
- If the DB change requires a sibling code change (e.g. you added a column the admin UI must render, or you changed a column type the client app must decode), end your reply with a clearly marked block:
    HANDOFF_TO: <web|expo|ios>
    REASON: <one-line summary, e.g. "rosibel-admin's <Header> needs to read the new last_seen_at column">
    NOTE: <optional, e.g. project slug, file hint, "expo executor not yet implemented — Spec 4">
- Do NOT tell the user "you also need to update the admin app yourself". The orchestrator handles cross-domain dispatch via HANDOFF_TO.
- One handoff per reply. If multiple downstream changes are needed (web AND expo), pick the highest-priority one for HANDOFF_TO and mention the other in NOTE.

You cannot dispatch other executors. If the orchestrator gave you a non-DB task, return an error so the orchestrator re-routes.

Output style:
- Concise. Under 400 words.
- Lead with the artifact (row counts, schema diff, PR URL when migration files are committed) when applicable.
- For plan mode: the exact SQL or file diff plus a one-line summary.
`

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function runDbExecutor(opts: ExecutorOpts): Promise<ExecutorResult> {
  const runId = randomId('exec-db')
  const shortId = runId.slice(-6)
  const log = (m: string) => console.log(`[exec db ${shortId}] ${m}`)
  log(`spawn — slug=${opts.projectSlug ?? 'none'} mode=${opts.mode ?? 'execute'}`)

  await convex.mutation(api.agents.create, {
    agentId: runId,
    conversationId: opts.conversationId,
    name: 'db-executor',
    task: opts.task,
    mcpServers: ['projects', 'supabase', 'revenuecat'],
  })
  await convex.mutation(api.agents.update, { agentId: runId, status: 'running' })
  broadcast('agent_spawned', { agentId: runId, name: 'db-executor', task: opts.task })

  const projectsServer = createProjectsMcp({
    tools: ['list_projects', 'get_project', 'run_in_project'],
    parentExecutorRunId: runId,
  })
  const draftServer = createDraftStagingMcp(opts.conversationId)
  const composioServers = await buildMcpServersForIntegrations(
    ['supabase'],
    opts.conversationId,
  )
  const revenuecatServer = createRevenueCatMcp()

  const mcpServers = {
    'boop-projects': projectsServer,
    'boop-drafts': draftServer,
    'boop-revenuecat': revenuecatServer,
    ...composioServers,
  }

  const allowedTools = [
    'mcp__boop-projects__list_projects',
    'mcp__boop-projects__get_project',
    'mcp__boop-projects__run_in_project',
    'mcp__boop-drafts__save_draft',
    'mcp__boop-revenuecat__list_subscriptions',
    'mcp__boop-revenuecat__list_purchases',
    'mcp__boop-revenuecat__get_customer',
    'mcp__boop-revenuecat__get_app_metrics',
    ...Object.keys(composioServers).flatMap((n) => [`mcp__${n}__*`]),
  ]

  const taskBrief = [
    opts.projectSlug
      ? `Target project: ${opts.projectSlug}`
      : 'No specific project specified by orchestrator. If the task implies a single project (Mila / pepbuddy / rosibel-* / etc.), call list_projects + get_project to identify it. If it spans multiple, return an error so the orchestrator dispatches per project.',
    `Mode: ${opts.mode ?? 'execute'}`,
    opts.previouslyDraftedRunId
      ? `Previously drafted plan run id: ${opts.previouslyDraftedRunId} — execute it.`
      : '',
    '',
    'User task:',
    opts.task,
  ]
    .filter(Boolean)
    .join('\n')

  const requestedModel = await getRuntimeModel()
  let buffer = ''
  let usage: UsageTotals = { ...EMPTY_USAGE }
  let status: 'completed' | 'failed' | 'cancelled' = 'completed'
  let errorMsg: string | undefined
  const start = Date.now()

  try {
    for await (const msg of query({
      prompt: taskBrief,
      options: {
        systemPrompt: DB_SYSTEM,
        model: requestedModel,
        mcpServers,
        allowedTools,
        settingSources: [],
        permissionMode: 'bypassPermissions',
      },
    })) {
      if (msg.type === 'assistant') {
        buffer = ''
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            buffer += block.text
            await convex.mutation(api.agents.addLog, {
              agentId: runId,
              logType: 'text',
              content: block.text,
            })
          } else if (block.type === 'tool_use') {
            const toolShort = block.name.replace(/^mcp__[a-z-]+__/, '')
            log(`tool: ${toolShort}`)
            await convex.mutation(api.agents.addLog, {
              agentId: runId,
              logType: 'tool_use',
              toolName: block.name,
              content: JSON.stringify(block.input).slice(0, 2000),
            })
          }
        }
      } else if (msg.type === 'result') {
        usage = aggregateUsageFromResult(msg, requestedModel)
      }
    }
  } catch (err) {
    status = 'failed'
    errorMsg = String(err)
    await convex.mutation(api.agents.addLog, {
      agentId: runId,
      logType: 'error',
      content: errorMsg,
    })
  }

  await convex.mutation(api.agents.update, {
    agentId: runId,
    status,
    result: buffer,
    error: errorMsg,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    costUsd: usage.costUsd,
  })
  if (usage.costUsd > 0) {
    await convex.mutation(api.usageRecords.record, {
      source: 'execution',
      conversationId: opts.conversationId,
      agentId: runId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - start,
    })
  }
  broadcast('agent_done', { agentId: runId, status, result: buffer.slice(0, 200) })

  return {
    runId,
    output: buffer || errorMsg || '(no output)',
    status,
    costUsd: usage.costUsd,
  }
}
