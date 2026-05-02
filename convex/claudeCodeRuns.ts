import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const statusV = v.union(
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("timeout"),
  v.literal("cancelled"),
);
const modeV = v.union(v.literal("plan"), v.literal("execute"));

export const create = mutation({
  args: {
    runId: v.string(),
    projectSlug: v.string(),
    parentExecutorRunId: v.optional(v.string()),
    task: v.string(),
    mode: modeV,
    allowedTools: v.string(),
    cwd: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("claudeCodeRuns", {
      ...args,
      status: "running",
      startedAt: Date.now(),
    });
  },
});

export const finish = mutation({
  args: {
    runId: v.string(),
    status: statusV,
    exitCode: v.optional(v.number()),
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { runId, ...patch } = args;
    const row = await ctx.db
      .query("claudeCodeRuns")
      .withIndex("by_run_id", (q) => q.eq("runId", runId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, { ...patch, endedAt: Date.now() });
    return row._id;
  },
});

export const list = query({
  args: { projectSlug: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const q = args.projectSlug
      ? ctx.db
          .query("claudeCodeRuns")
          .withIndex("by_project", (qq) => qq.eq("projectSlug", args.projectSlug!))
      : ctx.db.query("claudeCodeRuns");
    return await q.order("desc").take(limit);
  },
});
