# Tools and MCP Servers

`[Live]`

## What this is

Every agent in Command Center carries a tool allowlist: the exact set of capabilities it is allowed to use during a run. Tools are the verbs an agent can perform. One agent might only read files; another might search the web; another might delegate to other agents. The allowlist is scoped per agent, so each specialist gets exactly the reach it needs and nothing more.

On top of that built-in set, you can connect **MCP servers**: external [Model Context Protocol](https://modelcontextprotocol.io) processes or endpoints that expose their own tools. When you attach an MCP server to an agent, its tools light up automatically the next time that agent runs.

## How to use it

**The built-in tool model.** Each agent is defined with an `allowedTools` list. Out of the box the four specialists are scoped like this:

- **Main** (router): `Agent` only, so it can delegate to the others.
- **Comms**: `WebFetch`.
- **Content**: `WebSearch`, `WebFetch`.
- **Ops**: `Read`, `Glob`, `Grep` (read-only filesystem).

Other tools the SDK can grant include `Bash`, `Write`, and `Edit`. Custom agents you create from the sidebar pick their own allowlist. An agent can only ever use a tool that is on its list, so granting `Write` or `Bash` is a deliberate choice, not a default.

**Adding an MCP server.** Open the 🔌 **MCP** modal for an agent. Pick a transport:

- **stdio** spawns a local process. You give it a `command`, optional `args`, and optional `env` variables.
- **http** connects to an HTTP MCP endpoint by `url`, with optional `headers`.
- **sse** connects to a Server-Sent Events MCP endpoint, also `url` plus optional `headers`.

Each server gets a short `name` (1 to 40 characters, letters, digits, `_` or `-`). That name becomes the key the agent's tools are namespaced under. Save it, flip the enable toggle on, and the server's tools are available on the next run.

**A concrete example.** To give an agent the reference filesystem MCP server over stdio:

- Name: `filesystem`
- Transport: `stdio`
- Command: `npx`
- Args: `-y`, `@modelcontextprotocol/server-filesystem`, `/Users/you/Projects`

Enable it, and the agent gains that server's read/list/write tools, namespaced under `mcp__filesystem`.

**The Test button.** Next to each server is **Test**. It spins that one server up in isolation, reads the connection status the SDK reports, and aborts before the model takes a turn. You see connected or failed without spending a model call. Use it right after entering credentials to confirm the server actually comes up.

## How it works

MCP config is stored per agent in SQLite (`data/lab.db`, [`src/mcpServers.ts`](../../src/mcpServers.ts)) and never leaves your laptop. When an agent runs, the host composes `mcpOptionsFor()` into the SDK `query()` call. That does two things:

1. It builds the SDK's `mcpServers` map from the agent's **enabled** servers, matching the SDK's `McpServerConfig` union (`stdio` / `http` / `sse`).
2. It appends an `mcp__<name>` allow-token to the agent's `allowedTools` for each enabled server. Without that token the connected tools would be blocked by the agent's own allowlist, so this is what actually lights them up.

If an agent has no enabled servers, the `mcpServers` option is omitted entirely and the allowlist is passed through unchanged.

The **Test** route uses `singleServerConfig()` to build a map for just one server, starts a `query()`, reads the connection state out of the SDK's `system.init` message (its `mcp_servers` field reports connected or failed per server), then aborts before any model turn. That is how it can verify a connection cheaply.

## Common questions

**Why didn't my MCP tools show up?**
Check that the server's enable toggle is on. A saved-but-disabled server is stored but not spread into the run. Also confirm the run is for the agent you attached the server to. MCP config is per agent, not global.

**Are my env vars and headers safe?**
Yes. The values of env variables and HTTP headers are masked in the UI (keys stay visible, values show as dots). The real values stay in SQLite on your machine and are used raw only at runtime inside the `query()` call. They are never round-tripped back to the browser.

**Does Test cost anything?**
No. Test aborts before the model takes a turn, so it spends no tokens. It only verifies that the server process or endpoint connects.

**Can two servers share a name?**
Each server name should be unique per agent because it is the key in the `mcpServers` map. On a duplicate, last write wins, so give each one a distinct name.

**What is the difference between a tool and an MCP server?**
A tool is a single capability (read a file, fetch a URL). An MCP server is an external program that can expose many tools at once. Attaching one server can add a whole cluster of related tools under one `mcp__<name>` namespace.

## Where to go next

- [Skills](./skills.md), the other per-agent capability layer: jobs, not verbs.
- [Telegram Bridge](./telegram-bridge.md), drive these same agents and tools from your phone.
- [Voice (WhisprDesk)](./voice.md), talk to your agents instead of typing.
