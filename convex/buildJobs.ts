import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const kindV = v.union(
  v.literal("fastlane_lane"),
  v.literal("eas_build"),
  v.literal("eas_submit"),
  v.literal("eas_update"),
);

const statusV = v.union(
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const create = mutation({
  args: {
    jobId: v.string(),
    executorRunId: v.string(),
    conversationId: v.string(),
    kind: kindV,
    projectSlug: v.string(),
    args: v.string(),
    pid: v.optional(v.number()),
    remoteId: v.optional(v.string()),
    chainTo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("buildJobs", {
      ...args,
      status: "running",
      startedAt: Date.now(),
    });
  },
});

export const setRemoteId = mutation({
  args: { jobId: v.string(), remoteId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("buildJobs")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, { remoteId: args.remoteId });
    return row._id;
  },
});

export const setHeartbeat = mutation({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("buildJobs")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, { heartbeatSentAt: Date.now() });
    return row._id;
  },
});

export const markCompleted = mutation({
  args: {
    jobId: v.string(),
    status: statusV,
    resultText: v.optional(v.string()),
    resultArtifact: v.optional(v.string()),
    errorTail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("buildJobs")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, {
      status: args.status,
      resultText: args.resultText,
      resultArtifact: args.resultArtifact,
      errorTail: args.errorTail,
      completedAt: Date.now(),
    });
    return row._id;
  },
});

export const listRunning = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("buildJobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();
  },
});

export const getByJobId = query({
  args: { jobId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("buildJobs")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .unique();
  },
});
