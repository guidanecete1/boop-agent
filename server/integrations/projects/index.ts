import { registerIntegration } from '../registry.js'

// The projects MCP is loaded directly by orchestrator and CC executors with
// per-role tool subsets (see createProjectsMcp in ./tools.ts). It's registered
// here for discoverability in `list_integrations`, but cannot be loaded as a
// generic spawn integration — so its createServer throws.
registerIntegration({
  name: 'projects',
  description:
    "Project registry + Claude Code subprocess wrapper. Loaded directly by orchestrator and CC executors via createProjectsMcp(); cannot be passed to generic spawn_agent.",
  createServer: async () => {
    throw new Error(
      "The 'projects' integration is loaded directly by orchestrator and CC executors. Don't pass it to spawn_agent.",
    )
  },
})
