# C05 Telegram Bridge — Security Audit

> Date: 2026-04-29
> Branch: c05-telegram
> Threat model: personal-use, localhost-only, single-tenant. Same as C16a/b/c/d.
> Scope: token leakage paths, allowlist bypass, prompt-injection escalation, SSRF/exfil, rate-limit DoS, two-instance conflict, settings race, test-route exposure.

## Summary
0 HIGH, 0 MED, 4 LOW, 6 Info.

C05's bridge is sound under the personal-use threat model. The token never round-trips through any logger, response body, or error path I could exercise — Node's `fetch` happens to redact URL paths from its default error message, which is what makes the unsanitized `${TELEGRAM_API}/bot${token}/${method}` interpolation tolerable. Allowlist enforcement is correct and defense-in-depth (silent drop, no reply to non-allowed chats). The remaining LOW findings are watch-list items that escalate if/when this primitive lifts into Clawless multi-tenant or the server stops being localhost-bound. No inline fixes were applied — every gap I found was either accept-under-threat-model or a one-line hardening I'd want a Reviewer pass on before landing.

## Findings
| # | Severity | Threat | Status |
|---|---|---|---|
| S1 | Low | Token interpolated raw into URL with no character validation; an operator-pasted token containing CR/LF/`/` could produce malformed requests | accept (single-tenant; token is operator-controlled); harden if commercial |
| S2 | Low | `parseAllowedChatIds` accepts `1e10`, `0x100`, leading-zero octals via `Number()`; numbers above 2^53 collide due to float imprecision | accept (Telegram doesn't issue IDs in those ranges); easy hardening flagged |
| S3 | Low | Telegram-initiated runs do not auto-set `requiresApproval` on their dispatch; an allowlisted operator's compromised account gets the SAME tool surface as the web UI without a per-task gate | accept under single-tenant; explicit watch-list item |
| S4 | Low | `/api/telegram/test` is unauthenticated and proxies a `getMe` to Telegram; localhost trust applies but a cross-process attacker on 127.0.0.1 (or a malicious page hitting via DNS rebinding without CSRF) could rate-limit-burn the token | accept (inherits S4 baseline); HIGH if commercial |
| S5 | Info | `runLoop` falls back to `u.edited_message` even though `getUpdates` requests `allowed_updates: ["message"]` only; dead branch today, but safe — same allowlist filter applies | clean, documented |
| S6 | Info | Allowlist applied to `msg.chat.id`, NOT `msg.from.id` — group chats where the bot is added would route any group member's message to the agent | by-design under single-tenant; explicit operator responsibility |
| S7 | Info | `onTelegramMessage` is the only caller of dispatch logic; no codepath constructs an `IncomingMessageContext` directly that bypasses `runLoop`'s allowlist filter | clean |
| S8 | Info | SQL injection walk: `telegram.ts` and `telegramInstance.ts` touch zero SQL; `configValue` reads from `settings.ts` via the existing parameterized prepared statement | clean |
| S9 | Info | JSON parsing of `getUpdates` response: `res.json().catch(() => ({}))` swallows malformed bodies; result is treated as a plain object with no `eval`/`Function` path; `msg.text` is fed to `parseTelegramCommand` which only does `String.startsWith/indexOf/slice/toLowerCase/replace` | clean |
| S10 | Info | Two-instance conflict (409): `runLoop` flips status to `conflict` and stops; another machine's long-poll cannot corrupt this loop's offset because each `getUpdates` call carries its own `offset` and Telegram serves whichever instance has the open connection | clean |

### S1 — Token URL interpolation accepts any string
`src/telegram.ts:122`. `callApi` does `const url = \`${TELEGRAM_API}/bot${token}/${method}\`` with no validation of `token`. `readToken()` at `src/telegramInstance.ts:31-35` only `.trim()`s — no character whitelisting against the documented Telegram bot-token shape (`<bot_id>:<35_alphanumerics>`).

I exercised three pathological tokens to check the actual leakage surface:
1. **Token with `\n\r`**: Node's undici-fetch quietly drops the request (no error surfaces in some versions; in others it throws with a generic "fetch failed" that does NOT include the URL). Verified `e.message === "fetch failed"` and `e.cause.message === "getaddrinfo ENOTFOUND ..."` only — no URL or token in the message.
2. **Token with `/../../admin`**: `URL` parsing collapses `..` segments, and the resulting request goes to `https://api.telegram.org/admin/getMe` instead of the intended `/bot.../getMe`. Telegram's edge returns 404 with no token echo. The host is hardcoded — a malicious token cannot redirect off-host. Worst case is a wasted request.
3. **Token with whitespace**: `.trim()` only handles outer whitespace; embedded spaces stay in the path. Same outcome as (2).

No exfiltration vector found — the host is fixed at `https://api.telegram.org`, and `fetch`'s default error message stops at "fetch failed" without echoing the URL. But this is load-bearing on Node/undici implementation details that aren't part of the contract. A future undici version that *does* include the URL in error messages would convert this into a token-leakage finding.

**Watch-list**: validate token shape at `readToken()` boundary. The Telegram bot-token grammar is `^\d+:[A-Za-z0-9_-]+$` (35-char secret, but length isn't fixed across all token issuance — historical tokens have varied). A loose pattern of `^\d{1,12}:[A-Za-z0-9_-]{20,80}$` would close the door without rejecting any legitimate format I'm aware of. Rejected tokens should fail with `auth_failed` status using a generic error string ("invalid token format"), NOT echoing the supplied value.

Not fixed inline — token-shape validation is a one-line change but it interacts with the env-var fallback (operator may have a token in `TELEGRAM_BOT_TOKEN` that would suddenly stop working after a tightening), and Reviewer should weigh that. Filed as recommendation.

### S2 — `parseAllowedChatIds` over-accepts numeric formats
`src/telegram.ts:445-456`. `Number(tok)` accepts `1e10`, `0x100`, `0o7`, `007`, `Infinity`, and floats. The post-filter is `Number.isFinite(n) && Number.isInteger(n)`, which rejects `Infinity` and floats but accepts the others.

Concrete cases I exercised:
- `"1e10"` → `10000000000` (silent — operator typed scientific notation thinking it was decimal? unlikely, but accepted)
- `"0x100"` → `256` (silent — same)
- `"007"` → `7` (silent — JS doesn't treat leading-zero strings as octal in `Number()`, but visual confusion possible)
- `"999999999999999999999"` → `1e+21` (`Number.isInteger` returns `true` even for floats above 2^53). Two distinct chat-ID strings in this range coerce to the same float. A non-allowlisted user with a coincidentally-similar ID would match.

This is theoretical: real Telegram chat IDs sit well below `Number.MAX_SAFE_INTEGER` (2^53 - 1 ≈ 9.007 × 10^15). Group IDs are around `-1001234567890` (~13 digits), user IDs even smaller. So no real chat ID hits the imprecise-float collision. But the validator is permissive by accident, not by design.

**Watch-list**: tighten to `^-?\d+$` and additionally cap at `Number.MAX_SAFE_INTEGER` magnitude. Two-line change; not applied here because the collision scenario requires the operator to paste a malformed ID, and the consequence is "your own paste matches a non-real chat" — fail-loud (the bot never responds because no real Telegram update has that ID). Documenting only.

### S3 — Telegram-initiated runs bypass per-task approval gates
`src/server.ts:1766-1789`. The `query()` call inside `onTelegramMessage` passes `allowedTools`, `systemPrompt`, `cwd`, `model`, optional `resume`, optional `permissionMode: "plan"`, and optional `agents`. It does NOT thread a `requiresApproval` flag the way `taskQueue` runs do for C16d.

Consequence: an allowlisted operator sending a Telegram DM gets the same tool surface as the web-UI chat path — and, like the web path, that surface is gated by `cwdIsProductionMarked` (production-cwd matcher fires regardless of channel) but NOT by a per-task `requiresApproval: true`. Web-UI chat is in the same boat (the per-task flag only exists on `taskQueue`/scheduler entries). So this is consistent with the existing design.

The watch angle is asymmetric trust: an operator's web browser is generally on the same machine as the server (single workstation). An operator's Telegram DM is on a phone — credible compromise paths include a stolen unlocked phone, a SIM-swap attacker who has installed the operator's Telegram session via cloud login, or a malicious app on the phone reading clipboard for chat-ID copy operations. Compromise of the phone yields full agent control via `/main rm -rf /`.

In the current threat model the operator owns the phone and the localhost server, and "remote-ish" agent control is the FEATURE C05 ships. The operator gets to choose whether their phone account is allowlisted. Documenting because the symmetry break ("DM is just like web chat, but the credential is your phone") deserves an explicit watch-list entry rather than implicit acceptance.

**Watch-list**: a future enhancement could route Telegram-initiated runs through a "channel-aware" approval policy — e.g., always require approval for `Bash`/`Write`/`Edit`/`WebFetch` when channel is Telegram, regardless of cwd. The operator would respond via a follow-up Telegram message ("/approve <id>") or via the kanban. Not in the C05 scope; flagging for the next iteration.

### S4 — `/api/telegram/test` is unauthenticated
`src/server.ts:1852-1855`. `POST /api/telegram/test` runs `getMe()` against the configured token and returns `{ok: true, botUsername}` or `{ok: false, error}`. No body, no auth, idempotent on the server side but it does fire a real network call to Telegram on every invocation.

Two threats:
1. **Rate-limit burn against the token**: a localhost-resident attacker (or a misconfigured browser tab in a tight loop) can hammer this endpoint and burn the token's getMe quota. Telegram's per-method limits are generous (~30 req/sec for getMe) but persistent abuse can trip the 429-with-retry-after path. The result is a temporarily-degraded bridge.
2. **Token-presence side-channel**: the response distinguishes "no token configured" from "token configured but invalid" from "token configured and valid (returns botUsername)". An attacker can poll the endpoint to detect token configuration changes — useful for race-with-restart attacks that don't otherwise apply here.

In the current threat model the only HTTP caller is the operator's own browser, so both threats collapse to "the operator clicked the button too many times." Inherits the project-wide S4 baseline.

**Watch-list**: when commercial path opens, gate behind operator auth (same as `/api/settings`, `/api/approvals/:id/decide`). Add a per-IP rate limit (e.g., 1 req/sec) even for localhost as defense-in-depth — the test button doesn't need to be cheaper than the bot itself.

### S5 — `edited_message` fallback is dead branch
`src/telegram.ts:171` requests `allowed_updates: ["message"]`, which means Telegram will not push `edited_message` updates. `runLoop` at line 377 reads `const msg = u.message ?? u.edited_message;` — the fallback is unreachable today.

If someone changes `allowed_updates` to include `"edited_message"` later, the fallback path would correctly route through the same allowlist check (`runLoop:379` happens AFTER `msg` is resolved, regardless of which field it came from). So the dead branch is safe — it'll do the right thing if someone enables it.

Documented to flag the configuration-vs-code split: the wire-level allow-list and the code-level allow-list don't have to agree, and only the wire-level filter affects bandwidth. The code-level filter is the one that matters for security.

### S6 — Allowlist matches `chat.id`, NOT `from.id`
`src/telegram.ts:379`: `if (!this.opts.allowedChatIds.has(msg.chat.id)) continue;`.

For DMs, `chat.id === from.id` (Telegram uses the same numeric ID for the user's DM chat as for the user). So the allowlist correctly identifies "operator's DM with the bot."

For groups: `chat.id` is the group's ID (negative), `from.id` is the message-sender's user ID. If the operator's group ID is in the allowlist AND the bot is in the group, ANY group member's message routes to the agent. The operator may not have intended this — they may have allowed "my own group" thinking only their messages count.

In the current threat model the operator chooses the allowlist. The setting's help text (`src/settings.ts:185`) says "DMs from these chat IDs are routed to your agents" — the word "DMs" is misleading because group IDs work too, with the broader semantic just described.

**Watch-list**: tighten the help text to "Chat IDs (DMs OR groups). For groups, ANY member's message routes to your agents — only allowlist groups you fully control." Optional: add a `from.id` allowlist as a second filter. Not applied here because the change requires UI work and the current behavior is documented.

### S7 — No bypass path for `IncomingMessageContext`
Walked all callers of the `OnIncomingMessage` type and the `IncomingMessageContext` constructor. The only construction site is `src/telegram.ts:388-394` inside `runLoop`, immediately after the allowlist check. No alternate path constructs an `IncomingMessageContext` directly to feed `onMessage`. No test-only override observed (the existing tests at `tests/features.spec.ts` exercise the bridge through the real `runLoop` via mocked `getUpdates`).

Verified: `onTelegramMessage` cannot be called for a non-allowlisted chat. Tight.

### S8 — SQL injection walk
`src/telegram.ts`: zero `db.*` references, zero SQL.
`src/telegramInstance.ts`: zero `db.*` references; reads settings via `configValue()`.
`src/server.ts` Telegram block (1626-1855): zero `db.*` references; reads via `configValue()`, dispatches via `query()`.

`configValue` at `src/settings.ts:82-87` calls `getSettingStmt.get(key)` — a module-scoped prepared statement with one `?` placeholder. The `dbKey` argument comes from a hardcoded string literal at every Telegram call site (`"telegram.bot_token"`, `"telegram.allowed_chat_ids"`). No user-controlled input reaches a SQL builder via the Telegram path.

Clean.

### S9 — JSON parsing on untrusted input
`src/telegram.ts:136`: `(await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number }; }`. The `.catch(() => ({}))` swallows malformed-JSON errors — the caller then sees `json.ok === undefined`, falls into the `!res.ok || !json.ok` branch, throws `TelegramError(res.status, "HTTP <status>")`. Safe failure mode.

The TypeScript cast is purely structural — Node's `JSON.parse` produces plain objects with no prototype pollution surface (modern V8 strips `__proto__` in JSON parse). No `eval`, no `Function`, no dynamic property assignment from the response body to a sensitive target.

The only place the response payload reaches dangerous territory is `msg.text` flowing into `parseTelegramCommand` (`server.ts:1637-1656`). That function uses only `trim`, `startsWith`, `indexOf`, `slice`, `toLowerCase`, and a literal-pattern `replace(/@.*$/, "")`. No regex with input-sourced patterns, no template-string-then-eval, no `Function` constructor. Then the body is fed to `query({prompt, ...})` as a string — at which point we're back in the standard prompt-injection threat (S3 above).

Clean for the JSON-parsing-as-code class. The prompt-injection class is covered by S3.

### S10 — Two-instance conflict semantics
`src/telegram.ts:351-359`: a 409 Conflict from Telegram flips status to `conflict`, logs, and stops the loop. Telegram's own server enforces at-most-one long-poll connection per token, so a second Command Center instance (e.g., the operator running the dev server on their laptop while a production bot polls from a server) gets the 409 and exits.

The interaction with `getUpdates`'s `offset` is also clean: each `getUpdates` call carries its own `offset`, which Telegram uses to mark messages as acknowledged. If two instances were somehow racing (they can't, due to the 409), both would see the same updates initially, and whichever ack'd first would shift Telegram's pointer past those messages. Worst case: a brief window where messages might be processed twice — but the SDK's session tracking would treat them as separate prompts in the same session, which is operator-visible (they'd see the duplicate replies in their DM) but not security-relevant.

Verified safe.

## On the settings-save / restart race
Reviewer R3 flagged the concurrency angle: a `restartTelegram()` call fires asynchronously after `setSetting()` writes. In sequence:
1. `setSetting("telegram.bot_token", newToken)` writes to SQLite.
2. `restartTelegram()` is called fire-and-forget.
3. The route returns `{ok: true, changed}` to the caller immediately.
4. `restartTelegram()` reads the new token via `readToken()` (same SQLite call) and bootstraps.

The security angle: between step 1 and step 4, the listener's in-memory `opts.token` still holds the OLD token. Any in-flight `getUpdates` (long-poll) keeps using the old token until it returns or aborts. `stopTelegram()` calls `abortController.abort()` BEFORE step 4, so the in-flight poll cancels promptly.

There's no TOCTOU bypass here in the localhost-trusted threat model. A hypothetical remote attacker with `/api/settings` POST access could rotate the token to one they control, but that's the unauthenticated `/api/settings` exposure (S3 of C16d, S4 of 2026-04-23 baseline) — not specifically a Telegram bug.

`onTelegramMessage` re-reads the token via `configValue` on EVERY message (`server.ts:1683`), so the dispatch path always uses the fresh value even if the listener happens to be holding a stale token in `opts`. That's belt-and-suspenders, deliberate per the inline comment ("Settings save can rotate it"). Good.

## On the rate-limit DoS via compromised allowlisted account
A compromised operator phone spamming 1000 messages: `runLoop` accepts each (allowlist match), fires `onMessage` per message as a fire-and-forget Promise (`server.ts:1681` is the handler, called via `telegram.ts:396-407`), each fires a SDK `query()`. CostGuard's per-agent rate cap (`src/costGuard.ts`) caps requests per sliding window — once tripped, subsequent runs reply with `"⚠️ <budget cap reached>"` (`server.ts:1731-1738`).

So the cap is bounded:
- N messages from compromised phone arrive in tight succession
- First few (up to rate-cap window allowance) fire real `query()` calls and burn tokens
- Remainder hit CostGuard preflight, reply with budget message, no SDK fire

Total damage = (rate-cap allowance × per-call avg cost). With default no-cap configuration this is unbounded; with default rate cap it's bounded.

The fire-and-forget pattern at `telegram.ts:396` adds each in-flight `onMessage` promise to a `Set`, drained on stop. There's no per-listener cap on the `inFlight` Set — under sustained flood it could grow unboundedly between the rate-cap-budget-reached check (which is fast) and the SDK call returning. The reply chain is fast (just one `sendMessage` call), so each in-flight promise resolves in ~hundreds-of-ms even after rate-cap kicks in. Bounded growth in practice; could pathologically balloon if the operator's network is slow.

**Watch-list**: cap `inFlight.size` at e.g. 100 per listener. Reject (drop) the new `onMessage` if cap reached, log it, no reply. One-line fix; not applied here because the compromise-the-phone scenario has bigger problems than memory growth.

## Watch list (escalates if commercial path opens)
- **S1 → MED**: validate token shape at `readToken()` boundary (`^\d{1,12}:[A-Za-z0-9_-]{20,80}$` or similar). Precondition: any reliance on undici implementation detail for not echoing URL in error messages, OR the token surface broadens (e.g., logged on disk, returned in a debug response).
- **S2 → LOW (no escalation needed)**: tighten `parseAllowedChatIds` to `^-?\d+$` with `Number.MAX_SAFE_INTEGER` cap. Two-line change; do it whenever someone next touches the file.
- **S3 → MED**: Telegram-initiated runs should auto-trigger per-task approval for `Bash|Write|Edit|WebFetch`. Precondition: phone-compromise becomes a credible threat (e.g., the operator runs the bot in a shared family Telegram), OR commercial path opens and "remote channel" needs a stricter default than "local UI."
- **S4 → HIGH**: gate `/api/telegram/test` behind operator auth, rate-limit per-IP. Precondition: server binds beyond 127.0.0.1.
- **Compromised-account flood**: cap `inFlight.size` per listener. Precondition: any deployment that survives the operator's phone being compromised.

## Confirmed safe
- **Token never logged**: walked every `console.log/warn/error` in `telegram.ts`, `telegramInstance.ts`, and the C05 block of `server.ts`. None reference `token`, `bot_token`, or `TELEGRAM_BOT_TOKEN`. Logger callback at `telegramInstance.ts:69-79` explicitly comments "never include the token in any log line" and only forwards `msg` (which is constructed by `TelegramListener.log` and never includes the token in any of its callsites — verified at `telegram.ts:308, 348, 354, 367, 381, 401, 416-417`).
- **Token never returned in API responses**: `/api/settings` GET goes through `maskedSettings()` (`src/settings.ts:67-75`), which masks any `isSecret` row (`telegram.bot_token` is `isSecret: true` in the schema). `/api/telegram/status` returns `ListenerStatus`, which has shape `{kind, error?, botUsername?}` — no token field. `/api/telegram/test` returns `{ok, botUsername?}` or `{ok, error?}` — `error` comes from `(err as Error)?.message ?? String(err)` of a `getMe` failure, and Telegram's 401 description is `"Unauthorized: invalid token specified"` (verified live) — does NOT echo the token.
- **Token never echoed in error messages from `callApi`**: `TelegramError` carries `description` from Telegram's response body, which is the API's own error string ("Unauthorized", "Conflict: terminated by other getUpdates request", etc.) — never echoes the supplied token. Network-level errors propagate `(err as Error).message`, which on Node 20+ is `"fetch failed"` for connection failures with the URL hidden inside `err.cause` — verified by hitting `https://nonexistent.invalid/bot12345:SECRETTOKEN/getMe` and confirming `e.message === "fetch failed"` and `e.cause.message === "getaddrinfo ENOTFOUND nonexistent.invalid"`. Note: this is undici implementation behavior, not contract — see S1 watch-list.
- **Allowlist enforcement**: only path through `onMessage` is via `runLoop`, which checks `allowedChatIds.has(msg.chat.id)` and silently `continue`s on mismatch. No `sendMessage` call to non-allowed chats — confirmed deliberate by inline comment ("don't sendMessage(), which would confirm the bot exists to a non-allowed party"). Empty allowlist (`new Set()`) returns `false` from `.has()` for every input, blocking all messages — verified.
- **SSRF**: `TELEGRAM_API` is hardcoded to `https://api.telegram.org`. The only user-controlled input that lands in a URL is `token` and `chatId`/`messageId` — `chatId`/`messageId` go in the JSON body, not the URL. `token` lands in the path. Path-segment manipulation cannot redirect off-host (URL parsing keeps the host fixed). No SSRF vector.
- **No `eval`/`Function` on incoming text**: `parseTelegramCommand` uses only `String` methods. `chunkReply` uses only `String` methods. The text reaches `query({prompt})` as a plain string. No path treats incoming text as code.
- **Two-instance conflict surfaces correctly**: `409 Conflict` from Telegram flips status to `conflict` and stops the loop; cannot corrupt the other instance's offset (Telegram serializes its own per-token connection limit).
- **Settings rotate-token race**: `onTelegramMessage` re-reads the token on every message (`server.ts:1683`); listener's `opts.token` may be stale during a save+restart window, but the dispatch path is always fresh. No TOCTOU bypass under localhost trust.

## Verdict
- New HIGH: 0
- New MED: 0
- New LOW: 4 (S1 token validation, S2 chat-ID parser, S3 Telegram-channel approval gap, S4 test endpoint exposure)
- New Info: 6 (S5 dead branch, S6 group chat semantics, S7 no bypass path, S8 SQL clean, S9 JSON parsing clean, S10 two-instance conflict clean)
- Inline fix applied: 0 (every gap is either accept-under-threat-model or a one-line change that should land via Reviewer)
- Latent issues logged for next maintainer: 2 (S1 token-shape validation, S6 group-chat help text)

C05 ships. Token leakage paths are tight, allowlist is correctly enforced, no SSRF, no SQL injection, no JSON-as-code. The four LOW findings are all watch-list items that escalate if/when this primitive lifts beyond personal-use localhost — same shape as every prior C16{a,b,c,d} audit. Most acute future-fix is S3 (Telegram-channel runs warrant a stricter default approval policy than web-UI runs because the credential is a phone, not a workstation), but that's a feature, not a bug, and belongs in the next iteration rather than as a C05 blocker.
