import "./env-setup.js";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { addClient, broadcast } from "./broadcast.js";
import { handleUserMessage } from "./interaction-agent.js";
import { initWhatsApp } from "./whatsapp.js";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { loadIntegrations } from "./integrations/registry.js";
import { startCleanupLoop } from "./memory/clean.js";
import { startAutomationLoop } from "./automations.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { startConsolidationLoop } from "./consolidation.js";
import { cancelAgent, retryAgent } from "./execution-agent.js";
import { createComposioRouter } from "./composio-routes.js";
import { ensureProactiveWatcher } from "./proactive-email.js";
import { preloadLocalModel } from "./embeddings.js";
import { createMemoryRouter } from "./memory-routes.js";

async function main() {
  await loadIntegrations();
  startCleanupLoop();
  startAutomationLoop();
  startHeartbeatLoop();
  startConsolidationLoop();
  // No-op when a paid embedding key is set; otherwise downloads/loads the
  // local BGE-large model in the background so the first user-facing
  // recall() doesn't pay the model-load cost.
  preloadLocalModel();

  // If a stable public URL is configured, register the Composio webhook +
  // Gmail trigger now. For ngrok-based dev, scripts/dev.mjs drives the same
  // function once the ngrok URL is known, so we skip when only the local
  // PORT default is available.
  const stableUrl = process.env.PUBLIC_URL;
  if (stableUrl && !stableUrl.includes("localhost")) {
    ensureProactiveWatcher(stableUrl).catch((err) =>
      console.error("[proactive] startup failed", err),
    );
  }

  const app = express();
  app.use(cors());
  // Composio webhook receiver must read raw bytes for HMAC verification, so
  // its body parser is mounted BEFORE the global express.json. Without this
  // ordering the JSON parser consumes the stream first and the raw buffer
  // arrives empty.
  app.use("/composio/webhook", express.raw({ type: "application/json", limit: "2mb" }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "boop-agent" });
  });

  app.use("/composio", createComposioRouter());
  app.use("/memory", createMemoryRouter());

  app.post("/agents/:id/cancel", (req, res) => {
    const ok = cancelAgent(req.params.id);
    res.json({ ok });
  });

  app.post("/consolidate", async (_req, res) => {
    try {
      const { runConsolidation } = await import("./consolidation.js");
      // Fire-and-forget so the HTTP request returns immediately.
      runConsolidation("manual").catch((err) =>
        console.error("[consolidation] manual run failed", err),
      );
      res.json({ ok: true, triggered: "manual" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/agents/:id/retry", async (req, res) => {
    const result = await retryAgent(req.params.id);
    if (!result) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(result);
  });

  // Chat endpoint for local testing and the debug dashboard
  app.post("/chat", async (req, res) => {
    const { conversationId, content } = req.body ?? {};
    if (!conversationId || !content) {
      res.status(400).json({ error: "conversationId and content required" });
      return;
    }
    try {
      const reply = await handleUserMessage({ conversationId, content });
      res.json({ reply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    addClient(ws);
    ws.send(JSON.stringify({ event: "hello", data: { ok: true }, at: Date.now() }));
  });

  const port = Number(process.env.PORT ?? 3456);
  server.listen(port, () => {
    console.log(`boop-agent server listening on :${port}`);
    console.log(`  health      GET  http://localhost:${port}/health`);
    console.log(`  chat        POST http://localhost:${port}/chat`);
    console.log(`  whatsapp    (Baileys, in-process — see logs above for QR on first run)`);
    console.log(`  websocket   WS   ws://localhost:${port}/ws`);
  });

  const allowedNumbers = (process.env.WHATSAPP_ALLOWED_NUMBERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedNumbers.length === 0) {
    console.warn(
      "[whatsapp] WHATSAPP_ALLOWED_NUMBERS is empty — all inbound messages will be dropped",
    );
  }

  const wa = await initWhatsApp({
    sessionDir: process.env.WHATSAPP_SESSION_DIR ?? "./auth_info_baileys",
    allowedNumbers,
  });

  wa.onMessage(async (msg) => {
    const conversationId = `wa:${msg.fromE164}`;
    const turnTag = Math.random().toString(36).slice(2, 8);
    const previewText =
      msg.text.length > 100 ? msg.text.slice(0, 100) + "…" : msg.text;
    console.log(
      `[turn ${turnTag}] ← ${msg.fromE164} (${msg.language}): ${JSON.stringify(previewText)}`,
    );
    const start = Date.now();

    broadcast("message_in", {
      conversationId,
      content: msg.text,
      from_number: msg.fromE164,
      handle: msg.messageId,
    });

    await wa.setTyping(msg.fromE164, true);

    // Pragmatic language hint: prepend a one-line directive so the dispatcher
    // doesn't need a signature change for Spec 1. Spec 5 will replace this
    // with a proper meta field on handleUserMessage.
    const langHint =
      msg.language === "es"
        ? "(Reply in Spanish.) "
        : msg.language === "en"
          ? "(Reply in English.) "
          : "";
    const content = langHint + msg.text;

    try {
      const reply = await handleUserMessage({
        conversationId,
        content,
        turnTag,
        onThinking: (t) => broadcast("thinking", { conversationId, t }),
      });
      if (reply) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const replyPreview =
          reply.length > 100 ? reply.slice(0, 100) + "…" : reply;
        console.log(
          `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
        );
        await wa.send(msg.fromE164, reply);
        await convex.mutation(api.messages.send, {
          conversationId,
          role: "assistant",
          content: reply,
        });
      } else {
        console.log(`[turn ${turnTag}] → (no reply)`);
      }
    } catch (err) {
      console.error(`[turn ${turnTag}] handler error`, err);
    } finally {
      await wa.setTyping(msg.fromE164, false);
    }
  });
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
