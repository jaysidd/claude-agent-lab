# ClawdDesk — Architecture Flow Spec (for the website React Flow diagram)

A ready-to-build node/edge spec for the interactive diagram on clawddesk.ai,
modeled on the tradingagentslab.ai/flow pattern. Two diagrams: **A** is the
centerpiece (the request lifecycle), **B** is the optional fast-follow (every
feature mapped to its SDK primitive).

Everything here is lifted from `architecture.md` and the `README.md` "Features
at a glance" table — those remain the source of truth. Verify before publish.

---

## Diagram A — The request lifecycle (centerpiece)

**Thesis callout (pin near the diagram):** *"The SDK is the engine. One `query()`
call replaces the agent loop, tool dispatch, and streaming you'd otherwise build
by hand — which is why the whole app is one small server process."*

Layout: left-to-right flow, with a labeled **return path** back to the browser.

### Nodes

| id | label | panel description (shown on click) |
|----|-------|------------------------------------|
| `browser` | 🖥️ Browser (vanilla JS) | The entire UI — multi-agent sidebar, chat, live tool-use trace, modals. No framework, no build step. Talks to the server over `fetch` + an NDJSON stream. |
| `server` | ⚙️ Express server · `:3333` | One Node process (run by `tsx`, no compile step). Serves the static UI from `/public` and the `/api/*` routes. Holds in-memory state (per-agent session IDs, cwd, model overrides) plus a local SQLite file (`data/lab.db`) for memory, tasks, schedules, settings. |
| `sdk` | 🧠 Claude Agent SDK · `query()` | The engine. Every chat turn calls `query({ systemPrompt, allowedTools, cwd, model, mcpServers, hooks, resume, … })`. The agent loop, tool calls, and token streaming all happen inside this one call. |
| `cli` | 🔌 `claude` CLI (spawned) | `query()` resolves and spawns the bundled Claude Code CLI (`cli.js`) as a child process. That subprocess actually runs the agent loop and talks to the model — the SDK is the typed wrapper around it. |
| `creds` | 🔑 Your local credentials | The CLI authenticates with the Claude Code CLI's Max-plan OAuth session, or `ANTHROPIC_API_KEY` if you set one. **Nothing is relayed through any third-party server** — it runs on your machine against your own account. |

### Edges

| source → target | label | direction |
|-----------------|-------|-----------|
| `browser` → `server` | `POST /api/chat` (NDJSON stream) | request |
| `server` → `sdk` | `query({ options })` | request |
| `sdk` → `cli` | spawns `cli.js` subprocess | request |
| `cli` → `creds` | authenticates (OAuth / API key) | request |
| `cli` → `server` | `stream_event` · `tool_use` · `result` | return (dashed) |
| `server` → `browser` | streamed tokens + tool-use trace | return (dashed) |

> Visual note: render the request path solid, the return path dashed. The
> `server` node is the one to emphasize — "this whole box is the product; the
> three to its right are the SDK doing the heavy lifting for free."

---

## Diagram B — Feature → SDK primitive map (optional fast-follow)

A hub-and-spoke: a central **`query()` options** node, with feature nodes
branching off, each edge labeled by the option that powers it. The teaching
point: most features are *one or two options on a single function call*.

### Central node
- `query` — **`query({ … })`** — "Almost every feature below is a field on this one call."

### Feature spokes (node label → edge label = the SDK primitive)

| feature node | edge label (SDK primitive) |
|--------------|----------------------------|
| Multi-agent sidebar | `systemPrompt` + `allowedTools` (per agent) |
| Custom agents (CRUD) | same options, from a SQLite-backed registry |
| Sub-agent delegation | `agents: Record<string, AgentDefinition>` + the `Agent` tool |
| Token-by-token streaming | `includePartialMessages: true` → `stream_event` |
| Folder scoping | `cwd` |
| Per-agent model | `model: "claude-opus-4-8" \| "…sonnet-4-6" \| "…haiku-4-5"` |
| Browser automation | `mcpServers` (Playwright MCP) + a `PreToolUse` hook (URL gate) |
| Skills + Skills Studio | `settingSources: ['project','user']` + `skills` name filter |
| MCP servers | `mcpServers` (stdio / http / sse) |
| Approval gates | `PreToolUse` hook (await operator approve/reject) |
| Plan mode | `permissionMode: 'plan'` |
| Multi-turn per agent | `resume: sessionId` (captured from `system.init`) |
| Abort on disconnect | `abortController: AbortController` |
| Personality · memory · pins | composed into `systemPrompt` (one chokepoint: `augmentedSystemPrompt()`) |

### "Around the SDK, not inside query()" cluster
A visually separate group — these are host-side primitives ClawdDesk builds *on
top of* the SDK, not `query()` options. Good to show so the diagram is honest:

- **Durable task queue** — SQLite, atomic checkout, lease-based crash recovery
- **Cron scheduler** — node-side tick loop that fires `query()` on a schedule; result destinations + run history
- **CostGuard** — a preflight `check()` before every `query()`, plus `record()` after
- **Emergent skills** — a cheap Haiku `query()` distills a finished turn into a skill draft

---

## Assets + verification

- **Screenshots:** `docs/screenshots/01-overview.png` … `15-settings-budget.png` (15 hi-res PNGs).
- **Verify all claims against:** `architecture.md` (topology + data flow) and `README.md` (the feature→primitive table). When this spec and the repo disagree, the repo wins.
- **Run commands for any "get started" UI:** `git clone https://github.com/RBJGlobal/clawddesk.git && cd clawddesk && npm install && npm run serve` → http://127.0.0.1:3333 (Node 20+, plus the `claude` CLI logged in or `ANTHROPIC_API_KEY`).
