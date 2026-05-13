import { query } from '@anthropic-ai/claude-agent-sdk'
import { api } from '../../convex/_generated/api.js'
import { convex } from '../convex-client.js'
import { broadcast } from '../broadcast.js'
import { createDraftStagingMcp } from '../draft-tools.js'
import { createProjectsMcp } from '../integrations/projects/tools.js'
import { createAscMcp } from '../integrations/asc/tools.js'
import { createEasMcp } from '../integrations/eas/tools.js'
import { aggregateUsageFromResult, EMPTY_USAGE, type UsageTotals } from '../usage.js'
import { getRuntimeModel } from '../runtime-config.js'
import type { ExecutorOpts, ExecutorResult } from './types.js'

const EXPO_SYSTEM = `You are the Expo / React Native engineer. You ship Expo apps via EAS and the App Store / Play Console. You work on Expo projects (currently rosibel-clientes).

You delegate code edits to a Claude Code subprocess via run_in_project. The subprocess has access to all installed Claude Code skills, including:
- expo-router-patterns (Expo Router navigation)
- react-native-debugging
- superpowers:writing-plans (multi-step plans)
- superpowers:test-driven-development (writing tests first)

Tool surface:
- run_in_project — code edits, git, gh, anything local in the project's path.
- mcp__boop-asc__* — App Store Connect READ tools (list_apps, list_builds, get_build, get_latest_build). Useful for "did the just-submitted iOS build finish processing in TestFlight?"
- mcp__boop-eas__list_builds, mcp__boop-eas__get_build_status — read-only EAS queries, fast.
- mcp__boop-eas__eas_build — trigger an EAS cloud build. LONG-RUNNING (5-30 min). FIRE-AND-FORGET.
- mcp__boop-eas__eas_submit — submit a build to TestFlight or Play Console. LONG-RUNNING (~1-2 min). FIRE-AND-FORGET.
- mcp__boop-eas__eas_update — publish an OTA update. Fast (~30s). FIRE-AND-FORGET for consistency.

Mode discipline:
- mode='plan': read enough to produce a CONCRETE plan (which profile, which platform, which lane). Don't trigger any builds.
- mode='execute': trigger the build / update via the appropriate MCP tool. The MCP returns immediately with { jobId, status: "running" }. DO NOT block waiting. Return a short user-facing reply ("On it 🛠️ — EAS build production en cola (~10-20 min)."). The buildJobs tick handles completion notification automatically.

When you call run_lane or any of the eas_* fire-and-forget tools, you MUST pass executor_run_id and conversation_id. The orchestrator gives you these via opts:
- executor_run_id: <runId — see the task brief>
- conversation_id: <conversationId — see the task brief>

Chained operations (build → submit):
- For "EAS build then submit to TestFlight" flows, call eas_build with chain_to_submit: true. The tick will automatically create the eas_submit job once the build finishes successfully. ONE call from you, two completion pings to the user (build done + submit done).

Filesystem discipline:
- The project's path is the directory containing eas.json. ALWAYS instruct the CC subprocess to search RECURSIVELY (Glob '**/<pattern>' or 'find . -maxdepth 4 -iname ...') before concluding a file is missing.

You cannot dispatch other executors. If the orchestrator gave you a non-Expo task, return an error so the orchestrator re-routes.

Cross-domain handoff (CRITICAL):
- If the task involves an iOS-native sibling app (Mila / PepBuddy), end your reply with:
    HANDOFF_TO: ios
    REASON: <one-line>
- If the task involves DB work, end with:
    HANDOFF_TO: db
    REASON: <one-line>
    SQL_DRAFT: <SQL>

Output:
- Concise. Lead with the artifact (jobId for fire-and-forget; build URL for read tools).
- For plan mode: a numbered list of concrete steps.
`

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function runExpoExecutor(opts: ExecutorOpts): Promise<ExecutorResult> {
  const runId = randomId('exec-expo')
  const shortId = runId.slice(-6)
  const log = (m: string) => console.log(`[exec expo ${shortId}] ${m}`)
  log(`spawn — slug=${opts.projectSlug ?? 'none'} mode=${opts.mode ?? 'execute'}`)

  await convex.mutation(api.agents.create, {
    agentId: runId,
    conversationId: opts.conversationId,
    name: 'expo-executor',
    task: opts.task,
    mcpServers: ['projects', 'asc', 'eas'],
  })
  await convex.mutation(api.agents.update, { agentId: runId, status: 'running' })
  broadcast('agent_spawned', { agentId: runId, name: 'expo-executor', task: opts.task })

  const projectsServer = createProjectsMcp({
    tools: ['list_projects', 'get_project', 'run_in_project'],
    parentExecutorRunId: runId,
  })
  const draftServer = createDraftStagingMcp(opts.conversationId)
  const ascServer = createAscMcp()
  const easServer = createEasMcp()

  const mcpServers = {
    'boop-projects': projectsServer,
    'boop-drafts': draftServer,
    'boop-asc': ascServer,
    'boop-eas': easServer,
  }

  const allowedTools = [
    'mcp__boop-projects__list_projects',
    'mcp__boop-projects__get_project',
    'mcp__boop-projects__run_in_project',
    'mcp__boop-drafts__save_draft',
    'mcp__boop-asc__list_apps',
    'mcp__boop-asc__list_builds',
    'mcp__boop-asc__get_build',
    'mcp__boop-asc__get_latest_build',
    'mcp__boop-eas__eas_build',
    'mcp__boop-eas__eas_submit',
    'mcp__boop-eas__eas_update',
    'mcp__boop-eas__list_builds',
    'mcp__boop-eas__get_build_status',
  ]

  const taskBrief = [
    opts.projectSlug ? `Target project: ${opts.projectSlug}` : 'No specific project specified by the orchestrator.',
    `Mode: ${opts.mode ?? 'execute'}`,
    `Your runId (pass as executor_run_id when calling fire-and-forget tools): ${runId}`,
    `Your conversationId (pass as conversation_id when calling fire-and-forget tools): ${opts.conversationId}`,
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
        systemPrompt: EXPO_SYSTEM,
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
