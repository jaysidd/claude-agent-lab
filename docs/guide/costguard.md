# Budget Caps (CostGuard)

`[Live]`

## What this is

CostGuard is the spending and rate guardrail. It puts a ceiling on how much an agent can cost and how often it can call, so an unattended run cannot quietly burn through your budget or hammer the rate limit. It is what lets you trust a scheduled job or an autonomous task to run while you are not watching.

There are two caps, set per agent in Settings under Budget (CostGuard):

- **Cost cap**, a monthly USD ceiling.
- **Rate cap**, a maximum number of requests in a rolling time window.

The check is a preflight: it runs *before* the SDK call, so when an agent is over its budget the request is refused before a single token is spent. The whole thing is local. Caps and usage live in SQLite on your laptop, in `data/lab.db`. Nothing about your spending leaves the machine.

## How to use it

Open Settings → Budget (CostGuard) and set your caps. You can set **global defaults** that apply to every agent, then override them **per agent** for the ones that need a tighter or looser leash.

- **Cost cap (monthly USD):** the most an agent may spend in a calendar month.
- **Rate cap (requests per window):** the most calls an agent may make inside the window.
- **Window length:** how long the rate window is.

A blank cap, or `0`, means "unset", so that axis is not enforced. This is the one rule to remember: `0` does not mean "block everything," it means "no cap." If you genuinely want to pause an agent, set its **rate cap to 1**, the first call exhausts the window and every call after it is blocked until the window rolls.

When an agent is over budget, its next call returns a structured `429`-shaped block with a human-readable reason ("cost cap reached", "rate cap reached") instead of running. You see exactly why it stopped.

## How it works

CostGuard (`src/costGuard.ts`) is a standalone SQLite primitive. A preflight `check(agentId)` runs before **every** `query()` in the app: chat, streaming chat, task runs, scheduled fires, and Telegram messages all funnel through it. There is no path to the SDK that skips it, and the verdict is decided server-side only, so nothing the browser sends can influence it.

`check()` enforces the two caps:

- **Rate cap** counts the rows in the `cost_ledger` table for that agent inside the sliding window. If the count has reached the cap, it returns `ok: false` before the call runs.
- **Cost cap** sums the `cost_usd` of this agent's ledger rows for the month. If the sum has reached the monthly ceiling, it returns `ok: false`.

After every call resolves, success or failure, a row is appended to `cost_ledger` with `(agent_id, occurred_at, cost_usd, input_tokens, output_tokens, is_oauth)`. Failed calls are still recorded, because a failed call still consumed a slot in the rate window.

**The OAuth bypass.** On the Max plan, calls authenticate via OAuth and cost is effectively $0; charging a dollar cap against a flat-rate subscription would be meaningless. So OAuth calls record their ledger row with `is_oauth = 1`, and the cost-cap SUM filters those rows out (`WHERE is_oauth = 0`). The result is that **OAuth calls bypass the cost cap automatically**, with no env-var coupling; the data itself drives the bypass. The **rate cap, however, always applies**, OAuth or not, because rate-limit posture matters even when the dollar cost is zero.

About the `0 = unset` rule: that is an operator convention enforced where caps are resolved, not inside `check()`. A literal `0` passed as a real cap would compute `remaining = 0 - used`, which is never positive, so it would block. The resolver treats blank and `0` as "no cap configured" so the axis is simply skipped.

For introspection, `GET /api/costguard/status?agentId=X` returns `{ rateUsed, rateRemaining, costUsedThisMonth, costRemaining }` without making an enforcement decision, handy for surfacing live budget chips in the UI. The preflight overhead is microseconds, invisible against LLM latency.

## Common questions

**Why is my cost cap never triggering on the Max plan?**
Because OAuth calls cost $0 and bypass the cost cap by design. Their ledger rows are marked `is_oauth = 1` and excluded from the cost sum. The rate cap still applies.

**I set a cap to 0 to block an agent, but it still runs. Why?**
`0` (and blank) means "unset", not "block." To truly pause an agent, set its rate cap to `1`; the first call exhausts the window.

**Does the budget check cost me anything to run?**
No tokens. It is a local SQLite preflight measured in microseconds, run before the SDK call, so an over-budget request never reaches Claude.

**Are scheduled and Telegram runs checked too?**
Yes. Every `query()` path, chat, stream, task run, scheduled fire, and Telegram, goes through the same preflight `check()`.

**What happens when an agent goes over budget?**
The next call returns a structured `429`-shaped block with the reason, before any tokens are spent. Nothing runs and nothing is charged.

**Can I set different budgets for different agents?**
Yes. There are global defaults plus per-agent overrides in Settings → Budget (CostGuard).

## Where to go next

- [Scheduler](scheduler.md), scheduled fires that run through this same preflight.
- [Task Queue](task-queue.md), task runs are budget-checked before they call the SDK.
- [Settings Reference](settings-reference.md), where global and per-agent caps are configured.
