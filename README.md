<p align="center">
  <img src="assets/boop.gif" alt="Boop" width="220" />
</p>

# Boop

A WhatsApp-based personal agent built on top of the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview).

📺 **Watch the walkthrough:** [YouTube — How I built Boop](https://youtu.be/ZpmKjDDbqHs)

<p align="center">
  <img src="assets/imessage.jpg" alt="Boop replying inside WhatsApp" width="320" />
  <br>
  <sub><em>Boop in action — text it like a person, get back an answer with full context.</em></sub>
</p>

> **This is a starting point, not a finished product.**
> It's the architecture I built for my own personal agent, opened up as a template so you can take it, text-enable your own Claude, and extend it however you want. Integrations are plugged in via [Composio](https://composio.dev/?utm_source=chris&utm_medium=youtube&utm_campaign=collab) — drop in an API key and connect Gmail, Slack, GitHub, Linear, Notion, and ~1000 others straight from the debug dashboard.

```
 WhatsApp  →  Baileys (in-process)  →  Interaction agent  →  Sub-agents (per task)
                                               │                    │
                                               ▼                    ▼
                                         Memory store  ←──  Integrations (your MCP tools)
```

Built on:
- [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) — the loop, tool use, sub-agents, MCP
- [Composio](https://composio.dev/?utm_source=chris&utm_medium=youtube&utm_campaign=collab) — integrations layer. One API key = Gmail, Slack, GitHub, Linear, Notion, Stripe, Supabase, + ~1000 more with hosted OAuth
- [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) — embedded WhatsApp Web protocol — free-form proactive messaging, no Meta Cloud API template restrictions
- [Convex](https://convex.link/chrisraroque) — real-time database for memory, agents, drafts
- Your [Claude Code](https://claude.com/code?ref=chrisraroque) subscription — no separate Anthropic API key required

---

## What you get

- **WhatsApp in / WhatsApp out** via embedded Baileys (with allowlist enforcement and group-chat filtering).
- **Dispatcher + workers** pattern: a lean interaction agent decides what to do, spawns focused sub-agents that actually do the work.
- **Pure dispatcher** — the interaction agent has only memory + spawn + automation + draft tools. Web access, files, and integrations are explicitly denied to it; sub-agents get `WebSearch` / `WebFetch` / the integrations.
- **Tiered memory** (short / long / permanent) with post-turn extraction, decay, and cleaning.
- **Vector search** for recall when you add an embeddings key (Voyage or OpenAI) — falls back to substring.
- **Memory consolidation** — a daily 3-phase adversarial pipeline (proposer → adversary → judge) that merges duplicates, resolves contradictions, and prunes noise. Proposer and judge on Sonnet; adversary on Haiku for cheap skepticism. Runs every 24h by default, also triggerable manually via `POST /consolidate`.
- **Automations** — the agent can schedule recurring work from a text ("every morning at 8 summarize my calendar") and push results back to WhatsApp.
- **Draft-and-send** — any external action stages a draft first; the agent only commits when the user confirms.
- **Heartbeat + retry** — stuck agents auto-fail, debug dashboard can retry.
- **Composio-powered integrations** — one API key unlocks 1000+ toolkits. Connect Gmail, Slack, GitHub, Linear, Notion, Drive, HubSpot, etc. with a click from the debug dashboard. Composio handles OAuth + token refresh.
- **Debug dashboard** (React + Vite) with a Boop mascot — Dashboard (spend + tokens + agent status), Agents (timeline + integration logos), Automations, Memory (table + force-directed graph), Events, Connections.
- **Convex** for persistence — real-time, typed, free tier.
- **Uses your Claude Code subscription** — no separate Anthropic API key required.

<p align="center">
  <img src="assets/agents-view.jpg" alt="Agents view in the Boop debug dashboard" width="900" />
  <br>
  <sub><em>Agents tab — every spawned sub-agent with status, cost, tokens, turns, runtime, and the integrations it touched.</em></sub>
</p>

<p align="center">
  <img src="assets/automations.jpg" alt="Automations view in the Boop debug dashboard" width="900" />
  <br>
  <sub><em>Automations tab — schedule recurring jobs from a text ("every morning at 8 summarize my calendar") and watch them run.</em></sub>
</p>

<p align="center">
  <img src="assets/memory-graph.jpg" alt="Memory graph in the Boop debug dashboard" width="900" />
  <br>
  <sub><em>Memory tab — force-directed graph of clustered memories across short, long, and permanent tiers. Tabular view also available.</em></sub>
</p>

<p align="center">
  <img src="assets/connections.jpg" alt="Connections view in the Boop debug dashboard" width="900" />
  <br>
  <sub><em>Connections tab — Composio toolkits with OAuth handled for you. Click Connect and the agent can use it on the next message.</em></sub>
</p>

---

## Heads up before you use this

- **This was never meant to be open-sourced.** I built it for personal use and decided to share the architecture after enough people asked. It's not a product.
- **Not optimized for cost or security.** Use at your own risk. Review the code, set your own budgets, and don't trust it with anything you wouldn't trust yourself with.
- **I'm open to PRs for optimizations** — performance, bug fixes, DX improvements, new example integrations, better docs.

---

## Why is it named Boop?

<p align="center">
  <img src="assets/luna.jpeg" alt="Luna" width="220" />
  <br>
  <sub><em>Luna, the inspiration.</em></sub>
</p>

Boop is meant to be a proactive agent — one that nudges you over WhatsApp with reminders, drafts, and little follow-ups. A small "boop" whenever it has something for you.

And it's named after my dog, Luna, who gives plenty of them.

---

## A note on the native iOS app

I'm working on open-sourcing the native iOS app I originally built for this. The rewrite is taking much longer to get right than I'd hoped, but it will happen. I don't personally use it anymore — but enough people have asked, and I want to make it happen.

If you want to see what it looked like before I transitioned to a messaging-based agent, here's [the walkthrough on YouTube](https://www.youtube.com/watch?v=_h2EnRfxMQE).

---

## Prerequisites

You need accounts for these. Keep the tabs open — setup will ask for credentials from each.

> **You should be able to get away with the free plan for each service (except Claude Code), and I'm working to secure discounts for you guys on the pro plans. If you work at any of these companies, please reach out!**

| Service | Why | Free? | Discount code |
|---|---|---|---|
| [Claude Code](https://claude.com/code?ref=chrisraroque) | Powers the agent. Install it, sign in once, the SDK uses your session. | Subscription required | Working on getting one (if you work here, please reach out!) |
| A WhatsApp-capable phone | Boop links to your account as a Web device. The agent's number can be your personal one or a secondary number — see ban-risk note below. | Free | n/a |
| [Convex](https://convex.link/chrisraroque) | Database + realtime. | Free tier is plenty | Working on getting one (in touch with them 👀) |
| [Composio](https://composio.dev/?utm_source=chris&utm_medium=youtube&utm_campaign=collab) | Integrations — one API key unlocks ~1000 toolkits. Optional if you just want chat + memory + automations without third-party access. | Free tier covers personal use | `CHRISXCOMPOSIO` — 1 month free on starter plan |

**Custom integrations welcome.** Composio covers the common catalog, but you're free to add your own MCP servers under `server/integrations/` and register them in `server/integrations/registry.ts` — the dispatcher treats them the same as Composio-backed ones (just named toolkits the execution agent can spawn against). Useful for in-house APIs, local tools, or anything Composio doesn't ship.

---

## Quickstart

```bash
# 1. Clone + install
git clone https://github.com/raroque/boop-agent.git
cd boop-agent
npm install

# 2. Install Claude Code (one-time, global) and sign in
npm install -g @anthropic-ai/claude-code
claude  # sign in, then Ctrl-C to exit

# 3. Interactive setup — writes .env.local, creates Convex deployment, prompts for WhatsApp config
npm run setup

# 4. Start everything with one command — server, Convex, debug UI
npm run dev
```

On first boot, the server prints a QR code:

```
server   │ [whatsapp] scan this QR with the agent's WhatsApp:

(QR code appears here on first run)

server   │ [whatsapp] connected
```

Open WhatsApp on the phone hosting the agent number, go to **Settings → Linked Devices → Link a Device**, scan the QR. The Mac becomes a linked device. Subsequent boots reuse the saved session — no QR rescan needed.

Text the agent from the number you put in `WHATSAPP_ALLOWED_NUMBERS`. The agent replies.

> **Note on `PUBLIC_URL`:** if you have Composio configured and want webhook callbacks routed back to your server, set `PUBLIC_URL` in `.env.local` to a publicly reachable URL (e.g. a Cloudflare Tunnel or ngrok URL). For plain chat + memory + automations, no public URL is needed.

---

## Transport — WhatsApp via embedded Baileys

Boop talks WhatsApp via the embedded [Baileys](https://github.com/WhiskeySockets/Baileys)
library. The dev server connects to WhatsApp as a *linked device* of an existing
WhatsApp account (regular or Business) on a real phone — no Meta Business
verification, no 24-hour template window, no public webhook required.

### Why not the official WhatsApp Cloud API?

Boop relies on free-form proactive messaging (e.g. "boop me at 8am with a
calendar summary"). The official Cloud API enforces a 24-hour template window
on outbound messages after a customer goes silent — every kind of proactive
message has to be a Meta-approved template. That defeats the architecture.
The Baileys / WhatsApp-Web protocol has no such restriction.

The trade-off is that Meta could ban the agent number for using the
multi-device Web protocol from a non-mobile client. At single-user / personal
volumes the risk is low; recovery is to provision a new number and re-link.

### Configuration

Three env vars in `.env.local` (asked for during `npm run setup`):

- `WHATSAPP_AGENT_NUMBER` — the agent's E.164 number (display only).
- `WHATSAPP_ALLOWED_NUMBERS` — comma-separated E.164 list. Inbound from any
  number NOT in this list is logged and dropped silently. Group chats are
  always dropped. Single-user setup: just your own number.
- `WHATSAPP_SESSION_DIR` — defaults to `./auth_info_baileys`. Baileys writes
  multi-device auth state here. Already in `.gitignore`. Backed up? Restart
  with no QR rescan. Lost? Re-scan QR.

### Day-to-day

- `npm run dev` — server, Convex, debug dashboard. No ngrok needed.
- The agent's number stays linked as long as the phone goes online at least
  once per ~14 days (WhatsApp's policy). Otherwise the link dies — re-scan QR.
- To rotate the agent's number: stop the server, `rm -rf auth_info_baileys`,
  restart, scan the new account's QR.
- **Argentina-specific note:** WhatsApp delivers Argentine mobile numbers in
  E.164 with a `9` after the country code (`+5491123867005`), even though the
  phone displays `+541123867005`. Use the `+549...` form in
  `WHATSAPP_ALLOWED_NUMBERS`.

---

## Architecture in 30 seconds

```
┌─────────────┐   in-process   ┌─────────────────────┐
│  WhatsApp   │ ──────────────► │ Baileys → handler   │
└─────────────┘                └──────────┬──────────┘
                                          │
                                          ▼
                          ┌────────────────────────────┐
                          │    Interaction agent       │
                          │    (dispatcher only)       │
                          │  • recall / write_memory   │
                          │  • spawn_agent(...)        │
                          └────────┬────────┬──────────┘
                                   │        │
                   ┌───────────────┘        └──────────────┐
                   ▼                                       ▼
           ┌───────────────┐                      ┌──────────────┐
           │   Memory      │                      │  Execution   │
           │ (Convex)      │                      │  agent(s)    │
           │ + cleaning    │                      │  + integrations│
           └───────────────┘                      └──────────────┘
```

- **Interaction agent** (`server/interaction-agent.ts`) is the front door. It reads the user's message + recent history, optionally calls `recall`, writes memories, creates automations, and decides whether to answer directly or spawn a sub-agent.
- **Execution agent** (`server/execution-agent.ts`) is spawned per task. It loads only the integrations named in the spawn call and returns a tight answer.
- **Memory** (`server/memory/`) handles writes, recall, post-turn extraction, and daily cleaning. Stored in Convex.
- **Automations** (`server/automations.ts`) poll every 30s for due jobs, spawn an execution agent to run them, and push results back to the user.
- **Integrations** are provided by [Composio](https://composio.dev/?utm_source=chris&utm_medium=youtube&utm_campaign=collab). The dispatcher names toolkits by slug (`spawn_agent(integrations: ["gmail"])`); `server/composio.ts` opens a toolkit-scoped Composio session per spawn and wraps its tools as an MCP server. No per-integration code to write.

Deep dive: [ARCHITECTURE.md](./ARCHITECTURE.md). Adding your own tools: [INTEGRATIONS.md](./INTEGRATIONS.md).

---

## Skills

Skills are reusable playbooks — `SKILL.md` files under `.claude/skills/` that teach the execution agent how to do a specific kind of task (write a YouTube script, draft a cold email, plan a trip, etc.).

**How the Agent SDK handles them:** every `.claude/skills/*/SKILL.md` is loaded when the execution agent boots, and each skill's `description` gets injected into the agent's system prompt along with an instruction to pick the relevant one for the current task. You do **not** select skills per spawn — the agent picks based on which description matches. Only descriptions load upfront; the full SKILL.md body is pulled into context only when the agent actually invokes the skill, so adding more skills is cheap.

The SDK is pretty smart about picking the right skill as long as your `description` is specific and front-loads the trigger phrases ("Use when the user asks to write a video script, turn research into a YouTube video…"). Vague descriptions = missed invocations.

Wiring (in `server/execution-agent.ts`):
- `settingSources: ["project"]` — tells the SDK to load `.claude/skills/`
- `"Skill"` in `allowedTools` — enables the Skill tool

Only the **execution agent** loads skills. The dispatcher (interaction-agent) stays in SDK isolation mode, so it never sees them — which is correct, because the dispatcher should never do work, only route.

**To add a skill:** create `.claude/skills/<kebab-name>/SKILL.md`:

```yaml
---
name: youtube-script-writer
description: Write a tight, retention-focused YouTube script from a topic or outline. Use when the user asks for a video script, wants to turn research into a video, or needs a hook rewritten.
---

<instructions the agent follows when this skill is invoked>
```

There's a soft budget (~15k chars by default, via `SLASH_COMMAND_TOOL_CHAR_BUDGET`) for the combined skill-description block in context — if you end up with many skills, keep descriptions sharp so none get truncated.

Example included: `.claude/skills/youtube-script-writer/`.

---

## Using your Claude Code subscription

The Claude Agent SDK reuses the credentials Claude Code writes to your machine when you sign in. You do not need an `ANTHROPIC_API_KEY`.

- Install once: `npm install -g @anthropic-ai/claude-code`
- Run `claude` in a terminal, sign in.
- That's it — the SDK finds the session automatically.

If you'd prefer an API key (e.g. for a deployed server), set `ANTHROPIC_API_KEY` in `.env.local` and the SDK will use it instead.

---

## Environment variables

Everything lives in `.env.local` (auto-created by `npm run setup`). See `.env.example` for the full list.

| Var | Required | Notes |
|---|---|---|
| `CONVEX_URL` / `VITE_CONVEX_URL` | yes | Convex deployment URL. Written by `npx convex dev`. |
| `WHATSAPP_AGENT_NUMBER` | yes | Agent's E.164 number (display only, e.g. `+15551234567`). |
| `WHATSAPP_ALLOWED_NUMBERS` | yes | Comma-separated E.164 allowlist. Inbound from other numbers is silently dropped. |
| `WHATSAPP_SESSION_DIR` | no | Defaults to `./auth_info_baileys`. Baileys writes auth state here. |
| `BOOP_MODEL` | no | Default `claude-sonnet-4-6`. Used as the fallback when no runtime override is set. The user can switch the model at runtime from WhatsApp ("use opus", "switch to sonnet") via the `set_model` self-tool — that override is stored in the Convex `settings` table and takes precedence over this env var. |
| `BOOP_UPSTREAM_CHECK` | no | Set to `false` to disable the new-version banner on `npm run dev`. Default: on. |
| `PORT` | no | Default `3456`. |
| `PUBLIC_URL` | no | Base URL for Composio OAuth callbacks. Not needed for WhatsApp transport itself — only matters when Composio integrations are configured. |
| `VOYAGE_API_KEY` **or** `OPENAI_API_KEY` | optional | Unlocks vector recall. Falls back to substring. |
| `COMPOSIO_API_KEY` | optional | Enables integrations. Without it, plain chat + memory + automations still work. Get one at [app.composio.dev/developers](https://app.composio.dev/developers?utm_source=chris&utm_medium=youtube&utm_campaign=collab). |
| `COMPOSIO_USER_ID` | optional | Stable user id Composio keys connections under. Defaults to `boop-default`. |
| `ANTHROPIC_API_KEY` | optional | Bypass the Claude Code subscription. |

---

## Integrations, via Composio

Boop outsources 3rd-party service integrations to [Composio](https://composio.dev/?utm_source=chris&utm_medium=youtube&utm_campaign=collab). One API key unlocks ~1000 toolkits (Gmail, Slack, GitHub, Linear, Notion, Drive, Stripe, Supabase, HubSpot, Salesforce, Granola, and so on). Composio hosts the OAuth apps, manages token refresh, and exposes every toolkit as a set of Claude-ready tools. Boop never sees an access token.

### Quickstart

1. Grab an API key at [app.composio.dev/developers](https://app.composio.dev/developers?utm_source=chris&utm_medium=youtube&utm_campaign=collab).
2. Add it to `.env.local`:
   ```
   COMPOSIO_API_KEY=sk-comp-...
   ```
3. `npm run dev`.
4. Open the debug dashboard → **Connections** tab. You'll see a curated list of ~20 cards. For each one: click **Connect**, authenticate on Composio's hosted page, done — Composio ships managed OAuth for every curated toolkit. (If you add a custom toolkit that needs your own OAuth app, the card flips to a "Set up →" state pointing at `platform.composio.dev/auth-configs` — rare, but supported.)

After a successful connect, the agent can use that toolkit immediately — no restart.

### How it wires in

Boop keeps the dispatcher / executor split intact. Composio sits under the executor:

```
interaction-agent:  spawn_agent(task, integrations: ["gmail", "slack"])
                              │
                              ▼
execution-agent:    for each slug, open a Composio session scoped to that toolkit:
                      composio.create(BOOP_USER, { toolkits: ["gmail"] })
                      session.tools()          ← returns only Gmail tools
                              │
                              ▼
                    createSdkMcpServer({ name: "gmail", tools })
                              │
                              ▼
                    Sub-agent sees mcp__gmail__GMAIL_*  — nothing else.
```

Key properties:

- **Per-spawn tool scope.** The dispatcher picks which toolkits the sub-agent sees. Tens of tools per spawn, not thousands, so context stays tight and the agent stays fast.
- **Toolkit slug = integration name.** `spawn_agent(integrations: ["linear"])` works for any toolkit you've connected. Unknown slugs just log a warning and are skipped.
- **No tokens on our side.** Every tool call runs through Composio's proxy. If Composio goes down, integrations go down — but your server never holds user OAuth tokens.
- **Multi-account per toolkit.** Connect a second Gmail (work + personal) — each gets its own connection row you can alias. The dispatcher picks up all active connections for the slug.
- **Identity resolution.** Connection cards show the real account email (e.g. `chris@aloa.co`) resolved by calling the toolkit's own "who am I" tool through Composio (`GMAIL_GET_PROFILE`, etc.). Alias per connection if you want a friendlier label.

### Adding toolkits beyond the curated list

The ~20 toolkit catalog is hand-picked in `server/composio.ts:CURATED_TOOLKITS`. To surface another:

```ts
// server/composio.ts
export const CURATED_TOOLKITS: CuratedToolkit[] = [
  // …existing entries…
  { slug: "airtable", displayName: "Airtable", authMode: "managed" },
];
```

`authMode: "managed"` is correct for virtually every toolkit Composio ships today. Use `"byo"` only if Composio doesn't have a hosted OAuth app for that toolkit. If you guess wrong, the UI's auth-config fallback banner catches it and points you at the right dashboard page.

### Cost tracking

Every execution agent's `total_cost_usd` comes straight from the Claude Agent SDK's `result` message (authoritative, matches Anthropic's billing). You'll see real dollar amounts in the Dashboard tab's Cost tile and per-agent cards.

Every LLM call — dispatcher turn, execution-agent run, memory extraction, consolidation (proposer / adversary / judge) — also writes a row to the `usageRecords` table with per-layer tokens (including cache read/write) and cost. `usageRecords:summary` gives you totals by source so you can see which layer is actually burning the bill. Each row reports the model the caller requested, not the model-routing the SDK did internally.

### A note on runaway cost

Boop's `query()` calls don't currently set `maxTurns` or `maxBudgetUsd`. Those are hard stops the SDK exposes — set them and the agent aborts once the threshold hits, with whatever partial result it has.

Kept as-is intentionally for a single-user personal agent: every task is scoped tight (spawned by the dispatcher with a specific task string + a small integration list), integrations are Composio-scoped per spawn so the tool surface stays small, and the existing 15-minute heartbeat (`server/heartbeat.ts`) marks any long-running agent as `failed` and aborts it. In practice execution agents complete in under 60 seconds.

If you deploy Boop in a higher-throughput setting, or hand it integrations that allow looping (webhooks, scrapers), you probably want to set `maxTurns: 20` and `maxBudgetUsd: 2.00` on the `query()` call in `server/execution-agent.ts` as a belt-and-suspenders cap.

### Keeping it in sync

Deeper dive — auth modes, toolkit scoping internals, multi-account flow, per-connection identity: [INTEGRATIONS.md](./INTEGRATIONS.md).

Upgrade path when upstream ships changes: run `/upgrade-boop` inside `claude` (the skill under `.claude/skills/upgrade-boop/`) — previews diffs, backs up, merges, surfaces `[BREAKING]` CHANGELOG entries. See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution rules + the CHANGELOG / migration-skill conventions.

---

## Project layout

```
boop-agent/
├── server/
│   ├── index.ts                   # Express + WS + HTTP routes
│   ├── whatsapp.ts                # Baileys transport: inbound handler, reply, typing indicator
│   ├── interaction-agent.ts       # Dispatcher
│   ├── execution-agent.ts         # Sub-agent runner
│   ├── automations.ts             # Cron loop
│   ├── automation-tools.ts        # create/list/toggle/delete MCP
│   ├── draft-tools.ts             # save_draft / send_draft / reject_draft MCP
│   ├── heartbeat.ts               # Stale-agent sweep
│   ├── consolidation.ts           # 3-phase adversarial pipeline (proposer → adversary → judge)
│   ├── usage.ts                   # aggregateUsageFromResult helper (shared cost aggregation)
│   ├── embeddings.ts              # Voyage / OpenAI wrapper
│   ├── composio.ts                # Composio SDK wrapper (session + toolkit scoping)
│   ├── composio-routes.ts         # /composio/* HTTP routes for the Debug UI
│   ├── broadcast.ts               # WS fanout
│   ├── convex-client.ts           # Convex HTTP client
│   ├── memory/
│   │   ├── types.ts
│   │   ├── tools.ts               # write_memory / recall (vector + substring)
│   │   ├── extract.ts             # Post-turn extraction
│   │   └── clean.ts               # Decay + archive + prune
│   └── integrations/
│       ├── registry.ts            # Integration loader
│       └── composio-loader.ts     # Registers each connected Composio toolkit
├── convex/
│   ├── schema.ts
│   ├── messages.ts
│   ├── memoryRecords.ts
│   ├── agents.ts
│   ├── automations.ts
│   ├── consolidation.ts
│   ├── conversations.ts
│   ├── drafts.ts
│   ├── memoryEvents.ts
│   ├── usageRecords.ts            # Append-only per-call cost log
│   └── whatsappDedup.ts
├── debug/                         # Dashboard: Dashboard / Agents / Automations / Memory / Events / Connections
├── scripts/
│   ├── setup.ts                   # Interactive setup CLI
│   ├── dev.mjs                    # One-command orchestrator (server + convex + vite)
│   └── preflight.mjs              # Checks convex/_generated exists before booting
├── README.md           ← you are here
├── ARCHITECTURE.md
└── INTEGRATIONS.md
```

---

## Upgrading

Boop is a fork-and-own template. You customize your copy freely — system prompts, memory thresholds, extra tools — and pull upstream fixes in on your own schedule.

The intended path is **Claude Code-driven**, modeled on NanoClaw:

```bash
claude                 # inside your repo
/upgrade-boop
```

`/upgrade-boop` is a skill in `.claude/skills/upgrade-boop/SKILL.md`. It:

1. Refuses to run with a dirty working tree.
2. Creates a timestamped rollback tag.
3. Previews upstream changes bucketed by area (core / integrations / UI / schema / scripts / docs).
4. Merges (or cherry-picks, or rebases — your choice).
5. Runs `npm install` + `npm run typecheck`.
6. Parses `CHANGELOG.md` for `[BREAKING]` entries and offers to run the referenced migration skills.
7. Prints a rollback hash + any env-var additions you should copy into `.env.local`.

Plain git works too, if you'd rather:

```bash
git remote add upstream https://github.com/chris/boop-agent.git    # one-time
git fetch upstream
git merge upstream/main      # or: git rebase upstream/main
```

### New-version notifications

Every time you run `npm run dev`, a small background check (`scripts/check-upstream.mjs`) asks your `upstream` remote if there are new commits. If there are, you'll see a banner up top with the count and a reminder to run `/upgrade-boop`. If you're up to date, or the check fails for any reason (offline, no `upstream` remote, timeout), it stays silent.

Behavior at a glance:

- `upstream` set, new commits → banner with the count
- `upstream` set, up to date → silent
- No `upstream` remote, on a fork → one-line hint on adding it
- No `upstream` remote, on the canonical repo → silent (you *are* upstream)

To turn it off:

- **Env var:** add `BOOP_UPSTREAM_CHECK=false` to `.env.local`
- **Or comment it out:** the call lives in `scripts/dev.mjs` — the `spawn("node", ["scripts/check-upstream.mjs"], ...)` block. Delete or comment that block and the check never runs.

### CHANGELOG

Every release lists additions under [CHANGELOG.md](./CHANGELOG.md), with `[BREAKING]` prefixes for anything that requires action. `/upgrade-boop` parses that format automatically.

---

## Troubleshooting

**Agent doesn't reply.**
- Check the server is running: `curl http://localhost:3456/health`
- Check the WhatsApp session is connected — look for `[whatsapp] connected` in server logs.
- Watch server logs. Look for `[whatsapp]` and `[interaction]` messages.
- Verify the sending number is in `WHATSAPP_ALLOWED_NUMBERS` (E.164 format, `+549...` for Argentine mobiles).

**Convex errors / `VITE_CONVEX_URL is not set`.**
- Run `npx convex dev` manually. Ensure `.env.local` has both `CONVEX_URL` and `VITE_CONVEX_URL`.

**"Could not find public function for X:Y".**
- `CONVEX_DEPLOYMENT` and `CONVEX_URL` in `.env.local` are pointing at different projects. `convex dev` pushes functions to `CONVEX_DEPLOYMENT` but the client reads from `CONVEX_URL`. Fix: make sure the URL has the same name as the deployment — `CONVEX_DEPLOYMENT=dev:foo-bar-123` → `CONVEX_URL=https://foo-bar-123.convex.cloud`. Re-running `npm run setup` now auto-syncs these.

**Agent replies but can't use my integration.**
- Check `COMPOSIO_API_KEY` is set in `.env.local`.
- Check the toolkit shows as **Connected** in the Connections tab.
- Watch server logs for `[composio] registered …` at boot and `[integrations] unknown integration: …` on spawn attempts.

**I want to skip WhatsApp for now.**
- The server exposes `POST /chat` with `{ conversationId, content }` — curl or a tiny client can drive the agent directly, no WhatsApp required.

**Claude SDK says no credentials.**
- Run `claude` once and sign in, or set `ANTHROPIC_API_KEY` in `.env.local`.

**WhatsApp QR not appearing / session not connecting.**
- Make sure `WHATSAPP_SESSION_DIR` is writable. Delete its contents and restart to force a fresh QR.
- If the link expired (phone offline >14 days), delete `auth_info_baileys/` and re-scan.

**"Dashboard crashed" in the debug UI.**
- The ErrorBoundary caught something. Check the server logs (`server │` stream) and the browser console — both will have the real error. Most common cause: a new Convex function hasn't been deployed yet. Restart `npm run dev` so `convex dev` re-pushes.

---

## License

MIT. Build whatever you want on top of this.
