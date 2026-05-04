import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { api } from '../../../convex/_generated/api.js'
import { convex } from '../../convex-client.js'
import { spawnBuildProcess } from '../../build-jobs/spawn-helper.js'

function randomJobId(): string {
  return `buildjob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

async function resolveProjectPath(projectSlug: string): Promise<string> {
  const project = await convex.query(api.projects.getBySlug, { slug: projectSlug })
  if (!project?.path) throw new Error(`Project "${projectSlug}" not found in registry.`)
  return project.path
}

function runEasReadOnly(cwd: string, argv: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('eas', argv, { cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`eas ${argv.join(' ')} exit ${code}: ${stderr.slice(-500)}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(stdout)
      }
    })
  })
}

export function createEasMcp() {
  return createSdkMcpServer({
    name: 'boop-eas',
    version: '0.1.0',
    tools: [
      tool(
        'eas_build',
        `Trigger an EAS cloud build. LONG-RUNNING (5-30 min depending on queue). FIRE-AND-FORGET.

Required: project_slug, profile (e.g. "production", "preview"), platform ("ios" | "android" | "all"), executor_run_id, conversation_id.
Optional: chain_to_submit (true to auto-chain eas_submit on success — useful for "build then submit to TestFlight" flows).

Returns immediately with { jobId, status: "running" }. Reply to the user immediately; the tick handles completion notification.`,
        {
          project_slug: z.string(),
          profile: z.string(),
          platform: z.enum(['ios', 'android', 'all']),
          executor_run_id: z.string(),
          conversation_id: z.string(),
          chain_to_submit: z.boolean().optional(),
        },
        async (args) => {
          try {
            const cwd = await resolveProjectPath(args.project_slug)
            const argv = [
              'eas', 'build',
              '--profile', args.profile,
              '--platform', args.platform,
              '--non-interactive',
              '--json',
            ]
            const jobId = randomJobId()
            const result = spawnBuildProcess({ cwd, argv, jobId })
            await convex.mutation(api.buildJobs.create, {
              jobId,
              executorRunId: args.executor_run_id,
              conversationId: args.conversation_id,
              kind: 'eas_build',
              projectSlug: args.project_slug,
              args: JSON.stringify({ profile: args.profile, platform: args.platform }),
              pid: result.pid,
              chainTo: args.chain_to_submit
                ? JSON.stringify({ kind: 'eas_submit', args: { platform: args.platform } })
                : undefined,
            })
            // The remoteId (EAS build ID) lands in the JSON output once eas
            // build finishes the upload phase. For now we don't have it; the
            // tick will look for it on the first poll by re-running
            // `eas build:list --json --limit 1` and matching by status.
            // (Simpler alternative: parse the spawn's stdout when present.
            // For the initial implementation, we leave remoteId unset and
            // recover via a list call on first tick.)
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    jobId,
                    status: 'running',
                    pid: result.pid,
                    message: `EAS build started for ${args.project_slug} (${args.profile}, ${args.platform}); will ping when done.`,
                  }),
                },
              ],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `eas_build failed to launch: ${(err as Error).message}` }],
            }
          }
        },
      ),
      tool(
        'eas_submit',
        `Submit a TestFlight build (or Play Console). LONG-RUNNING (~1-2 min). FIRE-AND-FORGET.

Required: project_slug, platform, executor_run_id, conversation_id.
Optional: build_id (default: latest).`,
        {
          project_slug: z.string(),
          platform: z.enum(['ios', 'android']),
          executor_run_id: z.string(),
          conversation_id: z.string(),
          build_id: z.string().optional(),
        },
        async (args) => {
          try {
            const cwd = await resolveProjectPath(args.project_slug)
            const argv = ['eas', 'submit', '--platform', args.platform, '--non-interactive']
            if (args.build_id) argv.push('--id', args.build_id)
            else argv.push('--latest')
            const jobId = randomJobId()
            const result = spawnBuildProcess({ cwd, argv, jobId })
            await convex.mutation(api.buildJobs.create, {
              jobId,
              executorRunId: args.executor_run_id,
              conversationId: args.conversation_id,
              kind: 'eas_submit',
              projectSlug: args.project_slug,
              args: JSON.stringify({ platform: args.platform, build_id: args.build_id }),
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
                    message: `EAS submit started for ${args.project_slug} (${args.platform}).`,
                  }),
                },
              ],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `eas_submit failed to launch: ${(err as Error).message}` }],
            }
          }
        },
      ),
      tool(
        'eas_update',
        `Publish an OTA update. FAST (~30s). Still fire-and-forget for consistency.

Required: project_slug, branch (e.g. "production", "preview"), executor_run_id, conversation_id.
Optional: message.`,
        {
          project_slug: z.string(),
          branch: z.string(),
          executor_run_id: z.string(),
          conversation_id: z.string(),
          message: z.string().optional(),
        },
        async (args) => {
          try {
            const cwd = await resolveProjectPath(args.project_slug)
            const argv = ['eas', 'update', '--branch', args.branch, '--non-interactive']
            if (args.message) argv.push('--message', args.message)
            const jobId = randomJobId()
            const result = spawnBuildProcess({ cwd, argv, jobId })
            await convex.mutation(api.buildJobs.create, {
              jobId,
              executorRunId: args.executor_run_id,
              conversationId: args.conversation_id,
              kind: 'eas_update',
              projectSlug: args.project_slug,
              args: JSON.stringify({ branch: args.branch, message: args.message }),
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
                    message: `EAS update on '${args.branch}' started for ${args.project_slug}.`,
                  }),
                },
              ],
            }
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `eas_update failed to launch: ${(err as Error).message}` }],
            }
          }
        },
      ),
      tool(
        'list_builds',
        `List recent EAS builds for a project. Read-only, fast.

Required: project_slug.
Optional: limit (default 5).`,
        { project_slug: z.string(), limit: z.number().int().min(1).max(50).optional() },
        async (args) => {
          try {
            const cwd = await resolveProjectPath(args.project_slug)
            const limit = args.limit ?? 5
            const data = await runEasReadOnly(cwd, ['build:list', '--limit', String(limit), '--json', '--non-interactive'])
            return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `list_builds failed: ${(err as Error).message}` }] }
          }
        },
      ),
      tool(
        'get_build_status',
        `Get the status of a specific EAS build. Read-only.

Required: project_slug, build_id.`,
        { project_slug: z.string(), build_id: z.string() },
        async (args) => {
          try {
            const cwd = await resolveProjectPath(args.project_slug)
            const data = await runEasReadOnly(cwd, ['build:view', args.build_id, '--json', '--non-interactive'])
            return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `get_build_status failed: ${(err as Error).message}` }] }
          }
        },
      ),
    ],
  })
}
