#!/usr/bin/env node
// One-off diagnostic: dump every connected_account in this Composio org,
// grouped by user_id and status. Helps debug "why doesn't Boop see my
// connection?" by showing the ground truth from Composio's API.

import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "..", ".env.local") });

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) {
  console.error("COMPOSIO_API_KEY not set");
  process.exit(1);
}

// Composio paginates at 10 items per page; walk every page so a long-running
// account (lots of connect attempts, multiple Gmail accounts, etc.) doesn't
// silently truncate.
const items = [];
let cursor = null;
do {
  const url = new URL("https://backend.composio.dev/api/v3/connected_accounts");
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await fetch(url, { headers: { "x-api-key": apiKey } });
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  items.push(...(data.items ?? []));
  cursor = data.next_cursor ?? data.nextCursor ?? null;
} while (cursor);

const byUser = new Map();
for (const it of items) {
  const u = it.user_id ?? "(null)";
  if (!byUser.has(u)) byUser.set(u, []);
  byUser.get(u).push({
    id: it.id,
    toolkit: it.toolkit?.slug,
    status: it.status,
    createdAt: it.created_at,
  });
}

console.log(`\nTotal connections in org: ${items.length}\n`);
for (const [user, conns] of byUser) {
  console.log(`user_id=${user}  (${conns.length} connection${conns.length === 1 ? "" : "s"}):`);
  for (const c of conns) {
    console.log(`  - ${c.toolkit.padEnd(20)} ${c.status.padEnd(15)} ${c.id}  ${c.createdAt}`);
  }
  console.log();
}
