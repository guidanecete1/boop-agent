import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { api } from '../../../convex/_generated/api.js'
import { convex } from '../../convex-client.js'
import { spawnBuildProcess } from '../../build-jobs/spawn-helper.js'

function randomJobId(): string {
  return `buildjob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

async function resolveBuildRoot(projectSlug: string): Promise<string> {
  const project = await convex.query(api.projects.getBySlug, { slug: projectSlug })
  if (!project?.path) throw new Error(`Project "${projectSlug}" not found in registry.`)
  let buildRoot = project.path
  if (project.metadata) {
    try {
      const meta = JSON.parse(project.metadata) as { build_root?: string }
      if (meta.build_root) buildRoot = join(project.path, meta.build_root)
    } catch {
      // ignore parse errors — fall back to project.path
    }
  }
  return buildRoot
}

function listLanesViaShell(buildRoot: string): Promise<{ lane: string; description?: string }[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('fastlane', ['lanes'], { cwd: buildRoot })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`fastlane lanes exit ${code}: ${stderr.slice(-500)}`))
        return
      }
      // Fastlane prints lanes in a tree-ish format; we extract anything matching
      // a `<platform> <name>` prefix and the optional description that follows.
      const lanes: { lane: string; description?: string }[] = []
      const seen = new Set<string>()
      const laneRe = /^----\s+lane:\s*(?:[a-z]+\s+)?(\w+)\s+----$/i
      const lines = stdout.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(laneRe)
        if (m) {
          const lane = m[1]
          if (!seen.has(lane)) {
            seen.add(lane)
            lanes.push({ lane })
          }
        }
      }
      // Fallback: if regex didn't match (older fastlane), extract from --- pattern
      if (lanes.length === 0) {
        const fallbackRe = /\b(beta|release|build|test|deploy|tests|screenshots)\b/gi
        const matches = stdout.match(fallbackRe) ?? []
        for (const m of matches) {
          const lane = m.toLowerCase()
          if (!seen.has(lane)) {
            seen.add(lane)
            lanes.push({ lane })
          }
        }
      }
      resolve(lanes)
    })
  })
}

export function createFastlaneMcp() {
  return createSdkMcpServer({
    name: 'boop-fastlane',
    version: '0.1.0',
    tools: [
      tool(
        'list_lanes',
        `List Fastlane lanes available for a project. Read-only, fast (~2s).

Required: project_slug (e.g. "mila", "pepbuddy"). The MCP runs 'fastlane lanes' in the project's build_root.`,
        { project_slug: z.string() },
        async (args) => {
          try {
            const buildRoot = await resolveBuildRoot(args.project_slug)
            const lanes = await listLanesViaShell(buildRoot)
            return { content: [{ type: 'text' as const, text: JSON.stringify(lanes, null, 2) }] }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `list_lanes failed: ${(err as Error).message}` }],
            }
          }
        },
      ),
      tool(
        'run_lane',
        `Run a Fastlane lane. Long-running (3-10 min for typical 'beta'). FIRE-AND-FORGET — returns immediately with a jobId; the buildJobs tick handles completion notification via WhatsApp.

Required: project_slug, lane (e.g. "beta", "release"), executor_run_id (your runId so the tick knows who started this), conversation_id (so the tick knows where to ping).
Optional: lane_options (object of k/v string pairs forwarded as --<k> <v> Fastlane args).

DO NOT block waiting for completion. Return your reply to the user immediately after this call.`,
        {
          project_slug: z.string(),
          lane: z.string(),
          executor_run_id: z.string(),
          conversation_id: z.string(),
          lane_options: z.record(z.string()).optional(),
        },
        async (args) => {
          try {
            const buildRoot = await resolveBuildRoot(args.project_slug)
            const argv: string[] = ['fastlane', args.lane]
            if (args.lane_options) {
              for (const [k, v] of Object.entries(args.lane_options)) {
                argv.push(`--${k}`, v)
              }
            }
            const jobId = randomJobId()
            const env: Record<string, string> = {}
            // ASC env vars are inherited from process.env automatically; the
            // Fastfile patch reads them via ENV[].
            const result = spawnBuildProcess({
              cwd: buildRoot,
              argv,
              jobId,
              env,
            })
            await convex.mutation(api.buildJobs.create, {
              jobId,
              executorRunId: args.executor_run_id,
              conversationId: args.conversation_id,
              kind: 'fastlane_lane',
              projectSlug: args.project_slug,
              args: JSON.stringify({ lane: args.lane, lane_options: args.lane_options }),
              pid: result.pid,
            })
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    jobId,
                    status: 'running',
                    pid: result.pid,
                    message: `Fastlane '${args.lane}' started for ${args.project_slug}; will ping when done.`,
                  }),
                },
              ],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `run_lane failed: ${(err as Error).message}` }],
            }
          }
        },
      ),
    ],
  })
}
