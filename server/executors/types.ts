// =============================================================================
// SINGLE SOURCE OF TRUTH for executor types.
//
// `EXECUTOR_TYPES` drives:
//   - The TS `ExecutorType` union below (compile-time)
//   - The zod enum on the `dispatch_executor` MCP tool in
//     server/integrations/projects/tools.ts (LLM-facing schema)
//   - The exhaustive switch in `dispatchExecutorImpl` in
//     server/orchestrator.ts (TypeScript will fail to build if a case is
//     missing, thanks to the `never` check at the bottom of the switch)
//
// -----------------------------------------------------------------------------
// CHECKLIST when adding a new executor type (e.g. Spec 4 = 'expo'):
//
// 1. Add the type to `EXECUTOR_TYPES` below.
// 2. Create `server/executors/<type>.ts` exporting `run<Type>Executor(opts)`.
// 3. Add a `case '<type>': res = await run<Type>Executor(opts); break;`
//    branch in `dispatchExecutorImpl` (server/orchestrator.ts). Move the
//    type out of the not-yet-implemented stub fallthrough block. The
//    `never` check at the end of the switch will surface compile errors
//    if you forget.
// 4. Update the orchestrator's system prompt (`ORCHESTRATOR_SYSTEM` in
//    server/orchestrator.ts) — flip the type's "[NOT YET IMPLEMENTED — Spec N]"
//    tag, and add it to the routing-rule examples + anti-patterns.
// 5. Update the `dispatch_executor` tool's DESCRIPTION text (not just the
//    enum — the enum updates automatically via EXECUTOR_TYPES, but the
//    LLM-facing description in server/integrations/projects/tools.ts also
//    needs the new executor's role + tool surface documented so the model
//    routes correctly first try).
// 6. If the new executor needs an MCP surface different from existing ones,
//    decide its inclusion list and document why each entry is on it.
//    Existing pattern: each executor's MCPs are disjoint to make routing
//    structurally enforceable (e.g. supabase only on `db`, vercel only on
//    `web`).
// =============================================================================

export const EXECUTOR_TYPES = [
  // Implemented:
  'personal-assistant',
  'ios',
  'web',
  'db',
  'expo',
  // Not yet implemented — dispatching one returns a stub error:
  'marketing',
  'design',
  'holafly',
] as const

export type ExecutorType = (typeof EXECUTOR_TYPES)[number]

export interface ExecutorOpts {
  task: string
  conversationId: string
  projectSlug?: string
  mode?: 'plan' | 'execute'
  previouslyDraftedRunId?: string
}

export interface ExecutorResult {
  runId: string
  output: string
  status: 'completed' | 'failed' | 'cancelled'
  costUsd?: number
}
