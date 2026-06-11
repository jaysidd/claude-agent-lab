# Browser Automation — Security Audit

> **RESOLUTION (2026-06-11):** All findings addressed before merge.
> - **S1 (HIGH, open-mode click/redirect SSRF):** "open" mode **removed entirely** — the feature is allow-list-only. An agent can navigate only to operator-added domains; Playwright runs with `--allowed-origins` restricted to those. The residual (an allow-listed page that redirects/links to a private host is not individually re-gated, because Playwright origin flags do not gate redirects) is documented in the module header + the user guide, with a connect-time egress proxy noted as the future full fix.
> - **S2/S3 (HIGH/MED, IPv4-mapped IPv6 + trailing-dot + `[::]`):** fixed in `isUrlAllowed` — hostname is trailing-dot-stripped, `::`/`::1` denied, and `ipv6EmbeddedIPv4()` extracts the embedded IPv4 from `::ffff:...` / `64:ff9b::...` (including Node's compressed-hex form) and runs the private-IP check. A 24-case unit test covers every bypass string from this audit.
> - **S4 (watch-list):** browser + Bash on one agent can self-edit the gate via the unauthenticated localhost route — kept on the commercial-path watch-list; accepted under the personal-use/localhost model.

> Date: 2026-06-10
> Branch: browser-automation
> Scope: `src/browser.ts` (the domain gate — `isUrlAllowed`, `toIPv4`, `isPrivateIPv4`, `browserOptionsFor`, `BLOCKED_ORIGIN_FLOOR`) and the `src/server.ts` additions (`buildBrowserGuardHook` PreToolUse gate, `agentToolOptions`/`mergeHooks`/`hooksOpt`, `/api/browser/*` routes).
> Threat model: personal-use, localhost-only (`127.0.0.1:3333`), single-tenant — BUT a visited page is **untrusted input** (prompt-injection carrier) and a browsing agent is an **SSRF cannon** into the operator's LAN, loopback, and cloud-metadata endpoints. The domain gate is the containment, so it is held to a higher bar than the rest of the app.

## Summary
**2 HIGH, 1 MED, 3 LOW, 5 Info.**

The gate is well-conceived — two layers (Playwright origin flags + an IP-parsing PreToolUse hook), a hard deny-floor enforced in both modes, `--isolated` profile, protocol floor, parameterized SQL. **Allowlist mode is sound**: Playwright's `--allowed-origins` is a hard floor that blocks every destination not matching the operator's domains, regardless of any hook bypass, and regardless of click vs. explicit navigation.

**Open mode is structurally LAN-exposed**, and that is where the two HIGH findings live:

- **S1 (HIGH)** — In open mode, no `--allowed-origins` is passed. The only browser-layer floor is `--blocked-origins = BLOCKED_ORIGIN_FLOOR`, which lists six *literal* origins (`localhost`, `127.0.0.1`, `0.0.0.0`, `169.254.169.254`) — **not** the RFC1918 / link-local *ranges*. A link **click** or a page **redirect** (neither of which fires the `browser_navigate` hook) to plain `http://10.0.0.1`, `http://192.168.1.1`, `http://172.16.0.1`, or `http://169.254.169.254` (when not the literal in the floor) reaches the LAN. No obfuscation required.
- **S2 (HIGH)** — Even the *explicit* `browser_navigate` hook (the IP-aware layer that is supposed to catch what origin-strings miss) is bypassable via **IPv4-mapped IPv6** literals. `toIPv4` does not decode them and the IPv6 branch only matches `fc/fd/fe8-b` prefixes. Confirmed bypass strings below.

These two are HIGH **in open mode only**. In allowlist mode both are backstopped by `--allowed-origins`.

> Enforcement caveat: the bypasses are proven at the **gate-logic / Node-URL-parser** level (replicated `isUrlAllowed` traced against `new URL().hostname`; see "Verification" below). Whether Chromium then *connects* a given form to a live service is asserted only for the deterministic IPv4-mapped/plain-IP cases; `[::]` and `localhost.` carry a resolver-dependent caveat. The Playwright `--allowed-origins`/`--blocked-origins` semantics are read from the documented flag behavior, not live-fuzzed.

## Findings

| # | Severity | Threat | Status |
|---|---|---|---|
| S1 | **HIGH** | Open-mode click/redirect SSRF — hook only gates `browser_navigate`; `--blocked-origins` floor lists literals, not RFC1918/link-local ranges | open — recommend fix |
| S2 | **HIGH** | Explicit-nav hook bypass via IPv4-mapped IPv6 (`[::ffff:7f00:1]` etc.) — defeats `isUrlAllowed` in open mode | open — recommend fix |
| S3 | **MED** | `[::]` (unspecified) and `localhost.` (trailing dot) bypass the gate logic; connect-behavior resolver-dependent | open — fold into S2 fix |
| S4 | Low | `POST /api/browser/:agentId` can flip `mode: "open"` / add a domain with no auth — a prompt-injected agent with Bash can `curl` its own config before navigating | accept (localhost baseline); browser+Bash flagged on watch-list |
| S5 | Low | Hook denies but does not abort the run; allowlist-mode in-policy pages can still prompt-inject the agent into in-allowlist mischief | accept (inherent residual) |
| S6 | Low | `console.warn` logs the denied URL (untrusted) — log-injection / noise only | accept |
| S7 | Info | `--isolated` confirmed present; no path to the operator's real Chrome profile/cookies | confirmed safe |
| S8 | Info | Protocol floor + no `--allow-unrestricted-file-access`/`--no-sandbox` → `file://`/`chrome://`/`data:`/`view-source:` blocked | confirmed safe |
| S9 | Info | SQL parameterized; domains normalized; route input validated | confirmed safe |
| S10 | Info | Prompt-injection → denied-destination navigation is re-checked by the hook on every explicit nav (allowlist mode fully contained) | confirmed safe |
| S11 | Info | `--block-service-workers` set; `--allowed-origins` sentinel (`https://invalid.invalid`) for empty-allowlist mode is fail-closed | confirmed safe |

---

### S1 — Open-mode SSRF via link click / redirect (HIGH)

**`src/server.ts` `buildBrowserGuardHook` matcher `^mcp__browser__browser_navigate$`** + **`src/browser.ts:289-296` `BLOCKED_ORIGIN_FLOOR`**.

The PreToolUse hook matches **only** `mcp__browser__browser_navigate` (explicit navigation). A navigation triggered by **`browser_click` on an anchor**, by **`browser_run_code_unsafe`**, or by an **HTTP redirect / `<meta refresh>` / JS `location=`** on a visited page does **not** fire the hook. For those, the only browser-layer containment in **open mode** is Playwright's `--blocked-origins`, set to:

```
http://localhost;https://localhost;http://127.0.0.1;https://127.0.0.1;http://0.0.0.0;http://169.254.169.254
```

This is six **literal origins**. Playwright's `--blocked-origins` is **origin-pattern matching, not CIDR** — it cannot express "all of 10/8, 172.16-31/12, 192.168/16, 169.254/16." So in open mode the entire RFC1918 + link-local space is reachable by click/redirect with **no obfuscation at all**:

- `http://10.0.0.1/`, `http://192.168.1.1/` (router admin), `http://172.16.0.1/` — reachable
- `http://169.254.169.254/...` cloud metadata — the literal `http://169.254.169.254` is in the floor, but `https://169.254.169.254`, a port variant, or the IPv4-mapped form (S2) is not
- `http://127.0.0.1:3333/` — the local Command Center server itself; `http://localhost`/`http://127.0.0.1` are floored, but the trailing-dot and IPv6-mapped forms (S2/S3) are not

This is the dominant finding: the IP-aware floor (`isUrlAllowed`) is wired to a single tool name, while the actual navigation surface (clicks, redirects, in-page JS) is much wider. The hook is necessary but cannot be the floor by itself.

**Recommendation (developer applies):**
1. **Treat open mode as explicitly-unsafe-by-design.** The honest position: open mode cannot be fully contained against LAN SSRF by `--blocked-origins` alone, because that flag is not CIDR-aware. Either (a) **remove open mode**, (b) **route all browser egress through an IP-filtering forward proxy** that rejects private/loopback/link-local at connect-time (the only place that reliably catches click+redirect+DNS-rebinding), or (c) keep it but **document it as an explicit "this exposes your LAN" toggle** with a UI warning.
2. As a stop-gap (does **not** fully close it): expand `BLOCKED_ORIGIN_FLOOR` toward the private ranges as far as origin patterns allow, and add a **PostToolUse re-check** (or hook the other navigating tools — `browser_click`, `browser_navigate_back`, `browser_run_code_unsafe`) so the IP-aware `isUrlAllowed` runs on the resulting URL. Note this still can't see redirect chains the browser follows internally — only a connect-time proxy can.

### S2 — Explicit-nav hook bypass via IPv4-mapped IPv6 (HIGH)

**`src/browser.ts:89-114` (`toIPv4`), `155`, `170-175`.**

`isUrlAllowed` is the authoritative IP-aware layer — the one that is supposed to catch obfuscated private-IP forms that origin-strings miss. It does catch decimal/hex/short-form IPv4 (verified — see below). It **does not** catch **IPv4-mapped IPv6**, because:

- `toIPv4` returns `null` for any hostname containing `:` (none of its three regexes match), so the private-IPv4 path is skipped.
- The IPv6 branch (line 172) only denies `/^f[cd]/i` (fc00::/7) and `/^fe[89ab]/i` (fe80::/10). IPv4-mapped addresses start `::ffff:...` and fall through.

Node's `new URL()` **canonicalizes** `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]` (hex), and after the gate strips brackets the hostname is `::ffff:7f00:1` — `toIPv4` → null, IPv6 branch → no match, **gate passes**. In open mode (no `--allowed-origins`) the navigation proceeds to the embedded IPv4 target.

**Confirmed bypass strings (each reaches a private/loopback/metadata target, traced through replicated gate logic, open mode):**

| Input string | Node hostname | Embedded target | Gate verdict |
|---|---|---|---|
| `http://[::ffff:127.0.0.1]/` | `[::ffff:7f00:1]` | 127.0.0.1 (loopback) | **ALLOWED** |
| `http://[::ffff:7f00:1]/` | `[::ffff:7f00:1]` | 127.0.0.1 | **ALLOWED** |
| `http://[::ffff:a9fe:a9fe]/` | `[::ffff:a9fe:a9fe]` | **169.254.169.254 (cloud metadata)** | **ALLOWED** |
| `http://[::ffff:0a00:0001]/` | `[::ffff:a00:1]` | 10.0.0.1 (RFC1918) | **ALLOWED** |
| `http://[0:0:0:0:0:ffff:127.0.0.1]/` | `[::ffff:7f00:1]` | 127.0.0.1 | **ALLOWED** |

The IPv4-mapped metadata bypass (`[::ffff:a9fe:a9fe]` → 169.254.169.254) is the sharpest: it is the precise endpoint the floor's literal `169.254.169.254` was meant to protect, defeated by an alternate spelling that even the explicit-nav hook waves through.

**Recommendation:** in `toIPv4`, decode IPv4-mapped IPv6 before the IPv6 branch — detect a `::ffff:` (and `::ffff:0:`) prefix, extract the trailing IPv4 (whether dotted `::ffff:127.0.0.1` or hex-grouped `::ffff:7f00:1`), and run it through `isPrivateIPv4`. Equivalently, normalize the host with a real IP library (e.g. Node's `net.isIP` + manual mapped-prefix handling, or `ipaddr.js` which exposes `.range()` and `isIPv4MappedAddress()`). Same caveat as S1: this hardens the **explicit-nav hook only**; clicks/redirects (S1) still bypass it.

### S3 — `[::]` and trailing-dot `localhost.` bypass the gate logic (MED)

**`src/browser.ts:155-163`, `171-175`.**

Two more gate-logic bypasses, ranked below the IPv4-mapped set because whether Chromium **connects** them is OS/resolver-dependent (not deterministic like an embedded IPv4):

- **`http://[::]/`** → hostname `::` after bracket-strip. `toIPv4` null (has `:`); IPv6 branch matches only `fc/fd/fe8-b`, so `::` falls through → **ALLOWED**. `::` is the IPv6 unspecified address; on many stacks a client connecting to `[::]` reaches a loopback-bound listener (analogous to `0.0.0.0`, which the floor *does* deny). Whether it connects to the local Command Center server is stack-dependent.
- **`http://localhost./`** → hostname `localhost.` (trailing dot preserved by Node). `=== "localhost"` is false; `.endsWith(".localhost")` is false; `DENY_HOSTNAMES` has no `localhost.` → **ALLOWED**. Most resolvers treat `localhost.` as `localhost`. (Note: `127.0.0.1.` *is* caught — Node strips the trailing dot from IP-literals and `hostMatchesDomain`/`toIPv4` see `127.0.0.1`. The hole is specifically the named `localhost.`.)

**Recommendation:** fold into the S2 fix — in the IPv6 branch, deny `::` and `::1` defensively (the unspecified + loopback addresses); in the hostname floor, strip a single trailing dot before the `localhost` comparisons (`hostname.replace(/\.$/, "")`). Cheap and removes the ambiguity even if the connect-behavior is uncertain.

### S4 — Config is mutable via unauthenticated `POST /api/browser/:agentId` (LOW, watch-listed)

**`src/server.ts` `/api/browser/:agentId` (POST) and `/api/browser/:agentId/domain`.**

The gate config (mode, allowed domains, enabled) is SQLite-backed and writable via localhost HTTP with no auth — same baseline as `/api/settings`, `/api/cwd`, `/api/approvals/:id/decide` (see C16d S3/S4). A **prompt-injected agent that also has a Bash tool** can, before navigating:

```bash
curl -X POST http://127.0.0.1:3333/api/browser/<agentId> \
  -H 'content-type: application/json' -d '{"mode":"open"}'
```

flipping itself from allowlist to open mode (which removes the `--allowed-origins` floor — but only on the *next* `query()` for that agent, since the Playwright server args are fixed at spawn; an already-running browser session keeps its origin flags). This is the **same localhost-trust baseline** as the rest of the app, so LOW. But **browser + Bash is a uniquely potent combo** here: it converts the S1/S2 open-mode SSRF from "operator chose open mode" into "agent chose open mode for itself." Flagged on the watch-list.

### S5 — Hook denies but does not constrain in-policy injection (LOW, inherent)

The hook returns `permissionDecision: "deny"` for an out-of-policy URL but does not abort the run; the agent continues and may try other URLs. Within allowlist mode this is fully contained (every explicit nav is re-checked — S10 — and `--allowed-origins` floors clicks). The residual is **inherent**: a malicious in-allowlist page can still prompt-inject the agent into mischief *among allowed domains* (exfil to an allowed domain, in-allowlist actions). Not fixable by the gate; the gate's job is destination control, not content trust. Documenting honestly.

### S6 — Untrusted URL echoed to `console.warn` (LOW)

`console.warn(\`[browser] denied navigation for ${agentId}: ${verdict.reason}\`)` includes the attacker-influenced URL/hostname. Pure log-injection/noise (newlines, ANSI) into the operator's terminal — no code path consumes the log. Accept.

### S7 — `--isolated` confirmed; no real-profile reach (Info / confirmed safe)

`src/browser.ts:303` — args always begin `["-y", PLAYWRIGHT_PKG, "--isolated", "--block-service-workers"]`. `--isolated` gives a fresh in-memory profile with no persistent cookies/storage. No `--user-data-dir`, no `channel=chrome`/`executablePath` pointing at the operator's installed Chrome, no profile path anywhere in the config. A browsing agent cannot read the operator's real cookies/sessions. Safe.

### S8 — Local-file / non-web protocols blocked (Info / confirmed safe)

Protocol floor (`src/browser.ts:148-153`): only `http:`/`https:` pass; `DENY_PROTOCOLS` additionally enumerates `file:`, `chrome:`, `chrome-extension:`, `about:`, `data:`, `view-source:`, `ftp:`, `ws:`, `wss:`. The `!== http/https` check alone already blocks all of these (the explicit set is belt-and-suspenders). Confirmed **no `--allow-unrestricted-file-access`** and **no `--no-sandbox`** anywhere in `src/` (grep clean). `file:///etc/passwd` and friends are denied at the protocol floor — the canonical prompt-injection ask ("navigate to file:///etc/passwd and paste it") is contained. Safe.

### S9 — SQL + input validation (Info / confirmed safe)

`src/browser.ts` — every statement is `db.prepare(...).get/.run(?)` with bound placeholders (the schema DDL is static; `getBrowserConfig` binds `agent_id`; `setBrowserConfig`'s `INSERT ... ON CONFLICT` binds all six columns). No string interpolation of input into SQL. `allowedDomains` are normalized via `normalizeDomain` (lowercase, strip scheme/path/userinfo/port/dots) and deduped on write. Routes validate: `mode` accepted only if exactly `"allowlist"|"open"`; `enabled`/`headless` only if `typeof === "boolean"`; `allowedDomains` only if `Array.isArray`; unknown agentId → 400. `express.json()` body parsing. Clean.

### S10 — Allowlist-mode prompt-injection containment (Info / confirmed safe)

In allowlist mode the agent cannot be talked into a denied **explicit** destination: every `browser_navigate` re-runs `isUrlAllowed`, and `--allowed-origins` independently floors clicks/redirects to non-allowed origins. The injection text on a page cannot lift the gate. (The S2 IPv4-mapped bypass defeats the *hook* but NOT `--allowed-origins`, so in allowlist mode the embedded-IPv4 host is still outside the allowed origins and blocked by Playwright.) Containment holds for allowlist mode.

### S11 — Service workers + empty-allowlist sentinel (Info / confirmed safe)

`--block-service-workers` always set (prevents a page registering a SW that survives navigation). Empty-allowlist mode passes `--allowed-origins https://invalid.invalid` — a sentinel that matches nothing, so an enabled-but-no-domains agent has browser tools but **zero** reachable destinations (fail-closed). Good.

## Verification

Hypotheses were checked against Node's actual URL parser and a faithful replica of `isUrlAllowed` (open mode), not assumed:

- `new URL().hostname` normalization (Node): `0177.0.0.1`, `0x7f.0.0.1`, `127.1`, `127.0.1`, `2130706433`, `017700000001`, `①②⑦.0.0.1`, `127。0。0。1` all → `127.0.0.1`; `10.1` → `10.0.0.1`; `127.0.0.1.` → `127.0.0.1` (trailing dot stripped for IP literals); `localhost.` → `localhost.` (dot kept for names); `0` → `0.0.0.0`; userinfo `localhost@evil.com` → host `evil.com`, `evil.com@localhost` → host `localhost`; `[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`.
- **Correctly DENIED by the gate:** all decimal/hex/short-form IPv4 above, `192.168.1.1`, `172.16.0.1`, `169.254.169.254`, `[::1]`, `[fe80::1]`, `[fc00::1]`, `0.0.0.0`, `0`, `127.0.0.1.`, userinfo tricks (host resolves to the real host and is gated on that).
- **Bypass (ALLOWED, open mode) — the findings:** `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `[::ffff:a9fe:a9fe]` (metadata), `[::ffff:0a00:0001]` (10.0.0.1), `[0:0:0:0:0:ffff:127.0.0.1]`, `[::]`, `localhost.`.

## Watch list (escalates if commercial path opens)
- **S1 → CRITICAL** the moment open mode is reachable by a remote/non-localhost caller, or whenever the deployment runs on a cloud host with a `169.254.169.254` metadata endpoint (credential theft via the click/redirect SSRF). Even in personal use on a laptop with a home router, S1 already reaches `192.168.x.1` admin panels.
- **S2/S3 → fix now regardless** — they are pure gate-logic bugs in the IP-aware layer that is the app's stated SSRF defense; cheap to close, and they undercut the "the hook catches obfuscation the origins miss" design claim in `browser.ts`'s header comment.
- **S4 → HIGH** if `/api/browser/*` is ever exposed beyond 127.0.0.1, or if auth lands but browser-mode mutation isn't gated as privileged. Treat "flip to open mode" as a sudo-level config like `approvals.production_cwds` (C16d S3). Browser + Bash on the same agent should arguably require an explicit operator opt-in.
- **General**: the only robust containment for open-mode LAN SSRF is a **connect-time IP-filtering egress proxy** (catches clicks, redirects, DNS-rebinding, and every obfuscation in one place). The hook + origin flags are necessary defense-in-depth but cannot be the floor for open mode.

## Confirmed safe
- `--isolated` profile — no reach into the operator's real Chrome cookies/sessions (S7).
- `file://`/`chrome://`/`data:`/`view-source:`/`ftp:`/`ws(s):` blocked by the protocol floor; no `--allow-unrestricted-file-access`, no `--no-sandbox` (S8).
- SQL parameterized; domains normalized; route inputs type-validated; empty-allowlist fail-closed sentinel; `--block-service-workers` (S9, S11).
- **Allowlist mode** is contained against both explicit-nav and click/redirect to non-allowed origins by `--allowed-origins`, and against prompt-injected explicit nav by the per-nav hook re-check (S10). The HIGH findings are **open-mode only**.

## Verdict
- New HIGH: **2** (S1 open-mode click/redirect SSRF; S2 IPv4-mapped IPv6 hook bypass)
- New MED: **1** (S3 `[::]` / `localhost.` gate-logic bypass — connect-behavior caveat)
- New LOW: **3** (S4 unauth config flip-to-open; S5 in-policy injection residual; S6 log echo)
- New Info / confirmed safe: **5** (S7–S11)
- Inline fixes applied: **0** (report-only audit; developer applies)

**Do not ship open mode as-is.** Allowlist mode is sound and shippable under the personal-use threat model. Open mode is structurally LAN-exposed: the IP-aware hook only gates explicit `browser_navigate`, and Playwright's `--blocked-origins` floor is a literal-origin list, not CIDR — so clicks/redirects reach all of RFC1918 + link-local (S1), and even explicit navigation is bypassable via IPv4-mapped IPv6 to the very metadata endpoint the floor names (S2). Close S2/S3 in `toIPv4`/the IPv6 branch regardless (cheap, and they falsify the gate's own design claim), and either drop open mode, gate it behind an IP-filtering egress proxy, or label it explicitly unsafe with a UI warning before exposing it.
