# Approval Gates

`[Live]`

## What this is

Approval Gates are the safety net for unattended runs. When you let an agent work on its own, you usually want it to read freely but to stop and ask before it does something with consequences: run a shell command, write a file, edit code, fetch a URL. Approval gates give you exactly that pause point.

Mark a task "Requires approval" and the agent runs normally until it reaches a dangerous tool. At that moment the run genuinely **stops** and a pending-approval card appears on the kanban, showing the tool name and the full JSON payload the agent wants to run. Nothing happens until you Approve or Reject. This is what makes it safe to walk away from an agent that has Bash access: it cannot touch anything irreversible without your sign-off, and that decision happens on your machine, against state in `data/lab.db`, with nothing leaving the laptop.

## How to use it

1. **Mark the task "Requires approval"** when you create it (the checkbox on the task form), or run the task in a folder you have marked as production in Settings.
2. **Let the agent run.** It reads and reasons freely. When it reaches a gated tool, the run pauses and a pending-approval card appears on the board.
3. **Read the card.** It shows the tool name (for example `Bash`) and the exact JSON arguments the agent proposed.
4. **Decide.** Approve to let that one tool call proceed and the run continues. Reject, optionally with a reason, to abort the call.

By default the gated tools are `Bash`, `Write`, `Edit`, and `WebFetch`. In a production-marked folder, **every** tool is gated, so nothing runs without a look first.

One thing to expect: the gate fires for *each* dangerous tool call, not once for the whole task. A task that runs six Bash commands produces six cards, one per call. Each decision covers that single call. This is deliberate; it keeps a per-call audit trail rather than handing the agent a blank check.

## How it works

This is the page where the Claude Agent SDK does the heavy lifting. The gate is built on the SDK's **`PreToolUse` hook** (`src/approvals.ts`). Before any tool runs, the SDK calls the hook, and the hook returns a `Promise` that it does not resolve until you decide. Because the SDK awaits that promise, the agent loop is genuinely **paused**, not polling and not spinning. When you click Approve, the promise resolves with `{ permissionDecision: "allow" }` and the run resumes with that tool call. When you Reject, it resolves with `{ permissionDecision: "deny", permissionDecisionReason: <your reason> }`.

That rejection path is the interesting part. The SDK feeds your reason back into the agent's context as a new turn the agent can respond to. Tell it "no, use staging instead of prod," and the agent's next turn sees that text and can retry the call with a different argument. The approval is not just an OS-level allow/deny prompt; it becomes a conversational checkpoint in the agent loop.

The pending-approval rows live in the SQLite `pending_approvals` table, so the board stays accurate across a restart. A boot-time **orphan sweep** (`expireOrphaned()`) marks any pending row left over from a previous server process as expired, so the kanban never shows ghost cards for runs that no longer exist. Each pending approval also has a wall-clock safety timeout (1 hour) so a forgotten card cannot wedge a worker forever.

The production-folder list lives in Settings under Approvals. Any task whose `cwd` is on that allowlist is gated on all tools, regardless of whether you checked the per-task box.

**Why per-task gates differ from per-tool prompts.** A plain per-tool prompt only knows the tool name and arguments. A per-task gate knows the surrounding context, and that buys two things a per-tool prompt cannot express. First, **conditional gating by context**: a task in a production folder auto-escalates every tool to "ask," while the same tools in a sandbox folder run freely. Second, **rejection as a context turn**: your "no, do it differently" reason flows back into the agent loop so it can adapt, rather than just terminating the call. (Some of the per-task promise is thinner in practice; the full honest accounting is in `docs/analysis/c16d-per-task-vs-per-tool.md`.)

## Common questions

**Does approving a task once let the whole run finish unattended?**
No. The gate fires for every dangerous tool call. A six-step task means six cards, one decision each. This keeps a per-call audit trail.

**Which tools get gated?**
By default `Bash`, `Write`, `Edit`, and `WebFetch`. In a production-marked folder, all tools are gated.

**Is the agent actually paused while a card is pending, or is it polling?**
Genuinely paused. The `PreToolUse` hook returns a promise the SDK awaits, so no work and no tokens move until you decide.

**What does my rejection reason do?**
It is fed back into the agent's context as a turn. The agent can read your reason and try a different approach on its next turn.

**What happens to pending cards if I restart the server mid-run?**
A boot-time orphan sweep marks stale pending rows as expired so the board stays clean. The original run is gone, so you simply re-run the task.

**How do I mark a folder as production so everything in it is gated?**
Add it to the production allowlist in Settings under Approvals. Tasks running in that folder are gated on every tool.

## Where to go next

- [Task Queue](task-queue.md), where the "Requires approval" toggle lives.
- [Budget Caps (CostGuard)](costguard.md), the other guardrail for unattended runs.
- [Settings Reference](settings-reference.md), where the production-folder allowlist is configured.
