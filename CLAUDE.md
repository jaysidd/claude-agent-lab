# Command Center — Claude Code Project Instructions

## What Is This Project

Command Center is a **personal learning lab + mini "command center" dashboard** built directly on the official Anthropic [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). Not a wrapper. The SDK *is* the engine.

It pairs a small Express server with a vanilla-JS browser UI to expose the SDK's agent loop in the most visible, hackable way possible. Multi-agent sidebar, per-agent system prompts + tools + models, session persistence, folder selection, `@file` autocomplete. Built in ~15 minutes on 2026-04-23 while evaluating whether the SDK could replace a months-old OpenClaw-based project (Clawless). Verdict: **different problem, different tool** — SDK is Claude-only, OpenClaw is multi-provider. Command Center is the Claude-native side of that comparison, and a sandbox for exploring what the SDK makes easy.

### Authentication model (critical)

- **Personal use, local only.** Runs against the Claude Code CLI's Max subscription via OAuth — no `ANTHROPIC_API_KEY` needed.
- **Not a shippable product in its current form.** Anthropic's ToS forbids third-party products from offering claude.ai / Pro / Max login to end users. Any commercial version would require switching to user-supplied `ANTHROPIC_API_KEY` and a per-provider auth model (see Clawless, which does this properly).
- If you change this: set `ANTHROPIC_API_KEY` in the shell, the SDK picks it up automatically.

---

## Architecture (Single-Server)

```
Browser (vanilla JS)  →  Express server (port 3333)  →  Claude Agent SDK  →  Claude Code CLI
      │                         │                              │                    │
      │                  /api/* routes                   query({...})         OAuth session
      │                         │                              │
      │                  in-memory state                Max plan subscription
      │                  (sessions, cwd, overrides)
```

**One process, one port.** No electron, no IPC bridge, no separate renderer build. `tsx` runs TypeScript directly. Static files serve from `/public`.

**State model**:
- `sessionByAgent: Map<agentId, sessionId>` — SDK session IDs per agent (`resume:` threads conversations)
- `modelOverride: Map<agentId, string>` — per-agent model override vs `agents.ts` default
- `currentCwd: string` — working directory passed to every `query()` call
- Everything in-memory. Restart = fresh state. Persistent memory is on the backlog (C04).

### API surface

| Route | Method | Purpose |
|---|---|---|
| `/api/agents` | GET | List agents with model + defaultModel |
| `/api/models` | GET | Available models (Opus/Sonnet/Haiku) |
| `/api/model/:agentId` | POST | Override model for an agent (empty body = reset to default) |
| `/api/cwd` | GET/POST | Read/set working directory |
| `/api/browse?path=` | GET | List subdirectories (folder picker) |
| `/api/files?q=` | GET | List files in cwd (`@file` autocomplete) |
| `/api/chat` | POST | `{agentId, message}` → `{reply, toolUses, model, apiKeySource, cwd}` |
| `/api/reset/:agentId` | POST | Clear an agent's session |

---

## Development Team — Six Roles, Fixed Order

Mirrors the Clawless v5 process. Every medium-or-larger task runs through all six roles in sequence. No task is complete until every role signs off.

```
Architect → Developer → Reviewer → QA → Performance Analyst → Security Analyst
```

| Role | Fires | Job |
|------|-------|-----|
| **Architect** | Before any code | Approves design, flags architectural risks, Go/No-Go |
| **Developer** | After Architect Go | Implements exactly the approved design |
| **Reviewer** | After build passes | Audits code correctness from actual source files |
| **QA** | After Reviewer sign-off | Writes + runs Playwright tests for everything delivered |
| **Performance Analyst** | After QA sign-off | Profiles hot paths, bundle size, latency, dead code |
| **Security Analyst** | After Performance sign-off | Threat model; surface risks to the user explicitly |

### Architect checks (Command Center specific)
- Does it stay on the SDK — not wrap OpenClaw/OpenAI/etc.? (Multi-provider work belongs in Clawless, not here.)
- Does it respect the SDK's mental model (agent loop, tool use, sessions), or fight it?
- Is it the minimum that teaches the concept, or is it over-engineered?
- Simpler approach that reuses what the SDK gives us for free?

### Reviewer checks
- All new routes return structured JSON; errors carry `{error: string}` with appropriate status
- `query()` options are complete (`allowedTools`, `systemPrompt`, `cwd`, `resume`, `model`) and type-safe
- Session IDs captured from init message, not guessed or invented
- UI state changes are functional (no direct DOM scraping for app state)
- Frontend gracefully handles agent errors (shows message in chat, doesn't freeze UI)

### QA test categories (Playwright, see `/tests`)
Smoke · Agent chat · Session persistence · Model switching · Folder scoping · `@file` autocomplete · Error states

Every user-visible feature gets at least one Playwright test.

### Performance checks
- Streaming latency (once C02 lands): time-to-first-token target < 3s for Sonnet, < 5s for Opus
- No blocking work on main UI thread; all SDK calls async
- Session resume doesn't balloon the context window (track usage from result messages)
- Vanilla JS stays vanilla — no framework bloat creeping in

### Security checks
- Path traversal on `/api/cwd`, `/api/browse`, `/api/files` — resolved paths must stay under the user's control
- Prompt injection: tool outputs (Read on arbitrary files) can attempt to hijack the agent; don't auto-escalate tool allowlists based on model output
- No secrets logged to console or returned in API responses
- If/when API key support lands (C?? for commercial path): keys never round-trip through the renderer

### Skip rules — by task size
- **Cosmetic** (CSS tweak, copy change, docs-only): Reviewer only.
- **Small** (single-file logic fix, no new surface): Architect + Developer + Reviewer. Ask before skipping QA.
- **Medium-or-larger** (any new route, any new user surface, refactor across files): all six, no skips.
- Reviewer is **never** skipped.
- When in doubt, ask.

### End-of-session pattern
When wrapping a session, spawn Performance Analyst and Security Analyst as background agents (`run_in_background: true`). Their reports land in `docs/audits/` (public) for reference, and in `.notes/handoff.md` (private) for next-session triage.

---

## Key Rules

### What we ARE
- A direct Claude Agent SDK app. No abstraction layer between us and the SDK.
- A learning lab *and* a mini product. Both purposes co-exist on the same codebase.
- Claude-only. Opus / Sonnet / Haiku, via the official SDK.

### What we are NOT
- **Not multi-provider.** If you want OpenAI/OpenRouter/Ollama, that's Clawless territory (OpenClaw engine). Command Center stays Claude-only by design.
- Not a re-implementation of Claude Code. The SDK *is* Claude Code's loop exposed as a library.
- Not commercial in its current auth form. Max-plan OAuth is personal-only.

### Code rules
- **Package manager**: `npm` (not bun). Small project, no build pipeline, no reason to diverge.
- **Runtime**: `tsx` for TypeScript directly. No compile step.
- **Style**: minimal, functional, vanilla. No React on the frontend — keep the SDK concepts visible.
- **SDK options**: always pass `allowedTools`, `systemPrompt`, `model`, `cwd`. Pass `resume` when continuing a conversation.
- **Session capture**: read `session_id` off the first `system.init` message in the SDK message stream.
- **Tool use**: forward `tool_use` blocks to the UI for visible trace — the "thinking" should be legible.

### Commit conventions
- **Commit early and often.** After every successful feature that passes a smoke test, commit.
- Never batch unrelated changes.
- End every commit with `Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`.

---

## Documentation Update Protocol

After any major change, update before the session ends:

1. **`.notes/handoff.md`** *(private, gitignored)* — current state, what changed this session, what's next
2. **`backlog.md`** — move completed items to Done, add new items discovered during work
3. **`architecture.md`** — new design decisions, updated file map
4. **`docs/case-studies/`** *(public, when useful)* — case studies for patterns discovered, iteration loops, decisions worth documenting
5. **`.notes/drafts/`** *(private, gitignored, when useful)* — LinkedIn / blog drafts per session. Style: measured optimism, personal reflection, ends with a question.

### What's private vs public
The `.notes/` directory is gitignored. Anything in there stays on your disk
and never lands on the public GitHub repo — use it for session handoffs,
draft posts, and internal thinking. Everything else (docs/, backlog.md,
architecture.md, CLAUDE.md, README.md, source, tests, screenshots) is public.

### What counts as a "major change"
- New API route or user-facing surface
- New SDK option wired in (hooks, sub-agents, MCP, etc.)
- Refactor affecting multiple files
- New dependency

---

## Dev Server Protocol

After any change to `src/server.ts` or `src/agents.ts`, restart automatically:

```bash
lsof -ti:3333 | xargs kill -9 2>/dev/null
cd "~/Desktop/claude-agent-lab" && npm run serve &
```

Frontend changes (`public/*.html|css|js`) need only a browser reload — no server restart.

Tell the user: "Restarted the server — reload the browser to pick up changes."

---

## Launching the App

```bash
cd "~/Desktop/claude-agent-lab"
npm install          # if node_modules missing
npm run serve        # starts Express on :3333
open http://localhost:3333/
```

Prereqs:
- Node 20+ (tested on 24.14.1)
- `claude` CLI installed and logged in (Max plan OAuth)
- `ANTHROPIC_API_KEY` NOT set in shell (unset lets OAuth take over)

---

## Project Structure

```
claude-agent-lab/
├── src/
│   ├── agents.ts        # Agent definitions (systemPrompt, tools, model)
│   ├── server.ts        # Express + SDK glue (~180 LOC)
│   └── hello.ts         # First smoke test — URL-summarizer agent
├── public/
│   ├── index.html       # Dashboard markup
│   ├── style.css        # Dark command-center theme
│   └── app.js           # Frontend logic (vanilla JS)
├── tests/               # Playwright tests (added in C06)
├── docs/
│   ├── case-studies/    # Patterns, iterations, decisions
│   └── drafts/          # LinkedIn drafts per session
├── CLAUDE.md            # This file
├── architecture.md      # Technical architecture
├── backlog.md           # Sequential backlog (C##)
├── .notes/              # Private, gitignored — handoff + drafts
│   ├── handoff.md       # Session-to-session continuity (private)
│   └── drafts/          # LinkedIn / blog drafts (private)
├── package.json
├── tsconfig.json
└── .gitignore
```

---

## Documentation Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | This file — project rules and quick reference |
| `backlog.md` | Feature backlog prioritized by importance (C##) |
| `architecture.md` | Technical architecture and design decisions |
| `.notes/handoff.md` | Session handoff notes for continuity (private, gitignored) |

---

## User Preferences

- Same six-role dev-team flow as Clawless.
- Package manager: `npm` (not bun — small project, no build pipeline).
- Commits: early and often, never batch, with `Co-Authored-By` footer.
- Don't reinvent what the SDK gives for free — use its `agents`, `hooks`, `resume`, `cwd`, `model`, etc.
- **Don't confuse this with Clawless.** Clawless is the commercial multi-provider product; Command Center is the Claude-only personal lab. Different goals, different constraints.

---

## Current Status (as of 2026-04-25)

### Public surface
- **Repo**: https://github.com/jaysidd/claude-agent-lab (public, MIT)
- **Pages site**: https://jaysidd.github.io/claude-agent-lab/ (auto-rebuilds on push)
- **Tests**: 22 smoke (offline) + 2 @engine (real SDK) = 24 total, all green
- **LOC**: ~2,500 hand-written across `src/`, `public/`, `tests/`, `scripts/`

### Foundation (all DONE)
F1–F7: scaffold, multi-agent sidebar, per-agent prompts/tools/sessions, folder picker, `@file` autocomplete, model selector, auth+model footer.

### Features shipped (all DONE)
| # | Feature | Notes |
|---|---|---|
| C01 | Sub-agent delegation | Main routes via SDK `agents:` option; 🤝 chips |
| C02 | Token-by-token streaming | NDJSON; `includePartialMessages: true` |
| C03 | Task queue + Haiku auto-routing | Three-column board, classifier in `server.ts` |
| C06 | Playwright smoke + engine | Two projects in playwright.config.ts |
| C08 | Markdown rendering | marked + DOMPurify + highlight.js via jsDelivr |
| C09 | Persistent memory (SQLite) | better-sqlite3 at `data/lab.db`; injected as `<persistent-memory>` |
| C10 | Slash commands + autocomplete popover | `/help`, `/clear`, `/agents`, `/model`, `/think`, `/plan`, `/export` |
| C11 | Plan mode | Per-agent `permissionMode: 'plan'` toggle |
| C12 | (file checkpointing — flag pulled in audit; UI deferred) | See backlog `C12-follow-up` |
| C13 | WhisprDesk voice | Mic + SSE listener + speak button; WAV conversion in browser; ⌥V shortcut |
| C14 | Settings modal | SQLite-backed; secrets masked; env-var fallback |
| C15 | Custom agents (CRUD) | `+ New agent`; SQLite-backed; built-ins read-only |
| A1 | Cost & token tracking | OAuth-aware (no $ for Max plan); per-message + session totals |
| A2 | Session history + restore | Conversations persist; click any past session to resume |
| A3 | Conversation export | `/export md` and `/export json` slash commands |

### Operational state
- Server: `npm run serve` on `127.0.0.1:3333` (LAN-isolated)
- Launcher: `~/Desktop/Command Center.command` — auto-finds the project via candidate list (works whether it's at `~/Desktop/claude-agent-lab` or `~/Documents/projects/claude-agent-lab` etc.)
- WhisprDesk: integrated via Settings modal, model "base" downloaded, ⌥V toggles recording
- Pages: auto-rebuilds within ~60 s of any push to `main`

### Top backlog candidates (next session)
- **C05 Telegram bridge** — Settings fields exist with "coming soon" badge; needs the listener code
- **C12-follow-up File rewind UI** — needs streaming-input refactor to keep Query alive
- **Keyboard shortcuts hub** — Cmd+K agent switcher, Cmd+T tasks, Cmd+; settings
- **Context pinning per agent** — pin a file/snippet that's auto-prepended each turn
- **MCP configuration UI** — let users add stdio/HTTP MCP servers per agent
- **Skills panel** — UI for `.claude/skills/*/SKILL.md` in cwd
- **Sub-agent depth limit** — `maxTurns` safety rail

### Where to look first when picking up cold
1. **`.notes/handoff.md`** — the most recent session-end notes (private, gitignored)
2. **`backlog.md`** — full sequential backlog with change log at the bottom
3. **`architecture.md`** — module-by-module file map + design decisions
4. **`git log --oneline | head -20`** — last ~20 commits for the recent shape of changes

## ClaudeLink - Autonomous Agent Communication

You are part of a multi-agent team. Other agents may be running in separate terminals and can send you messages at any time via ClaudeLink.

### Automatic Inbox Checking

- **BEFORE starting any task**: Check your inbox using `read_inbox` first
- **AFTER completing any task**: Check your inbox again using `read_inbox`
- If you receive a message, acknowledge it and act on it before moving on
- If a message requires you to change your current work, do so immediately
- If a message is from another agent asking for information, respond using `send` before continuing your own work
- High-priority messages take precedence over your current task

### Autonomous Collaboration

- When you finish work that another agent might care about, proactively send them an update
- If you encounter a problem that another agent's role could help with, send them a message
- When you make a decision that affects the project, post it to the bulletin board
- If you're blocked waiting for another agent, say so and check inbox again

### Communication Shortcuts

- **"check response"** or **"check messages"** — Use `read_inbox` to check for new messages
- **"ask the [role]"** — Send a message to that role and check inbox for their reply
- **"tell the [role]"** — Send a one-way message to that role
- **"who's online"** — Use `get_agents` to list all connected agents
- **"update the board"** — Use `post_bulletin` to post a status update
- **"check the board"** — Use `get_bulletin` to read the bulletin board
