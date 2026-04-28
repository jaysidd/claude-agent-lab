# C16a Scheduler — Security Audit

> Date: 2026-04-28
> Branch: `c16a-scheduler`
> Threat model: personal-use, localhost-only, single-tenant. Same as C16b/C16c.
> Scope: stored prompt injection, cron-parser DoS, OAuth-dead regex bypass, schedule `cwd` traversal, race conditions in fire/pause/delete, info-leak via task metadata, SQL injection, JSON-body limits, scheduler-start thundering-herd, `fireNow` as auth-bypass.
> Files in scope: `src/scheduler.ts`, `src/schedulerInstance.ts`, `src/server.ts:1085-1362` (wiring + 8 routes), `public/app.js` modal UI (read-only — no exfil sinks identified).

## Summary
0 HIGH, 0 MED, 1 LOW, 4 Info. C16a introduces no new HIGH or MED issues under the personal-use threat model. SQL is uniformly parameterized; the new schedule routes inherit the project-baseline "no auth on `127.0.0.1`" posture (S4) without enlarging the practical attack surface; the OAuth-dead regex was tightened during this audit to also catch the canonical CLI message *"Please run \`claude login\`"* (was a benign false-negative — schedules still auto-paused after 3 strikes); cron-parser v5 shows no pathological behavior on 100-char inputs (worst case ~15 ms); `metadata.scheduleId` and `cwd` do not leak to clients via `/api/tasks` (the `toApiTask` shaper drops `metadata`). The unvalidated per-schedule `cwd` (R8 deferred) is recorded as **S-C16a-1 LOW** with a clear escalation precondition for the commercial path.

| # | Severity | Threat | Status |
|---|---|---|---|
| S-C16a-1 | LOW | `POST /api/schedules` accepts arbitrary `cwd` string with no `path.resolve`/stat/allowlist | accept (matches `/api/cwd` baseline behavior; reaffirms S1) |
| S-C16a-2 | Info | OAUTH_DEAD_PATTERN regex tightened — added canonical CLI phrase as second alternation | **fixed in this audit** |
| S-C16a-3 | Info | `scheduler.start()` thundering-herd on boot for many past-due schedules | reaffirm R9 (operational, not security) |
| S-C16a-4 | Info | `metadata.scheduleId`/`cwd` planted on enqueued tasks but suppressed by `toApiTask` shaper | confirmed safe, recorded for the Clawless lift |
| S-C16a-5 | Info | `fireNow` (`/api/schedules/:id/run-now`) is an unauthenticated trigger for arbitrary stored prompts | accept (same class as S4; consequence higher post-commercial) |

---

## Findings

### S-C16a-1 — Per-schedule `cwd` accepted unvalidated (LOW)
`src/server.ts:1256-1273` — the `POST /api/schedules` route forwards `req.body.cwd` straight into `scheduler.create(...)`, which stores it verbatim. At fire time (`server.ts:1174`), `fireCwd = ctx.cwd || currentCwd` — so a schedule created with `cwd: "/etc"` will execute `query()` against `/etc`. The route does not call `path.resolve(expandPath(...))`, does not stat the directory, and does not constrain it to any root.

This is the same root issue as the baseline S1/S2 findings: there is no path sandboxing anywhere in this project. `/api/cwd` POST does `path.resolve` + `stat` (existence check), but no allowlist either. The schedule path is *less* validated than `/api/cwd` — no stat, no resolve — but the difference is cosmetic in the personal-use threat model: an operator who can hit `/api/schedules` POST can already hit `/api/cwd` POST and achieve the same effect for the chat path.

In the personal-use threat model:
- Localhost-only binding means the only callers are the operator and other local processes already inside the trust boundary.
- A bad-faith operator setting `cwd: "/etc"` on their own schedule is self-harm — they have shell access to `/etc` already.
- Any tool call against `/etc` is constrained by the assigned agent's `allowedTools`. A schedule pointing the `ops` agent at `/etc` lets the agent `Read/Glob/Grep` there, which is the same baseline S1 risk: the operator chose this `cwd` themselves.

**Watch list — escalates to HIGH if commercial path opens** (precondition: any route on this server becomes reachable by a non-operator). At that point: `cwd` validation needs a `realpath(cwd).startsWith(COMMAND_CENTER_ROOT + sep)` guard at *both* schedule-create time and at fire time (defense in depth: a schedule created when the root was wide-open shouldn't fire after the root narrows).

**Recommendation today**: no code change. The deferred R8 is consistent with project policy. Adding `path.resolve` + `stat` would be a half-measure that doesn't actually constrain anything but creates a misleading signal of "validated". When path sandboxing lands, it must land everywhere (`/api/cwd`, `/api/browse`, `/api/files`, schedules) under a single allowlist primitive.

---

### S-C16a-2 — OAUTH_DEAD_PATTERN missed canonical CLI phrasing (Info — **fixed in this audit**)
`src/server.ts:1130` — the original regex required a domain word *and* a failure verb separated by `.*`. Canonical CLI exhortations like *"Please run \`claude login\`"* contain only the domain word; the phrase itself is the auth-failure signal, with no separate verb. Three real-world phrasings missed:

```
"Please run claude login"                              → no match (was benign false-neg)
"Please run `claude login`"                            → no match
"Please run `claude login` to refresh credentials"     → no match
```

**Consequence of the false negative**: a legitimate OAuth-dead error mis-classifies as a generic `"error"`, which still trips the 3-strike auto-pause — schedule pauses, just with `paused_reason='too_many_failures'` instead of `'oauth_unavailable'`. Annoying, not a security gap. The flip side (false-positive injection from a tool result containing a crafted oauth string) is independently mitigated by the position guard `!assistantMessageArrived` — tool results can only surface *after* the first assistant frame, since the agent loop cannot start without a working SDK transport. Confirmed: a crafted `WebFetch` result containing `"OAuth credentials expired"` cannot reach the regex test because by the time tool results stream, `assistantMessageArrived === true`.

**Fixed in this audit**: tightened to a top-level alternation that adds the canonical CLI phrase. Strictly additive — every prior true/false case retained, three real-world phrasings flip miss-to-hit. Test matrix run inline (8 positive + 6 negative cases, all pass).

```
Before: /(oauth|claude\s*(?:code\s*)?login|anthropic\s*api[ -]?key|credentials).*(expired|invalid|failed|required|missing|not authenticated|please run)/i

After:  /(?:(?:oauth|claude\s*(?:code\s*)?login|anthropic\s*api[ -]?key|credentials).*(?:expired|invalid|failed|required|missing|not authenticated|please run)|please\s+run\s+`?claude\s*(?:code\s*)?login`?)/i
```

The fix landed in `src/server.ts:1130-1144` with an in-file comment recording the audit context. No test references the regex (it is module-private), and no behavioral test covered the canonical phrasings — so no test fixtures need updating. Worth adding a `tests/scheduler.spec.ts` unit case for the three flipped phrasings in a follow-up; not blocking.

---

### S-C16a-3 — Thundering-herd on `scheduler.start()` (Info — reaffirm R9)
`src/scheduler.ts:347-354` — `start()` schedules the periodic `setInterval` *and* runs an immediate `tick()` synchronously. The immediate tick is intentional: schedules whose `next_fire_at` is in the past after a server restart shouldn't wait `intervalMs` (default 30 s) to catch up.

Side effect: if N schedules have past-due `next_fire_at` after a long downtime, all N fires kick off in a single tick. Each fire enqueues into `taskQueue` (synchronous SQLite INSERT), then awaits the SDK `query()` call asynchronously. The DB writes serialize through better-sqlite3's single writer. The SDK calls run in parallel — bounded only by the OS / Node event loop / Anthropic rate limits.

**Security relevance**: not a security issue at personal scale. With 50 past-due schedules, the surge is 50 parallel `query()` calls — Anthropic's rate limit fires, several get rejected (CostGuard's `rate_cap_per_window` would also gate, if configured), and the schedules increment `consecutive_failures` independently. After 3 rounds the schedules auto-pause. Self-correcting.

**Watch list — escalates if commercial path opens or if scheduling is exposed to untrusted users**: a malicious operator could create thousands of past-due schedules to amplify a DoS on the SDK transport. Mitigation at that point: cap the per-tick fire rate (`Math.min(due.length, MAX_PARALLEL_FIRES_PER_TICK)`), defer the rest. Today, no action.

R9 already noted this from the reviewer pass. Re-confirming from the security lens.

---

### S-C16a-4 — `metadata.scheduleId`/`cwd` planted but suppressed at the API edge (Info)
`src/server.ts:1102-1111` plants `{source: "scheduler", scheduleId, cwd, manual}` on the queue task's metadata. `src/server.ts:136-151` (`toApiTask`) does NOT include `metadata` in the wire shape. Confirmed by reading every field: `id`, `description`, `priority`, `assignedAgent`, `status`, `createdAt`, `result`, `error.message`. No `metadata`.

So the `cwd` and `scheduleId` planted on a fire's task row stay server-side; clients that hit `/api/tasks` see only the description (= the schedule prompt) and the agent ID. Confirmed safe under the personal-use threat model.

The schedule prompt itself (= task `description`) IS browser-reachable via `/api/tasks` — by design, the kanban shows what's running. A malicious operator who can create schedules can already see what they created. No leak through this path.

**Watch list — escalates if Clawless lifts this primitive into a multi-tenant context**: at that point, `metadata.scheduleId` would be a cross-tenant ID surface. Either (a) suppress `metadata` on cross-tenant `/api/tasks` reads (current behavior), or (b) add a tenant-id field and gate reads. The current `toApiTask`-strips-metadata shape is the right default and should be preserved through the lift.

---

### S-C16a-5 — `/api/schedules/:id/run-now` is auth-free trigger for stored prompts (Info)
`src/server.ts:1301-1327` — anyone with HTTP access to the server can fire any schedule on demand. The schedule's prompt runs under the assigned agent's `allowedTools`, in the schedule's `cwd`, with no human-in-the-loop and no plan-mode coercion (unless the agent's `planMode` flag is on globally — and `planMode` is module-state, not per-fire).

In current threat profile (localhost-only, single operator): same class as S4 (no auth on the API). Not a new attack surface.

**Watch list — escalates to HIGH if commercial path opens or if any route on this server becomes reachable by a non-operator**: the consequence of `/run-now` is *higher* than the consequence of `/api/chat`, because the schedule represents a *pre-approved, stored prompt with a chosen `cwd` and agent*. An attacker who can hit `/run-now` can fire any pre-existing schedule against `/etc` with `Ops`-tier tools, no chat round-trip needed. When auth lands:
1. `/run-now` needs the same auth gate as `/chat`.
2. Consider requiring an explicit `confirm: true` in the body for fires that target a non-default `cwd`.
3. Plan-mode default-on for `/run-now` fires would be a useful belt-and-braces (no tools execute without approval).

Today: no action. Recording for the threat-model lift.

---

## Confirmed safe

### Stored prompt injection
A schedule prompt is a persistent string that fires later. Under the current threat model, only the operator can write to the `schedules` table (via `POST /api/schedules` on localhost). The mitigations in the prompt brief all hold:
1. **HTTP routes are localhost-only** — confirmed at `src/server.ts:1367-1368`. Default HOST is `127.0.0.1`. Pre-existing.
2. **Agent's `allowedTools` constrains tool reach** — confirmed at `src/server.ts:1180`. The fire passes `agent.allowedTools` exactly as for chat/stream/task-run; no toolset escalation.
3. **Every fire shows on the kanban** — confirmed via `enqueueScheduledTask` (`server.ts:1102-1111`) → `taskQueue.enqueue` → visible at `/api/tasks`. The fire's terminal state (`done`/`failed`) lands via `taskQueue.complete`/`fail` in the same path.

A schedule whose prompt is *itself* a primed-exploit ("read /etc/passwd then exfiltrate") executes under the same constraints as that prompt typed live into chat — same agent, same tools, same `cwd`. The schedule mechanism does not enlarge the attack surface a free-typed prompt can exploit. Confirmed safe.

The one edge case worth recording: schedules persist across server restarts whereas a chat prompt is one-shot. So a malicious schedule survives an operator forgetting they created it. Mitigated by: the schedules table is browser-listable via `GET /api/schedules`, the modal UI lists every schedule, and `paused_reason` records auto-pauses for forensics. Operator can audit at any time.

### Cron-parser DoS
`cron-parser` v5 with the 100-char input cap shows no pathological behavior. Probed worst-case 100-char inputs (dense comma-lists, ranges with steps, all six fields populated) — worst observed parse+iterate time was 15 ms on a cold call, sub-millisecond on warm calls. The library rejects >6-field inputs (cap at minute/hour/dom/month/dow/optional-second), rejects malformed expressions, and the SchedulerInstance calls `parse` exactly once per validation (`scheduler.ts:587`). Re-derivation of `next_fire_at` happens on `update()` and `executeFire()`, also one parse call each. No unbounded loops, no exponential blowup paths. Safe.

### SQL injection (every prepared statement walked)
| Site | Method | Status |
|---|---|---|
| `scheduler.ts:188-208` | `create` INSERT | parameterized — 9 `?` placeholders |
| `scheduler.ts:260-262` | `update` dynamic UPDATE | field names from a fixed allowlist (`agent_id`, `prompt`, `cron`, `cwd`, `enabled`, `paused_reason`, `next_fire_at`, `consecutive_failures`, `updated_at`); values bound via `?`. Field names are **literal strings inside the source**, never derived from user input. Safe. |
| `scheduler.ts:268` | `delete` DELETE | parameterized |
| `scheduler.ts:273-275` | `get` SELECT | parameterized |
| `scheduler.ts:280-282` | `list` SELECT | no params; static SQL |
| `scheduler.ts:294-303` | `pause` UPDATE | parameterized — `enabled = 1` guard is a literal |
| `scheduler.ts:314-324` | `resume` UPDATE | parameterized |
| `scheduler.ts:373-380` | `tick` due-SELECT | parameterized — `enabled = 1` literal |
| `scheduler.ts:426-435` | `executeFire` cron-advance UPDATE | parameterized |
| `scheduler.ts:439-447` | `executeFire` manual UPDATE | parameterized |
| `scheduler.ts:485-493` | `recordOutcome` success UPDATE | parameterized |
| `scheduler.ts:498-508` | `recordOutcome` oauth-dead UPDATE | parameterized |
| `scheduler.ts:515-523` | `recordOutcome` budget UPDATE | parameterized |
| `scheduler.ts:535-544` | `recordOutcome` error increment UPDATE | parameterized — `consecutive_failures + 1` is SQL-side arithmetic |
| `scheduler.ts:551-560` | `recordOutcome` auto-pause UPDATE | parameterized |

No string interpolation of user-controlled data. The dynamic UPDATE in `update()` is the only place that builds SQL from a list, and the list is source-literal field names — never derived from `patch` keys without source-side inspection. Safe.

### JSON-body parsing on `/api/cron/preview` and `/api/schedules`
`src/server.ts:184` uses `app.use(express.json())` with the default 100 KB body limit. The cron-preview route validates `cron` is a non-empty string ≤ 100 chars (`src/server.ts:1346-1351`) before passing to `cronPreview`. The schedule POST route relies on `scheduler.create()`'s validation (`prompt` ≤ 8 KB, `cron` ≤ 100 chars, `agentId` non-empty string). Both routes return 400 with a sanitized first-line error on validator throws. Safe.

### Race conditions

**Schedule deleted mid-fire** — confirmed clean. `delete()` is a `DELETE FROM schedules WHERE id=?` (no FK constraints from `tasks` to `schedules`). If the fire is mid-`query()`, the schedule row vanishes; `recordOutcome` UPDATE-WHERE-id matches zero rows (silent no-op). The enqueued task in `tasks` remains as an orphan with `metadata.scheduleId` pointing to a now-nonexistent schedule — harmless, kanban still shows the task's terminal state when `taskQueue.complete`/`fail` lands. CostGuard ledger row records normally (the fire consumed real budget; recording it is correct). No leftover lease, no stuck worker — `WORKER_ID` is the same singleton; `taskQueue.complete`/`fail` succeeds. Confirmed safe.

**Schedule paused mid-fire** — confirmed clean. The `pause()` UPDATE is `WHERE id=? AND enabled=1`, and `recordOutcome`'s error-increment UPDATE has the same `enabled=1` guard. So if the operator manually pauses while a fire is running, the post-fire `recordOutcome` finds `enabled=0` and silently no-ops, leaving `paused_reason='manual'` intact. The fire itself completes its SDK call, records the cost ledger row (correct — real budget consumed), and updates the task's terminal state. The next-fire-at advance happened *before* the SDK call (in the executeFire enqueue transaction), so the schedule's `next_fire_at` was already advanced before the pause; on resume, `resume()` re-derives `next_fire_at` from now-relative cron eval, so a long-paused schedule doesn't fire immediately on resume. Confirmed safe and matches reviewer-pass functional analysis.

**Tick + delete race in same tick window** — `tick()` reads due rows synchronously, then iterates them outside any transaction. If a row is deleted between the SELECT and the per-row `executeFire` call: `executeFire` reads `sched.cron` from the in-memory `Schedule` object (already loaded), enqueues a task, and runs the cron-advance UPDATE. The UPDATE-WHERE-id matches zero rows, so the row stays deleted and no zombie row is recreated. The task IS enqueued — one stray fire executes against a now-deleted schedule. Same as the "deleted mid-fire" case above; orphan task, no leak. Confirmed safe.

### Position guard for OAuth-dead detection
`!assistantMessageArrived && OAUTH_DEAD_PATTERN.test(message)` at `src/server.ts:1246`. The `assistantMessageArrived` flag is set at `src/server.ts:1192-1194` on any `msg.type === "assistant"` frame. Tool results are surfaced to the agent only inside the agent loop, and the agent loop cannot start without ≥ 1 assistant frame from the model. Confirmed: a tool that returns a crafted `"OAuth credentials expired"` string cannot pass the regex check, because by the time the tool result enters the message stream, `assistantMessageArrived === true`. The position guard is the load-bearing mitigation against tool-content prompt injection here; the regex tightening from S-C16a-2 is independent.

### `cwd` flow in fire path
`src/server.ts:1174` — `fireCwd = ctx.cwd || currentCwd`. `ctx.cwd` is the schedule's stored `cwd`, set at `scheduler.ts:407` from `sched.cwd ?? ""`. If the schedule has no `cwd`, `ctx.cwd` is the empty string, falling through to `currentCwd`. No `undefined`/`null` reaches `query()`. Confirmed.

### `fireNow` not double-counting failures
`scheduler.ts:474-476` — manual fires explicitly skip `recordOutcome`. A `/run-now` of a schedule with `consecutive_failures: 2` does NOT trip auto-pause on its third failure. By design (locked OQ — manual runs are forensic, not part of the budget). Confirmed.

### Worker ID for scheduler-enqueued tasks
The scheduler enqueues into the queue but checks-out via the same `WORKER_ID` singleton as the chat/task-run paths (`src/server.ts:1157`). No client-supplied `workerId`. Confirmed by extension of the C16b SC-walk.

---

## Watch list (escalates if commercial path opens)

Each item is tied to a precondition. Auth on the HTTP surface is the one shared precondition that flips most of these from LOW/Info to HIGH.

| Item | Precondition for escalation | What to do then |
|---|---|---|
| **S-C16a-1** | Any route reachable by non-operator | `realpath(cwd).startsWith(COMMAND_CENTER_ROOT + sep)` at create AND at fire (defense in depth — root may have narrowed since create). Land alongside path sandboxing for `/api/cwd`, `/api/browse`, `/api/files` under one allowlist primitive. |
| **S-C16a-3** | `/api/schedules` POST exposed to untrusted users | Cap per-tick fires; defer the surplus. `MAX_PARALLEL_FIRES_PER_TICK` config knob. |
| **S-C16a-4** | Multi-tenant lift into Clawless | Preserve the `toApiTask`-strips-metadata invariant; add tenant-id field; gate `/api/tasks` reads by tenant. |
| **S-C16a-5** | Auth introduced on the API | `/run-now` needs the same auth gate as `/chat`. Require `confirm: true` for non-default-`cwd` fires. Default `permissionMode: 'plan'` for manual fires. |
| **OAUTH_DEAD regex (S-C16a-2)** | If tool results ever reach the regex BEFORE the first assistant frame (would require a SDK behavior change) | Position guard becomes the sole mitigation; consider hardening (e.g., a structured `error.code === 'oauth_dead'` SDK field) instead of regex. |
| **`cron_parser` upgrade** | Future major-version bump | Re-run the 100-char DoS probe; the API may change parse semantics. |

## Verdict
- New HIGH: 0
- New MED: 0
- New LOW: 1 (S-C16a-1, accepted under threat model; reaffirms baseline S1)
- New Info: 4 (S-C16a-2 fixed inline; S-C16a-3 reaffirms R9; S-C16a-4/-5 watch-list)
- Overall: **ship**

C16a is a clean primitive from a security standpoint. The host-agnostic `Scheduler` class is parameterized SQL throughout; the host-side wiring inherits the project's accepted localhost-only / no-auth posture without enlarging it; the OAuth-dead detection has both domain+verb regex and position-guard layers, and the regex was tightened during this audit to also catch the canonical CLI exhortation. The unvalidated `cwd` is the one finding worth recording, and it's a re-statement of baseline S1 ("no path sandboxing anywhere") rather than a new gap.

The watch list is short and tightly scoped to the commercial-path threat-model lift. None of the items require a code change today; all of them require code changes when auth lands, and they should land under one path-sandboxing primitive rather than per-route patches.
