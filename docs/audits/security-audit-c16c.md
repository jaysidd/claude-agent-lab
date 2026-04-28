# C16c Security Audit (2026-04-27)

Scope: CostGuard budget enforcement (`src/costGuard.ts`, `src/costGuardInstance.ts`), the three preflight wirings + `/api/costguard/status` route in `src/server.ts` (lines 333-340, 447-454, 705-712, 606-610), the settings allowlist for per-agent override keys (`src/server.ts:941-982`), and the `seedLedgerRow` test helper (`tests/features.spec.ts:9-19`). Read-only audit. Threat profile inherited from the 2026-04-23 baseline (single-user, LAN-isolated `127.0.0.1:3333`, Max OAuth, no auth/CSRF — accepted for personal use, BLOCKER pre-commercial). Locked design item validated: server-side cap enforcement only — cross-checked.

## Summary
All-clear. C16c introduces no new HIGH or MED issues. Per-agent override keys are gated by an exact-shape allowlist that resolves the trailing segment against the agent registry; SQL is uniformly parameterized; the `is_oauth` column is sourced exclusively from server-captured `system.init` and is immutable through any public route; `/api/costguard/status` validates `agentId` against `findAgent()` before reaching the prepared statement; and `seedLedgerRow` is test-only. Three Info items recorded for the file.

## Findings
| # | Severity | Threat | Status |
|---|---|---|---|
| SC4 | Info | `cost_ledger` has no retention/prune policy; unbounded growth when no cap is configured | accept (out of threat model; flag if commercial) |
| SC5 | Info | 429 `reason` string echoes cap value and window length | accept (operator's own data; not secrets) |
| SC6 | Info | Global `costguard.*` schema keys are operator-configurable via `/api/settings` (by design) | no-action (this is the configuration surface, not forgery) |

### SC4 — `cost_ledger` has no retention or prune policy
`src/costGuard.ts:51-64` defines the table; no retention column, no TTL, no prune helper. Compare to `tasks` (server.ts:141-166, retention cap of 50 enforced after each enqueue). Each `/api/chat`, `/api/chat/stream`, and `/api/task/:id/run` writes one row at completion (success or failure). The cost-cap query filters `is_oauth = 0`, but writes happen on every record — including OAuth.

When at least one cap is configured: ledger growth per agent per window is bounded by the cap itself (preflight rejects before record, except on the call that *crossed* the cap which still records once). When no cap is configured: writes are unbounded for the agent's lifetime.

In the current threat model, the only writer is the local operator's own SDK calls, each gated by Anthropic's per-call latency, so practical row-count growth is in the thousands-per-day range at most. SQLite handles that comfortably for years. No action today.

**Watch-list**: if/when this lifts into Clawless's B64 multi-tenant context, add a monthly archive/prune (`DELETE WHERE occurred_at < strftime('%s', 'now', '-90 days') * 1000` or similar) and an index-friendly archival window. The existing `idx_ledger_agent_time` index covers a time-range DELETE.

### SC5 — 429 `reason` discloses cap value and current usage
`src/costGuard.ts:111-115, 126-131` build human-readable strings:
- `rate cap reached: ${used}/${capValue} requests in last ${windowSeconds}s`
- `cost cap reached: $${used}/$${capCeiling} this month`

These reach the client through the chat/stream/task-run 429 bodies (`server.ts:336, 450, 708`). In the personal-use threat model the data is the operator's own configuration; not a secret. If the server is ever exposed beyond localhost, an unauthenticated attacker who hits the rate cap learns (a) the configured cap, (b) the window length, and (c) recent usage cadence — useful for timing a bypass attempt or for fingerprinting the operator's billing tier.

**Recommendation**: no action for personal-use. If/when commercial: replace the message with a generic `"budget cap reached"` and surface details only on an authenticated `/api/costguard/status` read. The structured response already carries `capType` and `remaining` separately, so UI rendering does not depend on the reason string.

### SC6 — Global `costguard.*` keys are configurable via `/api/settings`
`src/settings.ts:103-129` declares three CostGuard keys in `SETTINGS_SCHEMA`. They are in `knownKeys` (server.ts:945-947), so any client that POSTs to `/api/settings` can set or clear them. By design — this is the operator's configuration surface. The same `/api/settings` route also accepts per-agent override keys validated by `isCostGuardOverride()`.

This is not forgery. It is the documented mechanism for configuring caps. Recording it because: (a) the audit prompt asked specifically whether a client could raise their own cap, and the literal answer is "yes — by setting the cap, which is the configuration surface"; (b) when commercial, this configuration surface needs auth (same blanket S4 finding as the rest of the API); (c) the cap *cannot* be raised silently or through an unintended path — only through `/api/settings` POST, which is the cap administration endpoint by definition.

**Recommendation**: no action. Documented so the locked-design assertion ("client cannot grant itself headroom") is read precisely: a client cannot bypass the enforcement *without* writing to the configuration store. The config store itself is intentionally writable by the local trusted operator.

## Cap-forgery / override-key allowlist walk
`src/server.ts:949-965` defines `isCostGuardOverride(key)`:

```
const COST_GUARD_OVERRIDE_BASES = [
  "costguard.cost_cap_monthly_usd",
  "costguard.rate_cap_per_window",
];
```
- `rate_window_seconds` is intentionally omitted (resolver in `costGuardInstance.ts:42-43` reads only the global `"costguard.rate_window_seconds"`, never a per-agent variant). Confirmed: a malicious POST of `costguard.rate_window_seconds.main` falls through `knownKeys.has(key)` (false — not in schema), then `isCostGuardOverride(key)` returns false (not in `COST_GUARD_OVERRIDE_BASES`), then `continue`. Silently dropped. Good.
- For the two valid bases: `key.startsWith(prefix)` where `prefix = base + "."`. Then `agentId = key.slice(prefix.length)`.
- `if (!agentId || agentId.includes(".")) return false;` — rejects empty trailing segment and any nested-dot key (e.g., `costguard.cost_cap_monthly_usd.foo.bar` is rejected).
- `return !!findAgent(agentId);` — final gate against the combined registry (built-ins + custom).

Edge cases checked:
- Trailing whitespace `costguard.cost_cap_monthly_usd.main ` — `findAgent("main ")` returns `undefined` (the string compare in `AGENTS["main "]` and the prepared SELECT in `findCustomAgent` both miss). Rejected.
- Unicode lookalike `costguard.cost_cap_monthly_usd.mаin` (Cyrillic 'а') — `findAgent` returns undefined. Rejected.
- Custom-agent IDs are slugged through `customAgents.ts:63-69` which forces `[a-z0-9-]` only and clamps to 32 chars; cannot contain dots, quotes, or special chars. Confirmed.
- Empty agent id `costguard.cost_cap_monthly_usd.` — `agentId === ""` → rejected by `!agentId`.
- Prefix-only `costguard.cost_cap_monthly_usd` — does NOT enter the per-agent branch (no `.` after the base); falls through to `knownKeys.has(key)` which returns true (it is in the schema), so it's accepted as a *global* setting. This is the intended path. Good.

No malicious key shape sneaks past. Tight.

## SQL injection check (every prepared statement in costGuard.ts)
| Site | Method | Status |
|---|---|---|
| `costGuard.ts:80-84` | `insertStmt` INSERT | parameterized — 6 `?` placeholders |
| `costGuard.ts:85-88` | `rateCountStmt` SELECT | parameterized — 2 `?`, `is_oauth` not in WHERE |
| `costGuard.ts:89-92` | `monthCostStmt` SELECT | parameterized — 2 `?`, `is_oauth = 0` is a literal in the SQL text (not user-influenced) |
| `costGuard.ts:106-107` | `rateCountStmt.get(agentId, since)` | both args bound; `since` is `Date.now()`-derived number |
| `costGuard.ts:122-123` | `monthCostStmt.get(agentId, monthStart)` | both args bound; `monthStart` is `startOfMonth()`-derived number |
| `costGuard.ts:145-152` | `insertStmt.run(...)` | 6 args, all bound; `isOAuth ? 1 : 0` is a number, not user-controlled |
| `costGuard.ts:166-171` | status `.get()` calls | parameterized |

No string interpolation of user-controlled data anywhere. The only literal in any SQL text is the `is_oauth = 0` filter in the cost-sum query, which is intentional and not influenced by inputs. The `.exec()` in `migrate(db)` (line 52) contains no parameters at all.

Every numeric arg passed to a prepared statement traces to either `Date.now()` or `agentId` (which is validated by `findAgent()` at every public entry point). Clean.

## `agentId` validation on `/api/costguard/status`
**Yes, validated.** `src/server.ts:606-610`:

```
app.get("/api/costguard/status", (req, res) => {
  const agentId = (req.query.agentId as string) || "";
  if (!findAgent(agentId)) return res.status(400).json({ error: "unknown agent" });
  res.json(costGuard.status(agentId));
});
```

`findAgent()` is called *before* `costGuard.status()`. If the registry doesn't know the agent, the route returns 400 without touching the DB. Even if validation were skipped, the prepared statement would execute safely (parameterized) — the SQL injection class is closed independently of `findAgent`.

The empty-string fallback `|| ""` means a missing `agentId` query param goes through `findAgent("")` which returns undefined, surfacing as 400. Good.

Test coverage: `features.spec.ts:431-434` verifies an unknown agent returns 400. Test confirms intended behavior.

## OAuth-bypass forgery walk (every `record()` call site)
The `is_oauth` column is set from `opts.isOAuth` in `record()` (`costGuard.ts:151`). Every host call site sources `isOAuth` from a scoped variable that is set *only* by the SDK message stream's `system.init` event:

| Site | Source variable | Where set |
|---|---|---|
| `server.ts:391-393` (chat error path) | `apiKeySource` | `server.ts:372` — `anyMsg.type === "system" && anyMsg.subtype === "init"` |
| `server.ts:397-402` (chat success) | `apiKeySource` | same as above |
| `server.ts:566-571` (stream) | `streamApiKeySource` | `server.ts:514` — same init-only path |
| `server.ts:754-759` (task run) | `taskApiKeySource` | `server.ts:742` — same init-only path |

None of these read from `req.body`, `req.query`, or any client-controlled input. The variable `apiKeySource` is initialized to `undefined` and only ever assigned inside the init-message branch. A client cannot influence the `system.init` payload — it is generated by the SDK from the running auth context (Max OAuth → `"none"`, env API key → `"environment"`, etc.). Confirmed: the OAuth-bypass flag is server-truth, not client-asserted.

## Cost-cap post-hoc bypass check
- `costGuard.ts` exposes only `check`, `record`, `status` from the class. No public method updates `is_oauth` or `cost_usd` post-insert.
- Searched `src/server.ts` for any `UPDATE cost_ledger` or `cost_ledger` SET — none. The only DDL is in `migrate()`; the only DML is the parameterized INSERT in `insertStmt`.
- The DELETE-on-tasks at `server.ts:786-792` is constrained to the `tasks` table by the SQL text. No analogous DELETE/UPDATE on `cost_ledger` exists.

A client cannot toggle `is_oauth` on a row after insertion through any API route. To rewrite `is_oauth=1` for past API-key rows, an attacker would need filesystem write to `data/lab.db` — which is total game-over and outside the threat model (same baseline as SC3 in the C16b audit).

## Settings POST value coercion walk
`src/server.ts:968-980`:

```
const { key, value, isSecret } = entry ?? {};
if (typeof key !== "string") continue;
if (!knownKeys.has(key) && !isCostGuardOverride(key)) continue;
if (value === null || value === undefined) {
  deleteSetting(key);
  changed++;
} else if (typeof value === "string" && value.length > 0) {
  setSetting(key, value, !!isSecret);
  changed++;
}
// empty string = no-op (preserves existing secret when user leaves field blank)
```

Path-by-path:
- `value` is `null` or `undefined` → DELETE. (Cleared.)
- `value` is a non-empty `string` → INSERT/UPDATE with the literal string.
- `value` is an empty `string` → silent no-op (intentional: preserves an existing secret when the user leaves a password field blank).
- `value` is a `number` (e.g., `42`) → falls through both branches (not null/undefined, not string). **Silently dropped, no insert.** Operator must POST `"42"`. Good — defense in depth: `readCap()` already does `Number(raw)` coercion, but the writer side refuses anything non-string before it reaches the table.
- `value` is a `boolean` → same; silently dropped.
- `value` is an `object` or `array` → same; silently dropped. Critically: there is *no* implicit `String(value)` or `JSON.stringify(value)` coercion that could land `"[object Object]"` or a JSON blob into the `value` column. Tight.

The `setSetting()` function (`settings.ts:34-40`) itself takes a typed `string` parameter and binds it via prepared statement — so even if a future caller bypassed the type check, no SQL injection vector exists. Two layers of guard.

## Test seed helper risk (`seedLedgerRow`)
`tests/features.spec.ts:9-19` opens a *second* `better-sqlite3` handle to `data/lab.db`, executes a single parameterized INSERT into `cost_ledger`, then closes the handle. Walked production code paths:

- `seedLedgerRow` is defined inside `tests/features.spec.ts` and exported only locally (no `export` keyword; module-private function expression).
- `tsconfig.json`'s build/run path (`tsx src/server.ts`) does not import from `tests/`.
- The `tests/` directory is run by Playwright's runner, which spawns a separate Node process. The running server has no module reference to the test file.

Confirmed: `seedLedgerRow` is unreachable from any production code path. Even if it were, the INSERT is parameterized and writes only to the agent's own ledger — at worst an attacker with code-execution inside the test process could pre-fill the ledger to exhaust the cap. But code execution inside the test process is already game-over.

The `is_oauth=1` literal in the seed (line 16) means seeded rows count toward the rate cap but NOT the cost cap — by design (the test exercises the rate-cap path, which is provider-agnostic, without needing an API-key fixture).

## Worker / test isolation under concurrent writes
`memory.ts:15` sets `db.pragma("journal_mode = WAL")` once at module load on the server side. The test helper opens its own `Database` handle to the same file — better-sqlite3's WAL mode supports multiple readers + a single writer with the writer never blocking readers. The seed INSERT and any concurrent server-side writes (from a chat round-trip in flight) serialize correctly through the WAL.

The only way to lose data here would be a write that happens to coincide with the test's `db.close()` — but `close()` waits for outstanding statements to complete (better-sqlite3 is synchronous), so the close itself cannot race. Confirmed safe.

Note: the test does its OWN `new Database(LAB_DB)` open, which means it does NOT inherit the server's WAL pragma — but WAL mode is a *persistent* journal_mode setting in the database file's header once first set, so subsequent opens see WAL mode automatically. Verified by the comment at `features.spec.ts:11-12` ("The server runs in WAL mode so concurrent reads/writes are fine.")

## Resource exhaustion via ledger growth
Per the SC4 finding above: with caps configured, ledger growth is naturally bounded. Without caps, an attacker (= the local trusted operator in current threat model) can drive growth at the rate of SDK round-trips, which is latency-bounded to ~tens-per-second worst case. SQLite handles tens of millions of rows without performance degradation; the `idx_ledger_agent_time` index keeps `check()` queries O(log n) on the relevant agent's recent rows.

Practical ceiling for crashing the DB: filesystem fill. At ~80 bytes per row including index overhead, 1 GB ≈ 13 M rows ≈ years of unbounded local use. Not a realistic DoS vector inside the trust boundary.

## Confirmation that prior accepted risks are unaffected
Cross-references against `security-audit-2026-04-23.md` (S1–S10) and `security-audit-c16b.md` (SC1–SC3):

- **S1 (unscoped `currentCwd`)** — unchanged. C16c does not touch `/api/cwd`.
- **S2 (`/api/browse` arbitrary `?path=`)** — unchanged.
- **S3 (server binds 0.0.0.0)** — unchanged. (`server.ts:1074-1078` uses `HOST = "127.0.0.1"` default; pre-existing.)
- **S4 (no auth / CSRF / CORS)** — unchanged. All four CostGuard surfaces (`/api/chat`, `/api/chat/stream`, `/api/task/:id/run`, `/api/costguard/status`, `/api/settings`) inherit the project-policy "no auth on the API". No new attractive target.
- **S5/S6/S7 (prompt injection)** — unchanged. `check()` is a structured arithmetic decision, no LLM involvement; `record()` writes integers/floats only.
- **S8 (XSS via `innerHTML`)** — unchanged. The 429 body's `reason` string flows to the UI, but per the project's existing markdown/text rendering pipeline (DOMPurify on rendered chat output, plain-text rendering for error messages), the cap-reason text does not reach an `innerHTML` sink. Confirm in the QA pass for C16c if the UI surfaces it differently.
- **S9 (SDK delegation boundary)** — unchanged. CostGuard intercepts *before* `query()` and records *after*; it does not modify `agents:` or `subAgentsFor()`.
- **S10 (no key round-tripping)** — unchanged. `apiKeySource` is the SDK-reported source name (`"none"`, `"environment"`, etc.), never the key itself; landing in the ledger as a 0/1 flag, not the source string.
- **SC1 (per-task tool allowlist)** — unchanged.
- **SC2 (`error_json` permissive contract)** — unchanged. CostGuard has no error_json equivalent.
- **SC3 (`migrate(db)` FS-trust-rooted)** — same applies to `costGuard.migrate(db)` (line 51-64). Outside threat model.

## Verdict
- New HIGH: 0
- New MED: 0
- New LOW: 0
- New Info: 3 (SC4 ledger retention, SC5 reason-string disclosure, SC6 documented config surface)
- Overall: **ship**

C16c is a clean budget primitive from a security standpoint. The locked-design "server-side cap enforcement only" assertion validates: (a) override keys gated by exact-shape allowlist resolved against the agent registry, (b) `is_oauth` set exclusively from server-captured init events, (c) every SQL surface parameterized, (d) `agentId` validated upstream of every prepared statement that takes it. The three Info items document accepted properties of the design rather than gaps in the implementation.

Watch-list for future sessions:
1. If/when CostGuard lifts into Clawless's B64 multi-tenant context, add a ledger retention/prune policy (SC4) and replace the disclosing 429 reason strings with generic messages plus authenticated `/api/costguard/status` for details (SC5).
2. If/when `/api/settings` ships any auth at all, the `isCostGuardOverride` allowlist should remain in place — it is a defense-in-depth layer above the auth, not a substitute.
3. If the UI ever renders the 429 `reason` via `innerHTML` (e.g., a styled cap-banner with formatted numbers), apply DOMPurify or escape — current text-only path is safe.
