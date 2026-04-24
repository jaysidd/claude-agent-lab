# Command Center — Performance Audit (2026-04-23)

## Headline

For a ~2.1k-LOC personal-use single-tab app the baseline is healthy: no framework bloat, no build step, static assets total ~48 KB uncompressed. The one finding worth shipping a fix for is **P1 — render churn in `sendMessage()`**: every `text_delta` triggers a full rebuild of the chat log from scratch, which is O(N x M) where N is the number of deltas and M is the number of messages already on screen. On a 2,000-token Sonnet reply this is measurable jank. Two other issues are latent rather than user-visible today: the streaming route never hears about client disconnects (so the SDK iterator runs to completion even when the tab is closed), and the `tasks` Map grows forever. Several minor dead-code / latency items round out the list.

## Findings

### P1 — Full DOM rebuild on every streaming delta (HIGH)

**Where:** `public/app.js:106–175` (`renderMessages`) called from `public/app.js:228` inside the `for (const line of lines)` loop.

**What:** Each `text_delta` event appends a few characters to `agentMsg.text`, then calls `renderMessages()`, which does `messagesEl.innerHTML = ""` and re-creates every bubble, every tool chip, every footer, and every `empty-state` check for the whole conversation from scratch.

**Why it matters:** The SDK emits a `content_block_delta` per chunk from the streaming API. A 2,000-token Sonnet reply is roughly 500–1,500 deltas. With a 10-turn conversation already on screen (20 bubbles), each delta triggers:

- 20+ `document.createElement` calls
- 20+ appendChild into `messagesEl`
- a full layout/paint of the chat pane
- a `scrollTop = scrollHeight` (forces layout flush)

Rough budget per render at turn 10: ~2-5 ms of main-thread work. Over 1,000 deltas: 2–5 seconds of cumulative main-thread time during the stream. User symptom: the caret cursor stutters, typing into the composer mid-reply drops frames, and the scroll-to-bottom fights anything the user tries to scroll up to read. Gets worse linearly with conversation length — this is the O(N²) the brief flagged.

**Fix (est. 15–25 min):** Keep two render paths.

1. First render of a new bubble: full build (one time per message).
2. Subsequent deltas on the current streaming bubble: mutate only the last `.msg-body` `textContent` (and on `tool_use`, append a single chip). Skip the `innerHTML = ""` entirely.

Sketch:

```js
// once, when inserting agentMsg
const row = buildMessageRow(agentMsg);
messagesEl.appendChild(row);
agentMsg._bodyEl = row.querySelector(".msg-body");

// in the delta loop
} else if (ev.kind === "text_delta") {
  agentMsg.text += ev.text;
  agentMsg._bodyEl.textContent = agentMsg.text;
}
```

A `requestAnimationFrame` coalescer would be a nice-to-have but isn't needed — `textContent` on a single node is cheap.

### P2 — Streaming route never aborts on client disconnect (HIGH)

**Where:** `src/server.ts:242–318` (`POST /api/chat/stream`).

**What:** The route calls `for await (const msg of query({...}))` with no `abortController` option (see SDK `AbortController` support at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1120`). There is no `req.on("close", ...)` listener. If the user closes the tab, navigates away, or the browser reloads mid-stream, the server keeps consuming the SDK iterator to completion and every `res.write` silently no-ops (or throws `ERR_STREAM_WRITE_AFTER_END` the next tick, which is swallowed since `write` is not awaited and has no callback error handler at `src/server.ts:255`).

**Why it matters:** For personal single-tab use the blast radius is small — one wasted OAuth round-trip per abandoned stream. But it also means:

- A runaway Sonnet/Opus turn cannot be cancelled by the user (closing the tab doesn't stop the spend).
- `sessionByAgent.set(agent.id, newSessionId)` at `src/server.ts:315` still persists the session from a turn the user may have abandoned, so the next turn resumes a conversation the user never saw complete.

**Fix (est. 15 min):** Wire up an `AbortController` and bind it to the request close event:

```js
const ac = new AbortController();
req.on("close", () => ac.abort());
// ...pass abortController: ac into options
// ...wrap res.write in try/catch or guard with !res.writableEnded
```

Also harden `write`: guard with `if (res.writableEnded) return;` so a late event after the client vanishes is a no-op rather than a thrown unhandled rejection.

### P3 — `tasks` Map grows unbounded (MEDIUM)

**Where:** `src/server.ts:34` (`const tasks = new Map<string, Task>()`), written at `:349`, never pruned except via `DELETE /api/task/:id` (`:400`).

**What:** Every `POST /api/task` adds an entry. The only eviction path is an explicit per-id delete from the UI.

**Growth characteristics:** Each `Task` object is ~300 B of metadata plus the `result` string (unbounded — often a few KB). Personal use, maybe 20 tasks/day — over a month of uptime that's ~600 entries, ~1–3 MB, negligible. Still worth a cap so a long-running session doesn't accumulate indefinitely, and so the `GET /api/tasks` response (`src/server.ts:325–327`) doesn't linearly grow the payload every frontend open.

**Fix (est. 10 min):** After a task reaches `done`/`error` (`src/server.ts:388–395`), check the completed count and prune oldest beyond e.g. 50:

```js
if (completedCount(tasks) > 50) pruneOldestCompleted(tasks, 50);
```

LOW severity were this not user-visible — bumped to MEDIUM because `GET /api/tasks` sorts and serializes the whole Map on every task-board open (`src/server.ts:326`).

### P4 — Task classifier is serial only (MEDIUM)

**Where:** `src/server.ts:37–76` (`classifyTask`), invoked from `src/server.ts:339`.

**What:** Each `POST /api/task` without `agentId` blocks on a Haiku round-trip (1–3 s). If the UI adds a batch of tasks, they queue serially at the fetch layer because the frontend's `createTask` (`public/app.js:530`) awaits one create before the user can issue the next.

**Why it matters:** Today the UI is one-at-a-time, so this is latent. If a batch-create lands later, or a "paste 5 tasks" flow, the classifier will dominate. Worth noting, not worth fixing until there's demand.

**Also:** The system prompt at `src/server.ts:38–44` is already tight ("exactly ONE word"). The post-processing at `:57–69` is defensive belt-and-braces — good. No change needed there.

**Fix (est. 20 min if ever):** Add `POST /api/tasks/batch` that `Promise.all`s the classifier calls.

### P5 — `src/hello.ts` is dead code on the serve path (LOW)

**Where:** `src/hello.ts` (12 lines); referenced only at `package.json:7` (`"start": "tsx src/hello.ts"`).

**What:** `npm start` runs the smoke test, `npm run serve` runs the real app. The file is harmless but confusing — the repo's `start` script doesn't start the product. Nothing on disk imports it.

**Fix (est. 2 min):** Either rename the script (`"smoke": "tsx src/hello.ts"`, point `"start"` at `src/server.ts`) or delete `src/hello.ts` if the smoke is no longer useful. Recommend the rename — the file is cheap and documents the SDK minimum.

### P6 — Unused CSS (LOW)

**Where:** `public/style.css`.

- `.msg-meta` at `style.css:283` — no DOM reference in `app.js` or `index.html`.
- `.thinking` + `.thinking::after` + `@keyframes dots` at `style.css:308–323` — no DOM reference; superseded by `.streaming-empty` at `style.css:275`.

**Why it matters:** ~40 lines, ~800 B. Cosmetic only, but signals the refactor from non-streaming to streaming C02 left stragglers. Useful because someone reading the CSS will assume `.thinking` is live.

**Fix (est. 3 min):** Delete the three rules.

### P7 — `/api/browse` is O(N) on directory size (LOW)

**Where:** `src/server.ts:141–159`.

**What:** `fs.readdir(target, { withFileTypes: true })` then three chained array passes (`filter`, `map`, `sort`). For a huge directory (e.g. `~/Downloads` with thousands of entries) this is ~50–100 ms of sync JS on the event loop. Not blocking the user, but measurable.

**Fix:** Don't bother — only `/api/files` applies a `.slice(0, 15)` (`src/server.ts:172`); `/api/browse` returns every subdirectory. Capping to e.g. 500 with a "…more" hint would be fine, but the modal is scrollable and this is a one-shot on open. Defer.

## Quick wins (est. effort in minutes)

- **25 min** — P1: targeted DOM updates in `sendMessage()` stream loop. Biggest perceptual win of the list.
- **15 min** — P2: `AbortController` + `req.on("close")` on the streaming route. Also guards `res.write` after end.
- **10 min** — P3: cap completed tasks at 50, prune oldest.
- **3 min** — P6: delete `.msg-meta`, `.thinking`, `@keyframes dots`.
- **2 min** — P5: rename `"start"` script to point at `src/server.ts`; or rename current start to `"smoke"`.

Total: ~55 minutes. Ship P1 + P2 together as a "streaming polish" commit.

## Defer

- P4 (parallel classifier) — no batch UI exists; adds API surface for zero benefit today.
- P7 (`/api/browse` cap) — modal is scrollable; measurable but not felt.
- `requestAnimationFrame` coalescing of deltas — P1 alone removes enough work that a coalescer isn't necessary.
- Splitting `public/app.js` into modules — 24 KB over localhost is ~1 ms to transfer. Not worth the maintenance.

## Measurements

| Path | Before | Notes |
|---|---|---|
| `public/app.js` | 24 KB / 698 LOC | Single file, served uncompressed over localhost. No need to split. |
| `public/style.css` | 16 KB / 752 LOC | ~40 lines of dead rules (P6). |
| `public/index.html` | 8 KB / 135 LOC | Clean. |
| Total `/public` | ~48 KB | Well under any budget. |
| `src/server.ts` | 409 LOC | Two of three `query()` call sites (`/api/chat`, `/api/task/:id/run`) use the non-streaming iterator — fine, no backpressure risk. |
| `classifyTask` latency | ~1–3 s/task | Haiku 4.5, no tools, `~200` token prompt. Serial per task create. |
| `renderMessages()` per delta | ~2–5 ms at turn 10 | 20 bubbles rebuilt + full layout; scales linearly with turn count. See P1. |
| `/api/browse` on `~/Downloads` (thousands of entries) | ~50–100 ms | `readdir` + three array passes; main-thread Node, not browser. Acceptable. |
| Streaming TTFT (Sonnet) | SDK-side: ~1.5–2.5 s from enter to first `text_delta` | Dominated by SDK init + auth; server adds <5 ms. Within the `<3 s` target in `CLAUDE.md`. |
| `tasks` Map growth | ~1–3 MB/month personal use | Unbounded; see P3. |

Read-only audit — no code changed.
