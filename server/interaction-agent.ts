import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { createMemoryMcp } from "./memory/tools.js";
import { extractAndStore } from "./memory/extract.js";
import { spawnOrchestrator } from "./orchestrator.js";
import { createAutomationMcp } from "./automation-tools.js";
import { createDraftDecisionMcp } from "./draft-tools.js";
import { createSelfMcp } from "./self-tools.js";
import { getRuntimeModel } from "./runtime-config.js";
import { broadcast } from "./broadcast.js";
import { sendMessage } from "./messaging.js";
import { aggregateUsageFromResult, EMPTY_USAGE, type UsageTotals } from "./usage.js";

const INTERACTION_SYSTEM = `You are Boop, a personal agent the user texts from WhatsApp.

You are a DISPATCHER, not a doer. Your job:
1. Understand what the user wants.
2. Decide: answer directly (chit-chat, simple memory recall, self-inspection) OR spawn_orchestrator (any real work).
3. When you spawn the orchestrator, give it a crisp task — not the raw user message.
4. When the orchestrator returns, relay the result in YOUR voice, tightened for WhatsApp.

Tone: Warm, witty, concise. Write like you're texting a friend. No corporate voice. No bullet dumps unless the user asked for a list.

Your only tools:
- recall / write_memory (durable memory for this user)
- spawn_orchestrator (dispatches real work; the orchestrator picks the executor)
- create_automation / list_automations / toggle_automation / delete_automation
- list_drafts / send_draft / reject_draft
- get_config / set_model / set_timezone / list_integrations / search_composio_catalog / inspect_toolkit (self-inspection)

You cannot answer factual questions from your own knowledge. Not allowed.
You have NO browser, NO WebSearch, NO WebFetch, NO file access, NO APIs.
You are not allowed to recite facts about places, events, people, prices,
news, URLs, statistics, or anything "in the world." Your training data does
not count as a source.

Hard rule: if the user asks for information, research, a lookup, a
recommendation that requires real-world data, a current event, a comparison,
a tutorial, a how-to, any URL, or anything you'd be tempted to "just know" —
spawn_orchestrator. No exceptions. The orchestrator routes to a sub-agent
that has WebSearch / WebFetch / integrations / filesystem access.

Hard rule: if the user mentions a project, code, a fix, a build, a deploy,
a commit, a PR, the App Store, anything iOS / Android / Expo / Next.js /
Vercel / Supabase, ASO / ads / marketing / SEO, or anything that needs the
filesystem — spawn_orchestrator. The orchestrator owns project work.

Acknowledgment rule (WhatsApp UX):
BEFORE every spawn_orchestrator call, you MUST call send_ack first with a
short 1-sentence message. The user otherwise sees nothing for 10-90 seconds
while the orchestrator + executor + CC subprocess do their thing.
Examples: "On it 🔧", "Looking into your calendar…", "Drafting that now."
Order: send_ack → spawn_orchestrator → (wait) → final reply with the result.
Skip the ack ONLY for things you'll answer in under 2 seconds.

Memory — recall is MANDATORY before any claim about the user:
Your context does NOT auto-load saved memories. You must call recall()
explicitly. Conversation history is NOT memory — anything older than the
last few turns is gone, and even visible history may not be saved.

Hard rule: BEFORE making ANY statement about the user — names, contacts,
phone numbers, addresses, schedule, preferences, projects, history, who
they know, what they're working on — you MUST call recall() first.

This applies to NEGATIVE claims TOO. Saying "I don't have a phone number
for Alex" without first calling recall() is a CRITICAL FAILURE.

Recall is cheap. Overuse is correct. Underuse is a bug. Multiple recalls
per turn are fine and encouraged — different segments, different angles.

write_memory() — call aggressively for durable facts. Err on the side of
saving. If the user reveals anything personal, factual, or preferential,
write it down in the same turn.

Safe to answer directly without recall (a SHORT list):
- Greetings, acknowledgments, conversational filler ("thanks", "lol", "ok").
- Explaining what you just did, confirming a draft, relaying the orchestrator.
- Clarifying your own abilities or asking the user a clarifying question.
- Anything in the same conversation turn the user JUST told you.

Everything else about the user — SPAWN ORCHESTRATOR or RECALL FIRST.

Never fabricate URLs, site names, "sources", statistics, news, quotes, prices,
dates, or any external fact.

When relaying the orchestrator's answer:
- Pass through any Sources section / PR URL / commit SHA the orchestrator
  included, VERBATIM. Don't add, remove, paraphrase, or summarize URLs.
- You may tighten the body for WhatsApp (shorter bullets, fewer emojis),
  but the URLs are ground truth — don't touch them.

Automations:
When the user wants something to happen on a recurring schedule, use
create_automation. When the user wants to inspect / change / pause / remove,
use the appropriate list_/toggle_/delete_ tool.

Drafts:
The orchestrator stages drafts for destructive operations (commits, pushes,
deploys, App Store submits, sending external messages). When the user signals
they want a previously-prepared action to go through, call list_drafts to see
what's pending, then send_draft on the matching ones. send_draft will re-spawn
the orchestrator with the previouslyDraftedRunId to execute.

When the user signals they want to back out, call reject_draft.

Never claim something was sent unless send_draft returned success.

Self-inspection (no spawn needed — answer instantly):
- Wants to know what model / config / time → get_config
- Wants to switch models or change speed/quality → set_model
- Wants to know which integrations / accounts are connected → list_integrations
- Wondering if some service is connectable → search_composio_catalog
- Probing a connected integration's actual capabilities → inspect_toolkit
- Telling Boop their timezone → set_timezone

Time / timezone:
The user has a saved timezone in get_config.userTimezone. Whenever your reply
or an orchestrator task depends on local time, call get_config first.

Format: Plain WhatsApp-friendly text. Markdown sparingly (WhatsApp renders
*single asterisks* as bold; double asterisks display literally). Keep replies
under ~400 chars when you can.`;

interface HandleOpts {
  conversationId: string;
  content: string;
  turnTag?: string;
  onThinking?: (chunk: string) => void;
  // "proactive" persists the inbound message with role=system instead of
  // role=user, so the synthetic notice the IA receives doesn't pollute the
  // user-message history. Defaults to "user".
  kind?: "user" | "proactive";
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function handleUserMessage(opts: HandleOpts): Promise<string> {
  const turnId = randomId("turn");

  const inboundRole = opts.kind === "proactive" ? "system" : "user";
  await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: inboundRole,
    content: opts.content,
    turnId,
  });
  broadcast(opts.kind === "proactive" ? "proactive_notice" : "user_message", {
    conversationId: opts.conversationId,
    content: opts.content,
  });

  const memoryServer = createMemoryMcp(opts.conversationId);
  const automationServer = createAutomationMcp(opts.conversationId);
  const draftDecisionServer = createDraftDecisionMcp(opts.conversationId);
  const selfServer = createSelfMcp();

  const ackServer = createSdkMcpServer({
    name: "boop-ack",
    version: "0.1.0",
    tools: [
      tool(
        "send_ack",
        `Send a short acknowledgment message to the user IMMEDIATELY, before a slow operation. Use this BEFORE spawn_orchestrator so the user knows you heard them and are working on it. Keep it to ONE short sentence (ideally under 60 chars) with tone that matches the task. Examples: "On it — one sec 🔍", "Looking into it…", "Drafting now, hold tight.", "Let me check your calendar."`,
        {
          message: z.string().describe("1 short sentence ack. No markdown. Emojis OK."),
        },
        async (args) => {
          const text = args.message.trim();
          if (!text) {
            return {
              content: [{ type: "text" as const, text: "Empty ack skipped." }],
            };
          }
          // Skip the iMessage send for proactive turns — those go out as a
          // single self-contained notice from dispatchProactiveNotice. If the
          // IA calls send_ack here on a proactive turn, the user would get
          // two iMessages (the ack + the final reply). Still persist + log
          // so the debug UI sees it.
          if (opts.conversationId.startsWith("sms:") && opts.kind !== "proactive") {
            const number = opts.conversationId.slice(4);
            await sendMessage(number, text);
          }
          await convex.mutation(api.messages.send, {
            conversationId: opts.conversationId,
            role: "assistant",
            content: text,
            turnId,
          });
          broadcast("assistant_ack", {
            conversationId: opts.conversationId,
            content: text,
          });
          log(`→ ack: ${text}`);
          return {
            content: [{ type: "text" as const, text: "Ack sent to user." }],
          };
        },
      ),
    ],
  });

  const spawnServer = createSdkMcpServer({
    name: "boop-spawn",
    version: "0.1.0",
    tools: [
      tool(
        "spawn_orchestrator",
        "Dispatch real work to the orchestrator. The orchestrator picks the right executor type (ios, personal-assistant, etc.) and coordinates multi-step tasks. Returns the orchestrator's final reply for you to relay to the user. Use for ANY non-chitchat work.",
        {
          task: z
            .string()
            .describe(
              "Crisp task description — what you want the orchestrator to accomplish. Don't pre-decide which executor; the orchestrator routes.",
            ),
        },
        async (args) => {
          const res = await spawnOrchestrator({
            task: args.task,
            conversationId: opts.conversationId,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `[orchestrator ${res.agentId} ${res.status}]\n\n${res.result}`,
              },
            ],
          };
        },
      ),
    ],
  });

  const history = await convex.query(api.messages.recent, {
    conversationId: opts.conversationId,
    limit: 10,
  });
  const historyBlock = history
    .slice(0, -1)
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const systemPrompt = INTERACTION_SYSTEM;

  const prompt = historyBlock
    ? `Prior turns:\n${historyBlock}\n\nCurrent message:\n${opts.content}`
    : opts.content;

  const tag = opts.turnTag ?? turnId.slice(-6);
  const log = (msg: string) => console.log(`[turn ${tag}] ${msg}`);

  const turnStart = Date.now();
  const requestedModel = await getRuntimeModel();
  let reply = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  try {
    for await (const msg of query({
      prompt,
      options: {
        systemPrompt,
        model: requestedModel,
        mcpServers: {
          "boop-memory": memoryServer,
          "boop-spawn": spawnServer,
          "boop-automations": automationServer,
          "boop-draft-decisions": draftDecisionServer,
          "boop-ack": ackServer,
          "boop-self": selfServer,
        },
        allowedTools: [
          "mcp__boop-memory__write_memory",
          "mcp__boop-memory__recall",
          "mcp__boop-spawn__spawn_orchestrator",
          "mcp__boop-automations__create_automation",
          "mcp__boop-automations__list_automations",
          "mcp__boop-automations__toggle_automation",
          "mcp__boop-automations__delete_automation",
          "mcp__boop-draft-decisions__list_drafts",
          "mcp__boop-draft-decisions__send_draft",
          "mcp__boop-draft-decisions__reject_draft",
          "mcp__boop-ack__send_ack",
          "mcp__boop-self__get_config",
          "mcp__boop-self__set_model",
          "mcp__boop-self__set_timezone",
          "mcp__boop-self__list_integrations",
          "mcp__boop-self__search_composio_catalog",
          "mcp__boop-self__inspect_toolkit",
        ],
        // Belt-and-suspenders: even with bypassPermissions the SDK can leak
        // its built-ins if we only whitelist. Explicitly block them on the
        // dispatcher so it MUST spawn a sub-agent for external work.
        disallowedTools: [
          "WebSearch",
          "WebFetch",
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "Agent",
          "Skill",
        ],
        permissionMode: "bypassPermissions",
      },
    })) {
      if (msg.type === "assistant") {
        // Reset `reply` on each new assistant turn so only the LAST turn's
        // text becomes the user-facing iMessage. Earlier turns are usually
        // pre-tool-call narration ("Got it — saving that now.") that, if
        // concatenated with the post-tool-result final text, sends as one
        // smushed iMessage. Streaming via onThinking still sees everything.
        reply = "";
        for (const block of msg.message.content) {
          if (block.type === "text") {
            reply += block.text;
            opts.onThinking?.(block.text);
          } else if (block.type === "tool_use") {
            const name = block.name.replace(/^mcp__boop-[a-z-]+__/, "");
            const inputPreview = JSON.stringify(block.input);
            log(
              `tool: ${name}(${inputPreview.length > 90 ? inputPreview.slice(0, 90) + "…" : inputPreview})`,
            );
          }
        }
      } else if (msg.type === "result") {
        usage = aggregateUsageFromResult(msg, requestedModel);
      }
    }
  } catch (err) {
    console.error(`[turn ${tag}] query failed`, err);
    reply = "Sorry — I hit an error processing that. Try again in a moment.";
  }

  // Sometimes the model produces a placeholder string like "(no output)" or
  // "(no reply)" instead of composing a real reply — usually after a tool
  // call cycle where it lost the thread of what to say. Treat those as
  // empty so the user gets a real fallback they can act on.
  reply = reply.trim();
  // Match "(no output)" / "no reply." / "(No Response)" etc. Parens are
  // matched as a balanced pair (or omitted) — alternation prevents `(no
  // output` or `no output)` with one stray paren from sneaking through.
  const placeholder =
    /^(?:\(\s*no (?:output|reply|response|content)\s*\)|no (?:output|reply|response|content))\.?$/i;
  if (!reply || placeholder.test(reply)) {
    console.warn(`[turn ${tag}] empty/placeholder reply (${JSON.stringify(reply)}) — using fallback`);
    // Frame as model-side hiccup, not user error — the placeholder fires
    // when the model loses the thread mid-tool-call, the user's phrasing
    // is fine.
    reply = "Hmm — got tangled up there. Want to try that again?";
  }

  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    log(
      `cost: in/out ${usage.inputTokens}/${usage.outputTokens}, cache r/w ${usage.cacheReadTokens}/${usage.cacheCreationTokens}, $${usage.costUsd.toFixed(4)}`,
    );
    await convex.mutation(api.usageRecords.record, {
      source: "dispatcher",
      conversationId: opts.conversationId,
      turnId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - turnStart,
    });
  }

  broadcast("assistant_message", { conversationId: opts.conversationId, content: reply });

  // Background extraction — fire-and-forget; don't block the reply.
  // Skip on proactive turns: the "user message" is a synthetic
  // [proactive notice] derived from email content, not something the user
  // said. Letting extractAndStore run on it would persist email-derived
  // facts ("Alice asked about Q4 report") as user preferences/memory — the
  // same store the classifier reads on the next event, creating a feedback
  // loop where surfaced emails reshape future classification.
  if (opts.kind !== "proactive") {
    extractAndStore({
      conversationId: opts.conversationId,
      userMessage: opts.content,
      assistantReply: reply,
      turnId,
    }).catch((err) => console.error("[interaction] extraction error", err));
  }

  return reply;
}
