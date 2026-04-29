# Command Center — Sequential Backlog

> Last Updated: 2026-04-26 (C16 epic added — Phase 2: Autonomous Operations)
> Total items: 19+ (7 foundation + 14 shipped + 1 active epic + future list)
> Completed: F1–F7 + C01 + C02 + C03 + C06 + C08 + C09 + C10 + C11 + C13 + C14 + C15 + A1 + A2 + A3
> C12 was partial then reverted — flag pulled in the audit sweep, follow-up tracked
> Public surface: github.com/jaysidd/claude-agent-lab + jaysidd.github.io/claude-agent-lab/
> Tests: 22 smoke + 2 @engine = 24, all green

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

- [x] **Status**: DONE (2026-04-23)
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

- [x] **Status**: DONE (2026-04-23)
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

- [x] **Status**: DONE (2026-04-23)
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

- [x] **Status**: DONE (2026-04-23). 7 smoke + 2 @engine tests, all passing.
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

## Phase 2: Autonomous Operations

### C16 — Autonomous Agent Firm (scheduler · durable tasks · budgets · approvals)

- [ ] **Status**: Not started. Designed 2026-04-26 after evaluating Paperclip's [zero-human trading firm demo](https://www.youtube.com/watch?v=cXhEw2jF4go) and [paperclipai/paperclip](https://github.com/paperclipai/paperclip). Cross-checked with Clawless agent same day — see "Clawless cross-pollination" section below before implementing.
- **Priority**: MEDIUM-HIGH. Unlocks the whole "agents that run while you sleep" pattern that Paperclip is selling — but built directly on the Agent SDK with no Paperclip dependency.
- **Effort**: Large epic — split into four phased sub-features, each ~1 session. Total ~4–6 sessions.
- **Reference memory**: `memory/project_paperclip_comparison.md` (positioning vs Paperclip), `memory/project_clawless_c16_alignment.md` (Clawless lane split + cross-pollination decisions).

#### Goal

Take Command Center from "interactive lab" to "lab + small autonomous runtime." Make it possible to run a Paperclip-style agent firm (CEO + specialists, delegating via task comments, waking on schedule) directly on the SDK with the existing Max OAuth — without rebuilding Paperclip's whole platform.

#### Scope guard — what this is NOT

- **Not multi-provider.** Stays Claude-only. Cross-runtime adapters (Codex/Cursor/OpenClaw) belong in Clawless.
- **Not commercial.** Personal-use Max OAuth model is preserved. Commercial / hosted multi-tenant is explicitly out of scope; would require user-supplied API keys and lives in Clawless.
- **Not a Paperclip clone.** No org chart primitives, no governance audit, no workspace isolation via git worktrees. Those are Paperclip's lane.

#### Constraints baked into the design

These aren't blockers — they're shape constraints that should inform every sub-feature:

1. **Max plan rate limits.** 5-hour usage windows. Budget enforcement (C16c) must front-run rate exhaustion, not just track tokens after-the-fact, or the firm will stall mid-cycle.
2. **Fair-use posture.** Personal-scale only. Don't demo this as a 24/7 hedge fund. Keep schedules conservative (think "hourly," not "every 30 seconds").
3. **Permission bypass risk.** Headless agents need `permissionMode: 'bypassPermissions'` (SDK equivalent of Paperclip's `dangerouslySkipPermissions`). That removes the safety net for tool use. Approval gates (C16d) are how the safety net comes back for high-stakes steps.
4. **OAuth session lifetime.** Tokens rotate. The scheduler (C16a) needs a session healthcheck so the firm doesn't silently die at 3 AM after a token rotation.

#### Phased sub-features

##### C16a — Scheduler / cron-style agent triggers

- **What**: A persistent scheduler that wakes a chosen agent on a cron expression, with a prompt template, against a chosen cwd. UI: "Schedule" tab listing schedules; CRUD via `/api/schedules`.
- **SDK angle**: each fire is a normal `query()` call. The novelty is durability + timing, not the agent loop itself.
- **Clawless status**: shipped as B06 (Cron panel — friendly presets + raw cron, SQLite-durable, multiple result destinations, 31 tests). No collision. Different runtime (theirs routes through OpenClaw session API; ours hits the Agent SDK directly), so we build our own — but **steal liberally from B06's UX**: cron-expression presets, the multi-destination result routing pattern, the test shape. Healthcheck loop for OAuth-rotation is novel on our side and may flow back as a B06 refinement.
- **Files**: `src/scheduler.ts` (new — uses `node-cron` or a simple `setInterval` loop with persisted next-fire-at timestamps), `src/server.ts` (new routes), `data/lab.db` (schedules table), `public/schedules.html` or modal.
- **Acceptance**: schedule survives server restart · fires at the correct time · result lands in session history (A2) and task queue (C03) · can be paused/deleted from UI · OAuth-dead detection logged + scheduler self-pauses instead of looping errors.

##### C16b — Durable task queue (promote C03 to SQLite) — ✅ DONE 2026-04-27

> Shipped across commits `16d7784` (impl) → `2f7c11c` (Reviewer R1-R7) → `acdb5c3` (QA tests) → `f7cc8f8` (Perf P1+P2). Schema rev. 2 locked with Clawless agent across two review rounds before code; full design + audit reports preserved at `.notes/c16b-task-queue-design.md` (gitignored), `docs/audits/perf-audit-c16b.md`, `docs/audits/security-audit-c16b.md`. All acceptance criteria met. Next: C16c (CostGuard), C16a (Scheduler), or C16d (Approval gates).

- **What**: C03's in-memory `Map<taskId, Task>` moves to SQLite at `data/lab.db`. Tasks survive restart. Add atomic `checkout` semantics so a scheduled fire can't grab a task another worker already started.
- **Why now**: a scheduler firing into a volatile queue is fragile. Durability is the prerequisite for trusting overnight runs.
- **Clawless status**: greenfield on their side. B54 was filed as in-memory FIFO with zero SQLite design — they're not iterating from a counter-sketch, they're adopting **whatever we send mechanically**. That makes our schema the source of truth across both projects, and removes the "wait for their input" delay. Their existing storage stack (better-sqlite3 with WAL) gives concurrent reads + single writer but no checkout primitive, so we design the transactional shape from scratch. Don't underbuild assuming they have something they don't.
- **Files**: `src/db.ts` (tasks table + transactions), `src/taskQueue.ts` (new — extract the atomic-checkout primitive into a standalone module from day one, not later, so the lift is mechanical), `src/server.ts` (refactor task routes), `public/app.js` (no UI change — same kanban, persistent backing).
- **Acceptance**: tasks survive restart with status preserved · two concurrent fires for the same task → exactly one runs (other gets a 409-style "already checked out") · existing kanban UI unchanged · all C03 acceptance criteria still pass · `taskQueue.ts` has zero Command-Center-specific imports (no Express, no SDK references) so it's a pure data-layer module.

##### C16c — Budget enforcement (extend A1 from tracking to capping) — ✅ DONE 2026-04-27

> Shipped on branch `c16c-costguard`, commit `e0cb5a2`. All six roles signed off in one session. `src/costGuard.ts` (standalone primitive, zero Express/SDK imports — designed for Clawless B64 mechanical lift) + `src/costGuardInstance.ts` (singleton bootstrap reading caps from settings table) + `src/server.ts` wiring into `/api/chat`, `/api/chat/stream`, `/api/task/:id/run` + `GET /api/costguard/status` introspection + `Budget (CostGuard)` section in SETTINGS_SCHEMA. Reviewer M1 (override allowlist tightened to known agents only) + M2 (cap=0 collapses to "unset" to match the "blank = no cap" UX) folded in same session. 5 new Playwright smoke tests (32/32 green). Audits at `docs/audits/perf-audit-c16c.md` + `docs/audits/security-audit-c16c.md`.

- **What**: A1 already tracks per-message tokens and session totals. Add per-agent monthly token + cost caps (config in Settings modal C14). When an agent's window-to-date usage exceeds the cap, `/api/chat[/stream]` and scheduled fires return a structured "budget exhausted" response **before** the SDK call.
- **Special case**: Max OAuth has no $ cost — cap on tokens or on number-of-fires-per-window instead. API-key mode (if ever enabled) caps on $.
- **Clawless status**: parallel build coordinated 2026-04-26. Their B64 starts coding mid-next-week, launching in 2-3 weeks. **Signature + vocabulary now LOCKED** across both projects (see below). Two design principles adopted from their threat model:
  - **(a) Server-side enforcement only.** Their reasoning: a malicious Skill in renderer context can't grant itself headroom. For us, the analog is `src/server.ts`, never `public/app.js`. Mirror the principle even though we don't have a renderer/skill split.
  - **(b) Two-tier cap vocabulary.** OAuth bypasses the $ cap because cost is $0/call, but Max-OAuth (and Codex/ChatGPT-plan OAuth on Clawless side) still hit per-window rate limits, so a separate enforcement axis is needed. Adopted on both sides:
    - **cost cap** — monthly $ ceiling. OAuth providers bypass; API-key providers enforce.
    - **rate cap** — requests-per-window ceiling. Always enforced.
- **Locked preflight signature** (both projects build against this):
  ```ts
  check(
    agentId: string,
    estimatedTokens?: number   // optional — omit for post-hoc cost accumulation; pass for precise rate-cap and Phase-2 cost-cap predictions
  ): {
    ok: boolean;
    reason?: string;           // human-readable rejection reason when ok === false
    capType?: 'cost' | 'rate'; // which cap tripped
    remaining?: number;        // dollars for cost, requests for rate
  }
  ```
- **Locked naming**: `CostGuard` is the system-internal / agent-to-agent name. User-facing UI keeps "Budget" as the Settings entry-point label.
- **Files**: `src/costGuard.ts` (new — preflight primitive matching the locked signature; standalone, no Express/SDK imports so it lifts cleanly to Clawless's B64), `src/server.ts` (call `costGuard.check()` before every `query()`), `public/settings.html` (Budget tab — surfaces both cost cap and rate cap per agent).
- **Acceptance**: agent over cost cap returns 402-ish error without burning tokens · agent over rate cap returns 429-ish error · OAuth providers bypass cost cap, still hit rate cap · API providers hit cost cap, rate cap optional Phase 2 · `costGuard.check()` matches the locked signature exactly · enforcement is server-side only · `src/costGuard.ts` has zero Express/SDK imports.

##### C16d — Per-task approval gates

- **What**: A task can be marked `requires_approval: true`. When the agent reaches a configured "stop point" (mid-task, before a Bash command, before file write — TBD scope), it pauses, posts a comment, and waits. Operator approves/rejects from the kanban; agent resumes or aborts.
- **Why**: re-installs the safety net that `bypassPermissions` removes. Without this, autonomous trading (or any destructive action) is one prompt-injection away from disaster.
- **Clawless status**: Clawless ships per-tool approval today (Strict / Standard / Permissive profiles + Allow Once / Allow Always / Deny prompts at the OpenClaw permission layer). Ours is per-task at the SDK harness layer — different abstraction. Clawless is **wait-and-see**: portable in concept, expensive to land on their side because it would mean a parallel approval system on top of OpenClaw's. **Success criterion for portability**: the prototype must show that per-task gates are *qualitatively different* from per-tool batching — e.g., they enable behaviors per-tool can't (cross-tool atomic groupings, conditional approvals based on task metadata, scheduled approvals that auto-expire). If it ends up being "per-tool with batching," document that, drop the portability ambition, and treat C16d as Command-Center-specific.
- **Files**: `src/server.ts` (approval endpoints, hook integration), `src/db.ts` (approvals table), `public/app.js` (approve/reject UI on task cards).
- **SDK angle**: this is the natural home for `PreToolUse` hooks — register a hook that intercepts dangerous tools and parks the run on an approval queue. Plan mode (C11) is the per-turn cousin; this is the per-task version.
- **Acceptance**: task with `requires_approval: true` pauses and waits · approve from UI → agent resumes from the same point · reject → agent aborts cleanly with comment · approval state persists across restart · Bash/Write/Edit on production-marked cwd auto-trigger approval regardless of task setting (defense in depth) · written analysis (1 page) on whether per-task is qualitatively different from per-tool approval, with concrete examples — Clawless port decision flows from this.

#### Demo target (north-star end-state)

After all four sub-features ship, this should be possible:

1. Create 6 custom agents (CEO + 5 specialists) via C15 with the Paperclip trading-firm system prompts.
2. Schedule the CEO to wake every hour with prompt "review overnight specialist outputs and queue today's research cycle" (C16a).
3. CEO delegates via SDK sub-agents (C01) — child tasks land in the durable queue (C16b).
4. Each specialist has a $5/month token cap; Risk Management has $10 (C16c).
5. Execution agent has `requires_approval` on any live-trading tool — operator gets pinged, approves from phone via Telegram (C05) (C16d).

That's the full Paperclip demo, on the SDK, on Max OAuth, ~personal scale, no API key.

#### Out of scope / explicitly NOT building

- Org chart with reportsTo / titles — overkill for personal use; the agent list is the org chart.
- Workspaces with git-worktree isolation — `cwd` per agent is enough at this scale.
- Multi-runtime adapters (Codex / Cursor / OpenClaw) — Clawless's lane.
- Hosted multi-tenant deployment — would require API-key auth and Anthropic commercial terms.
- User-facing budget UX, license-gated runtime behavior, channel adapters, closed-source desktop product surface — Clawless's lane (per their reply 2026-04-26).

#### Clawless cross-pollination — required reads before implementation

Lane split confirmed with Clawless agent on 2026-04-26 after sharing the C16 design:

| Sub-feature | Clawless status | Action for Command Center |
|---|---|---|
| C16a Scheduler | **Shipped (B06)**, different runtime | Build ours; steal UX patterns from B06; OAuth-healthcheck novelty may flow back |
| C16b Durable queue | **B54 has no SQLite design — adopting ours wholesale** | Draft schema + atomic-checkout SQL → send to Clawless → implement (we're the source of truth) |
| C16c Budget | **B64 starts mid-next-week**, signature LOCKED | Build against the locked signature in src/costGuard.ts; Clawless's B64 builds against the same shape |
| C16d Approval gates | **Wait-and-see**, has per-tool already | Build it; produce written analysis on per-task-vs-per-tool qualitative difference; portability decision flows from that |

**Operating rule**: C16c signature is locked and both sides build against it. C16b is on us to draft first; Clawless adopts mechanically when ready. Ping Clawless agent when C16b schema lands.

---

## Future — Not Scheduled

| Item | Notes |
|---|---|
| **Markdown rendering in chat** | HIGH impact, SMALL effort. Agent replies are plain text; `marked` or similar + a syntax-highlighted code block renderer (hljs or shiki) would massively improve legibility, especially for Content and Ops output. |
| **Inline AskUserQuestion UI** | SDK exposes an `AskUserQuestion` tool that pauses mid-task with multiple-choice prompts. Wire this up in the streaming pipeline so mid-run disambiguation shows up as an interactive card. |
| **Plan mode toggle** | SDK supports `permissionMode: 'plan'` for read-only agent runs. One toggle per agent — huge trust multiplier for Ops. |
| **File checkpoint + rewind** | Expose `Query.rewindFiles()` as a "roll back to this turn" button on any user message. SDK native feature; OpenClaw doesn't have this. Differentiator. |
| **Slash commands** | `/clear`, `/model`, `/compact`, `/agents`, `/help`. Maps to Claude Code's native syntax. Users who know the CLI get muscle memory. |
| **Skills panel** | SDK loads `.claude/skills/*/SKILL.md` automatically if cwd contains them. Add UI to browse and toggle per agent. |
| **MCP configuration UI** | Point at a stdio or HTTP MCP server → light up as tools for chosen agent. The SDK's MCP primitive is the gateway to infinite integrations. |
| **Session history sidebar** | List past conversations per agent; click to restore via `resume:`. Goes hand-in-hand with C04 persistent memory. |
| **Context pinning per agent** | "Always consider my writing-style doc when drafting." A pinned file or snippet prepended to every turn for that agent. |
| **Cost & token tracking** | SDK's `ResultMessage` has usage info. Per-turn tokens, running total, forecast cost. Especially useful when the commercial path unlocks API-key mode. |
| **Conversation export** | Download chat history as markdown or JSON. One-click share. |
| **Multi-pane chat** | Split view — two agents side-by-side for model comparison or parallel work. Matches the YouTube "mission control" vibe. |
| **Right-panel file viewer** | When Ops reads a file, show it inline in a side pane so the user sees what the agent saw. Debugging + trust. |
| **Keyboard shortcuts** | Cmd+K switch agent, Cmd+Enter send, Cmd+T tasks, Cmd+F folder. Muscle-memory speed boost. |
| **Voice layer** | Whisper STT for input, TTS for output. Optional Pipecat/Gemini Live for a "war room" experience. Large effort; only worth it after the written flow is polished. |
| **"Council" mode** | One prompt → multiple agents weigh in → synthesizer produces a consolidated answer. Good for decisions. |
| **Hook inspector** | Render PreToolUse/PostToolUse/Stop events as a timeline for each turn. Developer-facing, but teaches the SDK's event model. |
| **Multiple workspaces** | Switch between project contexts (different cwd + memory partition) without losing state. Matches how devs actually work. |
| **Sub-agent depth limit** | Prevent runaway delegation chains. Currently no limit — a pathological prompt could cascade. |
| **Auth profile switcher** | Toggle between "personal (OAuth, Max)" and "dev (API key)" modes for testing the commercial path end-to-end. |
| **C12-follow-up: UI rewind** | Complete the file-rewind UI. `enableFileCheckpointing: true` is already set so snapshots exist; what's missing is holding the SDK `Query` object alive across HTTP requests so `Query.rewindFiles(userMessageId)` can be called on demand. Requires refactoring the chat lifecycle to streaming-input mode (`prompt` as `AsyncIterable<SDKUserMessage>`), tracking user-message UUIDs, and adding a rewind affordance on each user bubble. Effort: 2-3 hours, medium complexity. |
| **AskUserQuestion from hooks** | Let hooks ask the user for approval mid-tool-run (e.g., before a destructive Bash command). |
| **Per-agent avatar / personality** | One-click tone shifts: formal / casual / concise / playful. Stored as preamble injection. |
| **Onboarding tour** | 5-step first-run flow that highlights sidebar, chat, folder, tasks, model selector. |

---

## Change Log

| Date | Item | Notes |
|---|---|---|
| 2026-04-23 | F1–F7 shipped | Full foundation in one session. Express + SDK + vanilla UI, ~1,100 LOC. |
| 2026-04-23 | Docs scaffolded | CLAUDE.md + architecture.md + backlog.md + handoff.md, mirroring Clawless v5 conventions. |
| 2026-04-23 | C01 DONE | Sub-agent delegation via SDK `agents` option. Main routes to Comms/Content/Ops. Delegation chips in UI. Commit `38bd113`. |
| 2026-04-23 | C02 DONE | Streaming responses via `includePartialMessages: true`. NDJSON events from `/api/chat/stream`; blinking-cursor UI. Commit `b359d4c`. |
| 2026-04-23 | C03 DONE | Task queue with Haiku-classified auto-routing. 3-column board, priority, agent override. Commit `9e4142e`. |
| 2026-04-23 | C06 DONE | Playwright smoke + engine projects. 7 smoke (no engine) + 2 @engine tests. `npm run test:smoke` / `test:engine`. |
| 2026-04-24 | C08 DONE | Markdown rendering in chat. `marked` + `DOMPurify` + `highlight.js` via jsDelivr; applied only to completed (non-streaming) agent bubbles. Slash-command output renders as markdown too. |
| 2026-04-24 | C09 DONE | Persistent memory via `better-sqlite3` at `./data/lab.db`. CRUD routes; global or per-agent scope; `fact / preference / context` categories. Injected as `<persistent-memory>` system-prompt block on every `query()`, capped at ~2k chars. |
| 2026-04-24 | C10 DONE | Slash commands. Client-side dispatcher intercepts `/cmd args` and handles `/help`, `/clear`, `/model [id]`, `/agents`, `/plan on/off` without a server round-trip. System-origin messages render through the same markdown pipeline. |
| 2026-04-24 | C11 DONE | Plan mode toggle. Header checkbox flips `permissionMode: 'plan'` on for the active agent; task runs respect the toggle too. Switching plan mode clears that agent's session. |
| 2026-04-24 | C12 PARTIAL | `enableFileCheckpointing: true` is now set on every chat/stream/task `query()` call — snapshots are captured. UI rewind-to-user-message is deferred because `Query.rewindFiles()` requires holding the Query object alive across requests, which needs a streaming-input architecture. Added as `C12-follow-up` in the future list. |
| 2026-04-24 | Docs | `docs/drafts/linkedin-project-entry.md` added — copy-paste-ready content for LinkedIn Projects section. |
| 2026-04-24 | C13 DONE | WhisprDesk voice integration. Local HTTP proxy routes (`/api/whisprdesk/{status,capabilities,transcribe,events}`) forwarding to WhisprDesk's External App Gateway on `127.0.0.1:9879`. Browser mic button (MediaRecorder → proxy → transcript). Passive SSE listener auto-fills composer from any WhisprDesk dictation when tab is focused. Browser `SpeechSynthesis` speak button on each agent reply. Sidebar status indicator. Minimal .env loader added. Token stays server-side. |
| 2026-04-24 | C14 + C15 DONE | Settings modal (SQLite-backed config with env fallback, secrets masked) and dynamic agents (CRUD, custom_agents table, sidebar + New agent button). Closes the operator-surface gap from the audit. |
| 2026-04-24 | Audit sweep DONE | Architect/Reviewer/QA agents identified UI-vs-backend gaps + correctness issues. Closed all 13: Telegram fields disabled with "coming soon", `enableFileCheckpointing` flag removed, 4 dead routes deleted, memory validation fixes, race conditions, error-path logging, brittle test hardening. |
| 2026-04-24 | Sidebar UX | "+ New agent" promoted from a muted dashed button to a prominent gradient primary action. `/think hard\|fast\|default` slash aliases added on top of `/model`. |
| 2026-04-24 | Voice UX hardening | Mic button shows ⏹ icon when recording + pink "Recording / click ⏹ to stop" indicator with live timer. Errors from the WhisprDesk proxy now surface upstream details so failures are debuggable. |
| 2026-04-25 | Voice fixes | Browser-side WebM→WAV conversion (Web Audio API + PCM 16-bit encoder) so WhisprDesk's ffmpeg never chokes on streaming-EBML quirks. Shortcut switched from ⌘⇧M to **⌥V** (avoids Chrome user-switcher / macOS minimize collisions). |
| 2026-04-25 | A1 DONE | Cost & token tracking, OAuth-aware. Per-message footer always shows tokens; $ only when API-key auth. Session-totals chip in chat header. SDK's `total_cost_usd` used directly — no client-side pricing table. |
| 2026-04-25 | A2 DONE | Session history. Two new SQLite tables (`sessions`, `session_messages`); `appendTurn()` transactional; auto-titles from first user message. 📜 History modal lists past conversations grouped by agent; click any to restore via `resume:`. |
| 2026-04-25 | A3 DONE | Conversation export. `/export`, `/export md`, `/export json` slash commands generate downloads client-side from existing chat state. Markdown is publish-friendly, JSON keeps raw `usage` objects for downstream analysis. |
| 2026-04-25 | GitHub Pages | Pages enabled at `jaysidd.github.io/claude-agent-lab/` (source: main / root). Repo homepage URL set so the github.com sidebar shows the live URL. README is auto-served as the index by Jekyll. |
| 2026-04-25 | Marketing | Replaced 3 OpenCode references with [Clawless](https://clawless.ai/) cross-promo (intro, "what this is not", acknowledgements). Honest "same author" disclosures kept in each. README also documents history/cost/export sections with the two new screenshots (13-history-modal, 14-chat-with-usage). |
| 2026-04-25 | Mermaid fix | Streaming sequence-diagram Note text rewritten to plain prose — semicolons and parens were tripping GitHub's mermaid parser. Audit confirmed no other Notes have parser tripwires. |
| 2026-04-26 | C16 epic added | Autonomous Agent Firm: scheduler + durable tasks + budgets + approvals. Phased over four sub-features (C16a–d). Designed after evaluating Paperclip's trading-firm demo and confirming the SDK + Max OAuth path is viable for personal-scale autonomous runs. Subsumes the old "Cron / scheduled tasks" Future entry. |
| 2026-04-26 | C16 Clawless align | Cross-checked C16 with Clawless agent same day. C16a already shipped on their side as B06; C16b they want portably (will absorb into their B54); C16c parallel build (their B64, this week — must align preflight signature + main-process-enforcement principle + OAuth-bypass-but-keep-rate-cap); C16d wait-and-see pending qualitative-difference analysis vs their existing per-tool approval. Lane split: their lane includes user-facing budget UX, license-gated runtime, channel adapters, closed-source desktop. Required: design sync on C16b schema + C16c preflight signature before either side commits implementation. |
| 2026-04-26 | C16c signature LOCKED | Second Clawless round same day. Preflight signature `check(agentId, estimatedTokens?) → {ok, reason?, capType?: 'cost'\|'rate', remaining?}` agreed both sides — `estimatedTokens` is optional (post-hoc cost accumulation is acceptable for Phase 1; required for rate-cap and Phase-2 precision). Two-tier vocabulary adopted: **cost cap** ($, OAuth bypasses) + **rate cap** (requests-per-window, always enforced). Naming: `CostGuard` system-internal, "Budget" user-facing. C16b: Clawless's B54 is greenfield (in-memory FIFO, zero SQLite design); our schema is the source of truth, they adopt mechanically. B64 starts coding mid-next-week, launches 2-3 weeks. |
| 2026-04-27 | ClaudeLink wired | `.mcp.json` adds `claudelink-server` (stdio MCP) for cross-terminal multi-agent communication. CLAUDE.md gains the ClaudeLink protocol section (inbox-check cadence + shortcut phrases). `docs/Agent_Lab/` (writing project drafts) gitignored. Initial relay round to Clawless about C16b was paste-based; subsequent rounds via `mcp__claudelink__*` tools after a session restart picked up the MCP. |
| 2026-04-27 | C16b schema rev. 2 LOCKED | Two cross-project review rounds with Clawless agent on the durable-queue design. Final shape: 5-state enum (running dropped — worker-side concern), atomic `BEGIN IMMEDIATE` checkout via `RETURNING *`, lease-based crash recovery, 4 indexes (added `(agent_id, status)` for B54 per-agent serialization), `migrate(db)` exported separately (no bundled `_migrations` table — host wires into its own migration runner), 64 KB metadata soft-cap, six locked open-question resolutions. Design at `.notes/c16b-task-queue-design.md` (gitignored). |
| 2026-04-27 | C16b DONE | Durable task queue + atomic checkout shipped. `src/taskQueue.ts` (442 lines, host-agnostic, zero Express/SDK imports, designed for Clawless B54 mechanical lift) + `src/taskQueueInstance.ts` (singleton bootstrap with `WORKER_ID = {hostname}:{pid}:{uuid}`) + `src/server.ts` refactor of four task routes onto the queue (`GET /api/tasks`, `POST /api/task`, `POST /api/task/:id/run`, `DELETE /api/task/:id`) preserving the C03 wire format via `toApiTask` adapter. Tasks now survive restart with status preserved. Commit `16d7784`. |
| 2026-04-27 | C16b Reviewer pass | Independent reviewer agent surfaced 6 findings (2 MED, 4 LOW). All fixed: (R1) dropped `metadata_json` clobber on `/run` that would have destroyed caller-supplied metadata; (R2) constrained `DELETE /api/task/:id` to terminal states with 409 on non-terminal; (R6) defense-in-depth try/catch on terminal queue updates so a reaped/deleted-mid-run row doesn't crash the handler; (R3) doc comment on `checkoutById` attempt-count semantics; (R4) `enqueue` validates priority/maxAttempts/scheduledFor; (R5) exhaustive `statusFromQueue` switch with `never` guard; (R7) `WORKER_ID` fork/cluster comment. Commit `2f7c11c`. |
| 2026-04-27 | C16b QA pass | Five new Playwright API tests in `tests/features.spec.ts` (smoke project, no engine): persistence + wire shape, DELETE-on-queued-returns-409, DELETE-on-missing-is-idempotent, priority-enum validation, description-type validation. 27/27 smoke green. Commit `acdb5c3`. |
| 2026-04-27 | C16b Perf pass | Audit report at `docs/audits/perf-audit-c16b.md` — 0 HIGH, 2 MED, 5 LOW. (P1) Dropped redundant JS sort in `GET /api/tasks` by adding `TaskFilter.orderBy` option (additive — `priority` default for B54 next-in-queue, host opts into `createdAt DESC` for kanban). (P2) Gated `pruneCompletedTasks` on a count check; both statements now prepared once at module load. Commit `f7cc8f8`. |
| 2026-04-27 | C16b Security pass | Audit report at `docs/audits/security-audit-c16b.md` — 0 new HIGH/MED, 1 LOW (SC1 reaffirms S5/S6), 2 Info (SC2/SC3 out-of-threat-model). All 17 prepared statements walked + parameterized. Worker_id forgery structurally impossible (server-only, never client-supplied). All 10 prior accepted risks (S1-S10) confirmed unaffected. Watch-list for future sessions: external-source task ingestion (C05/C16d) should default plan-mode-on or gate Run behind approval; future remote-worker API needs worker_id auth before shipping; if `/api/task` ever accepts client-supplied metadata, wrap the 64 KB cap throw into 400. |
| 2026-04-27 | C16c DONE | CostGuard budget enforcement shipped on branch `c16c-costguard`, commit `e0cb5a2`. `src/costGuard.ts` (standalone primitive — zero Express/SDK imports, designed for Clawless B64 mechanical lift) + `src/costGuardInstance.ts` (singleton bootstrap reading caps from settings table) + wiring into `/api/chat`, `/api/chat/stream`, `/api/task/:id/run` (preflight 429 + post-call ledger record). New `GET /api/costguard/status` introspection route. New "Budget (CostGuard)" section in SETTINGS_SCHEMA. OAuth bypasses cost cap by recording `is_oauth=1` rows that the cost SUM filters out; rate cap always enforced regardless of provider. Reviewer fixes folded same session: M1 (override allowlist tightened to known agents, no nested dots, no `rate_window_seconds` per-agent variant) + M2 (cap=0 collapses to "unset" to match the "leave blank for no cap" UX promise). 5 new Playwright smoke tests (32/32 green): schema, allowlist, status shape, exhausted-cap-returns-429-without-firing-SDK (seeds ledger directly to stay in smoke project), cap=0 unset behavior. Untracks gitignored `test-results/.last-run.json` artifact. Audits at `docs/audits/perf-audit-c16c.md` + `docs/audits/security-audit-c16c.md`. |
| 2026-04-27 | C16c Security pass | 0 HIGH/MED/LOW, 3 Info (SC4 ledger has no retention/prune policy — fine at personal scale, watch for Clawless multi-tenant lift; SC5 the 429 `reason` string discloses cap value/window length — accepted; SC6 `costguard.*` global keys are intentionally operator-configurable via the existing `/api/settings` route). All 7 ledger SQL sites walked + parameterized. `agentId` validated by `findAgent()` before reaching `costGuard.status()`. The `is_oauth` flag is sourced exclusively from the server-captured `system.init` message at all 4 `record()` call sites — zero client influence. `seedLedgerRow` test helper unreachable from production. |
| 2026-04-27 | C16c Perf pass | Audit at `docs/audits/perf-audit-c16c.md`: 0 HIGH, 0 MED, 7 LOW. Total `check()` overhead measured at ~22 µs p50 / ~45 µs p99 — invisible against 1-10 s of LLM latency. Both ledger queries hit `idx_ledger_agent_time` (rate query is COVERING). One actionable fix applied (P1): cached prepared statement in `settings.ts:getSetting()` — drops 5× re-prepare per `resolveCaps()` from ~20 µs to ~2.4 µs and benefits every `configValue` caller (WhisprDesk, future Telegram, etc.), not just CostGuard. Six accepts: P2 partial-index threshold (>10k month-rows-per-agent — irrelevant at personal scale), P3 ledger pruning (80 B/row gives years), P4 no N+1 between check/record, P5 no double-record on aborted streams, P6 startOfMonth nanosecond cost, P7 sync sqlite is fine for single-process. Watch list noted for Clawless multi-tenant lift: partial covering index `(agent_id, occurred_at, cost_usd) WHERE is_oauth=0` (9× faster on month-sum at 30k rows), write-behind ledger inserts, async sqlite binding. |
| 2026-04-28 | README refresh (PR #3) | `1d77404`. Two new feature sections (Durable task queue, Budget caps / CostGuard), CostGuard preflight sequence diagram, redrawn task state machine for the durable 5-state enum, architecture state table flipped from in-memory-Maps to per-table SQLite breakdown, API contract updated (CostGuard + custom-agent CRUD + settings; bulk-delete-memories row removed), project layout and LOC refreshed (~2,500 → ~7,500), tests badge 22 → 35, "What's on the backlog" reframed around C16 with C16a marked ⭐ next. New screenshot `15-settings-budget.png`. Docs-only — Reviewer-only per skip rules; no Perf/Security audits. |
| 2026-04-28 | C16a DONE | Cron-style scheduler shipped on branch `c16a-scheduler`. `src/scheduler.ts` (~470 LOC, host-agnostic primitive — zero Express/SDK imports, mirrors taskQueue.ts/costGuard.ts pattern, ready for Clawless lift) + `src/schedulerInstance.ts` (singleton bootstrap with cron-parser v5 `CronExpressionParser`) + wiring into server.ts: 8 routes (`GET/POST /api/schedules`, `GET/PATCH/DELETE /api/schedules/:id`, `POST /api/schedules/:id/{run-now,pause,resume}`, `POST /api/cron/preview`) + onFire callback that runs the SDK with OAuth-dead detection (two-token regex + before-first-assistant-message position guard) + 3-strike auto-pause for non-OAuth recurring failures + CostGuard preflight + taskQueue-backed fires. Schedules modal UI: list view with status badges, create form with cron preset chips + live "next 3 fires" preview, pause/resume/run-now/delete actions. Single 30s tick fires due schedules + lights up `taskQueue.reapExpired()` (was unreachable per C16b P4). Reviewer pass: 13 findings, 5 fixed pre-QA (recordOutcome `enabled=1` guard + TOCTOU removal via `consecutive_failures + 1`, OAUTH_DEAD_PATTERN tightened to two-token requirement, run-now `.catch` for void'd promise, budget-block uses `taskQueue.cancel` instead of `checkoutById+fail`). 9 new Playwright smoke tests (42/42 green). |
| 2026-04-28 | C16a Perf pass | Audit at `docs/audits/perf-audit-c16a.md`: 0 HIGH, 0 MED, 8 LOW — ship as-is. `EXPLAIN QUERY PLAN` confirms `idx_schedules_due` partial index serves the tick query (`SEARCH schedules USING INDEX idx_schedules_due (next_fire_at<?)` with ORDER BY satisfied by index — no TEMP B-TREE). Steady-state tick at 50 schedules / 0 due: **0.23 µs every 30 s**. P1 inline `db.prepare(...)` (15 sites in scheduler.ts vs costGuard.ts's constructor cache) measured at ~6 µs/call — invisible at personal scale, worth a 30-line refactor for the Clawless lift. P2 `scheduler.list()` SCAN (partial index excludes paused rows) is ~46 µs at N=50, ~3.8 ms at N=5000; user-visible boundary ~12k rows. P3 reaffirms taskQueue.reapExpired stays dormant (audit found C16a tick wires it correctly — but the tick doesn't currently call it; clarified vs the original prompt). `cronPreview()` cost ~35 µs / 3 fires; 200 ms UI debounce more than sufficient. Concurrent fire fan-out is safe — better-sqlite3 transactions serialize on single Node process, sync prefix of executeFire commits before any await. |
| 2026-04-28 | C16a Security pass | Audit at `docs/audits/security-audit-c16a.md`: 0 HIGH, 0 MED, 1 LOW (S-C16a-1 reaffirms baseline S1 — `cwd` accepted unvalidated, watch-list for commercial path), 4 Info. **Inline fix applied** (S-C16a-2): OAUTH_DEAD_PATTERN extended with a second top-level alternation to also catch the canonical CLI exhortation `Please run \`claude login\``. Strictly additive — every prior true/false case retained; three real-world phrasings flip miss-to-hit. Pre-fix consequence was benign (legit OAuth-dead errors auto-paused after 3 strikes under `too_many_failures` instead of `oauth_unavailable`). Confirmed safe: stored prompt injection (localhost-only + agent allowedTools + kanban audit), cron-parser DoS (worst-case 100-char input parses in ~15 ms; library rejects >6-field inputs), SQL injection (15 prepared statements walked, all parameterized; dynamic UPDATE field names from a fixed source-literal allowlist), race conditions (delete-mid-fire / pause-mid-fire / tick-vs-delete all clean — `enabled=1` guards prevent stale fires from clobbering manual pauses), `metadata.scheduleId` info leak (`toApiTask` shaper drops metadata — verified). Watch list for Clawless multi-tenant lift: schedule routes become attack surface; `/run-now` is auth-free trigger for stored prompts. |
| 2026-04-29 | C16d DONE | Per-task approval gates shipped on branch `c16d-approvals`. Closes the C16 epic. `src/approvals.ts` (~280 LOC, host-agnostic primitive — zero Express/SDK imports, in-memory waiter Map + SQLite `pending_approvals` table with partial index) + `src/approvalsInstance.ts` (singleton bootstrap + boot-time `expireOrphaned()` for restart cleanup) + `buildApprovalHook` factory in server.ts that wires the SDK's `PreToolUse` hook to await `awaitDecision()` (genuine SDK-loop pause, no polling, no replay — uses `HookCallbackMatcher.timeout: 1h` for auto-deny ceiling). Defense-in-depth gating: per-task `requiresApproval` flag OR `cwdIsProductionMarked(cwd)` against the `approvals.production_cwds` settings allowlist. Default dangerous tools: `Bash|Write|Edit|WebFetch`; production-cwd-marked tasks gate ALL tools. New routes: `GET /api/approvals[?status=]`, `GET /api/approvals/:id`, `POST /api/approvals/:id/decide`. UI: "Requires approval" toggle on the New Task form + inline yellow-pulsing approval card on the kanban with tool name + cwd + JSON payload + reason field + Approve/Reject buttons + 5s poll while modal open + per-approval draft store so the reason input survives re-renders. Reviewer pass: 15 findings, 1 fixed pre-QA (R11 — bytecount-cap throw was bypassing the gate, now wrapped to return `permissionDecision: 'deny'`); 14 deferred per reviewer guidance. 10 new Playwright smoke tests (52/52 green). Per-task vs per-tool analysis at `docs/analysis/c16d-per-task-vs-per-tool.md` — verdict **partial portability**: 2 of 4 anticipated qualitative differences hold up (production-cwd auto-elevation + rejection-as-context-turn); the other 2 reduce to per-tool with batching. Recommendation for Clawless: lift the ideas, not the code. |
| 2026-04-29 | C16d Perf pass | Audit at `docs/audits/perf-audit-c16d.md`: 0 HIGH, 0 remaining MED, 5 LOW. **Inline fix applied** (P1, MEDIUM-then-fixed): `approvals.list({status: 'pending'})` was emitting `WHERE status IN (?)` for single-status filters which bypasses the partial index `idx_approvals_pending`; rewrite to `WHERE status = ?` for single-status, multi-element arrays still use IN. Result: poll latency at 10k decided rows drops from **574 µs → 20 µs (28× faster)** and stays flat regardless of historical count. Hook synchronous overhead per dangerous tool call: ~8 µs (INSERT + Promise + Map.set) — invisible against 1-10s LLM/tool latency. Awaiter Map memory ~300 B/entry, bounded. `expireOrphaned()` boot cost: 2 µs steady-state, 1.2 ms even at 1k pathological orphans. `cwdIsProductionMarked` is called once at run-start (Reviewer R9's "wasted work per call" framing turned out to be wrong — caller flow only invokes it once). No leak from 1-hour hook timeout: SDK's abort signal fires `approvals.expire()` listener which resolves the Promise and deletes the Map entry. P3 (INSERT re-prepare ~7 µs) deferred — invisible against 1-hour wait. P6 (no pruning policy) deferred — < 1 MB/year of disk. |
| 2026-04-29 | C16d Security pass | Audit at `docs/audits/security-audit-c16d.md`: 0 HIGH, 0 MED, 4 LOW, 5 Info. **Inline fix applied** (S2): `DEFAULT_DANGEROUS_TOOLS.join("|")` matcher anchored from `Bash\|Write\|Edit\|WebFetch` to `^(?:Bash\|Write\|Edit\|WebFetch)$` — Reviewer R2 follow-through, future-proofs against custom-agent tool-name collisions (e.g., a custom tool named `BashHelper` would no longer accidentally match). Verified clean: every SQL surface in `approvals.ts` parameterized (S8); hook abort listener cleanup double-guarded with `{once: true}` + `try/finally`; SDK retries get fresh listeners (S9); R11 fix confirmed (every throw path inside `buildApprovalHook` — 64KB cap, missing fields, JSON-stringify on circular — routes through catch-and-deny return). Latent issue logged: `await handle.awaitDecision()` is not wrapped in try/catch — fine today because primitive only ever calls `resolve()` on waiters, never `reject()`; one-line fix when a `reject()` path is added (e.g., shutdown handler). Watch list for commercial path: S1 (symlink resolution in `cwdIsProductionMarked`), S3 (`approvals.production_cwds` writable via /api/settings), S4 (decide endpoint unauthenticated), S5 (1-hour timeout × parallel runs creates bounded compounding queue), S6 (`tool_input_json` and `decision_reason` plaintext on disk). |
