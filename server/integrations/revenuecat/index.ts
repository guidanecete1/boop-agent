import { registerIntegration } from '../registry.js'

// The RevenueCat MCP is loaded directly by the db-executor (and possibly the
// ios-executor in Spec 4 if Mila's pipeline references RC config) via
// createRevenueCatMcp() in ./tools.ts. It's registered here for
// discoverability in `list_integrations` but cannot be loaded as a generic
// spawn integration.
registerIntegration({
  name: 'revenuecat',
  description:
    'RevenueCat read-only MCP — list subscriptions / purchases, get customer, get app metrics. Loaded directly by the db-executor; not for generic spawn_agent.',
  createServer: async () => {
    throw new Error(
      "The 'revenuecat' integration is loaded directly by the db-executor. Don't pass it to spawn_agent.",
    )
  },
})
