import { query } from '@anthropic-ai/claude-agent-sdk'
import { api } from '../../convex/_generated/api.js'
import { convex } from '../convex-client.js'
import { broadcast } from '../broadcast.js'
import { createDraftStagingMcp } from '../draft-tools.js'
import { createProjectsMcp } from '../integrations/projects/tools.js'
import { aggregateUsageFromResult, EMPTY_USAGE, type UsageTotals } from '../usage.js'
import { getRuntimeModel } from '../runtime-config.js'
import type { ExecutorOpts, ExecutorResult } from './types.js'

const IOS_SYSTEM = `You are the iOS engineer. You work on Swift / Xcode / Fastlane / iOS-native projects (currently mila and pepbuddy).

You DO NOT touch files directly. You delegate code work to a Claude Code subprocess via the run_in_project tool. The subprocess has access to all installed Claude Code skills, including:
- axiom-ios-ui (SwiftUI patterns)
- axiom-swift-concurrency (async/await, actors)
- axiom-swiftdata-migration (SwiftData schema changes)
- axiom-ios-build (build / signing / Fastlane)
- superpowers:writing-plans (multi-step plans)
- superpowers:test-driven-development (writing tests first)

Mode discipline:
- mode='plan': read enough to produce a CONCRETE plan (which files, which lines, which branch, which commit message, which commands). Don't make changes. Pass narrow allowed_tools.
- mode='execute': do the work end-to-end. Stage destructive operations (push, gh pr create, App Store submit) via save_draft if the orchestrator hasn't already pre-confirmed them. Return concrete artifacts (commit SHAs, branch names, PR URLs).

When you build the task brief for the CC subprocess:
- Mention 1-3 most relevant skills by name. The subprocess will auto-invoke them via the Skill tool.
- Be specific: project slug, what files / functions to focus on, what artifact to return.
- Don't dump the whole user task verbatim — extract the iOS-specific intent.

Filesystem discipline (IMPORTANT):
- The project's cwd is often a parent directory containing the actual code in subfolders, plus sibling artifacts (auth keys, screenshots, docs, etc.). For example, the registered path for "pepbuddy" is "Claude Ruflo Multiagents" but the actual app code lives in a "PepBuddy/" subdirectory.
- When asked to find/read/audit/inspect/summarize a file (README, source, config, plist, etc.), ALWAYS instruct the CC subprocess to search RECURSIVELY before concluding the file doesn't exist.
- Concrete patterns to use in the task brief: "Use Glob '**/<pattern>' to locate", or "Run \`find . -maxdepth 4 -iname '<pattern>' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/Pods/*'\`".
- Don't accept a top-level miss as the final answer. The project structure is the agent's responsibility to discover.

You cannot dispatch other executors. If the orchestrator gave you a non-iOS task, return an error so the orchestrator re-routes.

Output style:
- Concise. Under 400 words.
- Lead with the artifact (PR URL, commit SHA, etc.) when applicable.
- For plan mode: a numbered list of concrete steps.
`

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function runIosExecutor(opts: ExecutorOpts): Promise<ExecutorResult> {
  const runId = randomId('exec-ios')
  const shortId = runId.slice(-6)
  const log = (m: string) => console.log(`[exec ios ${shortId}] ${m}`)
  log(`spawn — slug=${opts.projectSlug ?? 'none'} mode=${opts.mode ?? 'execute'}`)

  // Persist as an executionAgents row so it shows up in the dashboard.
  await convex.mutation(api.agents.create, {
    agentId: runId,
    conversationId: opts.conversationId,
    name: 'ios-executor',
    task: opts.task,
    mcpServers: ['projects'],
  })
  await convex.mutation(api.agents.update, { agentId: runId, status: 'running' })
  broadcast('agent_spawned', { agentId: runId, name: 'ios-executor', task: opts.task })

  const projectsServer = createProjectsMcp({
    tools: ['list_projects', 'get_project', 'run_in_project'],
    parentExecutorRunId: runId,
  })
  const draftServer = createDraftStagingMcp(opts.conversationId)

  const allowedTools = [
    'mcp__boop-projects__list_projects',
    'mcp__boop-projects__get_project',
    'mcp__boop-projects__run_in_project',
    'mcp__boop-drafts__save_draft',
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
    `User task:`,
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
        systemPrompt: IOS_SYSTEM,
        model: requestedModel,
        mcpServers: {
          'boop-projects': projectsServer,
          'boop-drafts': draftServer,
        },
        allowedTools,
        // Skill discovery happens inside the CC subprocess (via claude -p),
        // not here — the executor itself has no Skill tool.
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
