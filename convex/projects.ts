import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const typeV = v.union(
  v.literal("ios-native"),
  v.literal("expo"),
  v.literal("nextjs-vercel"),
  v.literal("growth-work"),
);
const permissionV = v.union(
  v.literal("read-only"),
  v.literal("read-write"),
  v.literal("full"),
);

export const list = query({
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("projects").collect();
    return args.includeArchived ? all : all.filter((p) => !p.archived);
  },
});

export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});

export const upsert = mutation({
  args: {
    slug: v.string(),
    displayName: v.string(),
    type: typeV,
    path: v.optional(v.string()),
    permission: permissionV,
    metadata: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert("projects", {
      ...args,
      archived: false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const archive = mutation({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
    if (!existing) return null;
    await ctx.db.patch(existing._id, {
      archived: true,
      updatedAt: Date.now(),
    });
    return existing._id;
  },
});
