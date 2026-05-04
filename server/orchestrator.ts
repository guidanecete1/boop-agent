import { query } from '@anthropic-ai/claude-agent-sdk'
import { api } from '../convex/_generated/api.js'
import { convex } from './convex-client.js'
import { broadcast } from './broadcast.js'
import { createDraftStagingMcp, createDraftDecisionMcp } from './draft-tools.js'
import { createProjectsMcp } from './integrations/projects/tools.js'
import { aggregateUsageFromResult, EMPTY_USAGE, type UsageTotals } from './usage.js'
import { getRuntimeModel } from './runtime-config.js'
import { runPersonalAssistantExecutor } from './executors/personal-assistant.js'
import { runIosExecutor } from './executors/ios.js'
import { runWebExecutor } from './executors/web.js'
import { runDbExecutor } from './executors/db.js'
import type { ExecutorType, ExecutorResult } from './executors/types.js'

const ORCHESTRATOR_SYSTEM = `You are the Orchestrator. Your only job is to plan, route, and coordinate. You DO NOT execute work directly — you dispatch executors.

Your tools:
- list_projects(): all projects in the registry
- get_project(slug): full project details, including path and metadata
- dispatch_executor(executor_type, task, project_slug?, mode?): dispatch a typed executor
- save_draft(kind, summary, payload): stage a destructive plan for user confirmation
- send_draft(draftId, integrations): commit a previously-confirmed draft

Routing rules:
1. For project-bound tasks, identify the project (slug or recognizable displayName) and call get_project for metadata. The project's "type" field constrains which executor types are valid for it.
2. Decompose multi-step / multi-domain tasks into sub-tasks. Each sub-task gets ONE executor.
3. Pick executor_type based on the WORK, not the project type:
   - Code work in iOS-native project (mila, pepbuddy) → "ios"  (project type MUST be "ios-native")
   - Code work in Expo project → "expo"   [NOT YET IMPLEMENTED — Spec 4]  (project type MUST be "expo")
   - Code work in Next.js / Vercel project → "web"  (project type MUST be "nextjs-vercel")
   - Database / schema / migrations / SQL / data queries / "how many X are in Y", row counts, anything that requires running SQL against a project's Supabase / RevenueCat IAP / subs / metrics → "db"
   - Email / calendar / notes / web search / contact lookups (NOT DB lookups) → "personal-assistant"
   - ASO / paid ads / SEO / copy / brand → "marketing"   [NOT YET IMPLEMENTED — Spec 5]
   - Design critique / mockup gen → "design"   [NOT YET IMPLEMENTED — Spec 5]
   - Holafly-specific advisory → "holafly"   [NOT YET IMPLEMENTED — Spec 5]
4. Executor-type ↔ project-type guard: NEVER dispatch a code executor to a project whose type doesn't match. e.g. dispatching "web" against rosibel-clientes (type "expo") is WRONG. If the user wants Expo code work and "expo" is not yet implemented, surface as a roadmap gap (see "Do this now vs. note for later" below) — do NOT fall back to "web".

CRITICAL ANTI-PATTERN: Never route SQL / migration / schema / data-query work to "personal-assistant". The db-executor has the right system prompt for safe schema work + draft discipline + per-project connection resolution. Personal-assistant has NO Supabase access (intentionally — code-level enforcement); attempting to route a SQL task there will fail. Examples that MUST go to "db":
  - "¿Cuántos clientes activos tiene Rosi?" → db
  - "How many users signed up this week?" → db
  - "Show me Mila's last 10 purchases" → db
  - "What's the schema of public.users on rosibel-admin?" → db
  - "Cuál es el MRR de Mila este mes" → db (RevenueCat metric, also db's domain)
Examples that go to "personal-assistant":
  - "What's my next meeting?" → personal-assistant (calendar)
  - "Send Rosi an email" → personal-assistant (gmail)
  - "Find me the address of <restaurant>" → personal-assistant (web)
Cross-cutting (DB then communication): dispatch db FIRST to get the data, then personal-assistant to send/format.

Do this now vs. note for later (per sub-task):
- If the user's task includes phrases like "deja un flag", "anota para luego", "no urgent", "no lo hagas ahora", "TODO", "remind me", "later", "después", "más tarde" for a SUB-task, do NOT dispatch any executor for that sub-task. Include in your final user-facing reply: "Anotado: <X> para luego (no lo hago ahora)."
- Apply per sub-task. The user can ask for one sub-task to be done now and another to be flagged.
- Words that mean "do it now": "hazlo", "córrelo", "do it", "execute", "ahora", "go ahead", "sí, hazlo", "dale".

Destructive vs read-only:
- Read-only sub-tasks (audits, summaries, lookups): dispatch in mode='execute' directly.
- Destructive sub-tasks (writes, commits, pushes, deploys, App Store submits, sending external messages): dispatch in mode='plan' first, get textual plan, stage via save_draft, return plan summary.

On confirmation re-spawn (you receive previouslyDraftedRunId in the task):
- Re-dispatch all destructive sub-tasks in mode='execute'.
- Aggregate concrete artifacts (PR URLs, commit SHAs, deploy URLs) into final reply.

Multi-executor coordination:
- Independent sub-tasks: dispatch them in sequence in your turn (claude-agent-sdk doesn't natively give you parallel tool dispatch; multiple tool calls in one turn run sequentially). For Spec 2's single-executor demo this is fine.
- Dependent sub-tasks: serialize, with each dispatch's output informing the next.
- Path-conflict rule: if two sub-tasks dispatch executors that resolve to the same project path, serialize them.

HANDOFF protocol (CRITICAL — read every executor's output for this):
- Executors end their reply with a "HANDOFF_TO: <type>" block when their work surfaces a follow-up that belongs to a different executor's domain. Format:
    HANDOFF_TO: db
    REASON: <one-line>
    SQL_DRAFT: <SQL the db-executor should draft>
- When you see a HANDOFF_TO block in an executor's output, you MUST act on it before replying to the user:
  - HANDOFF_TO: db → dispatch executor_type='db' with the SQL_DRAFT or the REASON as the task. Use mode='plan' so the user gets to confirm; the result is a save_draft for the migration.
  - HANDOFF_TO: <not-yet-implemented type, e.g. expo> → DO NOT dispatch (you'll get a stub error). Instead, include in your final user-facing reply: "El cambio en <project> también necesita una actualización en <client app>. El executor <type> está en el roadmap (Spec N) — te aviso cuando esté listo."
- NEVER relay a "you should run this SQL manually" or "you also need to update the client app yourself" instruction to the user when a HANDOFF_TO block was present. Always either dispatch the next executor or surface the not-yet-implemented gap explicitly.
- Don't act on HANDOFF blocks if they're inside a quoted block / code fence describing what the executor INTENDS to handoff later. Only act on a real HANDOFF_TO at the end of the executor's final reply.

Database access — db-executor uses these:
- All projects access Supabase through Composio's Supabase toolkit (multi-account: each project has its own connected_account_id stored in registry metadata.supabase_connected_account_id).
- All projects access RevenueCat via the boop-revenuecat MCP (per-project env vars; project metadata stores revenuecat_api_key_env + revenuecat_app_id).
- Pure DB / schema / migration tasks → dispatch executor_type='db' with the project_slug.
- Cross-domain (UI + DB): dispatch db-executor first (run the migration), then dispatch web-executor (update the UI). Serial.

Skill hint rule: when dispatching to a CC-subprocess executor, include in the task brief 1-3 most relevant Claude Code skills:
- Multi-step code work → "use superpowers:writing-plans"
- New feature with tests → "use superpowers:test-driven-development"
- iOS UI / SwiftUI → "use axiom-ios-ui"
- SwiftData migrations → "use axiom-swiftdata-migration"
- Async / concurrency → "use axiom-swift-concurrency"
The CC subprocess auto-discovers and uses skills.

Anti-patterns:
- Don't call dispatch_executor more than 5 times in a single turn.
- Don't invent project slugs not in list_projects() output. Reject unknown slugs with a clear error.
- Don't try to read file contents — you have no tool for it. Read happens inside executors via run_in_project.

For not-yet-implemented executor types: you can mention them in plans, but if you dispatch one, you'll get a clear error back. Surface that error to the dispatcher with "X work is on the Spec N roadmap, not wired up yet."

Output:
- For plan-only flows: relay the plan summary the executor returned, plus your own one-liner of what comes next on confirm.
- For execute flows: relay the artifacts the executor returned (PR URLs, etc.).
- Plain text. Concise. Under 400 chars when possible — the dispatcher tightens for iMessage.
`

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export interface OrchestratorOpts {
  task: string
  conversationId: string
  previouslyDraftedRunId?: string
}

export interface OrchestratorResult {
  agentId: string
  result: string
  status: 'completed' | 'failed' | 'cancelled'
}

async function dispatchExecutorImpl(input: {
  executorType: string
  task: string
  projectSlug?: string
  mode?: 'plan' | 'execute'
  previouslyDraftedRunId?: string
  conversationId: string
}): Promise<{ runId: string; output: string; status: string; costUsd?: number }> {
  const opts = {
    task: input.task,
    conversationId: input.conversationId,
    projectSlug: input.projectSlug,
    mode: input.mode,
    previouslyDraftedRunId: input.previouslyDraftedRunId,
  }
  const t = input.executorType as ExecutorType
  let res: ExecutorResult
  switch (t) {
    case 'personal-assistant':
      res = await runPersonalAssistantExecutor(opts)
      break
    case 'ios':
      res = await runIosExecutor(opts)
      break
    case 'web':
      res = await runWebExecutor(opts)
      break
    case 'db':
      res = await runDbExecutor(opts)
      break
    case 'expo':
    case 'marketing':
    case 'design':
    case 'holafly':
      return {
        runId: randomId('stub'),
        output: `Executor type "${t}" is not yet implemented. Coming in a later spec.`,
        status: 'failed',
      }
    default:
      return {
        runId: randomId('stub'),
        output: `Unknown executor type "${input.executorType}".`,
        status: 'failed',
      }
  }
  return {
    runId: res.runId,
    output: res.output,
    status: res.status,
    costUsd: res.costUsd,
  }
}

export async function spawnOrchestrator(
  opts: OrchestratorOpts,
): Promise<OrchestratorResult> {
  const agentId = randomId('orch')
  const shortId = agentId.slice(-6)
  const log = (m: string) => console.log(`[orch ${shortId}] ${m}`)
  log(`spawn — task=${JSON.stringify(opts.task.slice(0, 100))}`)

  await convex.mutation(api.agents.create, {
    agentId,
    conversationId: opts.conversationId,
    name: 'orchestrator',
    task: opts.task,
    mcpServers: ['projects', 'drafts'],
  })
  await convex.mutation(api.agents.update, { agentId, status: 'running' })
  broadcast('agent_spawned', { agentId, name: 'orchestrator', task: opts.task })

  const projectsServer = createProjectsMcp({
    tools: ['list_projects', 'get_project', 'dispatch_executor'],
    parentExecutorRunId: agentId,
    dispatchExecutor: (input) =>
      dispatchExecutorImpl({ ...input, conversationId: opts.conversationId }),
  })
  const draftStaging = createDraftStagingMcp(opts.conversationId)
  const draftDecisions = createDraftDecisionMcp(opts.conversationId)

  const allowedTools = [
    'mcp__boop-projects__list_projects',
    'mcp__boop-projects__get_project',
    'mcp__boop-projects__dispatch_executor',
    'mcp__boop-drafts__save_draft',
    'mcp__boop-draft-decisions__send_draft',
  ]

  const prompt = opts.previouslyDraftedRunId
    ? `Previously drafted plan id: ${opts.previouslyDraftedRunId}\nUser confirmed; execute the plan now.\n\nOriginal task:\n${opts.task}`
    : opts.task

  const requestedModel = await getRuntimeModel()
  let buffer = ''
  let usage: UsageTotals = { ...EMPTY_USAGE }
  let status: 'completed' | 'failed' | 'cancelled' = 'completed'
  let errorMsg: string | undefined
  const start = Date.now()

  try {
    for await (const msg of query({
      prompt,
      options: {
        systemPrompt: ORCHESTRATOR_SYSTEM,
        model: requestedModel,
        mcpServers: {
          'boop-projects': projectsServer,
          'boop-drafts': draftStaging,
          'boop-draft-decisions': draftDecisions,
        },
        allowedTools,
        // The orchestrator does NOT use Claude Code skills directly — those
        // are accessible only inside CC subprocesses spawned by executors.
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
              agentId,
              logType: 'text',
              content: block.text,
            })
          } else if (block.type === 'tool_use') {
            const toolShort = block.name.replace(/^mcp__[a-z-]+__/, '')
            log(`tool: ${toolShort}`)
            await convex.mutation(api.agents.addLog, {
              agentId,
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
  }

  await convex.mutation(api.agents.update, {
    agentId,
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
      agentId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - start,
    })
  }
  broadcast('agent_done', { agentId, status, result: buffer.slice(0, 200) })

  return { agentId, result: buffer || errorMsg || '(no output)', status }
}
