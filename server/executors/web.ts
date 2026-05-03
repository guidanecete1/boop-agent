import { query } from '@anthropic-ai/claude-agent-sdk'
import { api } from '../../convex/_generated/api.js'
import { convex } from '../convex-client.js'
import { broadcast } from '../broadcast.js'
import { createDraftStagingMcp } from '../draft-tools.js'
import { createProjectsMcp } from '../integrations/projects/tools.js'
import { buildMcpServersForIntegrations } from '../integrations/registry.js'
import { aggregateUsageFromResult, EMPTY_USAGE, type UsageTotals } from '../usage.js'
import { getRuntimeModel } from '../runtime-config.js'
import type { ExecutorOpts, ExecutorResult } from './types.js'

const WEB_SYSTEM = `You are the web engineer. You work on Next.js / Vercel projects (currently rosibel-admin and rosibel-website).

You delegate code edits to a Claude Code subprocess via the run_in_project tool. The subprocess has access to all installed Claude Code skills, including:
- frontend-design (UI patterns)
- nextjs-turbopack (Next.js / Turbopack patterns)
- superpowers:writing-plans (multi-step plans)
- superpowers:test-driven-development (writing tests first)
(Pure DB work — schema migrations, RLS, data ops with no UI half — should be re-routed to the db-executor; mention that explicitly when handing back.)

Mode discipline:
- mode='plan': read enough to produce a CONCRETE plan (which files, which lines, which branch, which commit message, which deploy target). Don't make changes.
- mode='execute': do the work end-to-end. Stage destructive operations (push, gh pr create, vercel deploy --prod) via save_draft if the orchestrator hasn't already pre-confirmed them. Return concrete artifacts (commit SHAs, PR URLs, preview URLs).

Tool selection:
- Code edits → run_in_project (CC subprocess in the project's cwd, with Skill, Read, Write, Edit, Glob, Grep, Bash).
- For project-bound PR creation, prefer 'gh pr create' inside run_in_project (single CC turn, end-to-end). Composio's GitHub toolkit (mcp__github__*) is reserved for cross-project / non-code GitHub queries from the personal-assistant executor.
- For Vercel deploys: prefer the Composio Vercel toolkit (mcp__vercel__*) for deploy / list deployments / get deployment status. If Composio's Vercel surface doesn't expose preview-with-URL-return, fall back to letting Vercel's GitHub integration auto-build a preview when the PR opens, and read the preview URL from the GitHub PR's checks API via gh.
- For Supabase queries that come up incidentally during UI work: use mcp__supabase__*. If the work is pure DB (schema migrations, RLS, data ops with no UI half), tell the orchestrator and stop — re-route to db-executor.

When you build the task brief for the CC subprocess:
- Mention 1-3 most relevant skills by name.
- Be specific: project slug, what files / functions to focus on, what artifact to return.
- Don't dump the whole user task verbatim — extract the web-specific intent.

Filesystem discipline:
- The project's cwd is often a parent directory containing the actual code in subfolders, plus sibling artifacts (assets, screenshots, docs). For example, the registered path for rosibel-admin and rosibel-website is "/Users/Alfredo/Documents/AI Varios/Rosibel Avila" — the actual Next.js app lives in a subdirectory.
- ALWAYS instruct the CC subprocess to search RECURSIVELY (Glob '**/<pattern>' or 'find . -maxdepth 4 -iname ...') before concluding a file is missing.

You cannot dispatch other executors. If the orchestrator gave you a non-web task, return an error so the orchestrator re-routes.

Output style:
- Concise. Under 400 words.
- Lead with the artifact (PR URL, preview URL, commit SHA) when applicable.
- For plan mode: a numbered list of concrete steps.
`

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function runWebExecutor(opts: ExecutorOpts): Promise<ExecutorResult> {
  const runId = randomId('exec-web')
  const shortId = runId.slice(-6)
  const log = (m: string) => console.log(`[exec web ${shortId}] ${m}`)
  log(`spawn — slug=${opts.projectSlug ?? 'none'} mode=${opts.mode ?? 'execute'}`)

  await convex.mutation(api.agents.create, {
    agentId: runId,
    conversationId: opts.conversationId,
    name: 'web-executor',
    task: opts.task,
    mcpServers: ['projects', 'vercel', 'github', 'supabase'],
  })
  await convex.mutation(api.agents.update, { agentId: runId, status: 'running' })
  broadcast('agent_spawned', { agentId: runId, name: 'web-executor', task: opts.task })

  const projectsServer = createProjectsMcp({
    tools: ['list_projects', 'get_project', 'run_in_project'],
    parentExecutorRunId: runId,
  })
  const draftServer = createDraftStagingMcp(opts.conversationId)
  const composioServers = await buildMcpServersForIntegrations(
    ['vercel', 'github', 'supabase'],
    opts.conversationId,
  )

  const mcpServers = {
    'boop-projects': projectsServer,
    'boop-drafts': draftServer,
    ...composioServers,
  }

  const allowedTools = [
    'mcp__boop-projects__list_projects',
    'mcp__boop-projects__get_project',
    'mcp__boop-projects__run_in_project',
    'mcp__boop-drafts__save_draft',
    ...Object.keys(composioServers).flatMap((n) => [`mcp__${n}__*`]),
  ]

  const taskBrief = [
    opts.projectSlug
      ? `Target project: ${opts.projectSlug}`
      : 'No specific project; the orchestrator may have erred — fail loudly.',
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
        systemPrompt: WEB_SYSTEM,
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
