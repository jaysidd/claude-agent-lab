# C05 Telegram Bridge — Performance Audit

> Date: 2026-04-29
> Branch: c05-telegram
> Scope: long-poll loop overhead, onMessage fan-out, typing-loop cost, chunkReply + Markdown fallback, restart serialization, Settings save flow.

## Summary

C05 lands well-shaped for personal scale. The long-poll loop is essentially free at idle (one HTTP request every 25 s while parked on Telegram's server-side long-poll), the `inFlight` Set has correct cleanup semantics with no leak path, `chunkReply` is bounded and fast (~78 µs for 50 KB with paragraph boundaries), and `parseAllowedChatIds` is invisible (~0.2 µs for typical 3-id input).

One MED finding worth fixing inline: the typing-indicator loop sleeps a full 4 s between `sendChatAction` calls without an early-wake on SDK completion, so every Telegram reply pays an **average ~2 s (worst-case ~4 s) of dead-wait latency before the actual reply lands**. The reply itself is already in `finalText`, but the user-visible delay between "typing…" disappearing and the message landing is bounded by where the loop happens to be in its 4 s sleep. Fix is < 10 LOC: replace the bare `setTimeout` with a wake-able promise that the `finally` block can resolve immediately. Applied inline.

One LOW with operational implications: `restartTelegram()` is fire-and-forget and not serialized. Two concurrent Settings-save POSTs that both touch a `telegram.*` key can race the `if (listener && listener.isRunning())` guard in `startTelegram()` and end up with two listeners constructed; the first becomes an orphan that polls forever. Realistically rare (operator-driven save flow, not automated), but flagged.

Other findings are LOW or accept: the long-poll loop's idle CPU is negligible (one fetch per 25 s, blocked on the server side); the backoff cap of 5 min is correctly bounded; the `inFlight` Set drains correctly via `.finally`; `chunkReply` worst-case (1 MB pathological input) is ~300 µs and humans never see that scale; `getMe` on Settings save is one ~200 ms roundtrip, which is fine for a save-button flow.

- HIGH: 0
- MED: 1 (P1, **fixed inline**)
- LOW: 6

## Findings

| # | Severity | Area | Summary | Recommendation |
|---|---|---|---|---|
| P1 | MED | `src/server.ts:1740-1760` typing loop | The `setTimeout(r, 4000)` sleep is not wake-able; on SDK reply, the `finally` block sets `typingActive = false` but waits up to 4 s for the loop to observe it. Average ~2 s, worst-case ~4 s of user-visible delay before each Telegram reply | **Fixed in this audit**: introduced `wakeTypingLoop` to clear the timer and resolve the sleep immediately when the SDK call settles |
| P2 | LOW | `src/telegramInstance.ts:98-101` `restartTelegram()` | Not serialized. Concurrent calls can both pass `if (listener && listener.isRunning())` after their stops complete and construct two listeners; the first becomes an orphan that polls forever | Defer; add an in-flight `restarting: Promise<void> \| null` mutex when settings save grows multi-tab support |
| P3 | LOW | `src/telegram.ts:213-252` `chunkReply` | 50 KB paragraph input: ~78 µs. 50 KB no-boundaries: ~14 µs (the early-flush + slice path is faster than the iterate-paragraphs path). 1 MB pathological: ~293 µs / 263 chunks | Accept; bounded and fast, never on a hot path |
| P4 | LOW | `src/telegram.ts:436-456` `parseAllowedChatIds` | 0.07 µs (1 id) → 0.7 µs (10 ids) → 76 µs (1000 ids pathological). Runs once per restart | Accept; invisible |
| P5 | LOW | Markdown-parse fallback path (`src/server.ts:1820-1836`) | When Telegram rejects markdown, we re-send the same chunk plain-text — second HTTP roundtrip per affected chunk. Bounded by chunk count (~13 max for 50 KB) | Accept; pathological-only, and graceful is the right behavior |
| P6 | LOW | `inFlight: Set<Promise<void>>` memory model | Each entry: one Promise + the SDK-call frame. 10-message tight burst → Set grows to 10 entries, drains as each settles. No leak path (`.finally(() => this.inFlight.delete(p))` keys by identity, fires once per settle) | Accept |
| P7 | LOW | Idle long-poll CPU | One `fetch(getUpdates, timeout=25)` every ~25 s; both client and Telegram block on the server side, so steady-state CPU is essentially 0. Backoff exponential from 1 s, capped at 5 min, resets on success | Accept |

---

### P1 — Typing-loop sleep blocks reply latency (**MED, fixed inline**)

**Where:** `src/server.ts:1740-1760` (the typing loop) and `src/server.ts:1799-1803` (the finally block).

**Observation.** The original loop was:

```ts
let typingActive = true;
const typingLoop = (async () => {
  while (typingActive) {
    try { await telegramSendChatAction(token, ctx.chatId, "typing"); }
    catch { /* swallow */ }
    await new Promise((r) => setTimeout(r, 4000));   // <-- not wake-able
  }
})();

// ... SDK call ...
} finally {
  typingActive = false;       // flag flips, but loop is mid-sleep
  await typingLoop;           // waits up to 4 s for the sleep to drain
}
```

The `finally` block awaits `typingLoop` so the reply send is gated on the loop terminating. With the bare `setTimeout(4000)`, the average residual sleep at SDK-completion time is **~2 s**, and worst-case **~4 s**. The user sees the typing-indicator disappear, but no reply lands for 0-4 s afterward — exactly the dead-air window that breaks chat-app trust signals.

This is invisible at idle (no Telegram traffic) and doesn't affect throughput (one user, single conversation), but it is a **per-message user-visible latency tax** on every Telegram reply.

**Numbers:**
- Average extra latency before reply: ~2 s
- Worst-case extra latency: ~4 s (loop just entered sleep when SDK settled)
- Best-case extra latency: ~0 ms (SDK settled right at sleep boundary)
- Telegram-side cost: unchanged — same number of `sendChatAction` calls per SDK call (~7-8 for a 30 s call)

**Fixed in this audit** (`src/server.ts:1740-1760`): replaced the bare `setTimeout` with a wake-able promise that the finally block can clear:

```ts
let typingActive = true;
let wakeTypingLoop: () => void = () => {};
const typingLoop = (async () => {
  while (typingActive) {
    try { await telegramSendChatAction(token, ctx.chatId, "typing"); }
    catch { /* swallow */ }
    if (!typingActive) break;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 4000);
      wakeTypingLoop = () => { clearTimeout(t); resolve(); };
    });
  }
})();
// ... SDK call ...
} finally {
  typingActive = false;
  wakeTypingLoop();   // clears the in-flight setTimeout immediately
  await typingLoop;
}
```

Net change: 6 LOC. Reply latency now bounded by the in-flight `sendChatAction` HTTP roundtrip (~50-200 ms typical), not the 0-4 s sleep window. `clearTimeout` is harmless if the timer already fired (the resolve was already called; the second resolve is a no-op).

**Why MED, not HIGH:** the latency is annoying but not breaking — the bot still responds, just with a 0-4 s dead-air window after the typing indicator clears. Not user-blocking, not a leak.

**Why fix inline:** sub-10-LOC change, no API surface change, all 59 smoke tests stay green, and the user-visible improvement (every Telegram reply 2 s faster on average) is the kind of thing the audit exists to surface.

---

### P2 — `restartTelegram()` not serialized (LOW)

**Where:** `src/telegramInstance.ts:98-101` plus the fire-and-forget pattern at `src/server.ts:1035-1039`.

**Observation.** `restartTelegram()` is `await stopTelegram(); return startTelegram();`. The module-scope `listener` is the only state that gates concurrency:

```ts
export async function startTelegram(): Promise<ListenerStatus> {
  if (listener && listener.isRunning()) return listener.getStatus();   // (A)
  // ...
  listener = new TelegramListener({ ... });                            // (B)
  lastStatus = await listener.start();
  return lastStatus;
}

export async function stopTelegram(): Promise<void> {
  if (!listener) return;
  await listener.stop();
  listener = null;                                                      // (C)
  lastStatus = { kind: "stopped" };
}
```

Race scenario with two concurrent Settings saves both touching `telegram.*`:

1. Save A: `restartTelegram()` enters `stopTelegram()`, awaits `listener.stop()` (drains in-flight, ~0-N ms).
2. Save B: `restartTelegram()` enters `stopTelegram()`, sees `listener !== null`, awaits its own `listener.stop()` (now a no-op on the already-stopped listener, but still re-enters).
3. Save A resumes: sets `listener = null` at (C).
4. Save B resumes: sets `listener = null` at (C) — already null, no-op.
5. Save A: enters `startTelegram()`, passes guard (A) (listener is null), awaits `getMe`, eventually sets `listener = newListener_A` at (B).
6. Save B: enters `startTelegram()` *concurrently* with step 5, **also** passes guard (A) (listener was null when B checked, before A wrote it), awaits `getMe`, eventually overwrites `listener = newListener_B` at (B).

Result: `newListener_A` is unreachable from any module-scope reference. Its `runLoop()` is still polling forever — it can only be stopped by `listener.stop()`, but `listener` now points to B. **Orphan listener leak.** It also costs 2× `getMe` calls instead of 1× and creates two long-poll connections to api.telegram.org against the same bot token, which Telegram answers with HTTP 409 Conflict. The 409 path in `runLoop()` correctly sets `stopped = true` and exits, so the orphan eventually self-terminates — but only after the orphan made one more `getUpdates` roundtrip and got the Conflict response.

**Realistically:** Settings save is operator-driven. The user has to click Save twice fast enough for the requests to overlap on the server. The window is `getMe` duration (~200 ms typical), so this requires double-clicking the save button or two open tabs. Low probability in practice.

**Numbers (estimated, no live test):**
- Orphan listener wall time: bounded by the next 409 response → ~0-200 ms after the second `getUpdates` long-poll resolves.
- Extra HTTP cost per race: 1 spurious `getMe` + 1 `getUpdates` (which returns 409).
- Orphan-listener memory: TelegramListener object + AbortController + an in-flight `getUpdates` promise. ~5-10 KB until the Conflict response lands.

**Recommendation.** Defer. The fix is a module-scope `currentRestart: Promise<ListenerStatus> | null` that `restartTelegram()` awaits if non-null, otherwise sets to its own promise:

```ts
let currentRestart: Promise<ListenerStatus> | null = null;
export async function restartTelegram(): Promise<ListenerStatus> {
  if (currentRestart) return currentRestart;
  currentRestart = (async () => {
    try { await stopTelegram(); return await startTelegram(); }
    finally { currentRestart = null; }
  })();
  return currentRestart;
}
```

~7 LOC, but holds against a low-probability operator action. Worth doing alongside the next `telegramInstance.ts` touch — not urgent.

---

### P3 — `chunkReply` characteristics (LOW, accept)

**Where:** `src/telegram.ts:213-252`.

**Numbers (10 000 iters except as noted):**

| Input | Result chunks | µs/call |
|---|---|---|
| 12 B small | 1 | 0.05 |
| 3500 B (under target) | 1 | 0.04 |
| 10 KB paragraphs | 3 | 13.5 |
| 50 KB paragraphs | 11 | 78.1 |
| 50 KB no boundaries (single paragraph) | 13 | 14.1 (1000 iters) |
| 1 MB no boundaries (pathological) | 263 | 293.5 (100 iters) |

**Observations:**

1. **Bounded.** The output array is at most `ceil(text.length / 4000)` chunks, so memory is O(N).
2. **Faster path on no-boundaries input** (50 KB single paragraph: 14 µs vs 78 µs for the same byte count split into 250-char paragraphs). The iterate-paragraphs branch is the slower one because of the `string +` accumulator on every paragraph; the early-flush + slice path skips that and just does N hard slices.
3. **Annotation cost is real but small**: the final `chunks.map((c, i) => ...)` is the per-chunk cost (~5-7 µs for an 11-chunk reply).
4. **The function is called once per Telegram reply.** Even at the 1 MB pathological scale (which is well above any realistic agent reply), 293 µs is invisible.

**Recommendation.** Accept. If a future feature streams a multi-MB tool output to Telegram, revisit; today, no.

---

### P4 — `parseAllowedChatIds` (LOW, accept)

**Where:** `src/telegram.ts:436-456`. Called once per `startTelegram()` from `readAllowedChatIds()`.

**Numbers (100 000 iters except as noted):**

| Input | µs/call |
|---|---|
| empty | 0.02 |
| 1 id | 0.07 |
| 3 ids (typical) | 0.19 |
| 10 ids | 0.66 |
| 1000 ids (pathological) | 75.6 (1000 iters) |

**Observation.** Sub-microsecond at any realistic input size. Runs once per restart. The regex split (`/[\s,]+/`) compiles once at module load.

**Recommendation.** Accept. Confirmed invisible.

---

### P5 — Markdown-parse fallback double-send (LOW, accept)

**Where:** `src/server.ts:1820-1836`.

```ts
for (const chunk of chunks) {
  try {
    await telegramSendMessage(token, ctx.chatId, chunk, { parse_mode: "Markdown" });
  } catch (err: any) {
    const isParseError = /can't parse entities/i.test(err?.message ?? "");
    if (isParseError) {
      await telegramSendMessage(token, ctx.chatId, chunk).catch(() => {});
    } else {
      console.warn(`[telegram] sendMessage failed: ${err?.message ?? err}`);
    }
  }
}
```

**Observation.** When the agent emits markdown that Telegram's parser rejects (commonly: unbalanced `**`, code-block fence interactions, or an isolated `_`), we eat the failure and re-send plain-text. That's a second HTTP roundtrip *per affected chunk*. For a reply with 11 chunks where 3 fail markdown: 14 HTTP roundtrips instead of 11.

**Worst case (50 KB pathological all-markdown-broken):** 26 HTTP roundtrips instead of 13. Still well under Telegram's per-bot rate limit (30/sec global, but 1/sec per chat — the chunks ship serially, not concurrently, so no per-chat-rate violation).

**Could we pre-validate?** Telegram's markdown grammar is strict but documented. A regex-based pre-check would shave the failed-attempt roundtrip but add LOC and risks false-positives (rejecting valid markdown). The current "try, catch, fall back" is the cheapest correct approach.

**Recommendation.** Accept. The doubling only fires on agent-misshapen markdown, which is rare in practice.

---

### P6 — `inFlight: Set<Promise<void>>` memory model (LOW, accept)

**Where:** `src/telegram.ts:262, 396-407`.

**Observation.** The Set holds one Promise per in-flight `onMessage` call. The promise is added at fire-time and removed in `.finally()`. Cleanup keys by identity (`this.inFlight.delete(p)`), and `.finally()` fires exactly once per promise settle.

**Burst scenario (10 messages within < 200 ms):**
1. `getUpdates` returns array of 10 updates.
2. The `for (const u of updates)` loop fires `onMessage` 10 times synchronously, adding 10 promises to the Set.
3. Each `onMessage` runs an SDK call (1-30 s typical). They run concurrently against the SDK; the Promise-Set grows to 10.
4. As each SDK call settles, its `.finally()` removes its promise. Set drains.

**Memory:** baseline allocation per Set entry: ~24-50 B for the V8 Promise reference, plus the captured closure (the SDK call frame, the agent config reference, the ctx). Per in-flight: estimate 100-500 B for the closure chain, but the SDK call itself dominates (it holds a much larger frame). Net Set-overhead: **negligible against the SDK's per-call working set**.

**No leak path:** verified by inspection. The only way a promise stays in the Set is if `.finally()` doesn't fire, which requires the promise to never settle. The promise settles when `onMessage` resolves (SDK done) or rejects (caught by the `.catch` arm). Both paths are exhaustive.

**Recommendation.** Accept.

---

### P7 — Idle long-poll CPU and backoff (LOW, accept)

**Where:** `src/telegram.ts:327-371`.

**Observation.** Idle (no incoming messages):
- One `getUpdates(timeout=25)` request every ~25 s.
- The TCP connection is held open by Telegram for the full 25 s — the client side is parked on `await fetch(...)` with the AbortSignal, no CPU.
- Per-cycle wake: parse the empty `[]` response, loop back to `await getUpdates`. ~50-100 µs of in-process work per 25 s.

**Backoff path** (Telegram unreachable):
- Exponential from 1 s, capped at 5 min.
- Sleep is `await sleep(backoffMs)` — a bare `setTimeout` promise. CPU 0 during sleep.
- Reset on first successful poll.
- Steady-state at outage: one `fetch` failing fast (~5-30 s for DNS/TCP errors), one `sleep(backoff)`, repeat. At max-backoff (5 min): 1 fetch attempt every 5 min until Telegram returns.

**Aborted state** (`stop()` called):
- `abortController.abort()` rejects the in-flight `fetch` immediately.
- Loop checks `if (this.stopped) return;` before logging or backing off — no spurious logs.

**Recommendation.** Accept. The loop is the textbook shape for long-polling; backoff is bounded; abort is correct.

---

## Watch list (deferred / not actionable now)

- **P2 restart serialization** — Add `currentRestart` mutex when multi-tab Settings becomes a feature, or on the next `telegramInstance.ts` touch.
- **`onTelegramMessage` per-message overhead** — `configValue()` for the token, `findAgent()` lookup, `sessionByAgent.get/set`, CostGuard preflight + record. All synchronous in-process work; estimated ~5-15 µs total per message. Dwarfed by the SDK call (1-30 s). Verified via the C16c audit (CostGuard.check ~5 µs after C16c P1 cached `getSettingStmt`).
- **`getMe` on Settings save** — One ~200 ms HTTP roundtrip per save. Acceptable; flag if Settings save flow ever becomes higher-frequency.
- **`config.value` re-read per message** — `onTelegramMessage` re-reads the token via `configValue()` on every message (intentional, to support mid-session token rotation). The settings.ts P1 prepared-statement cache means this is ~0.5 µs/call. Accept.
- **Multi-bot future** — The current singleton listener pattern (one bot, one token) is a deliberate scope choice. If C05 grows to multiple bots / multiple tokens, the singleton becomes a Map and the restart path needs per-key serialization. Out of scope for C05.
- **Telegram rate-limit awareness** — `sendMessage` is called once per chunk in a loop with no rate-limit awareness. Telegram's per-chat rate is 1/sec; for a 13-chunk reply, the serial `await` already paces us at chunk-send-latency (~100-200 ms each), so we're well under. If a future code path concurrent-sends to multiple chats, revisit.
- **Per-message TLS reuse** — Each `callApi` does a fresh `fetch()`. Node 20+ has `undici` global agent with HTTP/1.1 keep-alive enabled by default, so the TLS handshake amortizes across calls to api.telegram.org. Verified — no work needed.

---

## Methodology

Microbenchmarks run on this project's Node 24.14.1 / Darwin 25.3.0 with the project's own `tsx` loader. Functions imported directly from `src/telegram.ts`. Each bench warmed with 1k iterations before the timed run; iter counts varied (100-100 000) to keep total wall time under 1 s per measurement.

Verified:
- **`chunkReply`** — sized inputs from 12 B to 1 MB, with paragraph-rich and no-boundary variants. Confirmed bounded chunk count and µs-scale wall time.
- **`parseAllowedChatIds`** — sized inputs from empty to 1000 ids. Confirmed sub-microsecond at typical scale.
- **Set memory baseline** — populated 1000 Sets each with 100 settled Promises, measured `process.memoryUsage().heapUsed` delta. ~10 KB per 100-promise Set, dominated by the Promise references rather than the Set's own metadata.
- **Typing-loop latency** — modeled the `setTimeout(4000)` wait window analytically; confirmed the `finally` await blocks on the residual sleep. Wake-able fix verified to compile (`npx tsc --noEmit`) and pass smoke (`npx playwright test --project=smoke` 59/59 green).
- **Restart race** — verified by code inspection of `startTelegram` / `stopTelegram` / `restartTelegram` against the module-scope `listener` reference. No live concurrent test; the race window is `getMe` duration (~200 ms).
- **`runLoop` abort path** — verified `if (this.stopped) return;` runs before logging in the catch arm; aborts via `AbortController.abort()` reject the in-flight fetch immediately.

Scratch benchmark file written to project root (`tmp-bench-c05.mjs`) and removed after measurement — not committed.

---

## Verdict

- HIGH: 0
- MED: 1 (P1, **fixed inline**)
- LOW: 6 (one defer, six accept)
- **Ship after the inline P1 typing-loop fix lands with the rest of C05.**

The bridge implementation is shaped well: standalone primitive with clean stop semantics, abort-aware fetch chain, exponential backoff capped at a reasonable ceiling, paragraph-aware chunking, fail-safe markdown fallback. The one user-visible perf bug — typing-loop sleep blocking the reply by up to 4 s — is now closed inline. Everything else is on the watch list for scale or operational shapes that don't apply to personal-tier Command Center.

Inline change: `src/server.ts:1740-1760` (typing loop made wake-able) and `src/server.ts:1799-1803` (finally block calls `wakeTypingLoop()`). No other files touched.
