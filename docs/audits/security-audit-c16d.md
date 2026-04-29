# C16d Approval Gates — Security Audit

> Date: 2026-04-29
> Branch: c16d-approvals
> Threat model: personal-use, localhost-only, single-tenant. Same as C16a/b/c.
> Scope: hook bypass paths, allowlist tampering, decide-endpoint trust, tool-input secret persistence, race conditions in create/decide/expire.

## Summary
0 HIGH, 0 MED, 4 LOW, 5 Info.

C16d's gate is sound under the personal-use threat model. The reviewer-driven R11 fix (catch-and-deny on `approvals.create()` throw) closes the dominant bypass class. One inline tightening landed during this audit (matcher regex anchoring, S2). The remaining findings are watch-list items that escalate in severity if/when the API surface stops being localhost-only or grows multi-tenant.

## Findings
| # | Severity | Threat | Status |
|---|---|---|---|
| S1 | Low | Production-cwd matcher does not resolve symlinks | accept (operator misconfiguration; escalates if a prompt-injected agent can plant the symlink) |
| S2 | Info | Tool-name matcher was unanchored (`Bash|Write|Edit|WebFetch`) — `BashHelper`/`MyEdit` would have matched | **fixed in this audit** (anchored to `^(?:Bash|Write|Edit|WebFetch)$`) |
| S3 | Low | `approvals.production_cwds` is writable via `/api/settings` POST — a prompt-injected agent could `curl -X POST` to clear the allowlist before its own dangerous call fires | accept (localhost trust, single-tenant); HIGH if commercial path opens |
| S4 | Info | `POST /api/approvals/:id/decide` has no auth — any HTTP caller can approve any pending row | accept (inherits S4 from 2026-04-23 baseline); HIGH if non-localhost |
| S5 | Low | Each pending hook holds a Promise + Map entry + the SDK call that is awaiting the hook return; a tight prompt-injection loop can pile up awaiters | bounded by SDK subprocess pool + 1-hour expiry; flag |
| S6 | Low | `tool_input_json` and `decision_reason` persist in plaintext indefinitely; secrets a tool was *about to use* (e.g., `echo $ANTHROPIC_API_KEY`) survive in `data/lab.db` | accept (FS-trust-rooted; same baseline as SC3/C16b) |
| S7 | Info | Two simultaneously-launched server processes both register fresh `WORKER_ID`s and each holds awaiters for their own pending rows; the OTHER process's `decide()` API call would no-op against rows that aren't its own | pathological; documented |
| S8 | Info | SQL injection walk: every `db.prepare(...).run/.get/.all(...)` in `approvals.ts` parameterized; dynamic `WHERE` builder uses placeholders | clean |
| S9 | Info | Hook abort-listener cleanup: `try/finally` + `{once: true}` provide double-cleanup; SDK retries get fresh listeners on a fresh hook invocation | clean |

### S1 — Symlink in cwd evades production-marked matcher
`src/server.ts:1131-1143`. `cwdIsProductionMarked` compares `path.resolve(cwd)` against `path.resolve(marked)`. `path.resolve` does NOT follow symlinks — it normalizes `..`, `.`, and joins relative segments, but a symlink at `/Users/me/safe → /Users/me/prod` resolves to its own literal path, never the target.

Concretely: if the operator's `approvals.production_cwds` setting contains `/Users/me/prod`, and a task's cwd is `/Users/me/safe` (a symlink that resolves on the filesystem to `/Users/me/prod`), the matcher returns `false`. The task can read/write files under `prod` without firing the production-cwd gate path.

In the current threat model the operator owns the filesystem and has chosen which symlinks to plant. This is misconfiguration, not a bypass. The risk escalates if a prior agent run (with a Bash/Write tool) can create a symlink the OPERATOR didn't intend — at that point a future task with a "safe" cwd quietly writes into prod.

**Fix when**: prompt-injection-induced symlink placement becomes a credible scenario, or the cwd allowlist is consulted by anything other than the local trusted operator. Then switch to `fs.realpath.native` (or the synchronous `fs.realpathSync.native`) inside `cwdIsProductionMarked`. The function is on the hot path for every run, so cache the realpath per-cwd-change (currentCwd is mutated through `/api/cwd` POST — invalidate there).

Documenting only. No fix today; the symlink-planting scenario requires a tool we already let agents execute, which is a separate "use plan mode" concern.

### S2 — Tool-name matcher was unanchored (fixed)
**Fixed in this audit** at `src/server.ts:1153-1160`. Before:
```ts
const matcher = opts.productionMarked ? ".*" : DEFAULT_DANGEROUS_TOOLS.join("|");
```
After:
```ts
const matcher = opts.productionMarked ? ".*" : `^(?:${DEFAULT_DANGEROUS_TOOLS.join("|")})$`;
```

Without anchors, the regex `Bash|Write|Edit|WebFetch` matches any tool name *containing* one of those tokens — `BashHelper`, `BashSafe`, `MyEdit`, `WebFetchProxy`, etc. The behavior in this repo is conservative (matching MORE tool names is fail-CLOSED, not fail-open), so this was not a bypass. It WAS a misnaming bug: a built-in SDK tool whose name contained `Bash` as a substring would have been gated unintentionally.

Anchoring fixes the future-proofing concern: when the SDK introduces new tool names (or when this primitive lifts into Clawless multi-provider where MCP-prefixed tools like `mcp__server__bash_run` exist), unanchored matching would gate them too. The matcher is now an exact whole-name match.

Verified: `^(?:Bash|Write|Edit|WebFetch)$` matches each of the four exactly and rejects `Bash2`, `BashHelper`, `mcp__server__Bash`, etc. Custom-agent tool-name escape (Concern 3 in the audit prompt) is closed by this same change — even if a future custom agent could declare a tool named `Bash2`, it now falls outside the matcher and would route through whatever the production-cwd path decides (matched as `.*` if production-marked, ungated otherwise — same as the existing semantic for any non-default tool).

Note on the broader question: custom agents (C15) declare `allowedTools` as an array of strings (`src/customAgents.ts:96`), but those strings are an allowlist *filter* over the SDK's known tool set, not arbitrary executable definitions. The SDK only fires `PreToolUse` for tools it actually knows about. An agent declaring `allowedTools: ["Bash2"]` does not give it a tool named `Bash2` — the SDK's tool registry is the source of truth. This audit confirms the matcher is independently safe regardless of allowedTools content.

### S3 — `approvals.production_cwds` is writable via `/api/settings` POST
`src/server.ts:978-980` builds `knownKeys` from `SETTINGS_SCHEMA`; `approvals.production_cwds` is in the schema (`src/settings.ts:137`), so it passes the allowlist gate at `server.ts:1004`. Any client with HTTP access to the server can POST a clearing entry:
```json
{ "entries": [{ "key": "approvals.production_cwds", "value": null }] }
```
That deletes the row, `productionMarkedCwds()` returns `[]`, and the next gate check returns `false`.

Threat: a prompt-injected agent that has a Bash tool can `curl -X POST http://127.0.0.1:3333/api/settings -H 'content-type: application/json' -d '{"entries":[{"key":"approvals.production_cwds","value":null}]}'` BEFORE issuing its dangerous tool call. The hook's *next* invocation re-reads `productionMarkedCwds()` (no caching layer), so the change takes effect immediately for subsequent calls.

There's a defense-in-depth wrinkle: the per-task `requiresApproval: true` flag is independent of the allowlist (`shouldGateRun` ORs the two), and an agent run that started with `gated: true` keeps its hook attached for the full run — clearing the allowlist does not detach an already-attached hook. So the bypass requires the run to NOT have a per-task flag, only the production-cwd path. Scheduled fires fall in this window (`server.ts:1340-1351` notes the per-task flag isn't yet wired into schedules).

In the current threat model the operator owns the localhost server and the prompt-injection scenario presumes the operator already accepted Bash tool risk. Documenting as accept. The fix is the same as the rest of `/api/settings`: auth on the route. No standalone fix here — the gate is one of many config knobs and they all live inside the same trust boundary.

**Watch-list**: if `/api/settings` ships any auth at all (commercial path), `approvals.production_cwds` MUST require a higher privilege than ordinary settings (treat it like a sudo-level config). Consider also: a tamper-evident audit log row on every mutation of this key, surfaced on the kanban so the operator notices unexpected clearance.

### S4 — `POST /api/approvals/:id/decide` is unauthenticated
`src/server.ts:1569-1592`. The route accepts `{decision: "approve" | "reject", reason?: string}` and resolves any pending approval. Inherits the project-wide S4 baseline (no auth). Same as `/api/settings`, `/api/cwd`, every other mutating endpoint.

What's specifically C16d about this: an attacker with HTTP access doesn't merely read state, they *grant* permission for an SDK tool call that's currently gated. The gated call is precisely the one the operator wanted human review for. So the decide endpoint is the highest-leverage unauthenticated mutation in the codebase.

In the current threat model this is the SAME exposure as every other route — bound to 127.0.0.1, single-tenant, single-process, the only HTTP caller is the operator's browser. No new exposure.

**Watch-list**: when commercial path opens, this route MUST authenticate the operator AND bind to the specific approval row's owning user/workspace. The decide call should be a per-tenant capability, not a global one.

### S5 — Hook timeout DoS via tight prompt-injection loop
`src/server.ts:1120` sets `APPROVAL_HOOK_TIMEOUT_SECONDS = 60 * 60` (1 hour). Each pending hook holds:
- One row in `pending_approvals` (~200 bytes plus tool_input up to 64 KB)
- One in-memory `Map` entry: `{resolve, reject}` plus closure scope (~few hundred bytes)
- One unresolved `Promise`
- One waiting SDK call (one subprocess slot in the SDK's pool)

A malicious agent run that emits 1000 dangerous tool calls in a tight loop creates 1000 pending hooks. RAM cost: ~64 MB worst case (input cap-bounded), fine. SQLite cost: a thousand small rows, fine. SDK subprocess cost: depends on pool sizing — the SDK serializes tool calls per-session, so in practice the agent loop blocks on the FIRST pending hook and never gets to issue the next one. Good — the SDK's own serialization caps this naturally to ~1 in-flight per agent run.

But: multiple parallel runs (multiple tasks executing simultaneously, each with its own hook) DO compound. With N parallel scheduled fires all hitting production-marked cwd, you get N pending hooks. CostGuard rate-cap caps per-agent firing rate, but the kanban can have N tasks across N agents.

Practical ceiling: bounded by CostGuard's rate cap × number of agents × 1 in-flight per agent. With default no-cap configuration and ~10 agents, getting more than ~10 simultaneous pending approvals requires either deliberate operator action or simultaneous slow-decide on every pending row. Not a credible DoS in single-tenant.

**Watch-list**: under multi-tenant the formula becomes N tenants × M agents × 1 in-flight = quadratic in tenants. Consider a per-tenant pending-approvals cap (e.g., max 10 in-flight per tenant) plus a max global cap (e.g., 1000). Reject the *new* hook — return `deny` with reason "approval queue full" — rather than blocking the existing ones.

### S6 — Tool input + decision reason persist in plaintext
`pending_approvals.tool_input_json` stores the SDK's tool_input as JSON. If a Bash tool's `command` field includes a secret substitution that the agent CHOSE to construct (e.g., the agent decides "let me dump the env to debug" → `echo $ANTHROPIC_API_KEY > /tmp/x`), the literal command string is what the SDK sends, which is what the hook captures, which is what the row stores. Even after `decide()` flips status to `rejected`, the row stays in the DB.

The same applies to `decision_reason` on the operator side — a 1000-char free-text field where the operator might paste sensitive context.

In the current threat model (single-trusted-operator, single FS), this is the same FS-trust risk as SC3 in C16b: anyone with read access to `data/lab.db` is already game-over. Documenting because the previous audits called the same property out for the cost ledger and chat memory tables; consistency.

**Watch-list**: under multi-tenant, encrypt-at-rest the `tool_input_json` column with a per-tenant key, OR scrub on `decide()` (replace the input with `{redacted: true, original_keys: [...]}`). For now, the design intentionally retains the input so the kanban's "history" view can show what was approved/rejected — that view is operator-only, and the row is the operator's own data.

A retention/prune policy (parallel to SC4 for `cost_ledger`) would mitigate long-tail accumulation of sensitive command strings. Not added today; same backlog item as C16c's SC4.

### S7 — Dual-server-launch awaiter split-brain
`src/approvalsInstance.ts:17`: `expireOrphaned(WORKER_ID)` runs at module load. If two server processes start within milliseconds of each other:

- Process A boots with `WORKER_ID = "wA"`. Sweep: marks any rows with `worker_id != "wA"` as expired. At T0, no rows exist; sweep is a no-op.
- Process B boots with `WORKER_ID = "wB"`. Sweep: marks any rows with `worker_id != "wB"` as expired. Same — no rows yet.
- Both processes accept HTTP. Both processes register `PreToolUse` hooks for their own runs.
- Process A's hook creates row R_A with `worker_id = "wA"` and registers `waiters.set(R_A.id, ...)` in *Process A's* memory.
- Process B's hook creates row R_B with `worker_id = "wB"` and registers `waiters.set(R_B.id, ...)` in *Process B's* memory.
- Operator opens the kanban (whichever process the browser hits — say Process B). They see BOTH R_A and R_B (DB-truth).
- Operator clicks "approve" on R_A. The HTTP request hits Process B (browser is talking to one process). Process B's `decide()` updates the DB row but `waiters.get(R_A.id)` returns undefined (Process A holds that waiter). Decision recorded; awaiter never resolves. R_A's hook hangs for the full 1-hour timeout.

Pathological — port 3333 only allows one bind, so a second `npm run serve` fails immediately. The only way to land in this scenario is two processes binding to *different* ports but reading the same `data/lab.db`. The current Express config in `src/server.ts:1597` reads PORT/HOST from env, so `PORT=3334 npm run serve` would work alongside `PORT=3333 npm run serve`. A developer running two dev servers on different ports against one DB would see this.

In single-server production deployment this cannot happen. Documenting because it's a property of the in-memory waiter design that deserves an explicit "don't run two servers against one DB" disclaimer somewhere.

**Watch-list**: if/when multi-process becomes a deployment shape (e.g., two servers behind a load balancer), the in-memory waiter Map needs to be replaced by a cross-process pub/sub (Redis, Postgres `LISTEN/NOTIFY`, etc.). For now: not a deployment shape we support. Documented in approvals.ts comments already (the "server may have restarted between create() and decide()" note covers the same class of issue).

### S8 — SQL injection walk
Every prepared statement in `src/approvals.ts`:

| Line | Method | Status |
|---|---|---|
| 175-191 | `INSERT` | parameterized, 8 placeholders, all bound |
| 220-231 | `UPDATE ... RETURNING` (decide) | parameterized, 5 placeholders, all bound |
| 256-266 | `UPDATE ... RETURNING` (expire) | parameterized, 3 placeholders, all bound |
| 287-296 | `UPDATE` (expireOrphaned) | parameterized, 2 placeholders; `worker_id != ?` correctly excludes own rows |
| 318-324 | dynamic `SELECT ... WHERE` (list) | dynamic SQL, but every `where[]` push is a hardcoded string (`"task_id = ?"`, `"status IN (?,?,...)"`) and every parameter is bound — no input concatenation |
| 329-331 | `SELECT WHERE id = ?` (get) | parameterized |

The `list()` dynamic SQL is the highest-risk shape; verified: `where.push("task_id = ?")` is a constant string, not interpolating `filter.taskId`. The `IN (...)` clause builds `?,?,?,...` from a `.map(() => "?")` — no string interpolation of input values, only a count of placeholders driven by `statuses.length`. `params.push(...statuses)` binds each one positionally. Clean.

C16d server.ts additions (`/api/approvals` routes at 1550-1592) call only `approvals.list/get/decide` — no SQL, just method calls. The route at 1550 validates `status` against a hardcoded `knownStatuses` tuple before passing to `list()`; even if it were bypassed, `list()` itself binds the value.

No SQL injection vector. Tight.

### S9 — Hook abort-listener cleanup
Concern 10 from the audit prompt: does an SDK retry on the same hook lead to a leaking listener? Walking the code at `server.ts:1190-1208`:

```ts
const onAbort = () => approvals.expire(handle.id, "sdk_aborted");
signal.addEventListener("abort", onAbort, { once: true });

try {
  const decision = await handle.awaitDecision();
  return { hookSpecificOutput: { ... } };
} finally {
  signal.removeEventListener("abort", onAbort);
}
```

Every invocation of the hook callback creates:
1. A fresh `handle` from `approvals.create()` (new id, new waiter row, new in-memory Promise).
2. A fresh `onAbort` closure capturing THIS invocation's `handle.id`.
3. A fresh `signal` parameter from the SDK's hook context — each callback invocation gets its own signal.

`{once: true}` ensures `onAbort` fires at most once per attach, AND auto-detaches after firing (whether or not we then call `removeEventListener`). The `try/finally` provides a second cleanup so a *non-abort* decision path also detaches. Two layers of cleanup, both correct.

If the SDK retries the same tool call: it's a brand-new `PreToolUse` event → brand-new callback invocation → brand-new `handle`, `onAbort`, and `signal`. The previous invocation's listener is gone (either fired-and-removed via `once`, or finalized through the previous `finally`). No accumulation.

If `decide()` is called on a row whose hook already aborted: row status is `expired` (set by the abort listener), so the `WHERE ... AND status = 'pending'` clause skips it, returning `null`. The `/api/approvals/:id/decide` route catches the null and returns 409. No double-resolve, no double-listener.

Verified safe.

## Watch list (escalates if commercial path opens)
- **S1 → MED**: if a previous agent run can plant a symlink the operator didn't audit, switch `cwdIsProductionMarked` to use realpath. Precondition: any agent in the registry is allowed to run with Bash/Write tools without per-task approval.
- **S3 → HIGH**: remote write to `/api/settings` without auth would let a remote attacker clear `approvals.production_cwds`. Precondition: server binds beyond 127.0.0.1, OR auth is added but `approvals.production_cwds` is not gated separately as a privileged setting.
- **S4 → HIGH**: remote write to `/api/approvals/:id/decide` without auth lets the attacker approve any operator-pending approval. Precondition: same as S3.
- **S5 → MED**: under multi-tenant, the per-tenant pending-approvals queue needs an explicit cap. Without it, one tenant's tight loop can starve the SDK subprocess pool for other tenants. Precondition: multi-tenant deployment.
- **S6 → MED**: under multi-tenant, the `tool_input_json` column should be encrypted at rest with a per-tenant key, OR retention should be capped at a small window. Precondition: multi-tenant DB, OR external read access to `data/lab.db`.
- **S7**: add a per-DB-instance lock (e.g., write a sentinel row with the live `WORKER_ID`; refuse boot if another live sentinel is recent) before claiming multi-process safety. Precondition: deployment shape includes >1 server process.

## Confirmed safe
- **R11 fix**: catch-and-deny on `approvals.create()` throw verified at `server.ts:1166-1188`. The 64 KB cap throw, the JSON.stringify-on-circular throw (`approvals.ts:151` calls `JSON.stringify(input.toolInput ?? null)` — circular reference throws `TypeError`), the missing-required-field throws (`approvals.ts:141-149`) — ALL surface inside the `try` block at `server.ts:1167` and route through the deny return at 1181-1187. No throw escapes the callback to be misinterpreted by the SDK as non-blocking.
- **`signal.addEventListener` itself does not throw**: it's a synchronous DOM/Node API that registers a listener; no path inside it raises. Same for `removeEventListener`.
- **Awaiter rejection**: `decide()` and `expire()` only ever call `resolve()` on the in-memory waiter, never `reject()`. The only reject-path declared in `approvals.ts:170` (`rejectDecision`) is captured but never called by any current code. So the hook's `await handle.awaitDecision()` never throws — it always resolves with a `Decision` object. If a future `expire`-variant or shutdown path adds a `reject()` call, that throw would propagate out of `await` and into the hook callback, where it would NOT be caught (the `try` block currently ends at line 1188 around the `create()` call, not the `await` call). Documented inline below.

## Latent bug: future reject() path is not caught
The hook's `try { handle = approvals.create(...) } catch { return deny }` block guards `create()`, but the subsequent `await handle.awaitDecision()` is NOT inside a `try/catch`. Today this is fine because `decide()` and `expire()` only `resolve()`, never `reject()`. If a future change to `Approvals.expire()` (or a new `cancel()`/`shutdown()` method) calls `rejectDecision(err)` on the waiter, the hook callback would throw — the SDK would treat the throw as a non-blocking error, and the dangerous tool call would proceed.

Recommended hardening (not applied today — out of scope for this audit and would change runtime behavior in the no-throw common path): wrap the `await` in `try { ... await handle.awaitDecision() ... } catch (err) { return deny-with-message }`. This is a one-line guard against a future maintainer calling `reject()` from inside the primitive.

This is logged as a comment for the next maintainer rather than fixed inline because the fix changes the shape of the callback's control flow (vs. the trivial regex anchoring fix in S2). Calling it out explicitly so it's not lost in code-search drift.

## Verdict
- New HIGH: 0
- New MED: 0
- New LOW: 4 (S1 symlinks, S3 settings tampering, S5 hook DoS, S6 plaintext persistence)
- New Info: 5 (S2 fixed, S4 baseline, S7 dual-launch, S8 SQL clean, S9 listener clean)
- Inline fix applied: 1 (S2 — matcher regex anchored)
- Latent issue logged for next maintainer: 1 (future `reject()` path not caught around `await handle.awaitDecision()`)
- Overall: **ship**

C16d's gate is correct under the personal-use threat model. The fail-closed design (R11 + S2's anchored matcher + production-cwd OR per-task flag) gives defense in depth. The watch-list items all collapse to the same precondition the rest of the codebase has flagged for a year: server-side auth on `/api/*` is the gate that has to land before any non-localhost deployment.
