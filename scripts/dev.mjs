#!/usr/bin/env node
// One command to run Boop locally: server + convex + debug dashboard.
// (No ngrok, no Sendblue — WhatsApp transport is handled in-process by Baileys.)

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// --- preflight: Convex types must exist ----------------------------------
if (!existsSync(resolve(root, "convex/_generated/api.js"))) {
  console.error(`
┌─────────────────────────────────────────────────────────────┐
│  Convex types haven't been generated yet.                   │
│                                                             │
│  Run this first:                                            │
│    npm run setup           (full interactive setup)         │
│    npx convex dev --once   (just generate types)            │
└─────────────────────────────────────────────────────────────┘
`);
  process.exit(1);
}

function readEnv() {
  const p = resolve(root, ".env.local");
  if (!existsSync(p)) return {};
  const env = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(?:\s+#.*)?$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const envVars = readEnv();
const port = envVars.PORT || "3456";
const publicUrl = envVars.PUBLIC_URL || "";
const hasStaticUrl =
  publicUrl && !publicUrl.includes("localhost") && !publicUrl.includes("127.0.0.1");

const C = {
  server: "\x1b[36m",
  convex: "\x1b[35m",
  debug: "\x1b[33m",
  composio: "\x1b[32m",
  upstream: "\x1b[34m",
  banner: "\x1b[1;32m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

const NOISE_TRIGGERS = [
  /\[vite\] ws proxy socket error/,
  /\[vite\] ws proxy error/,
  /Error: write EPIPE/,
  /Error: read ECONNRESET/,
  /AggregateError \[ECONNREFUSED\]/,
];
const STACK_LINE = /^\s+at\s/;

function run(name, cmd, args, readyPattern) {
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  const prefix = `${C[name]}${name.padEnd(8)}${C.reset} │ `;
  let buf = "";
  let suppressing = false;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const feed = (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      if (NOISE_TRIGGERS.some((r) => r.test(plain))) {
        suppressing = true;
        continue;
      }
      if (suppressing) {
        if (STACK_LINE.test(plain) || plain.trim() === "") continue;
        suppressing = false;
      }
      if (line.trim()) process.stdout.write(prefix + line + "\n");
      if (readyPattern && readyPattern.test(plain)) resolveReady();
    }
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.ready = ready;
  return child;
}

function showBanner() {
  const line = "═".repeat(68);
  const dashboard = `http://localhost:5173`;
  const agentNumber = envVars.WHATSAPP_AGENT_NUMBER || "(unset)";
  const allowed = envVars.WHATSAPP_ALLOWED_NUMBERS || "(none)";
  console.log(`
${C.banner}${line}
  Boop is ready.

  🐶 Debug dashboard:        ${dashboard}
  📱 Agent WhatsApp number:  ${agentNumber}
  ✅ Allowed senders:        ${allowed}

  First boot? Watch the ${C.server}server${C.reset}${C.banner} log for a QR code and
  scan it with the WhatsApp app on the phone hosting the agent number.
${line}${C.reset}
`);
}

console.log(`\nBoop dev starting on port ${port}. Ctrl-C to stop everything.\n`);

run("upstream", "node", ["scripts/check-upstream.mjs"]);

const serverChild = run(
  "server",
  "npx",
  ["tsx", "watch", "server/index.ts"],
  /listening on :/,
);
const convexChild = run(
  "convex",
  "npx",
  ["convex", "dev"],
  /Convex functions ready/,
);
const debugChild = run(
  "debug",
  "npx",
  ["vite", "--config", "debug/vite.config.ts"],
  /Local:\s+http/,
);
const children = [serverChild, convexChild, debugChild];

async function autoRegisterComposioWebhook(url) {
  if (envVars.COMPOSIO_AUTO_WEBHOOK === "false") return;
  if (!envVars.COMPOSIO_API_KEY) return;
  if (!url || url.includes("localhost") || url.includes("127.0.0.1")) return;
  const prefix = `${C.composio}composio${C.reset} │ `;
  const child = spawn("npx", ["tsx", "scripts/composio-webhook.ts", url], {
    cwd: root,
    env: { ...process.env },
  });
  child.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  child.stderr.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      if (line.trim()) process.stdout.write(prefix + line + "\n");
    }
  });
  await new Promise((r) => child.on("exit", r));
}

Promise.all([serverChild.ready, convexChild.ready, debugChild.ready])
  .then(async () => {
    if (hasStaticUrl) {
      await autoRegisterComposioWebhook(publicUrl);
    }
    showBanner();
  })
  .catch(() => {});

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 500);
};
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
for (const c of children) {
  c.on("exit", (code) => {
    if (!shuttingDown && code !== null && code !== 0) {
      console.error(`\nA child process exited with code ${code}. Shutting down.`);
      shutdown(code);
    }
  });
}
