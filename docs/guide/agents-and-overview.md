# Agents

`[Live]`

## What this is

An agent is a named worker with its own personality, its own set of allowed tools, and its own default model. Command Center ships four built-in agents and lets you spawn as many custom ones as you like. Each lives in the left sidebar, keeps its own conversation, and is one click away.

The four built-ins are:

- **🧭 Main** is the triage and router. It has no direct tools of its own and instead delegates work to the specialists when a request fits their lane. Default model: Sonnet 4.6.
- **✉️ Comms** drafts emails, messages, replies, and outreach. It has `WebFetch` for pulling context. Default model: Sonnet 4.6.
- **🎬 Content** handles YouTube scripts, outlines, hooks, and titles. It has `WebSearch` and `WebFetch`, and runs on Opus 4.8 for the strongest creative output.
- **⚙️ Ops** reads local files in the selected folder using `Read`, `Glob`, and `Grep`. It is read-only and never modifies anything. Default model: Sonnet 4.6.

## How to use it

Click any agent in the sidebar to start or resume a chat with it. The chip under each agent name shows its current model.

To make your own agent, click the **+ New agent** button at the bottom of the sidebar. The editor asks for:

- a name and an emoji
- an accent color
- a one-line description (this is what the router reads when deciding whether to delegate to it)
- a default model
- tool checkboxes for the SDK-known tools
- a router flag
- a system prompt

Save, and the new agent appears in the sidebar immediately. Hover a custom agent to get the ✎ edit button. You can change or delete custom agents freely. The four built-ins are read-only, so the editor will not let you overwrite them.

Custom agents participate in everything: streaming, sessions, memory, pins, folder scoping, and plan mode. If you flag one as a router, Main's delegation list grows to include it.

## How it works

Each agent maps to one `query()` call with that agent's `systemPrompt`, `allowedTools`, and `model`. Switching agents in the sidebar just changes which config the server passes. There is no shared global personality; the system prompt is per agent, per call.

Custom agents are stored in SQLite at `data/lab.db` and merged with the built-ins at runtime through a unified agent registry. The built-ins stay defined in TypeScript so they are version-controlled, while anything you spawn from the UI lives in the database. The registry is also the one place that knows whether a given agent is built-in (read-only) or custom (editable).

Sub-agent delegation is pure SDK. Promote an agent to a router by giving it the `Agent` tool in its allowlist and populating the SDK's `options.agents` with the specialists. Ask Main to "draft a short thank-you email" and it recognizes Comms's lane, invokes Comms as a sub-agent, and threads the reply back with a "🤝 delegated to ✉️ Comms" chip. The model makes the routing decision; there is no hand-written "which agent gets this" code on the server.

A key safety property: a sub-agent runs with its own `allowedTools`, not the router's. Delegation cannot escalate tool access. Main's empty tool set does not leak into Comms, and Comms's `WebFetch` does not leak back out to Main.

## Common questions

**Can I edit the four built-in agents?**
Not from the UI. They are read-only and return an error on edit or delete. You can change their defaults in `src/agents.ts` if you are running your own copy, but the lab keeps them stable so the baseline is predictable.

**What does the router flag do on a custom agent?**
It gives that agent the `Agent` tool and lets it delegate to the other agents, the same way Main does. Use it when you want a second triage layer with a different personality or model.

**Where do my custom agents live, and do they leave my machine?**
They live in the local SQLite database at `data/lab.db`, which is gitignored. Nothing about them is uploaded anywhere.

**Why does Main usually delegate instead of answering?**
Its system prompt tells it to prefer delegation when a request clearly fits a specialist's lane. For general questions or cross-specialist planning, it answers directly.

**Does delegation cost extra?**
A delegated turn runs the specialist as its own SDK sub-agent, so it is a real model call with the specialist's own model. On the Max plan there is no per-call dollar charge; the token usage shows up in the normal totals.

## Where to go next

- [Chat and Models](./chat-and-models.md) for how a turn streams and how per-agent model choice works.
- [Memory and Pins](./memory-and-pins.md) to give an agent durable context every turn.
- [Slash Commands](./slash-commands.md) including `/agents` to list everyone at a glance.
- [Keyboard Shortcuts](./keyboard-shortcuts.md) to jump between agents from the command palette.
