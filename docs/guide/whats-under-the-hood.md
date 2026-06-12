# What's Under the Hood

`[Live]`

## What this is

Clawd Desk is not a wrapper around Claude. The Claude Agent SDK *is* the engine, and this app is the thinnest possible UI on top of it.

The SDK is the same agent loop that powers the Claude Code CLI, exposed as a TypeScript library. You hand it a prompt plus a set of options, and you iterate over an async stream of events: session init, assistant text, tool calls, tool results, and a final result. Tool use, plan mode, hooks, sub-agents, sessions, all of it is reachable as an option on one function call. The engine that used to take weeks to build collapses to a function call when Claude is the target model.

That framing is the whole point of this project: every feature in the dashboard maps to one or two options on the SDK's `query()` call. Reading the source is reading the SDK's surface area.

## How to use it

You do not configure any of this directly, but it helps to know the shape while you work.

**One process, one port.** A single Node process runs Express on port 3333 and spawns the `claude` subprocess that the SDK drives. There is no Electron, no IPC bridge, and no separate frontend build. `tsx` runs the TypeScript directly, and static files serve from `/public`.

**The request path.** When you send a message, the browser POSTs to the server, the server calls `query()` with the active agent's options, and the SDK streams events back. For the streaming chat the server forwards those events as NDJSON (one JSON object per line) so the reply appears token by token.

**Watch the trace.** Because the SDK exposes tool use as events, you see them. A delegation shows a "🤝 delegated to" chip; a file read or web fetch surfaces as a tool-use line. The "thinking" is meant to be legible, not hidden.

## How it works

State lives in two layers. A small **in-memory** layer holds per-process pointers: the SDK session ID per agent (used for `resume:` to continue a conversation), any per-agent model override, and the current working directory passed as `cwd`. These reset when you restart the server.

Everything meant to survive a restart lives in **SQLite at `data/lab.db`**: persistent memory, the durable task queue, conversation sessions and messages, settings, custom agents, context pins, MCP server configs, the cost ledger, schedules, and pending approvals. That file is gitignored, so it stays on your disk and never reaches the public repo.

## Common questions

**Is this a fork of Claude Code?**
No. It uses the Claude Agent SDK, which is Claude Code's loop published as a library. Clawd Desk just renders that loop in a browser.

**Why one process instead of a client plus a server, or Electron?**
Simplicity. The SDK already has filesystem access through its tools, so there is no need for a native shell. One Express process is the least surprising thing that works.

**Does anything leave my machine?**
Only the agent's own calls to Anthropic. The server is localhost-only and all durable state is in the local SQLite file. Nothing is relayed through a hosted backend.

**What do I lose when I restart the server?**
Only the in-memory pointers: live session resume, the active model override, and the current folder. Your memory, tasks, conversation history, settings, and custom agents are in SQLite and come back exactly as you left them.

**Is this multi-provider?**
No. Clawd Desk is Claude-only by design. If you need OpenAI, Ollama, or local models, that is a different tool.

## Where to go next

- [Getting Started](getting-started.md), clone, auth, and your first message.
- [Authentication](authentication.md), how the SDK resolves credentials.
- [Settings Reference](settings-reference.md), the operator config stored in SQLite.
