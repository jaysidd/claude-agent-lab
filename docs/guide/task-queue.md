# Task Queue

`[Live]`

## What this is

The Task Queue is the 📋 Tasks board: a place to hand work to your agents and walk away. You describe a job, pick a priority, and let an agent run it while you do something else. The board is a three-column kanban (Queued, Active, Done) that shows every task moving through the system.

The important word is **durable**. Tasks do not live in browser memory or in a variable that vanishes on restart. They live in SQLite, on your laptop, in `data/lab.db`. Close the tab, restart the server, reboot the machine: your queue is exactly where you left it. That durability is what makes the queue trustworthy for unattended work. Nothing leaves your machine, and nothing gets silently dropped.

## How to use it

Open the 📋 Tasks board and create a task:

1. **Write a description.** This is the prompt the agent will run, so be specific about what "done" looks like.
2. **Set a priority.** Higher priority tasks get checked out first. Same-priority tasks run oldest-first, so the queue is fair.
3. **Pick an agent, or let the classifier choose.** You can target a specific agent with an override, or leave it on auto-routing. When you leave it to auto-routing, a one-shot Haiku `query()` reads your description and picks the agent best suited to the job.
4. **Optionally flip "Requires approval."** This pauses the run before any dangerous tool fires and waits for your sign-off. See [Approval Gates](./approval-gates.md).

Once created, the task lands in **Queued**. A worker checks it out and it moves to **Active**. When it finishes it moves to **Done**, where you can read the result. The Run button lets you push a specific task forward immediately instead of waiting for the queue to drain in order.

## How it works

The queue is a standalone SQLite primitive (`src/taskQueue.ts`), built on `better-sqlite3`. Three mechanisms make it safe to run unattended.

**Atomic checkout.** When a worker claims a task, it runs a transaction opened with `BEGIN IMMEDIATE`, selects the highest-priority queued task, and flips it to `checked_out` with an `UPDATE ... RETURNING *`. Because `BEGIN IMMEDIATE` serializes writers at the SQLite level, two workers that race for the same task cannot both win. Exactly one gets the row back; the other gets nothing and moves on. No double-runs, ever.

**Lease-based crash recovery.** Each checkout claims a lease (default 300 seconds, 5 minutes). The worker holds the task only as long as the lease is valid, and renews it with a heartbeat while it works. If the worker dies for any reason, a killed process, an OS reboot, a crash mid-run, the lease simply expires. A periodic `reapExpired()` sweep finds the abandoned task and returns it to `queued` for another attempt, up to `maxAttempts` (default 3). After the final attempt it lands in `failed` rather than looping forever.

**The 5-state machine.** Every task moves through `queued → checked_out → done | failed | cancelled`, with an expired lease looping `checked_out` back to `queued`. A task only reaches `failed` once its attempts are exhausted; before that, a failure requeues it. `cancelled` is the operator-override exit, available any time before a task reaches a terminal state.

Because all of this state lives in the `tasks` table rather than in a worker's memory, the queue survives a restart with full fidelity. A task that was mid-run when the server died is recovered by lease expiry, not lost.

## Common questions

**Where do my tasks actually live?**
In SQLite, in `data/lab.db`, on your machine. There is no server, no cloud, no external store. Restarting the app does not clear the board.

**What happens to a task if the server crashes while it is running?**
Its lease expires, the reaper requeues it, and it runs again on the next checkout, up to `maxAttempts`. You do not have to re-create it.

**Can two workers grab the same task and run it twice?**
No. Checkout is atomic via `BEGIN IMMEDIATE` plus `RETURNING *`. Exactly one worker wins each task; the rest see it as already taken.

**What is the difference between a failed and a cancelled task?**
`failed` means the work was attempted and did not succeed after `maxAttempts`. `cancelled` means an operator stopped it deliberately before it finished.

**How does auto-routing decide which agent runs my task?**
A single Haiku `query()` acts as a classifier: it reads your description and returns the best-fit agent. You can always override this by picking an agent yourself when you create the task.

**Does the priority guarantee strict ordering?**
Higher priority is always checked out before lower priority. Within the same priority, tasks run oldest-first, so nothing starves behind a same-priority backlog.

## Where to go next

- [Scheduler](scheduler.md), fire tasks into this queue on a cron schedule.
- [Approval Gates](approval-gates.md), what the "Requires approval" toggle does.
- [Budget Caps (CostGuard)](costguard.md), the preflight that runs before each task fires an SDK call.
