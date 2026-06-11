# Settings Reference

`[Live]`

## What this is

The ⚙️ **Settings** modal is where operator configuration lives, instead of being buried in `.env` edits. It is backed by a SQLite `settings` table, so your values persist across restarts and stay on your machine. You can open it from the header ⚙️ button, the ⌘K command palette ("Open Settings"), or the `⌘;` shortcut.

Settings cover four areas: budget caps, approval gates, voice, and the Telegram bridge.

## How to use it

Each section has its own **Save section** button, so you can save one block without touching the others. As soon as you edit a field, that field gets an amber dirty border as a cue that you have unsaved changes; saving clears it.

Sections that talk to an external service also have a **Test connection** button. Testing auto-saves any dirty fields in that section first, so the value you just typed is the one that gets tested. Budget and Approvals have nothing to reach out to, so they have no Test button.

Secrets are masked. Secret fields show a masked preview like `••••c123`, never the raw value. Leaving a secret field blank keeps the existing value rather than wiping it. The real token stays server-side and is used for every proxied request.

The sections:

**Budget (CostGuard).** Per-agent budget caps enforced before every SDK call.
- *Monthly cost cap (USD)*, a per-agent dollar ceiling with a global default. OAuth (Max plan) calls record as $0 and bypass this cap automatically; only API-key calls enforce it.
- *Rate cap (requests per window)*, a per-agent request ceiling, always enforced regardless of provider, because rate posture matters even at $0.
- *Rate window (seconds)*, the sliding-window length for the rate cap. This is a single global value and does not vary per agent (default 3600, one hour).
- Cost cap and rate cap each support per-agent overrides via keys like `costguard.cost_cap_monthly_usd.<agentId>`. A blank or `0` cap means unset; to truly pause an agent, set its rate cap to `1`.

**Approvals (C16d).** One field, *Production-marked cwds*, an absolute path per line. Any schedule or task whose `cwd` matches one of these paths requires approval for every tool call, as defense in depth on top of the per-task approval toggle.

**WhisprDesk (voice).** Connection details for local voice transcription.
- *Gateway URL*, WhisprDesk's local address (default `http://127.0.0.1:9879`).
- *Bearer token*, a secret, copied from WhisprDesk's External App Gateway card.
- Use **Test connection** to confirm the gateway is reachable before you rely on the mic button.

**Telegram bridge.** Drive the same agents from your phone.
- *Bot token*, a secret, from @BotFather on Telegram.
- *Allowed chat IDs*, comma- or whitespace-separated. Only these senders are routed to your agents; everyone else is silently dropped. Empty blocks all.
- Saving restarts the listener live, so no server bounce is needed.

## How it works

Every value lives in the SQLite `settings` table (`key`, `value`, `is_secret`, `updated_at`) at `data/lab.db`, which is gitignored. The server reads each value with a SQLite-first, env-var-fallback helper: if a key is present in the database it wins, otherwise the matching environment variable is used. That env fallback exists for the WhisprDesk and Telegram fields (so you can still paste tokens into `.env` for headless runs); Budget and Approvals are database-only. Secrets are masked on the way out to the browser and never round-trip in the clear.

## Common questions

**Why does the cost cap do nothing on my Max plan?**
Because OAuth (Max plan) calls are flat-rate and record as $0, so there is no dollar total to cap. The cost cap only bites on API-key usage. The rate cap, by contrast, is always enforced.

**Why does my secret field show dots instead of my token?**
That is the mask. The real token stays on the server. To keep it, leave the field blank; to change it, type a new value and save.

**Does every section have a Test button?**
No. Only sections that reach an external service, WhisprDesk and Telegram, have one. Budget and Approvals have nothing to test.

**Do I have to save each section separately?**
Yes, each section has its own Save button. The amber border shows you which fields are unsaved. Hitting Test in a section auto-saves that section's dirty fields first.

**Can I configure these in `.env` instead?**
For WhisprDesk and Telegram, yes, those fields fall back to environment variables when the database value is blank. Budget and Approvals are configured only in the modal.

**Where is all this stored?**
In the `settings` table inside `data/lab.db`, on your machine, gitignored. Nothing is sent anywhere.

## Where to go next

- [Authentication](authentication.md), why the cost cap is OAuth-aware.
- [What's Under the Hood](whats-under-the-hood.md), the SQLite layer that backs settings.
- [Getting Started](getting-started.md), first-run setup before you tune settings.
