import { registerIntegration } from '../registry.js'

// boop-asc is loaded directly by the ios and expo executors via
// createAscMcp() in ./tools.ts. It is registered here for discoverability
// in `list_integrations` but cannot be loaded as a generic spawn integration.
registerIntegration({
  name: 'asc',
  description:
    'App Store Connect read-only MCP — list apps, list builds, get build status. Loaded directly by ios + expo executors; not for generic spawn_agent.',
  createServer: async () => {
    throw new Error(
      "The 'asc' integration is loaded directly by the ios + expo executors. Don't pass it to spawn_agent.",
    )
  },
})
