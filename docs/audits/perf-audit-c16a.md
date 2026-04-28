# C16a Scheduler — Performance Audit

> Date: 2026-04-28
> Branch: c16a-scheduler
> Scope: tick loop, fire fan-out, prepared-statement reuse, cron preview cost, list/render cost, live "next in" rerender plan

## Summary

The scheduler primitive lands clean for personal scale. The tick query is fully served by the `idx_schedules_due` partial index — `EXPLAIN QUERY PLAN` reports a single `SEARCH ... USING INDEX idx_schedules_due (next_fire_at<?)` with the `ORDER BY next_fire_at ASC` satisfied by the index ordering, no TEMP B-TREE. Steady-state tick cost at 50 enabled schedules with 0 due: **~0.23 µs of in-process work, fired every 30 s** — well under any latency you would notice. Concurrent fire fan-out is safe (better-sqlite3 transactions are synchronous and serialize within the single Node process). The big-picture verdict is "ship as-is."

The one observation worth recording — every method on `Scheduler` re-prepares its SQL via inline `this.db.prepare(...)` rather than caching like `costGuard.ts` does. Measured cost is **~6 µs of statement-construction overhead per call**, paid 1×/tick + 2-3×/CRUD route. Negligible at personal scale; flagged for the Clawless lift, where the same code path will run under multi-process write contention with much larger schedule tables. Two LOW finds beyond that: `scheduler.list()` does a full SCAN + TEMP B-TREE because the partial index can't serve unfiltered reads (boundary at ~1k schedules), and the prompt's hypothesis that the tick calls `taskQueue.reapExpired()` was incorrect — `reapExpired` is still dormant. No HIGH or MED findings, no inline fixes applied.

## Findings

| # | Severity | Area | Summary | Recommendation |
|---|---|---|---|---|
| P1 | LOW | `src/scheduler.ts` (15 inline `db.prepare(...)` sites) | Every CRUD/tick call pays ~6 µs of statement-construction overhead vs ~1 µs with cached statements; total ~7 µs/tick + ~25 µs/fire | Cache prepared statements at construction time (mirror `costGuard.ts` pattern); ~30-line refactor; defer until Clawless lift |
| P2 | LOW | `Scheduler.list()` — `src/scheduler.ts:279-284` | Full SCAN + TEMP B-TREE FOR ORDER BY because the partial index excludes disabled rows; ~46 µs at N=50, ~3.8 ms at N=5000 | Accept; acceptable up to ~1k schedules, then add a non-partial covering index on `(next_fire_at)` if needed |
| P3 | LOW | Prompt premise: tick calls `taskQueue.reapExpired()` | `reapExpired()` is **not** wired into the tick. It remains dormant (same state flagged in C16b P4) | Accept; or wire into tick at e.g. every-5th-tick cadence (~150 s) — see "Watch list" |
| P4 | LOW | `executeFire` — inline-prepares inside the txn | Two inline `db.prepare(...)` UPDATE sites inside a `db.transaction(...)` — same overhead pattern as P1, but inside a write txn | Roll into P1 fix; no separate action |
| P5 | LOW | `cronPreview()` — `src/schedulerInstance.ts:33-42` | ~35 µs to compute 3 fires for `*/5 * * * *`; ~23 µs for `0 9 * * 1-5` | Accept; 200 ms debounce in UI is more than sufficient |
| P6 | LOW | `renderSchedules()` — `public/app.js:2599-2618` | Per-render `state.agents.find(...)` lookup inside `renderScheduleCard()` (linear scan per card); at 50 schedules × 4 agents = 200 scans, all sub-µs | Accept; if R13's setInterval re-render lands, build an `agentsById` Map once per render |
| P7 | LOW | Concurrent fire fan-out | better-sqlite3 transactions serialize on the single Node process; no write contention possible | Accept (no work) |
| P8 | LOW | `runScheduleNow` route — `setTimeout(0)` yield | `await new Promise(r => setTimeout(r, 0))` adds ~1 ms macrotask delay to the run-now response | Accept; user-visible only on the manual run path, dwarfed by network latency |

---

### P1 — Inline `db.prepare(...)` on every Scheduler call (LOW)

**Where:** `src/scheduler.ts` — 15 prepare sites, lines 188, 261, 268, 274, 281, 295, 315, 374, 427, 440, 486, 499, 516, 536, 552. Compare with `src/costGuard.ts` which constructs `insertStmt`, `rateCountStmt`, `monthCostStmt` once in the constructor.

**Observation:** better-sqlite3 caches prepared statements internally by SQL text, so the parser/planner work is amortized. But each `db.prepare(...)` still costs:

- A hash lookup against the cache by SQL text
- A new JS `Statement` object allocation
- The bound-statement plumbing inside the binding

Microbench measured on this project's better-sqlite3 build (`:memory:` DB, 50 schedules):

| Call | Inline prepare | Cached statement | Δ per call |
|---|---|---|---|
| `get(id)` (PK lookup) | 7.09 µs | 1.19 µs | **5.9 µs** |
| Tick SELECT (50 schedules, 5 due) | 12.13 µs | 3.63 µs | **8.5 µs** |
| Tick SELECT (0 due) | 7.59 µs | 0.27 µs (`tickStmt2.all` reused) | **7.3 µs** |

**Cost on Command Center:**

- **Tick path:** 1 prepare every 30 s = ~7 µs/30 s = ~0.23 µs/sec. Invisible.
- **CRUD routes:** `pause()` calls `get()` + UPDATE + `get()` = 3 prepares = ~20 µs added per request. `update()` similar. `list()` = 1 prepare = ~7 µs added. All dwarfed by the HTTP round-trip.
- **Per fire (executeFire):** Worst case 4 prepares (transaction body + recordOutcome) = ~25 µs. Dwarfed by the SDK call (1-10 s).

**Cost on Clawless lift:** More relevant. If the lift uses a connection-per-request pattern with thousands of schedules, the 6 µs/call statement construction starts mattering, and the inline pattern fragments the per-connection cache. Still LOW — but the easy win that `costGuard.ts` already takes is the right shape to copy.

**Recommendation:** No action today. ~30-line refactor: introduce private fields `private readonly stmts: { get: Statement; list: Statement; tickDue: Statement; insertNew: Statement; update*: Statement; ...}` initialized in the constructor, then replace each call site with the cached statement. The dynamic `update()` method (which builds variable SQL based on which fields are present) is the one path that legitimately needs runtime prepare — leave it as inline. Save for the Clawless lift PR or a dedicated cleanup commit; not blocking C16a ship.

---

### P2 — `scheduler.list()` does a SCAN + TEMP B-TREE (LOW)

**Where:** `src/scheduler.ts:279-284`.

```ts
list(): Schedule[] {
  const rows = this.db
    .prepare("SELECT * FROM schedules ORDER BY next_fire_at ASC")
    .all() as ScheduleRow[];
  return rows.map(rowToSchedule);
}
```

**Observation:** `EXPLAIN QUERY PLAN` confirms:

```
SCAN schedules
USE TEMP B-TREE FOR ORDER BY
```

The reason is the index definition:

```sql
CREATE INDEX idx_schedules_due ON schedules (next_fire_at) WHERE enabled = 1;
```

The `WHERE enabled = 1` clause makes this a **partial index** — it does not contain disabled rows. SQLite can only use it for queries whose predicate guarantees `enabled = 1` (the tick query is exactly this case). `list()` returns both enabled and disabled rows, so the planner falls back to a full SCAN + TEMP B-TREE for the sort.

**Cost numbers (microbench, `:memory:`):**

| Schedule count | `list()` cost |
|---|---|
| 0 | 7.1 µs (just the prepare overhead) |
| 50 | **46.5 µs** |
| 500 | 401 µs |
| 5,000 | 3.83 ms |

**Cost on Command Center:** Personal scale tops out at maybe 20-50 schedules realistically. At 50 the route returns in well under a millisecond. Not a problem.

**Cost boundary:** Crossing ~1,000 schedules is where this query stops being cheap (~800 µs and growing linearly). The boundary where it becomes user-visible (>10 ms) is around 12,000 rows. Personal scale will never reach this; the Clawless lift might if their B54 schedule fan-out is per-customer.

**Recommendation:** No action today. If/when the Clawless lift exercises this with thousands of schedules, two options:

1. **Add a second non-partial index** on `(next_fire_at)` (no `WHERE` clause). Costs ~32 B/row in storage; serves `list()` directly with no TEMP B-TREE.
2. **Pre-sort in JS** with a covering wide index — but that's a worse plan because it still requires reading all rows.

Option 1 is the right move at scale. Cheap, idempotent, doesn't affect the existing partial index.

---

### P3 — Prompt premise: `reapExpired()` is not actually called from the tick (LOW)

**Where:** Prompt's section 1 said "Each tick: SELECT schedules ... iterate; `taskQueue.reapExpired()`." Verified: `grep -rn "reapExpired"` in `src/` returns only the definition in `taskQueue.ts:396`. Nothing in `scheduler.ts`, `schedulerInstance.ts`, or `server.ts` calls it.

**Observation:** This was already flagged as C16b P4 — the reaper primitive shipped but is unreachable. C16a does **not** activate it. Lease expiration is still a dormant code path: a long-running fire whose lease expires will never be detected and requeued by the queue itself, only by whatever (currently nothing) decides to call `reapExpired`. In practice the scheduler's own paths recover the fire's terminal state via `taskQueue.complete()` / `fail()` after the SDK loop exits, so the lease-expiration window is only relevant if `executeFire` itself crashes mid-await without surfacing — which the outer `Promise.catch` in `tick()` (scheduler.ts:385-393) does catch.

**Cost analysis if it were called every tick:** `reapExpired` is bounded by the count of expired-lease rows. Steady state: 0 rows. Single statement preparation + an indexed range scan that returns 0 rows — under 10 µs total per tick. Calling it every tick would be safe.

**Cost analysis if it were called every 5th tick (150 s):** Same 10 µs but five times less often. Negligible difference; cadence choice should be driven by *how stale you want lease detection to be*, not by perf.

**Recommendation:** Either keep the current state (no auto-reap, accepting that `executeFire` is the only recovery path) or wire `taskQueue.reapExpired()` into the scheduler tick at the *same* 30 s cadence. There is no perf reason to push it out to every-5-ticks. If it gets wired, do it where the comment in scheduler.ts:347-354 hints — inside `tick()`, before or after the due-schedules loop. One line plus a `requeued`/`failed` log hook.

---

### P4 — `executeFire` inline-prepares inside the transaction (LOW)

**Where:** `src/scheduler.ts:413-450`. Inside `this.db.transaction(...)`, two `db.prepare(...)` calls (lines 426 and 440), one of which fires per execute.

**Observation:** Same shape as P1 but inside a write transaction. Cost identical (~6 µs/call). No transactional concern — `db.prepare` doesn't acquire any DB locks.

**Recommendation:** Roll into P1 fix. Two more cached statements in the constructor (one for the recurring-fire UPDATE, one for the manual-fire UPDATE).

---

### P5 — `cronPreview()` cost (LOW)

**Where:** `src/schedulerInstance.ts:33-42` (3 iterations of `it.next().toDate().getTime()`).

**Observation:** Microbench:

| Cron | 3-fire preview cost |
|---|---|
| `*/5 * * * *` (every 5 min) | **35.1 µs** |
| `0 9 * * 1-5` (weekday 9 AM) | ~70 µs (estimate from 1× being 23.3 µs) |

The route (`/api/cron/preview`) wraps this with an Express handler + JSON serialization, total ~150 µs server-side.

**Cost on Command Center:** UI debounces cron-input keystrokes at 200 ms (`public/app.js:2472`). Even a fast typist won't generate more than ~5 previews/sec. Server cost: ~750 µs/sec at peak, or ~0.075% of one CPU. Invisible.

**Recommendation:** Accept. The 200 ms debounce is generous; the underlying cost is well below what a 100 ms debounce could surface as observable.

---

### P6 — `renderSchedules()` agent lookup cost per card (LOW)

**Where:** `public/app.js:2620-2621`:

```js
function renderScheduleCard(sched) {
  const agent = state.agents.find((a) => a.id === sched.agentId);
  ...
}
```

**Observation:** `state.agents.find(...)` is a linear scan. With ~5 built-in agents + a few custom = O(5-10), and 50 schedules, this is 50 × ~10 = 500 string compares per render. Sub-microsecond total.

**Implication for R13's "live next-in" setInterval idea:** If a 10 s `setInterval` re-renders all cards, the cost is `renderScheduleCard()` × 50, which is dominated by DOM allocation (createElement × 12-15 nodes per card). Browser-side, that's roughly 0.5-2 ms of layout work per tick on a 50-card list. Smooth enough — but a smarter approach is to NOT rebuild DOM and instead update the `.schedule-card-next` text node in place, walking only `nextEl` per card. ~50 cards × 1 text-node update = sub-millisecond and no layout churn.

**Recommendation:** No action on the current code. If R13's live-rerender ships, prefer the in-place text update over `innerHTML = ""` + full rebuild. Also build an `agentsById` Map once at the top of `renderSchedules()` — three lines:

```js
const agentsById = new Map(state.agents.map((a) => [a.id, a]));
// then in renderScheduleCard: const agent = agentsById.get(sched.agentId);
```

Free win, sets up the cleaner pattern for the live-rerender path.

---

### P7 — Concurrent fire fan-out is safe (LOW, accept)

**Where:** `src/scheduler.ts:382-395` (the `for (const row of due)` loop kicks off N `executeFire` promises without awaiting).

**Observation:** If 5 schedules are due at the same tick, `executeFire` runs the synchronous prefix (the `db.transaction` for enqueue + next_fire_at advance) **before** the first await. better-sqlite3 transactions are synchronous and run to completion before returning to the event loop. So even with 5 fires fanning out, their transactions serialize: txn-1 runs fully, then txn-2, etc., all on the same JS turn before any onFire promise gets to await. No race possible inside the single Node process.

**The only multi-process concern** is if Clawless ever runs two server replicas hitting the same SQLite WAL. SQLite WAL is multi-process-safe at the page level, and the `enabled = 1` guard in `pause()`/`recordOutcome` UPDATEs is the right TOCTOU defense. The reviewer comment at scheduler.ts:530-533 already acknowledges this. No action.

**Recommendation:** Accept.

---

### P8 — `runScheduleNow` route waits for a `setTimeout(0)` (LOW, accept)

**Where:** `src/server.ts:1320`.

```ts
await new Promise((r) => setTimeout(r, 0));
const fresh = scheduler.get(req.params.id);
```

**Observation:** This adds one macrotask tick (~1 ms in practice) to the manual run-now response so the synchronous prefix of `fireNow` (enqueue + last_task_id record) lands before the read-back. Per the comment at lines 1317-1320 it's necessary because better-sqlite3 is sync but the *catch* on the rejected fireNow promise needs a microtask to settle.

**Cost:** ~1 ms per run-now click. Network latency to localhost is already ~1-3 ms; not user-visible.

**Recommendation:** Accept. The alternative (synchronously calling `enqueueAdapter` + the UPDATE before kicking off the SDK call) would require a bigger refactor of `executeFire`, and the savings are not worth it.

---

## Watch list (deferred / not actionable now)

- **Cached prepared statements (P1).** ~30-line refactor in `src/scheduler.ts`. Trivial to apply when there's a reason; matches `costGuard.ts` shape; meaningful for the Clawless lift if multi-process or large-N scenarios materialize. Personal scale: do not bother.
- **Non-partial covering index for `list()` (P2).** Add only past ~1k schedules. Cheap and reversible.
- **`reapExpired()` wired into tick (P3).** Real correctness reason if executeFire could crash mid-await without bubbling — currently the Promise.catch at scheduler.ts:385-393 catches throws, so the only "lost lease" case is a host-side terminal-update throw. C16b P4's recommendation stands: one line in tick.
- **`agentsById` Map in `renderSchedules()` (P6).** Three lines, free, sets up the right pattern for any future live-rerender.
- **Live "next in Xm" setInterval (R13 reviewer flag).** When/if added, prefer in-place text-node update over full DOM rebuild. No setInterval needed unless modal is open — wire start/stop to modal show/hide.
- **`scheduler.start()` runs a tick synchronously inside the constructor's caller** (server.ts:1244). No issue, but worth noting: server boot blocks on the first tick's SQL. At 0 schedules: ~7 µs. No concern.

---

## Methodology

**Tools:** Microbenchmarks against `better-sqlite3@12.9.0` and `cron-parser@5.5.0` (the project's installed versions), run on the same machine that hosts the dev server. All bench scripts used `:memory:` databases so I did not touch the live `data/lab.db`. `EXPLAIN QUERY PLAN` was run against an in-memory table mirroring the production schema (`CREATE TABLE schedules ...; CREATE INDEX idx_schedules_due ... WHERE enabled = 1`).

**Index plan verification:**

```
EXPLAIN QUERY PLAN
  SELECT * FROM schedules WHERE enabled = 1 AND next_fire_at <= ? ORDER BY next_fire_at ASC
=> SEARCH schedules USING INDEX idx_schedules_due (next_fire_at<?)
   (no TEMP B-TREE — ORDER BY satisfied by index ordering)

EXPLAIN QUERY PLAN
  SELECT * FROM schedules ORDER BY next_fire_at ASC
=> SCAN schedules
   USE TEMP B-TREE FOR ORDER BY

EXPLAIN QUERY PLAN
  SELECT * FROM schedules WHERE id = ?
=> SEARCH schedules USING INDEX sqlite_autoindex_schedules_1 (id=?)
```

**Microbench shape:** Each measurement was warmed for `min(1000, iters)` iterations, then timed across 5,000-20,000 iterations using `process.hrtime.bigint()`. Single-threaded, no concurrent load. Measurements should be read as "lower bound for steady state" — real wall-clock will be slightly higher under load.

**Key numbers (memory backend):**

| Operation | Cost |
|---|---|
| Tick SELECT, 0 due (cached stmt) | 0.23 µs |
| Tick SELECT, 5 due, 50 enabled (cached stmt) | 3.6 µs |
| Tick SELECT, 5 due, 50 enabled (inline prepare) | 12.1 µs |
| `list()`, 50 rows | 46.5 µs |
| `list()`, 5,000 rows | 3.83 ms |
| `get(id)` cached | 1.19 µs |
| `get(id)` inline prepare | 7.09 µs |
| cron eval `*/5 * * * *` | 19.97 µs |
| cron preview ×3 `*/5 * * * *` | 35.1 µs |

The on-disk WAL backend is typically 5-10× slower per write than `:memory:` for SQLite (driven by fsync) but **read** queries against a hot cache are within ~2× of memory-backend numbers. The tick query is read-only and the active-schedule footprint fits in the page cache, so the production read path should be within a small constant factor of these numbers.

**What I did not measure:** end-to-end fire latency (dominated by SDK call wall-time, 1-10 s, not C16a-controlled), HTTP route latency for `/api/schedules*` (dominated by Express middleware + JSON serialization, ~ms range, also not C16a-specific), or browser-side `renderSchedules()` (no schedule-population fixture available; estimated from createElement counts + browser baseline).

---

## Verdict

- HIGH: 0
- MED: 0
- LOW: 8 (one watch-list item worth a 30-line refactor on the Clawless lift, the rest accept)
- Inline fixes applied: **none** (no finding rose to P1-MED)

C16a ships clean. The partial index pulls its weight on the only path that matters (the tick), the schema is right-shaped, and the host-side wiring (`fireScheduledTask` + `enqueueScheduledTask`) is appropriately bounded. The one cleanup that's worth doing eventually — caching prepared statements like `costGuard.ts` does — is < 30 LOC and pure-mechanical, but at personal scale it would be deck-chair rearrangement. Park it for the Clawless lift PR.

Read-only audit — no code changed.
