# Command Center — User Guide

A friendly, task-oriented guide to every surface in Command Center. If the
[main README](../../README.md) is the "what and why," this is the "how do I
actually use it."

Everything here runs entirely on your own machine at `http://127.0.0.1:3333`.
Nothing is relayed through any server, and your data lives in memory or in a
local SQLite file (`data/lab.db`) that never leaves your laptop.

## Status legend

- `[Live]` — shipped and working today. Every page in this guide is Live.
- `[Planned]` — on the backlog, not yet built (see [`backlog.md`](../../backlog.md)).
  Examples still on the bench: file-rewind UI, an inline AskUserQuestion card,
  a sub-agent depth limit.

## New here? Read in this order

1. [Getting Started](./getting-started.md) — install, pick an auth method, send your first message.
2. [What's Under the Hood](./whats-under-the-hood.md) — how the Claude Agent SDK maps to what you see.
3. [Chat and Models](./chat-and-models.md) — the surface you spend the most time in.
4. [Agents](./agents-and-overview.md) — the built-in specialists and how to spawn your own.
5. [Memory and Pins](./memory-and-pins.md) — give an agent durable context.

Everything else is pick-and-choose.

---

## Getting started

The first launch, the auth model, and how the SDK maps to what you see.

| Page | What it covers |
|---|---|
| [Getting Started](./getting-started.md) | Clone, choose API key vs CLI OAuth, `npm run serve`, first message, the launcher |
| [What's Under the Hood](./whats-under-the-hood.md) | What the Agent SDK is, the one-process topology, where state lives |
| [Authentication](./authentication.md) | The SDK's credential order, what "Max plan" means, the ToS caveat |

## Chat, agents, and memory

The day-to-day surfaces.

| Page | What it covers |
|---|---|
| [Chat and Models](./chat-and-models.md) | Streaming, model selection, plan mode, `@file`, multi-turn sessions |
| [Agents](./agents-and-overview.md) | The four built-ins, custom-agent CRUD, sub-agent delegation |
| [Memory and Pins](./memory-and-pins.md) | Persistent memory and context pins, both injected every turn |
| [History and Export](./history-and-export.md) | Restore-and-resume past sessions, export to Markdown or JSON |

## Tools, skills, and integrations

How agents do real work, and how you extend them.

| Page | What it covers |
|---|---|
| [Tools and MCP Servers](./tools-and-mcp.md) | Per-agent tool allowlists, MCP servers (stdio/http/sse), the Test button |
| [Browser Automation](./browser-automation.md) | Give an agent a real browser behind a per-domain allow-list |
| [Agent Personality](./personality.md) | Give an agent a voice (Soul Builder) over locked guardrails |
| [Skills](./skills.md) | Per-agent Agent Skills from `.claude/skills`, toggle + rescan |
| [Telegram Bridge](./telegram-bridge.md) | Drive the same agents from your phone, allowlist-gated |
| [Voice (WhisprDesk)](./voice.md) | Speak to your agents and have replies read aloud |

## Automation, queue, and safety

Run agents unattended, on a schedule, within guardrails. This is the
"Autonomous Agent Firm" and it is Command Center's richest differentiator.

| Page | What it covers |
|---|---|
| [Task Queue](./task-queue.md) | The durable SQLite kanban: enqueue, atomic checkout, crash recovery |
| [Scheduler](./scheduler.md) | Cron-style schedules with OAuth-rotation auto-pause |
| [Approval Gates](./approval-gates.md) | Pause dangerous tools for your sign-off mid-run |
| [Budget Caps (CostGuard)](./costguard.md) | Per-agent cost + rate caps enforced before every call |

## Reference

The flat lists you look things up in.

| Page | What it covers |
|---|---|
| [Slash Commands](./slash-commands.md) | The full `/command` table and `@file` mechanics |
| [Keyboard Shortcuts](./keyboard-shortcuts.md) | The ⌘K command palette and direct shortcuts |
| [Settings Reference](./settings-reference.md) | Every Settings section, every option, the secret-masking rules |

---

This guide is hand-written Markdown, the same as Command Center itself. Found
something wrong or out of date? It is just files in [`docs/guide/`](.), so a
one-line fix and a pull request is all it takes.
