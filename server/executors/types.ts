export type ExecutorType =
  | 'personal-assistant'
  | 'ios'
  | 'expo'
  | 'web'
  | 'marketing'
  | 'design'
  | 'holafly'

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
