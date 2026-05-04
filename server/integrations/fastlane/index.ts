import { registerIntegration } from '../registry.js'

// boop-fastlane is loaded directly by the ios executor via createFastlaneMcp()
// in ./tools.ts. Registered here for discoverability only.
registerIntegration({
  name: 'fastlane',
  description:
    'Fastlane MCP — list lanes + run a lane (fire-and-forget, ~3-10 min builds with WhatsApp completion ping). Loaded directly by the ios executor.',
  createServer: async () => {
    throw new Error(
      "The 'fastlane' integration is loaded directly by the ios executor. Don't pass it to spawn_agent.",
    )
  },
})
