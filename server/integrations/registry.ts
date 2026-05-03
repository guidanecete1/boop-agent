import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";

export interface IntegrationModule {
  name: string;
  description: string;
  requiredEnv?: string[];
  createServer: (ctx: IntegrationContext) => Promise<McpSdkServerConfigWithInstance>;
}

export interface IntegrationContext {
  conversationId?: string;
}

const registry = new Map<string, IntegrationModule>();

export function registerIntegration(mod: IntegrationModule): void {
  registry.set(mod.name, mod);
}

export function listIntegrations(): IntegrationModule[] {
  return [...registry.values()];
}

export function getIntegration(name: string): IntegrationModule | undefined {
  return registry.get(name);
}

const SEED_PROJECTS = [
  {
    slug: "pepbuddy",
    displayName: "PepBuddy",
    type: "ios-native" as const,
    path: "/Users/Alfredo/Documents/Claude Ruflo Multiagents",
    permission: "full" as const,
    metadata: JSON.stringify({ supabase_access: "mcp" }),
  },
  {
    slug: "mila",
    displayName: "Mila App",
    type: "ios-native" as const,
    path: "/Users/Alfredo/Documents/Mila app",
    permission: "full" as const,
    metadata: JSON.stringify({
      // Mila's Supabase account is connected separately under the same
      // Composio Supabase toolkit (allowMultiple), so the unified path
      // (supabase_access: "mcp") covers it alongside pepbuddy / rosibel.
      // The Management API path is dropped — revisit only if a real
      // project-level (org-scoped) ops use case surfaces.
      supabase_access: "mcp",
      asc_auth_key_path: "/Users/Alfredo/Documents/Mila app/AuthKey_3Z2FX63D4X.p8",
    }),
  },
  {
    slug: "rosibel-clientes",
    displayName: "Rosibel Clientes (Expo)",
    type: "expo" as const,
    path: "/Users/Alfredo/Documents/AI Varios/Rosibel Avila/rosi-client-app",
    permission: "full" as const,
    metadata: JSON.stringify({ supabase_access: "mcp" }),
  },
  {
    slug: "rosibel-admin",
    displayName: "Rosibel Admin (Next.js)",
    type: "nextjs-vercel" as const,
    path: "/Users/Alfredo/Documents/AI Varios/Rosibel Avila",
    permission: "full" as const,
    metadata: JSON.stringify({ supabase_access: "mcp" }),
  },
  {
    slug: "rosibel-website",
    displayName: "Rosibel Website (Next.js)",
    type: "nextjs-vercel" as const,
    path: "/Users/Alfredo/Documents/AI Varios/Rosibel Avila",
    permission: "full" as const,
    metadata: JSON.stringify({ supabase_access: "mcp" }),
  },
  {
    slug: "holafly",
    displayName: "Holafly",
    type: "growth-work" as const,
    path: "/Users/Alfredo/Documents/Holafly",
    permission: "read-only" as const,
    metadata: JSON.stringify({}),
  },
];

export async function seedProjectsIfEmpty(): Promise<void> {
  const existing = await convex.query(api.projects.list, {});
  if (existing.length > 0) {
    console.log(
      `[projects] seed skipped — ${existing.length} project(s) already in registry`,
    );
    return;
  }
  for (const p of SEED_PROJECTS) {
    await convex.mutation(api.projects.upsert, p);
  }
  console.log(
    `[projects] seeded ${SEED_PROJECTS.length} projects (${SEED_PROJECTS.map((p) => p.slug).join(", ")})`,
  );
}

export async function loadIntegrations(): Promise<void> {
  await seedProjectsIfEmpty();
  // Side-effect import: registers the 'projects' module in the registry.
  await import("./projects/index.js");
  const { registerComposioToolkits } = await import("./composio-loader.js");
  await registerComposioToolkits();
  const loaded = [...registry.keys()];
  console.log(
    `[integrations] loaded: ${loaded.join(", ") || "(none — connect a toolkit from the Debug UI's Connections tab)"}`,
  );
}

export async function refreshIntegrations(): Promise<void> {
  registry.clear();
  await loadIntegrations();
}

export function makeContext(conversationId?: string): IntegrationContext {
  return { conversationId };
}

export async function buildMcpServersForIntegrations(
  names: string[],
  conversationId?: string,
): Promise<Record<string, McpSdkServerConfigWithInstance>> {
  const ctx = makeContext(conversationId);
  const out: Record<string, McpSdkServerConfigWithInstance> = {};
  for (const name of names) {
    const mod = registry.get(name);
    if (!mod) {
      console.warn(`[integrations] unknown integration: ${name}`);
      continue;
    }
    try {
      out[name] = await mod.createServer(ctx);
    } catch (err) {
      console.error(`[integrations] failed to build ${name}`, err);
    }
  }
  return out;
}
