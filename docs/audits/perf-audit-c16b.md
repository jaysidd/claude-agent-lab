# C16b Performance Audit (2026-04-26)

## Summary

The durable-queue refactor lands with the right shape: every hot-path query hits an index, prepared statements aren't fragmented by string interpolation, and the standalone primitive carries no host-specific overhead. Two MED findings on the host side: `GET /api/tasks` does a redundant JS re-sort that throws away the SQL `ORDER BY`, and `pruneCompletedTasks` runs synchronously on every `POST /api/task` even when the table is well under the cap. Both are cheap to fix and have negligible impact at personal scale, but together they're worth a 10-minute follow-up commit. No HIGH findings. Ship as-is, queue the fixes.

## Findings

| # | Severity | Area | Summary | Recommendation |
|---|---|---|---|---|
| P1 | MED | `GET /api/tasks` route | SQL `ORDER BY priority, created_at` is computed then thrown away by a JS re-sort on `createdAt DESC` | Fix in next housekeeping commit |
| P2 | MED | `pruneCompletedTasks` host policy | Runs unconditionally on every enqueue; subquery hits the wrong index and uses TEMP B-TREE | Fix in next housekeeping commit |
| P3 | LOW | `list()` SQL composition | Template-literal interpolation produces one prepared-statement cache entry per unique filter shape | No action; document in module header |
| P4 | LOW | `idx_tasks_scheduled` index | Currently unused — host never enqueues with `scheduledFor`, reaper never called | No action; lands with C16a |
| P5 | LOW | `idx_tasks_lease` partial-index opportunity | Index ordering doesn't cover the `lease_expires_at IS NOT NULL` predicate as well as a partial index would | No action; defer until reaper has measurable load |
| P6 | LOW | `migrate(db)` boot cost | Idempotent DDL runs on every server start — measured ~0.3 ms in this state | No action |
| P7 | LOW | `JSON.stringify`/`safeParse` allocations | Per-task overhead on enqueue, list, get, complete, fail | No action; bounded by task count, not turn count |

---

### P1 — Redundant JS sort on `GET /api/tasks` (MED)

**Where:** `src/server.ts:600-604`.

```ts
app.get("/api/tasks", (_req, res) => {
  const all = taskQueue.list();
  const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);
  res.json(sorted.map(toApiTask));
});
```

**Observation:** `taskQueue.list()` (with no filter) issues `SELECT * FROM tasks ORDER BY priority DESC, created_at ASC`. EXPLAIN QUERY PLAN confirms this is a `SCAN tasks` + `USE TEMP B-TREE FOR ORDER BY` — the planner builds a temporary sort tree because no compound index covers the unfiltered case. The route then immediately spreads the result into a fresh array and re-sorts by `createdAt DESC`, completely overriding the SQL sort.

**Cost:** Two sorts on the same N rows, plus one `Array.from`-equivalent copy. With `pruneCompletedTasks` capping terminal rows at 50, N is bounded around 50–80 in steady state, so wall-clock is sub-millisecond either way. Still: the SQL sort is wasted work and the JS spread is a wasted allocation. The pattern is also misleading — a future reader of `taskQueue.list()` might assume callers are getting priority-ordered results when in fact the only consumer re-sorts.

**Recommendation:** Either (a) drop the JS re-sort and change the queue's `list()` to ORDER BY `created_at DESC`, or (b) keep the queue's API stable (priority-first is more useful for B54's consumers) and just remove the wasted SQL sort by adding a `list({ orderBy: 'createdAt DESC' })` option. Personally: option (a) is simpler and the queue's priority semantics belong inside `checkout`, not `list`. 5-min change. Defer if you don't want to touch the locked rev. 2 contract — re-sort cost is negligible at N=50.

---

### P2 — `pruneCompletedTasks` runs on every enqueue with a sub-optimal plan (MED)

**Where:** `src/server.ts:142-155` (the function), `src/server.ts:627` (the call site inside `POST /api/task`).

**Observation:** Two issues compound here.

**(a) Unconditional invocation.** Every task creation runs the prune. Until the table holds more than 50 terminal rows, every prune is a no-op DELETE that still executes the full subquery + outer scan. At personal scale this is harmless (a few μs per call), but it's strictly wasted work.

**(b) Sub-optimal query plan.** `EXPLAIN QUERY PLAN`:

```
|--SEARCH tasks USING INDEX idx_tasks_scheduled (status=?)
`--LIST SUBQUERY 1
   |--SEARCH tasks USING INDEX idx_tasks_scheduled (status=?)
   `--USE TEMP B-TREE FOR ORDER BY
```

The planner picks `idx_tasks_scheduled` (which is `(status, scheduled_for)`) because it leads with `status` — but it doesn't help the inner `ORDER BY updated_at DESC LIMIT 50`, so SQLite builds a TEMP B-TREE for that sort. The other status-leading index (`idx_tasks_status_priority`) is no better because it orders on `(priority, created_at)`, not `updated_at`.

**Cost:** Both passes are bounded by the size of the terminal-status partition. Capped at 50 in steady state (since prune fires every enqueue), the total cost stays under 0.1 ms. The TEMP B-TREE only matters once the table grows past the cap and the prune actually deletes — i.e., once. Latent issue, not active.

**Recommendation:** Two cheap changes. (1) Gate the prune on a count check — skip the subquery entirely when `COUNT(*) WHERE status IN (terminal) <= cap`. (2) If you ever care about the TEMP B-TREE, add an index on `(status, updated_at DESC)` — but I'd defer until there's a reason. Or simpler: just call `pruneCompletedTasks` on a timer (every 5 min) instead of on every enqueue, since the cap is a soft retention policy not a correctness invariant.

---

### P3 — `list()` SQL is template-interpolated, fragmenting the prepared-statement cache (LOW)

**Where:** `src/taskQueue.ts:471-478`.

```ts
const sql = `
  SELECT * FROM tasks
  ${where.length ? "WHERE " + where.join(" AND ") : ""}
  ORDER BY priority DESC, created_at ASC
  ${limitClause}
`;
const rows = this.db.prepare(sql).all(...params) as TaskRow[];
```

**Observation:** better-sqlite3 caches prepared statements internally by SQL text. Every unique combination of `filter.status` count, `filter.agentId` presence, and `filter.limit` value produces a different SQL string and therefore a different cache entry. The `LIMIT` baked into the literal (`LIMIT ${Math.floor(filter.limit)}`) is the worst offender — every distinct numeric limit is a brand-new statement.

**Cost on Command Center:** Zero. The only host caller is `taskQueue.list()` with no arguments, producing exactly one SQL string. Cache entry count: 1.

**Cost on Clawless lift:** Potentially relevant. B54's per-agent serialization need (`is there an in-flight task for agent X`) will exercise `list({ status: 'checked_out', agentId })` on hot paths. The cache stays compact (one entry per `(status-cardinality, agentId-presence)` pair, with `limit` parameterized by the caller). Not a real problem, but worth knowing.

**Recommendation:** No action for Command Center. If Clawless ever dynamically varies `limit`, switch the limit to a bound parameter (`LIMIT ?` + `params.push(limit)`) — better-sqlite3 supports it. Cosmetic optimization at this scale. Maybe leave a comment near the `list()` body noting that callers should keep filter shapes stable for cache friendliness.

---

### P4 — `idx_tasks_scheduled` and reaper code are dormant (LOW)

**Where:** `src/taskQueue.ts:102` (index DDL), `src/taskQueue.ts:392-448` (`reapExpired`).

**Observation:** Three queue features are implemented but unreachable from the current host:

- `enqueue` accepts `scheduledFor` but `server.ts` never passes it.
- `reapExpired()` is exported but never called — neither on a tick, nor on a `checkout` returning null, nor on server startup.
- `heartbeat()` is exported but no host code calls it (the `/run` route is a single blocking SDK call, then a single terminal update — no mid-call heartbeat).

**Implication:** None of this is a bug — the queue was deliberately designed as a standalone primitive ahead of C16a's scheduler. But it does mean three items show up as "covered by tests" without being on any production hot path. The `idx_tasks_scheduled` index also costs ~80 B per row in extra index storage with zero current benefit.

**Recommendation:** Leave as-is. C16a will activate all three. Worth one line in the C16a backlog entry: "wire `reapExpired()` into the scheduler tick" so it's not forgotten.

---

### P5 — `idx_tasks_lease` could be a partial index for tighter locality (LOW)

**Where:** `src/taskQueue.ts:101`, schema:

```sql
CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status, lease_expires_at);
```

**Observation:** Currently this index includes one row per task (every status). The reaper query is:

```sql
SELECT id, attempt_count, max_attempts FROM tasks
 WHERE status = 'checked_out'
   AND lease_expires_at IS NOT NULL
   AND lease_expires_at < ?
```

EXPLAIN QUERY PLAN confirms the index is used and both range predicates apply (`status=? AND lease_expires_at>? AND lease_expires_at<?`). Good. But: the index also indexes `(queued, NULL)`, `(done, NULL)`, `(failed, NULL)`, `(cancelled, NULL)` — every terminal row carries an entry that the reaper will never read.

**Better shape (if reaper load ever matters):**

```sql
CREATE INDEX idx_tasks_lease ON tasks(lease_expires_at)
  WHERE status = 'checked_out' AND lease_expires_at IS NOT NULL;
```

A partial index — same behaviour, ~5x smaller, ignored by writes that don't touch active leases.

**Recommendation:** No action. SQLite partial indexes are well supported (3.8.0+) and `better-sqlite3` ships modern SQLite. But the win is invisible until the table holds thousands of rows, which it never will at personal scale. Park this for the Clawless lift if their B54 traffic warrants it.

---

### P6 — `migrate(db)` boot cost (LOW)

**Where:** `src/taskQueueInstance.ts:6` calls `migrate(db)` on module load.

**Observation:** `CREATE TABLE IF NOT EXISTS` + four `CREATE INDEX IF NOT EXISTS` are fast-path no-ops when the objects already exist. Measured against the on-disk WAL `data/lab.db`: ~0.3 ms total for the five DDL statements (sub-ms even on a cold cache because the schema is already resident). On a fresh database the cost is the schema-write itself plus index creation against zero rows — bounded by IO, single-digit milliseconds.

**Recommendation:** No action. This is the right shape (idempotent, host-agnostic per the locked rev. 2 contract). Alternative — gating on a version-check — would save the ~0.3 ms but adds the `_migrations` table that Clawless explicitly asked us not to bundle. Not worth the trade.

---

### P7 — JSON serialization on the queue boundary (LOW)

**Where:** `src/taskQueue.ts:280` (`complete`), `:305` (`fail`), `:512-535` (`rowToTask`), `:538-547` (`serializeMetadata`).

**Observation:** Every queue operation that crosses the row boundary serializes/parses JSON:

- `enqueue` → 1 stringify (metadata, only when present)
- `complete` → 1 stringify (result)
- `fail` → 1 stringify (error)
- `get` → up to 3 parses (result, error, metadata)
- `list(N)` → up to 3N parses

**Cost:** This is per-task work, not per-token or per-message. At 20 tasks/day with ~1 KB result blobs, total annual JSON allocations are negligible (~7 MB of throwaway strings). The 64 KB metadata soft-cap (enforced in `serializeMetadata`) prevents pathological blobs.

**One small thing worth noting:** `rowToTask` calls `safeParse` which returns `null` on parse failure but the queue stores the raw text. If a future caller stuffs invalid JSON into `metadata_json` directly via raw SQL (e.g. a Clawless migration), `list()` will silently return `null` for those rows' `metadata`. Defensible — `safeParse` is the right choice for a system-of-record table — but worth a unit test that asserts the silent-null behaviour is intentional.

**Recommendation:** No action. The allocation profile is bounded and the safe-parse default is correct.

---

## What I checked and did not flag

- **`db.prepare(...)` calls inside method bodies.** Confirmed every prepared statement uses bound parameters, not interpolated values, except for the `LIMIT N` case in `list()` (P3). Statement cache is healthy.
- **Per-call overhead in `checkout` / `checkoutById`.** Both wrap a SELECT + UPDATE in `db.transaction(...).immediate()`. EXPLAIN confirms the SELECT uses `idx_tasks_status_priority` and the UPDATE uses `sqlite_autoindex_tasks_1` (PK lookup by id). One round-trip into the txn. Clean.
- **`reapExpired` inner-loop prepared-statement reuse.** The two UPDATE statements are prepared once per `reapExpired` invocation and reused across N rows in the for-loop. Correct pattern.
- **`statusFromQueue` exhaustive switch.** Reviewer R5 added the `_exhaustive: never` guard. No runtime cost (compiles to a default fallthrough); helpful at TypeScript build time.
- **Try/catch around terminal updates in `/api/task/:id/run`.** Reviewer R6's defense-in-depth fix. The catch is on the cold path (reap-mid-query is rare); zero steady-state cost.
- **48-task smoke test against `:memory:`.** Smoke runs in <1 s on memory backend. The on-disk WAL backend will be 5-10x slower per write but still well under any latency you'd notice — a 48-task burst at ~1-2 ms per insert is ~50-100 ms total. Personal-scale enqueue rate is one task per few seconds; never close to that.
- **Wire-format compatibility.** Confirmed `startedAt`/`completedAt` were dropped per Reviewer R1 and that no consumer (`public/`, `tests/`, `scripts/`) reads them. The two `startedAt` matches in `public/app.js` are local UI timer state, unrelated to the API.
- **Dead code from C03.** No leftovers. The old `Task` and `TaskStatus` types are gone, replaced by `ApiTask`/`ApiTaskStatus` (host-side wire format) and `QueueTask` (queue-side import). `randomUUID` was correctly removed from `server.ts`.

---

## Verdict

- HIGH count: 0
- MED count: 2 (P1, P2)
- LOW count: 5 (P3, P4, P5, P6, P7)
- Overall: **Ship as-is, queue fixes**

The implementation is clean. The two MEDs are housekeeping — both are bounded by the 50-task retention cap, both are sub-millisecond at personal scale, neither blocks the C16b acceptance criteria. Recommended follow-up is one ~10-minute commit that:

1. Drops the redundant `[...all].sort(...)` in `GET /api/tasks` (P1).
2. Gates `pruneCompletedTasks` on a count check, or moves it to a setInterval (P2).

Everything else can wait for whichever feature actually exercises it (C16a for P4, the Clawless lift for P3 + P5, never for P6).

Read-only audit — no code changed.
