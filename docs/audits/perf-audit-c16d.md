# C16d Approval Gates — Performance Audit

> Date: 2026-04-29
> Branch: c16d-approvals
> Scope: hook overhead per tool call, production-cwd resolution, orphan sweep, list/poll cost, awaiter Map memory, hook-timeout leak.

## Summary

C16d lands in good shape at personal scale. Hook synchronous overhead is ~8 µs (INSERT + Promise + Map.set) — invisible against 1–10 s of LLM/tool latency. The orphan sweep is a near-no-op on boot (2 µs steady state, ~1.2 ms even at 1k pathological orphans). Awaiter Map memory is bounded by concurrent dangerous tool calls (~300 B/entry; tens of MB only at thousands of in-flight approvals — unreachable at personal scale).

One MEDIUM finding worth fixing: `approvals.list({status: 'pending'})` — the endpoint the UI polls every 5 s — bypasses the `idx_approvals_pending` partial index because the query is shaped `WHERE status IN (?)` instead of `WHERE status = ?`. SQLite's partial-index matcher does not trigger on `IN`, so the polling query falls back to a full table scan + temp B-tree sort. At ~10k historical decided/expired rows (a few months of moderate use, no pruning policy) the poll costs **~570 µs/call**; with the fix it drops to **~20 µs/call (28× faster)** and remains flat regardless of historical row count. Fix is < 10 LOC, applied inline (see P1 below).

Other findings are LOW: per-call INSERT re-prepares (P3, ~7 µs avoidable), `cwdIsProductionMarked` reading SQLite per dangerous tool call (P4, ~1 µs avoidable), unbounded approvals table (P6, no pruning policy). All accept-or-defer.

- HIGH: 0
- MED: 1 (fixed inline)
- LOW: 6

## Findings

| # | Severity | Area | Summary | Recommendation |
|---|---|---|---|---|
| P1 | MED | `src/approvals.ts:308-312` (UI poll path) | `list({status: 'pending'})` uses `WHERE status IN (?)` which **does not** trigger the partial index `idx_approvals_pending`; full table scan + temp B-tree sort instead | **Fixed in this audit**: single-status branch now emits `status = ?` and hits the partial index |
| P2 | LOW | `src/server.ts:1131-1143` `cwdIsProductionMarked` | Two `path.resolve` per call inside the loop; one is loop-invariant | Accept (~0.3 µs); not worth a closure cache |
| P3 | LOW | `src/approvals.ts:175-191` INSERT re-preparation | `db.prepare(...)` runs per `create()` call; ~15 µs vs ~7 µs cached | Defer (one-time fix, ~3 LOC) — invisible against the hook's 1-10 s wait |
| P4 | LOW | `src/server.ts:1131-1143` reads `settings` table per dangerous tool call | `configValue("approvals.production_cwds")` SELECT on every gated tool fire; ~0.6 µs | Accept (cached one level deeper via `settings.ts` getStmt — C16c P1 already landed) |
| P5 | LOW | `expireOrphaned()` boot cost | 2 µs steady state (no orphans); 1.2 ms at 1k pathological orphans | Accept; invisible to humans |
| P6 | LOW | `pending_approvals` has no pruning policy | Every approved/rejected/expired row lives forever; bloats UI poll once P1 lands the index, but un-bounded growth still hits `list({taskId})` (uses `idx_approvals_task` SCAN per task) | Defer; queue a `prune(olderThan)` method for if row count crosses ~10k |
| P7 | LOW | `Promise.all([fetch /api/tasks, fetch /api/approvals?status=pending])` 5 s poll | Two SQL queries per cycle; with P1 applied, total < 50 µs server-side at any reasonable scale | Accept |
| P8 | LOW | `renderTasks` + `renderApprovalPanel` full innerHTML rebuild every poll | At 50 tasks + 5 approvals: ~2-5 ms render; `state.agents.find` linear lookup per card (carry-over from C16a R10, not a C16d regression) | Defer; out of C16d scope |

---

### P1 — UI poll bypasses partial index (**MED, fixed inline**)

**Where:** `src/approvals.ts:308-312` and the operator-facing route at `src/server.ts:1556-1559`.

**Observation.** The `list({status: 'pending'})` path is the hot one — the UI calls `/api/approvals?status=pending` every 5 s while the tasks modal is open. The schema declares a partial index *literally for this query*:

```sql
CREATE INDEX IF NOT EXISTS idx_approvals_pending
  ON pending_approvals (created_at)
  WHERE status = 'pending';
```

But the SQL `list()` builds is:

```js
where.push(`status IN (${statuses.map(() => "?").join(",")})`);
```

…which produces `WHERE status IN (?)` even for a single-status filter. SQLite's partial-index matching requires the WHERE clause to literally include the predicate the index was defined with — `status = 'pending'` (or `status = ?` with `?` bound to `'pending'`) qualifies; `status IN (?)` does not. EXPLAIN QUERY PLAN confirms:

```
WHERE status = 'pending'   → SCAN USING INDEX idx_approvals_pending          ✓
WHERE status = ?           → SCAN USING INDEX idx_approvals_pending          ✓
WHERE status IN (?)        → SCAN pending_approvals + USE TEMP B-TREE        ✗
```

**Numbers (in-memory DB, 5000 iters/cell):**

| `decided` rows | `pending` rows | Current `IN (?)` | Fixed `= ?` | Speedup |
|---|---|---|---|---|
| 0 | 0 | 0.6 µs | 12.3 µs | (cold) |
| 100 | 0 | 5.3 µs | 11.8 µs | — |
| 1,000 | 0 | 49.8 µs | 13.2 µs | 3.8× |
| 10,000 | 0 | 566.7 µs | 13.9 µs | **40×** |
| 1,000 | 5 | 66.2 µs | 21.9 µs | 3.0× |
| 10,000 | 5 | 573.9 µs | 20.3 µs | **28×** |

(The cold/empty case is faster on `IN` because there are zero rows so the scan completes immediately, while `=` still has to consult the partial-index B-tree. Once any historical rows exist, `IN` loses by an order of magnitude.)

The killer is that **decided/expired/rejected rows accumulate forever** — there's no pruning policy (P6). A user who runs Command Center against a production-marked cwd for a month will accumulate hundreds-to-thousands of decided rows, and every 5 s UI poll will scan them all. Without the fix, the poll latency grows linearly with the table; with the fix it's flat.

**Fixed in this audit** (`src/approvals.ts:308-318`):

```ts
if (filter?.status) {
  const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
  // Single-status filter uses `status = ?` so SQLite picks the partial
  // index `idx_approvals_pending` (which is defined `WHERE status = 'pending'`).
  // `status IN (?)` does NOT trigger partial-index matching and falls back
  // to a full table scan + temp B-tree sort. C16d perf audit P1.
  if (statuses.length === 1) {
    where.push(`status = ?`);
    params.push(statuses[0]);
  } else {
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
}
```

Multi-status filter behavior is unchanged (the `IN (?, ?)` form does not match the partial index either, but no caller currently passes an array — the fallback exists for future flexibility). The index branch only fires when callers explicitly ask for `pending` (or any single status that has a matching partial index, should we add more later).

**Why not P0/HIGH:** at < 1k decided rows the cost is < 50 µs and humans can't see it. The pathological scale (10k+) is still single-digit milliseconds total wall time, also not human-visible. But the fix is < 10 LOC, the index *exists*, and the math gets worse not better — so it's worth landing.

---

### P2 — `cwdIsProductionMarked` does two `path.resolve`s per loop iteration (LOW, accept)

**Where:** `src/server.ts:1131-1143`.

```ts
function cwdIsProductionMarked(cwd: string): boolean {
  if (!cwd) return false;
  const resolved = path.resolve(cwd);
  for (const marked of productionMarkedCwds()) {
    const resolvedMarked = path.resolve(marked);  // loop-invariant per (marked) but not per call
    ...
  }
}
```

**Observation.** With 3 production cwds configured, the function takes ~1.3 µs (with DB read) or ~0.7 µs (no DB read, in-memory only) per call. The DB read is the dominant cost; the path.resolves are nanoseconds. The reviewer R9 framing — "is this wasted work?" — is true in the absolute, false in the practical sense. At the rate this fires (1× per dangerous tool call inside the SDK loop, which itself is gated on 100 ms+ of in-tool work), 1.3 µs is dwarfed by 5+ orders of magnitude.

The "shouldGateRun caches the decision into the closure" optimization the prompt asks about is real but invisible. Right now `cwdIsProductionMarked` is called once at run-start (in `shouldGateRun`/scheduler `fireScheduledTask`), and the result determines the matcher pattern of the hook (`.*` vs `Bash|Write|Edit|WebFetch`). The hook callback itself does NOT re-call `cwdIsProductionMarked` — it just runs the matcher SDK-side and creates an approval row. So the per-tool-call overhead is **already constant** w.r.t. production-cwd resolution; the only cost is the one-time call at run-start.

**Recommendation.** Accept. The path.resolves can be memoized on the marked-list level if they ever show up in a flame graph (~3 lines, module-scoped Map keyed by the raw string). Today, no.

---

### P3 — INSERT statement re-prepared on every `create()` (LOW, defer)

**Where:** `src/approvals.ts:175-191`.

```ts
this.db
  .prepare(
    `INSERT INTO pending_approvals (id, task_id, ...) VALUES (?, ?, ...)`,
  )
  .run(id, ...);
```

**Numbers (5000 iters):**
- `db.prepare(...).run(...)` per call (current): **14.9 µs**
- Cached `insertStmt` (constructed once): **7.2 µs**

**Observation.** better-sqlite3 caches by SQL text so the parser/planner work is amortized — what `db.prepare()` actually pays is a hash lookup + JS object construction. The same finding as C16c P1 (settings.ts), already fixed there. A 3-line fix in the constructor would shave 7 µs/call. The full hook synchronous prefix (INSERT + Promise + Map.set + Map.delete + resolve) measured at 8.0 µs total when the INSERT is cached.

`decide()`, `expire()`, and `expireOrphaned()` have the same shape but fire much less often (only on operator action / boot), so they're fine left as-is.

**Recommendation.** Defer to a follow-up commit. The fix is trivial (cache `insertStmt` in the constructor, use it in `create()`) but the win is invisible — every hook callback then waits 1 hour (default `APPROVAL_HOOK_TIMEOUT_SECONDS`) for the operator to decide. Saving 7 µs against a 3,600,000,000 µs wait is performance-art at best.

---

### P4 — `productionMarkedCwds()` reads SQLite on every dangerous tool call (LOW, accept)

**Where:** `src/server.ts:1122-1129` calls `configValue("approvals.production_cwds")` which goes through `settings.ts:getSetting`. That SELECT *is* prepared-cached (C16c P1 already landed), so per-call cost is sub-microsecond.

**Observation (50k iters):**
- `cwdIsProductionMarked` empty config (typical): **0.51 µs/call**
- `cwdIsProductionMarked` 3-cwd config: **1.33 µs/call**

The reviewer R9 flag was about whether this is "wasted work per tool call" — it's not, because:
1. `cwdIsProductionMarked` only fires once at run-start (`shouldGateRun` / `fireScheduledTask`), not per tool call.
2. The hook callback does NOT re-resolve the production-cwd state; it just creates approval rows for tools matching the matcher pattern that was decided at run-start.

So per-tool-call cost is `0`, and per-run-start cost is ~1 µs.

**Recommendation.** Accept. If future code paths start calling `cwdIsProductionMarked` from inside the hook callback, revisit.

---

### P5 — `expireOrphaned()` boot cost (LOW, accept)

**Where:** `src/approvals.ts:285-298`, fired at module load via `src/approvalsInstance.ts:17`.

**Numbers (1000 iters except pathological):**

| Scenario | Cost |
|---|---|
| 0 rows in table | 2.2 µs |
| 100 historical rows, 0 orphans | 2.1 µs |
| 1,000 historical rows, 0 orphans | 2.4 µs |
| 1,000 orphans pathological (all dispatched at once) | 1.2 ms total |

EXPLAIN QUERY PLAN: `SCAN pending_approvals USING INDEX idx_approvals_pending`. The partial index is used (the UPDATE's predicate matches the partial-index condition `status = 'pending'`).

**Observation.** Steady-state 2 µs is pure no-op cost — fast even when the table grows because the index only references pending rows. Pathological 1k orphans → 1.2 ms one-time at boot is invisible to humans.

**Recommendation.** Accept.

---

### P6 — `pending_approvals` has no pruning policy (LOW, defer)

**Where:** `src/approvals.ts` — no `prune` / no DELETE outside test fixtures.

**Observation.** Every approval row that's ever been created stays in the table forever. With P1 fixed, the UI poll cost is independent of historical row count (the partial index excludes non-pending rows). But two paths still scan the whole table:

1. `list({taskId})` — uses `idx_approvals_task` (B-tree on `task_id`), so it's keyed lookups only. Fine.
2. `get(id)` — uses the implicit `sqlite_autoindex_pending_approvals_1` PK. Fine.

The only real cost is disk space. At ~80 B/row including index entries, even a year of heavy use (10k approvals/year) is < 1 MB. Different from the C16c CostGuard ledger, which has the same characteristic and was also accepted.

**Recommendation.** Defer. Add a `prune(olderThan: number)` method only if the table ever crosses ~10k rows or if Clawless lifts this primitive into a multi-tenant context where storage matters.

---

### P7 — UI 5 s poll Promise.all cost (LOW, accept)

**Where:** `public/app.js:881-899` — `Promise.all([fetch("/api/tasks"), fetch("/api/approvals?status=pending")])`.

**Observation.** Server-side cost per cycle (with P1 applied):
- `/api/tasks`: `taskQueue.list({orderBy: "createdAt DESC"})` ≈ 50-100 µs at typical task counts (separately audited in C16a perf).
- `/api/approvals?status=pending`: now ~13-22 µs regardless of historical row count.

Total: ~120 µs of SQL work per 5 s cycle. Two HTTP round-trips on `localhost` add ~1-3 ms each in practice.

**Recommendation.** Accept. If a future feature wants ~1 s polling, revisit; at 5 s this is invisible.

---

### P8 — UI render cost on `renderTasks` + `renderApprovalPanel` (LOW, deferred — out of C16d scope)

**Where:** `public/app.js:933-1038`.

**Observation.** Full innerHTML rebuild every poll (5 s while modal open). Per-card path includes:
- `state.agents.find((a) => a.id === task.assignedAgent)` — linear scan, was flagged in C16a R10. Carry-over.
- `renderApprovalPanel` allocates ~10 DOM elements + a `JSON.stringify(approval.toolInput, null, 2)` (could be 0-64 KB; bounded by the 64 KB cap on the create() side).

At 50 tasks + 5 pending approvals: estimated 2-5 ms render time. At 500 tasks: would matter. At Command Center's personal scale (rarely > 20 tasks visible at once): invisible.

**Recommendation.** Defer. The `state.agents.find` -> Map lookup is a generic UI fix, not C16d-specific; if it lands as part of the carry-over from C16a R10, this gets fixed for free.

---

## Watch list (deferred / not actionable now)

- **P3 cached INSERT statement** — 3-line fix; do alongside next approvals.ts touch.
- **P6 pruning policy** — Add when row count crosses ~10k or if pinning durability matters.
- **`renderApprovalPanel` payload pretty-print** — Currently re-stringifies `JSON.stringify(approval.toolInput, null, 2)` every poll. Cache the rendered string keyed by `approval.id` if a future flame graph shows it.
- **5 s poll → SSE** — The polling-while-modal-open shape is fine for personal scale but the natural Phase 2 is to subscribe to an `/api/approvals/stream` SSE channel that pushes new pending rows + decision events. Removes the poll, removes the Promise.all, makes the UI feel instant. Out of scope for C16d.
- **Awaiter Map memory at scale** — Each `{resolve, reject}` pair costs ~300 B in V8 heap. 10k entries = ~3 MB. The Map is bounded by **concurrent in-flight approvals**, which is at most `(in-flight query() calls) × (dangerous tools per call awaiting)`. Personal scale: 1-2 entries ever. Hits problem territory only at 10k+ concurrent entries, i.e. a Clawless-scale multi-tenant lift. Worth a doc note in the lift PR.
- **Hook timeout = 1 hour** — Each in-flight approval holds an open Promise + Map entry + an open SDK call. When the SDK times out, the hook callback's Promise stays unresolved unless something resolves/rejects it. Verified the SDK aborts via `signal` → the `signal.addEventListener("abort", onAbort, { once: true })` path calls `approvals.expire()` which resolves the Promise and deletes the Map entry. Confirmed no leak path. The single residual edge case: the SDK times out without firing abort. The Map entry would leak in that scenario, but reading the SDK timeout semantics, abort is fired on timeout — the listener path catches it. No action.
- **Bytecount cap throw → deny** — Reviewer R11's fix: when `tool_input` exceeds 64 KB, `approvals.create()` throws, the hook callback catches it and returns `permissionDecision: "deny"`. This is the correct fail-closed behavior. From a perf perspective: the throw allocation + catch + JSON.stringify cost is bounded by the 64 KB cap, so worst-case ~50-100 µs. Not on a hot path (only fires on pathological tool inputs). Accept.

---

## Methodology

All measurements taken on the project's own better-sqlite3 build (Node 24.14.1, macOS Darwin 25.3.0). In-memory `:memory:` databases used to isolate the schema/index/query characteristics from disk I/O variance. Each microbenchmark warmed up with 1k iterations before the timed run; iter counts varied (1k–100k) to keep total wall time under 1 s per measurement.

Verified:
- **EXPLAIN QUERY PLAN** for: `list({status:'pending'})` (current vs fixed shape), `list({taskId})`, `decide()`, `expire()`, `expireOrphaned()`. All recorded in P1, P5.
- **Round-trip cost** of the full hook synchronous prefix (INSERT + Promise creation + Map.set + Map.delete + resolve) at 8.0 µs.
- **Awaiter Map memory** by populating 10k entries and reading `process.memoryUsage().heapUsed` delta: ~300 B/entry.
- **Partial-index trigger** on `WHERE status = ?` vs `WHERE status IN (?)` — confirmed `IN` does not trigger partial-index matching, even for single-element `IN`.
- **Realistic mixed table** (decided + pending rows) at 100 / 1k / 10k decided + 0-5 pending: confirmed scan cost grows linearly with `IN`, stays flat with `=`.

Scratch benchmark scripts written to project root (for module resolution into `node_modules/better-sqlite3`) and removed after measurement — no files committed.

---

## Verdict

- HIGH: 0
- MED: 1 (P1, **fixed inline**)
- LOW: 6 (one defer, one out-of-scope, four accept)
- **Ship as-is** after the inline P1 fix lands with the rest of the C16d branch.

The implementation is shaped well: standalone primitive with prepared-statement-friendly schema, atomic waiter-then-INSERT to close the race window, abort-signal cleanup in the hook callback, partial index for the hot read path. The one design slip — building `IN (?)` for single-status filters and silently bypassing the partial index — is now closed. Everything else is on the watch list for scale we don't have.

Inline change: `src/approvals.ts:308-318` (single-status branch). No other files touched.
