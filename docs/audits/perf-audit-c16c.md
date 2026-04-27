# C16c Performance Audit (2026-04-27)

## Summary

CostGuard lands clean at personal scale. Both ledger queries hit `idx_ledger_agent_time` with no temp B-tree, prepared statements are constructed once in the constructor, and the synchronous `check()` adds well under 100 µs to a chat call dominated by 1–10 s of LLM latency. The one finding worth flagging is the settings hot-path: `resolveCaps()` performs five `db.prepare(...)` calls per `check()` because `getSetting` re-prepares the SELECT each invocation. That's ~20 µs vs ~2.5 µs with a cached statement — invisible today, trivially recoverable later. No HIGH findings. Ship as-is, queue one LOW fix and a "watch list" partial-index suggestion for if the ledger ever grows past ~10k rows.

## Findings

| # | Severity | Area | Summary | Recommendation |
|---|---|---|---|---|
| P1 | LOW | `settings.ts:28` via `costGuardInstance.ts:34-45` | `resolveCaps()` runs 5× `db.prepare(...).get()` per `check()` (~20 µs); cached stmt would be ~2.5 µs | Cache the SELECT in `settings.ts` getSetting (3-line fix) |
| P2 | LOW | `costGuard.ts:89-92` (month-cost query) | At ~10k+ rows in current month for a single agent, the cost-cap path crosses 1 ms; all rows scanned because `is_oauth=0` is a non-leading filter | Accept today; add partial index `(agent_id, occurred_at, cost_usd) WHERE is_oauth=0` if monthly volume grows |
| P3 | LOW | `costGuard.ts` — no pruning policy | Ledger grows unbounded; OAuth-heavy month at one chat/min ≈ 43k rows/month | Accept; revisit when row count is observable in `/api/costguard/status` latency |
| P4 | LOW | Resolve-then-record duplicates work | `record()` does NOT re-resolve caps (just inserts), so there is no N+1; flagged for completeness | Accept (no fix — already optimal) |
| P5 | LOW | Stream-path `record()` semantics | `costGuard.record()` runs unconditionally after the loop, including on aborted streams; no double-record | Accept; behavior matches "failed calls still consume rate budget" docstring |
| P6 | LOW | `startOfMonth()` allocations | Two `Date` objects per cost-cap check (~315 ns) | Accept |
| P7 | LOW | Sync `check()` blocks the event loop | Worst measured cost is ~25 µs; well under any latency you'd notice on a personal-scale single-process server | Accept |

---

### P1 — `resolveCaps()` re-prepares the same SELECT five times per check (LOW)

**Where:** `src/costGuardInstance.ts:34-45` calls `configValue()` 5×; `src/settings.ts:28` does `db.prepare("SELECT value FROM settings WHERE key = ?").get(key)` per call.

**Observation:** better-sqlite3 caches by SQL text (so the parser/planner work is amortized), but it still pays a hash lookup + JS object construction per `db.prepare(...)`. Measured on the project's own better-sqlite3 build:

- 5× `db.prepare(...).get()` (current code shape): **19.7 µs** total
- 5× cached statement reuse: **2.4 µs** total

Net cost in the synchronous pre-`query()` path is ~17 µs of avoidable work per chat call.

**Why it's low:** A chat call's wall time is dominated by 1–10 s of model latency, not 17 µs of statement construction. The only path where you'd ever notice is the `/api/costguard/status` endpoint, which calls `resolveCaps()` once per request and is not on the chat hot path.

**Recommendation:** Cheap fix in `settings.ts` only — module-scope a single prepared statement and have `getSetting` reuse it. Three lines:

```ts
const getStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
export function getSetting(key: string) {
  const row = getStmt.get(key) as { value: string } | undefined;
  return row?.value || undefined;
}
```

That benefits every `configValue()` caller (WhisprDesk, Telegram-pending, CostGuard) and is host-side only — no contract change to the standalone primitive. Not blocking.

---

### P2 — Month-cost query is non-covering and all-rows-in-month for that agent (LOW today, watch)

**Where:** `src/costGuard.ts:89-92`:

```sql
SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_ledger
 WHERE agent_id = ? AND occurred_at >= ? AND is_oauth = 0
```

**Observation:** The index `idx_ledger_agent_time(agent_id, occurred_at)` matches both leading predicates and SQLite reports it as a "USING INDEX" (not "COVERING") search — it still has to fetch each row's payload to read `is_oauth` and `cost_usd`. That's correct and is the same plan the rate-count query uses, but the rate query is reported as **COVERING** because `COUNT(*)` doesn't need any non-key columns.

**Numbers (100k-row synthetic ledger, "main" agent has 30k rows in current month, in-memory DB):**

| Path | Latency / call |
|---|---|
| rate count (`COUNT(*)`)               | **1.9 µs** (covering index) |
| month sum (current schema)            | **5.5 ms** (index search + row fetch ×30k) |
| month sum + partial idx `WHERE is_oauth=0` covering `(agent_id, occurred_at, cost_usd)` | **0.6 ms** (~9× faster) |
| month sum + full covering `(agent_id, occurred_at, is_oauth, cost_usd)` | **1.1 ms** |
| insert into ledger                    | **3.0 µs** |

At realistic personal scale (a few hundred rows per month per agent, per the C16c numbers in `architecture.md`) this is sub-microsecond — every row in the partition fits in a single page. The 5.5 ms only shows up if you somehow rack up 10k+ rows for one agent in one month.

**Recommendation:** No action today. Document the watch threshold: if `/api/costguard/status` ever measurably slows or `cost_ledger` row count exceeds ~10k for a single agent in a single month, drop in the partial index — it's cheap, it's idempotent, it does not require a code change. Belongs in the Clawless lift conversation more than here.

---

### P3 — No pruning policy on `cost_ledger` (LOW)

**Where:** `src/costGuard.ts` (no `prune` method exists).

**Observation:** Ledger only grows. At the absolute upper bound for personal scale — one chat/min, 24/7 — that's 43,200 rows/month, all retained forever. Realistic: <1,000 rows/month.

The cost-cap query only scans rows in the current month for the relevant agent, so historical rows don't slow the cost path. The rate-count query scans only the last `rateWindowSeconds` (default 1 hour) for the agent, so historical rows don't slow that either. Old rows literally only cost disk space.

**Recommendation:** Accept. Monthly disk growth is bounded by your usage rate × ~80 B/row including index entries. A year of heavy use is < 50 MB. No prune policy needed at this scale; if you ever want one, scope it to "drop rows where `occurred_at < (now - 13 months)`" and run on server boot — the rate window is hours and the cost window is calendar-month, so 13 months is the safe floor.

---

### P4 — No N+1 between `check()` and `record()` (LOW, accept)

**Where:** `src/costGuard.ts:100-136` (check) and `:143-153` (record).

**Observation:** Audit prompt asked whether the agent is "read 1× per check() and again 1× per record() — could we collapse?" Answer: there is no read in `record()`. It's a single `INSERT` with no SELECT. The only "read" relating to the agent is `resolveCaps(agentId)` inside `check()`, and `record()` does not invoke the resolver at all (correctly, since recording shouldn't depend on enforcement config). No work to collapse here.

**Recommendation:** No action.

---

### P5 — Stream path: no double-record, no skipped-record (LOW, accept)

**Where:** `src/server.ts:447-454` (pre-flight check), `:566-571` (post-loop record).

**Observation:**

- Single check before the SDK loop opens (line 447). Single record after the loop closes (line 566). No record inside the loop.
- The record runs in **all** terminal paths: clean completion, mid-stream error caught at line 558, client-aborted stream caught by `clientClosed`, and the abort-controller-driven termination from `res.on("close", ...)` at line 463. The for-await loop exits in every case and the `record()` call happens unconditionally afterward.
- The non-stream path (`:354-395`) records exactly once: either inside the catch (line 391) and then early-returns, or after the loop (line 397). No path can double-record.
- Task-run path (`:754-759`) records exactly once after the loop; the `try/catch` around `taskQueue.complete/fail` at `:765` is downstream of the record and cannot affect it.

**Recommendation:** No action. Behavior matches the docstring on `record()`: "Failed calls should still be recorded — they consume rate budget."

One nuance worth noting (not a bug): on a stream that's aborted before any `system.init` arrives, `streamApiKeySource` is `undefined`, so `isOAuth: streamApiKeySource === "none"` evaluates `false`, and the record lands as a paid call. Since `costUsd` is also 0 in that case, it doesn't accidentally count toward the cost cap (the row is `is_oauth=0` but `cost_usd=0`, so `SUM(cost_usd)` is unaffected). It does still consume rate budget, which is correct.

---

### P6 — `startOfMonth()` allocations (LOW, accept)

**Where:** `src/costGuard.ts:121` (called once per check on the cost-cap path), `:168` (called once per `status()`).

**Observation:** Allocates two `Date` objects per call. Measured: **315 ns**. That's a rounding error against the 17 µs of P1, let alone the 1–10 s LLM call.

**Recommendation:** Accept. If anyone ever wants to trim it, replace with a cached `monthStart` that recomputes when `Date.now()` crosses the month boundary — but the savings are nanoseconds and the cache invalidation is non-trivial (timezone DST transitions). Not worth it.

---

### P7 — Synchronous SQLite work in the request path (LOW, accept)

**Where:** `src/costGuard.ts:106` (rate count), `:122` (month sum). better-sqlite3 is synchronous — this blocks the event loop for the duration.

**Observation:** Total worst-case `check()` cost is dominated by the month-sum query plus `resolveCaps()`:

- typical (caps unset → resolver returns undefined and both query branches skip): **~20 µs** (resolver only)
- typical (caps set, ledger small): **~25 µs** (resolver + 1.9 µs rate + ~1 µs month at <100 rows)
- pathological (caps set, 10k+ rows in month for agent): up to **~6 ms** worst case

For a single-user, single-process Express server on `:3333`, blocking the event loop for 25 µs per request is invisible. It would matter if Command Center ever became multi-tenant or fronted concurrent SDK calls (Clawless territory). It does not matter today.

**Recommendation:** Accept. If/when the Clawless lift happens and concurrency matters, the path can move to a worker thread or async sqlite binding — but that's an architectural change, not a CostGuard fix.

---

## Numbers — estimated added latency for a typical OAuth chat call

Personal scale, OAuth (Max plan), caps configured globally, ledger ~hundreds of rows, mac-class CPU:

| Stage | p50 | p99 |
|---|---|---|
| `resolveCaps()` — 5× `db.prepare().get()` | 18 µs | 30 µs |
| `rateCountStmt.get()` (covering index) | 2 µs | 5 µs |
| `monthCostStmt.get()` (small partition) | 2 µs | 8 µs |
| `startOfMonth()` | 0.3 µs | 0.5 µs |
| **Total `check()` overhead** | **~22 µs** | **~45 µs** |
| `record()` — single INSERT | 3 µs | 10 µs |
| **Total CostGuard overhead** | **~25 µs** | **~55 µs** |

For comparison, the call's wall time will be 1,000,000–10,000,000 µs (1–10 s) of LLM latency. CostGuard adds 0.0005% to the chat round-trip in the typical case. p99 latency for the chat-route remains LLM-bound.

If P1 (cached stmt) were applied: total `check()` overhead drops to ~7 µs p50 / ~15 µs p99.

---

## Watch list (matters at higher scale, fine today)

- **Settings statement caching** — the LOW above. Becomes meaningful only if many concurrent requests share the event loop; trivially fixable.
- **Partial covering index on `cost_ledger`** — `(agent_id, occurred_at, cost_usd) WHERE is_oauth=0` would 9× the month-cost query at 30k rows. No-op at <1k rows. Add only if the ledger grows.
- **Ledger pruning** — only relevant if disk pressure ever shows up. At 80 B/row and personal scale, you have years of headroom.
- **Async/worker-thread ledger writes** — moot for single-user. For the Clawless multi-tenant lift, consider batching ledger inserts in a write-behind queue so the request path doesn't pay the WAL fsync cost on durable mode.
- **`is_oauth` cardinality** — half-and-half today. If you ever flip everyone to OAuth, the cost-cap query effectively scans an empty result set, and the partial index above becomes free disk space. Re-evaluate if the OAuth-only assumption ever holds.
- **`/api/costguard/status` polling from the UI** — currently the only consumer issues a 5-cap-resolve + 2-query path. If a future UI polls this once per second for every agent in the sidebar, it's still <1 ms of work. Keep an eye on it if a status widget gets added.

---

## What I checked and did not flag

- **Prepared statement reuse on the ledger.** All three (`insertStmt`, `rateCountStmt`, `monthCostStmt`) are constructed once in the `CostGuard` constructor. No per-call `db.prepare`.
- **Index sufficiency.** EXPLAIN QUERY PLAN confirms both reads use `idx_ledger_agent_time` with both predicates applied. Rate query is COVERING (no row fetches). Month query is search-only (row fetches required for `cost_usd` + `is_oauth`); fine at personal scale.
- **`migrate(db)` boot cost.** Idempotent DDL. Same shape as `taskQueue.migrate()` — sub-ms on a warm cache.
- **Settings-route impact.** `POST /api/settings` (server.ts:941) does not invalidate any cache because there is no cache to invalidate. The CostGuard's prepared statements and the resolver capture `db` and `configValue` by reference, so a new setting value flows through the next `check()` automatically. Correct.
- **Per-agent override key validation.** `isCostGuardOverride()` at `server.ts:956` short-circuits invalid agent suffixes; cheap (Set + Map lookup). No path to a runaway settings table.
- **`status()` correctness vs caps unset.** When a cap is unset, `status()` returns `null` for `*Remaining` and runs `rateCountStmt`/`monthCostStmt` regardless. That's two unconditional queries on a path that's only used by `/api/costguard/status` — fine, but worth noting if status is ever called on a hot loop. Could be conditional on `caps.rateCapPerWindow` / `caps.costCapMonthlyUsd` being defined; ~5-line tweak.

---

## Verdict

- HIGH count: 0
- MED count: 0
- LOW count: 7 (one fix recommended, six accept)
- Overall: **Ship as-is**

The implementation is shaped well: standalone primitive, prepared statements in the constructor, indexes hit on every read, no double-record on the streaming path, no N+1 between check and record. The only thing worth a follow-up commit is the 3-line `getSetting` cache in `settings.ts` (P1), and that's a generic improvement that benefits every `configValue` caller — not a CostGuard-specific fix. Everything else is on the watch list for scale we don't have.

Read-only audit — no code changed.
