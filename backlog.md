# Command Center — Sequential Backlog

> Last Updated: 2026-04-23
> Total items: 13 (7 foundation + 6 queued features + future list)
> Completed: F1–F7 foundation

> **Work order**: Items are numbered C##. Complete them in order unless a higher-priority need lands.
>
> **Tracking legend**:
> - [ ] Not started
> - [~] In progress
> - [x] Complete
> - [CHANGED] Plan modified (reason documented)
> - [DROPPED] Removed (reason documented)

---

## DONE — Foundation (Completed 2026-04-23)

| # | Item | Date | Notes |
|---|------|------|-------|
| F1 | Project scaffold — Express + tsx + SDK + vanilla UI | 2026-04-23 | `npm install @anthropic-ai/claude-agent-sdk`, `tsx`, `express` |
| F2 | Multi-agent sidebar — Main / Comms / Content / Ops | 2026-04-23 | `agents.ts` defines each; sidebar renders from `/api/agents` |
| F3 | Per-agent system prompts, tools, session persistence | 2026-04-23 | `resume: sessionId` stored per agent in server Map |
| F4 | Folder picker + cwd scoping | 2026-04-23 | `/api/cwd`, `/api/browse`; `query()` receives `cwd:` |
| F5 | `@file` autocomplete | 2026-04-23 | `/api/files`; dropdown in composer with keyboard nav |
| F6 | Model selector per agent (Opus / Sonnet / Haiku) | 2026-04-23 | Runtime override via `/api/model/:agentId`; defaults in `agents.ts` |
| F7 | Model + auth footer on each reply | 2026-04-23 | Captured from `system.init`; "Max plan · subscription" when `apiKeySource === "none"` |

---

## Phase 1: Sub-agent + Real-Time UX

### C01 — Sub-agent delegation (Main auto-routes to specialists)

- [ ] **Status**: Not started
- **Priority**: HIGH. This is the single biggest "aha" for the command-center pattern.
- **Effort**: Medium (1 session). Uses the SDK's native `agents:` option — no custom routing code.

#### Rationale
Right now Main just *tells* the user "you should ask Comms about that." The SDK can do better: if Main is given `agents: { comms, content, ops }` in its options, it gains an `Agent` tool and can delegate directly. The user asks Main; Main decides "this is a comms task"; invokes Comms as a sub-agent; returns the combined result. That's the pattern from the YouTube demo.

#### Design
- Add an `agents` map on every `query()` call when the active agent is Main (or any agent flagged as a "router")
- Include `Agent` in Main's `allowedTools`
- Sub-agent definitions inline (description, prompt, tools) derived from `AGENTS`
- UI: when the response contains `Agent` tool uses, render a "delegated to X" trace chip

#### Files
- `src/agents.ts` — add `isRouter: boolean` field; Main = true, others = false
- `src/server.ts` — when `agent.isRouter`, populate `options.agents` with the other agents' definitions
- `public/app.js` — render delegation trace inline with tool chips

#### Acceptance criteria
- [ ] Ask Main "draft an email declining a meeting" → delegates to Comms → returns Comms's draft
- [ ] Ask Main "what files are in my project" with a cwd set → delegates to Ops
- [ ] Delegation is visible in the UI (not just the final answer — show "🤝 delegated to Ops" chip)
- [ ] Main still answers direct questions without delegating when appropriate
- [ ] Existing specialist-direct chats still work unchanged

---

### C02 — Streaming responses (SSE, token-by-token)

- [ ] **Status**: Not started
- **Priority**: HIGH. Biggest perceived-speed win; also makes the agent feel "alive" during long tool chains.
- **Effort**: Medium (1 session).

#### Rationale
Current `/api/chat` waits for the full SDK stream to complete, then returns JSON. For quick replies this is fine; for Opus answering a hard question, the user stares at "thinking…" for 20s. Streaming the intermediate `assistant` messages + tool uses as they happen turns that into visible progress.

#### Design
- New route `POST /api/chat/stream` returning Server-Sent Events
- Each event has a `type`: `init` (session_id, model, apiKeySource), `assistant_delta` (text chunk), `tool_use` (tool call), `result` (final text), `error`
- Frontend: swap `fetch` for `EventSource`; append deltas to a growing message bubble; close connection on `result` or `error`
- Keep `/api/chat` around as the non-streaming fallback (used by tests)

#### Files
- `src/server.ts` — add streaming route; extract SDK message-type normalization into a helper
- `public/app.js` — `sendMessage()` becomes `sendMessageStreaming()`; render partials incrementally

#### Acceptance criteria
- [ ] Tokens appear progressively in the chat bubble for any agent
- [ ] Tool use chips appear the moment the tool call happens, not at the end
- [ ] Errors mid-stream surface immediately
- [ ] Non-streaming route still works (used by Playwright tests)

---

### C03 — Task queue with LLM auto-routing

- [ ] **Status**: Not started
- **Priority**: MEDIUM. High visual impact, matches the YouTube demo's "create task" flow.
- **Effort**: Medium (1 session).

#### Rationale
A "+ New task" button opens a modal. User types the task + picks priority. Server hands the task description to a cheap classifier (Haiku) which picks the right agent. The task lands in a simple kanban column ("queued"). Click to fire; agent runs asynchronously; status moves to "in progress" → "done" with the result linked.

#### Design
- New route `POST /api/task` → `{description, priority}` → Haiku classifies agent → returns `{taskId, assignedAgent, description}`
- Task state in a server-side `Map<taskId, Task>`
- UI: bottom-left sidebar panel ("Tasks"), shows queued/active/done lists
- Clicking a queued task moves it to active and fires `/api/chat/stream` with the chosen agent and task description as the prompt
- Completed tasks persist in memory with the final reply

#### Files
- `src/server.ts` — `/api/task`, `/api/tasks` GET, `/api/task/:id/start` POST
- `src/taskRouter.ts` (new) — Haiku prompt for classification
- `public/app.js` — task panel + modal

#### Acceptance criteria
- [ ] "Draft an email to my team about the launch" → routed to Comms
- [ ] "Research the top YouTube titles for productivity tools" → routed to Content
- [ ] "Summarize my project notes in this folder" → routed to Ops
- [ ] Ambiguous task ("help me think through this idea") → routed to Main
- [ ] Classifier runs on Haiku (verified in response model field)
- [ ] Task board shows queued / active / done columns

---

### C04 — Persistent memory (SQLite)

- [ ] **Status**: Not started
- **Priority**: MEDIUM. Becomes HIGH once the agents accumulate enough useful context that losing it on restart is painful.
- **Effort**: Large (2 sessions). Schema, CRUD, injection logic, UI.

#### Rationale
Today: restart = amnesia. Chat history and agent sessions die. That's fine for a learning lab; it's not fine if you actually want Main to remember that you prefer short emails or that Comms should always sign off "— J".

Clawless learned this the hard way and ported a custom memory engine with BM25 + vector search. We don't need that level yet. Minimal version:
- SQLite DB at `~/.claude-agent-lab.db`
- `memories` table: id, content, agent (nullable for global), category (fact/preference/context), created_at
- CRUD routes + panel
- Inject top N relevant memories into the system prompt for each `query()` call
- Simple relevance: substring match + recency for v1; upgrade to embeddings later

#### Files
- `src/db.ts` (new) — better-sqlite3 wrapper, schema init
- `src/memory.ts` (new) — CRUD + injection helpers
- `src/server.ts` — wire memory retrieval into `/api/chat[/stream]`
- `public/memory.html` + CSS + JS (or a modal) — view/add/delete memories

#### Acceptance criteria
- [ ] Memories persist across restarts
- [ ] Memory added via UI is visible in next chat (agent references it)
- [ ] Global memories injected for all agents; agent-specific only for that agent
- [ ] Deleting a memory removes it from subsequent chats
- [ ] Token budget: injected memories capped at ~2000 tokens

---

### C05 — Telegram bridge

- [ ] **Status**: Not started. Requires bot token from user.
- **Priority**: MEDIUM-LOW. Second interface on the same backend — teaches portability.
- **Effort**: Small (1 session) once token is in hand.

#### Rationale
The whole pitch of the SDK is: same engine, any interface. Running alongside the web UI, a Telegram bot routes messages to the same agents. Shows tangibly that the SDK is "Claude as a subroutine."

#### Design
- `src/channels/telegram.ts` — long-poll bot using `node-telegram-bot-api`
- Chat ID allowlist (security — single owner)
- Default agent = Main; `/<agent>` commands switch
- Shares session state with web UI (both talking to Main = same conversation)

#### Files
- `src/channels/telegram.ts` (new)
- `src/server.ts` — spawn the Telegram listener on startup if `TELEGRAM_BOT_TOKEN` env set
- `.env.example` — document the two env vars needed

#### Acceptance criteria
- [ ] Telegram message to bot → Main responds
- [ ] `/ops` switches to Ops agent
- [ ] Unauthorized chat ID gets silence (no response, logged)
- [ ] Same conversation context usable from web + Telegram

---

### C06 — Playwright smoke tests

- [ ] **Status**: Not started
- **Priority**: HIGH. Without tests the next refactor risks breaking the flows we just built.
- **Effort**: Small-Medium (1 session).

#### Rationale
Mirror Clawless's "every user-visible surface has at least one Playwright test" rule. Starting point:
- Page loads and shows 4 agents
- Can select an agent and see empty state
- Can send a message and receive a reply (hits real SDK — mark as `@engine`)
- Model selector changes model and response footer reflects change
- Folder picker changes cwd and next reply carries it
- `@` shows file list from cwd

#### Files
- `playwright.config.ts`
- `tests/smoke.spec.ts` — page load + agents visible (no engine needed)
- `tests/chat.spec.ts` — `@engine` tests that hit SDK
- `package.json` scripts — `test`, `test:smoke`, `test:engine`

#### Acceptance criteria
- [ ] `npm run test:smoke` passes offline (no SDK calls)
- [ ] `npm run test:engine` passes against a running server with Max OAuth
- [ ] At least one test per: page load, agent switch, chat flow, model switch, folder switch, `@file`

---

### C07 — Electron / Tauri packaging (later)

- [ ] **Status**: Not started. Defer until the feature set is stable.
- **Priority**: LOW.
- **Effort**: Medium-Large.

Package the web UI + server as a desktop app. Electron is the easy path given the ecosystem familiarity (Clawless uses it). Tauri is smaller binaries. Revisit when packaging becomes useful.

---

## Future — Not Scheduled

| Item | Notes |
|---|---|
| **Voice layer** | Pipecat / Gemini Live for voice I/O. Matches the "war room" idea from the YouTube video. Large effort; ties into streaming. |
| **Slash commands** | `/clear`, `/model`, `/compact`, `/agents`. Maps naturally to existing Claude Code slash command syntax. |
| **Skills panel** | SDK loads `.claude/skills/*/SKILL.md` automatically if cwd contains them. Add a UI to browse and toggle. |
| **MCP configuration UI** | Let the user point at an MCP server (stdio or HTTP) and have it light up as a tool for a chosen agent. |
| **Conversation export** | Download chat history as markdown or JSON. |
| **Multiple workspaces** | Switch between project contexts (different cwd + memory partition) without losing state. |
| **Hook inspector** | Visualize which hooks fired during a turn (PreToolUse, PostToolUse, etc.). |
| **File rewind** | Expose the SDK's `Query.rewindFiles()` — roll files back to state at any prior user message. Trust-building for destructive Ops work. |
| **Right-panel file viewer** | Inline viewer for files Ops Reads, so user sees what the agent saw. |
| **Cost & usage tracking** | Show tokens in/out per turn, total per session. |
| **Cron / scheduled tasks** | Morning briefing, end-of-day summary, etc. Pair with C03 Task queue. |
| **Multi-pane chat** | Split view: two agents side-by-side for model comparison or parallel work. |
| **Sub-agent depth limit** | Prevent runaway delegation chains once C01 lands. |
| **Auth profile switcher** | Toggle between "personal (OAuth)" and "development (API key)" modes for testing the commercial path. |

---

## Change Log

| Date | Item | Notes |
|---|---|---|
| 2026-04-23 | F1–F7 shipped | Full foundation in one session. Express + SDK + vanilla UI, ~1,100 LOC. |
| 2026-04-23 | Docs scaffolded | CLAUDE.md + architecture.md + backlog.md + handoff.md, mirroring Clawless v5 conventions. |
