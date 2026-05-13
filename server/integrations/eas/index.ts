import { registerIntegration } from '../registry.js'

// boop-eas is loaded directly by the expo executor via createEasMcp()
// in ./tools.ts. Registered here for discoverability only.
registerIntegration({
  name: 'eas',
  description:
    'EAS CLI MCP — eas build / eas submit / eas update (fire-and-forget) + read tools (list_builds, get_build_status). Loaded directly by the expo executor.',
  createServer: async () => {
    throw new Error(
      "The 'eas' integration is loaded directly by the expo executor. Don't pass it to spawn_agent.",
    )
  },
})
