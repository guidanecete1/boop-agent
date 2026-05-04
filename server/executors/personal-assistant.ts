import { spawnExecutionAgent, availableIntegrations } from '../execution-agent.js'
import type { ExecutorOpts, ExecutorResult } from './types.js'

export async function runPersonalAssistantExecutor(
  opts: ExecutorOpts,
): Promise<ExecutorResult> {
  // For personal-assistant work, load every connected Composio integration
  // EXCEPT the ones that belong to specialist executors. The execution-agent
  // itself adds WebSearch + WebFetch.
  //
  // Excluded:
  //   'projects'    — selectively loaded by CC-subprocess executors (ios/web)
  //   'revenuecat'  — loaded directly by db-executor (its shim throws if
  //                   reached via buildMcpServersForIntegrations)
  //   'supabase'    — DB work belongs to db-executor; without this exclusion
  //                   the orchestrator keeps mis-routing "cuantos clientes…"
  //                   style SQL queries to personal-assistant because PA has
  //                   the tools and the routing rule is ambiguous between
  //                   "data query" → db and "lookup" → personal-assistant.
  //                   Removing supabase from PA is code-level enforcement of
  //                   the correct routing — PA literally cannot query the DB
  //                   directly, so the orchestrator must compose db + PA for
  //                   any task that needs both (e.g. "query then email").
  const SPECIAL_INTEGRATIONS = new Set(['projects', 'revenuecat', 'supabase'])
  const integrations = availableIntegrations().filter((n) => !SPECIAL_INTEGRATIONS.has(n))
  const res = await spawnExecutionAgent({
    task: opts.task,
    integrations,
    conversationId: opts.conversationId,
    name: 'personal-assistant',
  })
  return {
    runId: res.agentId,
    output: res.result,
    status: res.status,
  }
}
