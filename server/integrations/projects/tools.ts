import { tool, createSdkMcpServer, type SdkMcpToolDefinition, type AnyZodRawShape } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { api } from '../../../convex/_generated/api.js'
import { convex } from '../../convex-client.js'
import { broadcast } from '../../broadcast.js'
import { runCcSubprocess } from './cc-subprocess.js'
import { clampAllowedTools, type Permission } from './permission-clamp.js'
import { EXECUTOR_TYPES } from '../../executors/types.js'

const MODE_DEFAULTS = {
  plan: 'Skill,Read,Grep,Glob,Bash(echo:*),Bash(ls:*),Bash(git status:*),Bash(git log:*),Bash(git diff:*)',
  execute: 'Skill,Read,Write,Edit,Glob,Grep,Bash',
} as const

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export type ProjectsToolName =
  | 'list_projects'
  | 'get_project'
  | 'dispatch_executor'
  | 'run_in_project'

export interface ProjectsMcpOptions {
  /** which tools to load — orchestrator gets list/get/dispatch; CC executors get list/get/run_in_project */
  tools: ProjectsToolName[]
  /** parent run id (executionAgents agentId) for tracking lineage */
  parentExecutorRunId?: string
  /**
   * dispatcher invoked by `dispatch_executor`. Caller must provide this — the
   * tools module shouldn't import the executor modules directly to avoid a
   * circular dependency. See server/orchestrator.ts wiring.
   */
  dispatchExecutor?: (input: {
    executorType: string
    task: string
    projectSlug?: string
    mode?: 'plan' | 'execute'
    previouslyDraftedRunId?: string
  }) => Promise<{ runId: string; output: string; status: string; costUsd?: number }>
}

export function createProjectsMcp(opts: ProjectsMcpOptions) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolDefs: SdkMcpToolDefinition<any>[] = []

  if (opts.tools.includes('list_projects')) {
    toolDefs.push(
      tool(
        'list_projects',
        'List all projects in the registry. Returns slug, displayName, type, and permission for each. Use this to discover what projects exist before dispatching to executors.',
        {},
        async () => {
          const rows = await convex.query(api.projects.list, {})
          const trimmed = rows.map((r) => ({
            slug: r.slug,
            displayName: r.displayName,
            type: r.type,
            permission: r.permission,
          }))
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(trimmed, null, 2) }],
          }
        },
      ),
    )
  }

  if (opts.tools.includes('get_project')) {
    toolDefs.push(
      tool(
        'get_project',
        'Get full project details by slug, including path and metadata JSON.',
        { slug: z.string() },
        async (args) => {
          const row = await convex.query(api.projects.getBySlug, { slug: args.slug })
          if (!row) {
            return {
              content: [
                { type: 'text' as const, text: `No project with slug "${args.slug}".` },
              ],
            }
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(row, null, 2) }],
          }
        },
      ),
    )
  }

  if (opts.tools.includes('dispatch_executor')) {
    toolDefs.push(
      tool(
        'dispatch_executor',
        `Dispatch a typed executor agent to handle a sub-task.

executor_type (IMPLEMENTED):
- "personal-assistant" — in-process, Composio (NO supabase / NO revenuecat by design) + WebSearch + WebFetch. For email, calendar, notes, contacts, web lookups. NOT for SQL or DB queries.
- "ios" — CC subprocess in iOS-native projects (mila, pepbuddy). For Swift / Xcode / Fastlane work. Project type must be "ios-native".
- "web" — CC subprocess in Next.js / Vercel projects (rosibel-admin, rosibel-website). For Next.js code edits, Vercel deploys, project-bound PRs via gh CLI. Project type must be "nextjs-vercel". Has NO supabase access — DB work belongs to "db".
- "db" — cross-project DB executor. Has Supabase (Composio multi-account) + RevenueCat (boop-revenuecat MCP). For SQL queries / schema / migrations / row counts / RC subscriptions / RC metrics. Pass project_slug so it can resolve the right connected_account_id and RC env-var name from registry metadata. Use this for "how many X are in Y" style questions even if the project happens to be a Next.js app.

executor_type (NOT YET IMPLEMENTED, will return an error if dispatched — surface as roadmap gap instead):
- "expo" — Spec 4 (rosibel-clientes Expo app)
- "marketing" / "design" / "holafly" — Spec 5

mode:
- "plan" — read-only investigation; outputs a textual plan
- "execute" — full work end-to-end (commits + pushes + deploys for code work; SQL execution for db work). Destructive ops gated by allowed_tools / project permission / save_draft when the orchestrator has not pre-confirmed.

Returns the executor's final output. For destructive multi-step tasks, dispatch with mode='plan' first, then stage a draft of the plan via save_draft.`,
        {
          // Schema is derived from the single source of truth in
          // server/executors/types.ts so it can never drift from the
          // ExecutorType TS union. When you add a new executor type,
          // update EXECUTOR_TYPES there + the description text above.
          executor_type: z.enum(EXECUTOR_TYPES),
          task: z.string(),
          project_slug: z.string().optional(),
          mode: z.enum(['plan', 'execute']).optional(),
          previously_drafted_run_id: z.string().optional(),
        },
        async (args) => {
          if (!opts.dispatchExecutor) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Internal error: dispatch_executor not wired.',
                },
              ],
            }
          }
          const res = await opts.dispatchExecutor({
            executorType: args.executor_type,
            task: args.task,
            projectSlug: args.project_slug,
            mode: args.mode,
            previouslyDraftedRunId: args.previously_drafted_run_id,
          })
          return {
            content: [
              {
                type: 'text' as const,
                text: `[executor ${args.executor_type} ${res.status}] (run ${res.runId})\n\n${res.output}`,
              },
            ],
          }
        },
      ),
    )
  }

  if (opts.tools.includes('run_in_project')) {
    toolDefs.push(
      tool(
        'run_in_project',
        `Spawn a Claude Code subprocess in a project's working directory to do filesystem work.
The subprocess has access to all installed Claude Code skills (~/.claude/skills/) including superpowers, axiom, marketing, and design skills.

allowed_tools is a comma-separated list. Permission is enforced by the registry — read-only projects strip Write/Edit/destructive Bash regardless of what you pass. Mode-driven defaults if you omit allowed_tools:
- plan:    Skill,Read,Grep,Glob,Bash(echo:*),Bash(ls:*),Bash(git status:*),Bash(git log:*),Bash(git diff:*)
- execute: Skill,Read,Write,Edit,Glob,Grep,Bash`,
        {
          slug: z.string(),
          task: z.string(),
          allowed_tools: z.string().optional(),
          mode: z.enum(['plan', 'execute']).optional(),
          timeout_minutes: z.number().optional(),
        },
        async (args) => {
          const project = await convex.query(api.projects.getBySlug, { slug: args.slug })
          if (!project) {
            return {
              content: [
                { type: 'text' as const, text: `No project with slug "${args.slug}".` },
              ],
            }
          }
          if (!project.path) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Project "${args.slug}" has no filesystem path; run_in_project requires a path.`,
                },
              ],
            }
          }
          const mode = args.mode ?? 'execute'
          const requestedTools = args.allowed_tools ?? MODE_DEFAULTS[mode]
          const clamped = clampAllowedTools(requestedTools, project.permission as Permission)
          const timeoutMs = (args.timeout_minutes ?? 10) * 60_000

          const runId = randomId('ccrun')
          await convex.mutation(api.claudeCodeRuns.create, {
            runId,
            projectSlug: project.slug,
            parentExecutorRunId: opts.parentExecutorRunId,
            task: args.task,
            mode,
            allowedTools: clamped,
            cwd: project.path,
          })
          broadcast('cc_run_started', { runId, slug: project.slug, mode })

          const result = await runCcSubprocess({
            cwd: project.path,
            task: args.task,
            allowedTools: clamped,
            timeoutMs,
          })

          let status: 'completed' | 'failed' | 'timeout' = 'completed'
          if (result.exitCode === -1 && result.error?.match(/timeout/i)) status = 'timeout'
          else if (result.exitCode !== 0) status = 'failed'

          await convex.mutation(api.claudeCodeRuns.finish, {
            runId,
            status,
            exitCode: result.exitCode,
            output: result.output.slice(0, 50_000),
            error: result.error?.slice(0, 5_000),
            costUsd: result.costUsd,
          })
          broadcast('cc_run_finished', { runId, status, exitCode: result.exitCode })

          return {
            content: [
              {
                type: 'text' as const,
                text: `[cc ${runId} ${status}] exitCode=${result.exitCode}${
                  result.costUsd ? ` cost=$${result.costUsd.toFixed(4)}` : ''
                }\n\n${result.output}`,
              },
            ],
          }
        },
      ),
    )
  }

  return createSdkMcpServer({
    name: 'boop-projects',
    version: '0.1.0',
    tools: toolDefs,
  })
}
