import { spawnExecutionAgent, availableIntegrations } from '../execution-agent.js'
import type { ExecutorOpts, ExecutorResult } from './types.js'

export async function runPersonalAssistantExecutor(
  opts: ExecutorOpts,
): Promise<ExecutorResult> {
  // For personal-assistant work, load every connected Composio integration.
  // The execution-agent itself adds WebSearch + WebFetch.
  // 'projects' is excluded — that integration is loaded selectively by
  // CC-subprocess executors (ios, etc.).
  const integrations = availableIntegrations().filter((n) => n !== 'projects')
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
