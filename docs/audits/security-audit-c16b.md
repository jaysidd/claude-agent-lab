# C16b Security Audit (2026-04-26)

Scope: durable task queue (`src/taskQueue.ts`, `src/taskQueueInstance.ts`) and the four refactored task routes in `src/server.ts` (lines 600–718). Read-only audit. Threat profile inherited from the 2026-04-23 baseline (single-user, LAN-isolated `127.0.0.1:3333`, Max OAuth, no auth/CSRF — all accepted for personal use, BLOCKER pre-commercial).

## Summary
All-clear. C16b introduces no new HIGH or MED issues. SQL is uniformly parameterized, WORKER_ID is server-only and never accepted from clients, the metadata path has both schema-layer and serialization-layer guards, and the prompt-injection surface is unchanged from C03 (already covered by S5/S6/S7). Two LOW/Info items worth recording for the file.

## Findings
| # | Severity | Threat | Status |
|---|---|---|---|
| SC1 | LOW | Per-task agent run inherits assigned agent's full tool allowlist (no plan-mode coercion) | accept (reaffirms S5/S6) |
| SC2 | Info | `error_json` will faithfully persist whatever a future caller passes as `details` | no-action (current host route passes only `{message}`) |
| SC3 | Info | `migrate(db)` is FS-trust-rooted (host with FS write can rewrite schema) | no-action (out of threat model) |

### SC1 — Per-task `/run` honors per-agent tool allowlist; plan-mode is not forced
`src/server.ts:657-667`

When `/api/task/:id/run` fires, `query()` is called with `allowedTools: agent.allowedTools`, and `permissionMode: 'plan'` is only set when the per-agent `planMode` flag is on. So a task description authored anywhere — kanban input box, programmatic POST, a future ClaudeLink push — is executed against the assigned agent's full toolset. If the classifier routed to `ops`, the run can `Read/Glob/Grep` over `currentCwd`. If a future custom agent grants `Bash`, a malicious task description could attempt shell execution.

This is the same risk class as S5/S6 from the 2026-04-23 audit (prompt injection through tool-returned content / via direct user input), and the same mitigations apply: minimal allowlists per agent, no escalation through delegation (`agentRegistry`/`subAgentsFor` already enforces this), and the user understanding that anything they enqueue runs with the assigned agent's tools.

C16b does not change this surface — it just persists tasks across restart, where C03 lost them. Reaffirm and move on.

**Exploit prerequisites**: attacker can enqueue a task. In current threat profile, that means the operator typing into the kanban (or another local process on `127.0.0.1` POSTing to `/api/task`) — both cases are already inside the trust boundary.

**Recommendation**: no action for the personal-use threat profile. If/when the queue accepts tasks from untrusted sources (Telegram bridge in C05, ClaudeLink in C16d approval gates), revisit by either (a) defaulting plan-mode on for externally-sourced tasks, or (b) requiring approval before any `Run` button enables for tasks whose `metadata.source` is external.

### SC2 — `fail()`'s `details` is `unknown` and persisted as JSON
`src/taskQueue.ts:303-305`

`fail(taskId, workerId, error: { message: string; details?: unknown })` calls `JSON.stringify(error)` and writes the result to `error_json`. A worker that passes a stack trace, an Error object's full enumerable properties, or an arbitrary HTTP response body into `details` will persist that to disk. The current host route at `server.ts:684` passes only `{ message: err.message }` — no `details` — so today there is nothing sensitive landing in the column.

This is informational, not a vulnerability. Recording it because: (a) `details: unknown` is a permissive contract by design — Clawless's B54 will lift this module, and B54's worker may pass richer error payloads, (b) `error_json` flows out via `/api/tasks` GET (rendered into the kanban) and `/api/task/:id` DELETE 409 response, so anything stored there is browser-reachable.

**Recommendation**: when adding any worker that passes `details` in its `fail()` call, scrub the field at the worker boundary (no PII, no secrets, no full stack with file paths if file paths are sensitive). No code change needed today — current call site is clean.

### SC3 — `migrate(db)` is FS-trust-rooted
`src/taskQueue.ts:108-110`

`migrate(db)` runs the idempotent DDL via `db.exec()`. Re-runnable by design (`IF NOT EXISTS`). An attacker with FS write to `data/lab.db` could pre-populate the table with arbitrary rows or alter it — but FS write to the DB is total game-over, so this is well outside the threat model.

**Recommendation**: none. Documented for completeness.

## SQL injection check (walked every prepared statement)
| Site | Method | Status |
|---|---|---|
| `taskQueue.ts:151-166` | `enqueue` INSERT | parameterized — 9 `?` placeholders |
| `taskQueue.ts:185-192` | `checkout` SELECT winner | parameterized |
| `taskQueue.ts:196-207` | `checkout` UPDATE | parameterized |
| `taskQueue.ts:231-244` | `checkoutById` UPDATE | parameterized |
| `taskQueue.ts:262-271` | `heartbeat` UPDATE | parameterized |
| `taskQueue.ts:281-293` | `complete` UPDATE | parameterized |
| `taskQueue.ts:308-313` | `fail` SELECT | parameterized |
| `taskQueue.ts:324-334` | `fail` UPDATE | parameterized |
| `taskQueue.ts:350-361` | `release` UPDATE | parameterized |
| `taskQueue.ts:375-386` | `cancel` UPDATE | parameterized |
| `taskQueue.ts:395-401` | `reapExpired` SELECT | parameterized |
| `taskQueue.ts:411-418` | `reapExpired` requeue UPDATE | parameterized |
| `taskQueue.ts:420-428` | `reapExpired` fail UPDATE | parameterized |
| `taskQueue.ts:450-479` | `list` dynamic SELECT | parameterized — IN clause uses `?` × N spread (line 458); `LIMIT` uses `${Math.floor(filter.limit)}` after `Number.isFinite` + `> 0` guards (lines 466-469) — numeric only, not user-string-interpolatable |
| `taskQueue.ts:482-486` | `get` SELECT | parameterized |
| `server.ts:145-154` | `pruneCompletedTasks` DELETE | parameterized (cap as `?`) |
| `server.ts:703-709` | DELETE `/api/task/:id` | parameterized (id as `?`) |

No string interpolation of user-controlled data anywhere. The only template literals in SQL are `LIMIT ${Math.floor(filter.limit)}` (gated by `Number.isFinite` + positive check) and the IN-list comma-join of `?` placeholders. Both are safe.

## Worker ID forgery check
`taskQueueInstance.ts:11` builds `WORKER_ID = ${hostname}:${pid}:${randomUUID()}` once at module load. The four host call sites that pass it (`server.ts:646, 684, 686`) pass the imported constant — never `req.body.workerId`, never any value derived from a request. There is no route surface that accepts a worker_id from the client. A malicious local caller can hit `/api/task/:id/run` (which then internally calls `checkoutById` with the server's WORKER_ID), but they cannot supply a foreign worker_id to spoof another worker's `complete`/`fail`/`heartbeat`. Correctly designed.

If a future route ever exposes worker semantics (e.g., a remote-worker API for distributed execution), worker_id authentication becomes a HIGH-priority gate at that point. Note in handoff.

## Race exploit on max_attempts (per checkout)
The status guard `WHERE id = ? AND status = 'queued'` in `checkoutById` (line 240) means once a task is `checked_out`, parallel `/api/task/:id/run` calls return 409 immediately (the second `checkoutById` returns `null` because status is no longer `'queued'`). The only window where `attempt_count` can be incremented in rapid succession is *between* `complete`/`fail` (which sets status back to `done`/`failed`/`queued`) and the next click. For the requeue case (`fail` with `attempt_count < max_attempts`), each click costs one attempt — so 3 rapid manual Runs on a `max_attempts: 3` task will exhaust it. This is by design (locked OQ #3 in the rev. 2 design doc — manual runs count). Not a security issue; it's documented behavior. Calling out for completeness.

## Information leakage in error responses
`server.ts:711-715` — DELETE 409 returns the full `toApiTask(current)` object. Fields exposed: `id`, `description` (user-supplied), `priority`, `assignedAgent` (string ID), `status`, `createdAt`, optional `result`/`error.message`. Nothing internal — no `worker_id`, no `lease_expires_at`, no `metadata`. The `toApiTask` shaper (`server.ts:123-138`) drops every field that isn't part of the wire contract. Clean.

`server.ts:689-692` logs reaped/deleted-mid-run failures via `console.warn` with `err?.message`. The queue's own throw messages (`"complete: task X not held by worker Y"`) leak the worker_id pattern, which is `hostname:pid:uuid` — hostname and PID are mildly identifying but inside the trust boundary already. No secrets. Acceptable.

## Metadata explosion / poisoning
`taskQueue.ts:538-547` enforces a 64 KB byte cap at `serializeMetadata` time, before INSERT. The host route `/api/task` (`server.ts:606-629`) does not currently forward `metadata` from the request body — only `description`, `priority`, `agentId` — so client-supplied metadata is not yet a vector. If a future route exposes metadata enqueue, the cap fires inside `enqueue` and throws before the INSERT, which `/api/task` would 500. Recommend wrapping in try/catch and returning 400 at that point. Not a current finding.

`safeParse` (`taskQueue.ts:549-555`) catches `JSON.parse` errors and returns `null`, so a corrupted `metadata_json` row cannot crash a `list()` or `get()` call. Defensive, correct.

## Confirmation that prior accepted risks are unaffected
- **S1 (unscoped `currentCwd`)** — unchanged. C16b does not touch `/api/cwd`.
- **S2 (`/api/browse` arbitrary `?path=`)** — unchanged. C16b does not touch `/api/browse`.
- **S3 (server binds 0.0.0.0)** — unchanged. C16b does not touch `app.listen`.
- **S4 (no auth / CSRF / CORS)** — unchanged. The four task routes have no new auth layer (correctly, per project policy), and no new state they expose worsens this. The four routes are no more attractive a target than the existing chat route.
- **S5 (Ops file-read prompt injection)** — unchanged. SC1 above re-confirms.
- **S6 (WebFetch / WebSearch prompt injection)** — unchanged. SC1 above re-confirms.
- **S7 (classifier prompt injection)** — unchanged. `classifyTask` (server.ts:169) still whitelists output against `AGENTS` keys (`server.ts:620` calls `findAgent(agentOverride)` — the registry guards the agent ID before it reaches `enqueue`). No string interpolation of `description` into a sub-prompt anywhere.
- **S8 (XSS via `innerHTML`)** — unchanged. The new task fields (`result`, `error`) flow through `toApiTask` to existing UI render code; no new `innerHTML` sites in C16b.
- **S9 (SDK delegation boundary)** — unchanged. The `/run` handler at `server.ts:655` still uses `subAgentsFor(agent.id)`; no new escalation path.
- **S10 (no key round-tripping)** — unchanged. C16b adds no logging of credentials and no new response shapes that could include a key.

## Verdict
- New HIGH: 0
- New MED: 0
- New LOW: 1 (SC1 — reaffirms S5/S6, no action needed today)
- New Info: 2 (SC2, SC3)
- Overall: **ship**

C16b is a clean refactor from a security standpoint. The durable queue does not enlarge the attack surface beyond the C03 in-memory baseline, and the design's worker_id discipline + parameterized-everywhere SQL discipline + 64 KB metadata cap are all correctly implemented. The single LOW item is a re-statement of an already-accepted inherent risk and does not warrant a fix in this scope.

Watch-list for future sessions:
1. If/when an external-source task ingestion lands (C05 Telegram, C16d approvals), revisit SC1 — externally-sourced tasks should default plan-mode on or require approval before `Run` enables.
2. If/when a remote-worker API exposes worker_id semantics on the wire, add worker_id authentication before that route ships.
3. If/when the `/api/task` route accepts client-supplied `metadata`, wrap `enqueue` in try/catch to translate the 64 KB cap throw into a 400 response.
