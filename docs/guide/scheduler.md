# Scheduler

`[Live]`

## What this is

The Scheduler is the 🕒 Schedules modal: it wakes an agent on a schedule and lets it run without you sitting there. A morning digest at 9am, a repo health check every six hours, a Friday 5pm summary. You pick the agent, write the prompt, set the cadence, and the scheduler fires it for you on time, every time.

It is built to be left running. Schedules live in SQLite on your laptop, in `data/lab.db`, so they survive a restart. Every fire is routed through the same durable [Task Queue](./task-queue.md) and the same [Budget Caps](./costguard.md) preflight your manual chats use. And it handles the awkward real-world failure modes of unattended runs, like an expired OAuth session at 3am, by pausing cleanly instead of looping errors while you sleep.

## How to use it

Open the 🕒 Schedules modal and create a schedule:

1. **Pick an agent.** This is who runs the prompt when the schedule fires.
2. **Write the prompt.** Same shape as a chat message. This is the work the agent does each time.
3. **Set a cron.** Use a preset chip or write raw cron. The presets cover the common cadences: Every hour, Every 6 hours, Daily 9am, Weekdays 5pm, and Mon 9am. As you type or click, a live **"Next 3 fires"** preview shows exactly when it will run, so you can confirm the cadence before saving.

Once saved, a schedule runs on its own. From the list you can **Pause** it, **Resume** it, or **Run now** to fire it once immediately for a test. A manual Run now does not advance the cron cadence and does not count toward the auto-pause failure budget; it is purely a forensic "let me see this work" button.

## How it works

The scheduler (`src/scheduler.ts`) is a host-side primitive, not part of the Claude Agent SDK. The SDK has no scheduler; this is a plain Node `setInterval` tick loop wired up around it. A single **30 second tick** wakes up, queries the `schedules` table for any row whose `next_fire_at` has passed, and fires it. Cron expressions are evaluated by `cron-parser`, which is injected so the primitive stays dependency-light.

Each fire is atomic in the part that matters. Inside one transaction, the scheduler enqueues a task into the durable queue and advances `next_fire_at` to the next cron occurrence. Because the advance happens before the async SDK call begins, a slow run can never double-trigger. The actual `query()` then runs through the CostGuard preflight, exactly like a manual chat.

Three behaviors make this safe to leave unattended:

**OAuth-rotation handling.** When the SDK reports that the OAuth session has died, the scheduler does not retry into the void. It auto-pauses the schedule with `paused_reason: 'oauth_unavailable'` so you see a clear reason rather than a wall of errors. Re-authenticate, hit Resume, and it picks up from the next valid fire.

**3-strike fallback.** For ordinary recurring failures (not OAuth), a schedule that errors three times in a row auto-pauses with `paused_reason: 'too_many_failures'`. A single success resets the counter, so a flaky one-off does not trip it.

**No catch-up backlog.** If the server was off when a schedule was due, it does not fire once for every missed slot on startup. It fires once and advances to the next occurrence. Resuming a long-paused schedule re-derives `next_fire_at` from the current time, so you never get a thundering herd of stale fires.

All of this state lives in SQLite, so schedules, their pause reasons, and their next-fire times all survive a restart untouched.

## Where the result goes (destinations + run history)

A scheduled run produces output — and now you can decide where it lands. When you create a schedule, pick a **destination**:

- **In-app (run history only)** — the default. The output is kept in this schedule's run history (see below); nothing leaves the app.
- **Append to a file** — name a file like `digest.md` and each run appends its output (with a timestamp header) to that file. The file lives **under `~/.claude-agent-lab/reports/`** — you name a file inside that folder, you can't point it at an arbitrary path. (More on why below.)
- **Telegram** — if you've configured the [Telegram bridge](telegram-bridge.md), the run's output is sent to a chat id you specify.

Every schedule keeps a **run history**: click **History** on a schedule card to see its past runs, each with its status (success / error / budget), timestamp, delivery result, and the full output transcript. The most recent runs are kept (older ones roll off), so a frequent schedule won't grow the database without bound.

Run outcome and delivery outcome are tracked separately: if the agent run succeeds but the Telegram send or file write fails, the run is still recorded as a success and the delivery error is shown next to it — a failed delivery never marks the work itself as failed.

### Why file output is confined to a reports folder

A scheduled run is **unattended**, and an agent's output can include content it read from the web (if it has [browser automation](browser-automation.md) on). Writing that output to a file you chose is fine for a data file, but it would be dangerous if the file were something that gets *interpreted later* — a shell startup file, an SSH config, a `SKILL.md`. A malicious web page could try to steer the output into one of those.

So file destinations are confined to `~/.claude-agent-lab/reports/` with the same path floor used elsewhere in the app: you choose a name inside that folder, and `../`, absolute paths, and escapes are rejected. "Write my daily digest to `news.md`" works exactly as you'd expect; "append to `~/.zshrc`" is simply not possible.

## Common questions

**Do I have to know cron syntax?**
No. The preset chips cover the common cadences, and the "Next 3 fires" preview confirms the timing in plain dates before you save. Raw cron is there if you want it.

**What happens at 3am if my OAuth session has expired?**
The schedule auto-pauses with reason `oauth_unavailable` instead of looping errors. You re-authenticate, hit Resume, and it continues from the next valid fire.

**If my laptop was asleep when a daily job was due, does it run a pile of catch-up jobs when it wakes?**
No. There is no catch-up backlog. The schedule fires once and advances to the next occurrence.

**Will a scheduled run still be checked against my budget?**
Yes. Every fire goes through the same CostGuard preflight as a manual chat. If the agent is over its cap, the run is blocked before tokens are spent and the schedule records `budget_exhausted` without pausing.

**Does "Run now" change my schedule?**
No. A manual Run now fires once for testing. It does not advance the cron cadence and does not count toward the 3-strike auto-pause budget.

**Do my schedules survive a server restart?**
Yes. They live in the SQLite `schedules` table in `data/lab.db`, including their pause reasons and next-fire times.

## Where to go next

- [Task Queue](task-queue.md), the durable queue every scheduled fire runs through.
- [Budget Caps (CostGuard)](costguard.md), the preflight that gates each scheduled fire.
- [Approval Gates](approval-gates.md), pause scheduled runs before dangerous tools.
