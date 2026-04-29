# Per-task approval gates vs per-tool approval — analysis

> Date: 2026-04-29
> Status: shipped C16d in Command Center; portability decision = **partial — see verdict**
> Cross-references: `src/approvals.ts`, `.notes/c16d-approval-gates-design.md`,
> Clawless's existing per-tool approval (Strict / Standard / Permissive profiles
> + Allow Once / Allow Always / Deny prompts at the OpenClaw permission layer)

## What we built

Command Center's C16d adds approval gates at the **task layer**: a task is marked `requiresApproval: true` (or its `cwd` matches a production-marked allowlist), and the SDK's `PreToolUse` hook awaits an external `/api/approvals/:id/decide` call before any dangerous tool fires (Bash / Write / Edit / WebFetch by default; ALL tools when production-marked). The hook genuinely pauses the SDK loop via `Promise<HookJSONOutput>` — no polling, no replay.

Clawless's existing approval layer is at the **tool layer**: each tool call surfaces an Allow Once / Allow Always / Deny prompt to the user, with permission profiles (Strict / Standard / Permissive) controlling defaults. The decision is per-call, anchored to a tool name + matcher pattern.

The Architect doc set portability success criterion explicitly:

> the prototype must show that per-task gates are *qualitatively different* from per-tool batching — e.g., they enable behaviors per-tool can't (cross-tool atomic groupings, conditional approvals based on task metadata, scheduled approvals that auto-expire). If it ends up being "per-tool with batching," document that, drop the portability ambition, and treat C16d as Command-Center-specific.

This document is the receipts.

## Four cases I expected to be qualitatively different

### 1. Cross-tool atomic groupings — **partial difference**

**The hope**: "Approve this whole task" lets all tool calls in the run proceed unattended once. Per-tool approval would prompt N times unless batched.

**The reality**: Our hook fires for **every** dangerous tool call within an approved task. The "approval" we just decided is for *that one tool call*, not for the rest of the run. The 1-hour `HookCallbackMatcher.timeout` is per-callback-invocation, not per-task. So a 6-step research task with 6 Bash calls produces 6 approval cards.

What we actually have is **per-tool approval, scoped to the task's dangerous-tool set**. The "per-task" framing is the *opt-in unit* (the operator marks the task once), but the operator's interaction model is still per-tool.

To get genuinely batched approval — "yes to all tools in this task" — we'd need either:
- A task-scoped allow-list that the hook consults before creating an approval row (effectively "Allow Always for this task"), OR
- A grouping affordance in the UI: "Approve this AND skip future approvals on this task"

Neither is shipped in v1. Clawless's "Allow Always" is the per-tool equivalent and is functionally close — operator clicks Allow Always once, subsequent calls of that tool pass without prompting.

**Verdict**: per-tool with batching is what each side really has. **Difference: marginal.**

### 2. Conditional approvals based on task metadata — **real difference**

**The hope**: production-cwd-marked tasks auto-elevate approval; same tools on a sandbox cwd auto-allow. Per-tool can't see "what task am I part of."

**The reality**: We genuinely have this. `cwdIsProductionMarked()` checks the run's cwd against a settings allowlist; `shouldGateRun()` ORs the production-cwd marker with the per-task `requiresApproval` flag. A task in `/Users/me/prod/` requires approval for ALL tool calls regardless of how it was created. A task in `/Users/me/sandbox/` requires approval only if its `requiresApproval` flag was set.

Clawless's per-tool layer doesn't have a natural place to express "this tool call deserves approval *because the surrounding task is in a production cwd*." Tool decisions are anchored to (tool name, args) — not to (task id, cwd, agent purpose). To replicate this in Clawless, they'd need to inject task context into the per-tool decision, which adds a coupling their permission layer was deliberately built without.

**Verdict**: real qualitative difference. Per-task can express conditional gates that per-tool structurally cannot without breaking the per-tool abstraction.

### 3. Auto-expiring approvals tied to task lifetime — **not implemented; would be real if it were**

**The hope**: approvals expire when the task ends, not on a wall-clock timer. Per-tool approvals tied to a session don't naturally have a "task" boundary.

**The reality**: Not in v1. Our approvals expire on a fixed 1-hour wall-clock timeout (the SDK's `HookCallbackMatcher.timeout` — `APPROVAL_HOOK_TIMEOUT_SECONDS = 60 * 60`). When a task fails or is cancelled, leftover pending approvals for that task become orphans (Reviewer R10 — deferred). The boot-time `expireOrphaned()` sweeps them when worker_id changes, but a task that ends within the same process leaves its approvals dangling until that 1-hour timer trips.

If we shipped task-lifetime expiry properly (Reviewer R10's belt-and-suspenders fix), this would be a real qualitative difference. Today it's an aspirational property the design supports but the implementation doesn't enforce.

**Verdict**: future-real, present-not. **Difference: latent.**

### 4. Rejection becomes a context turn — **real difference**

**The hope**: the rejection reason flows into the agent's context as `permissionDecisionReason`, and the agent can respond by trying a different approach. Per-tool denial in a CLI doesn't have this affordance because there's no agent loop to feed it back to.

**The reality**: This works. Our hook returns `{permissionDecision: "deny", permissionDecisionReason: <operator's reason>}`. The SDK injects this back into the agent's context, and the agent's next turn sees the rejection text. Operator says "no — use staging instead of prod"; agent's next turn re-runs the Bash call with the staging argument.

Clawless's per-tool denial in the CLI is terminal for that one call. The user's "deny" reason isn't fed back to anything because the CLI loop expects the *user* to retry by re-prompting. There's no agent context to update because the per-tool decision lives at the OS-permission layer, below the agent.

**Verdict**: real qualitative difference, and it's the most interesting one. The approval becomes a conversational checkpoint, not just an OS prompt.

## Cases that prove this is just per-tool-with-batching (the honest skip path)

The Architect doc said: "If 80% of approvals end up being for a single tool call, 'atomic groupings' is just one tool with extra steps." We don't have production usage data, but the structure suggests:

- For tasks where the agent uses one Bash call to do the whole job, our gate is per-tool with marketing.
- For tasks where the user always re-prompts on each subsequent tool call (don't trust blanket grants), our gate is per-tool with marketing.
- For tasks in a sandbox cwd with no production marking and no per-task flag, our gate doesn't fire at all — irrelevant.

The cases where per-task is **genuinely** different are: production-cwd auto-elevation (case 2) and rejection-as-context-turn (case 4). Cases 1 and 3 reduce to per-tool-with-batching.

## Verdict: partial portability

Two of four cases hold up. The portable surface is:

- **Conditional gating based on run-context (cwd, task metadata)** — Clawless could adopt this by extending their per-tool layer to consult task context. Cost: medium.
- **Rejection as agent-context turn** — Clawless's CLI surface doesn't naturally support this; would need a new "denial-with-rationale" channel in the agent loop. Cost: high.

The non-portable surface is:

- **Atomic groupings** — Clawless already has Allow Always. Their per-tool with batching is the same shape we shipped under a per-task label.
- **Auto-expiring task-lifetime approvals** — not implemented in C16d, so nothing to port.

**Recommendation for Clawless port**: do not lift `src/approvals.ts` wholesale. Instead, **adopt the two ideas that are portable**:

1. **Conditional per-tool gating based on run context** — if the run's cwd or metadata flags it as sensitive, escalate the per-tool prompt's default from Allow to Ask. This is a small extension to the existing OpenClaw permission layer, not a parallel system.

2. **Denial-with-rationale fed back to the agent loop** — when a per-tool denial happens with a user-supplied reason, surface it to the next agent turn rather than ending the loop. This is the architecturally interesting piece and the one Clawless's per-tool layer is *missing*, regardless of how approval is triggered.

We do NOT recommend porting `src/approvals.ts` as a parallel approval system on top of OpenClaw. The implementation cost is high and the wins (cases 2 and 4) can be retrofitted into the existing per-tool layer at lower cost.

## Implications for Command Center

C16d still ships in Command Center because it's the right shape **here**:

- We're at the SDK harness layer where `PreToolUse` is first-class.
- The kanban already presents tasks as units, so per-task approval cards fit the existing UI without inventing a new surface.
- The qualitative wins (cases 2 and 4) work for our personal-use scale even if they don't generalize to Clawless's commercial multi-provider context.

If a future operator finds case 1 (atomic groupings) painful — six approval cards for one task — the natural follow-up is **"Approve all remaining for this task"** as a button on the first card, NOT a per-task allowlist that bypasses subsequent hooks. The button keeps the per-tool audit trail (every call still creates a row) while collapsing the per-tool friction. Logged as a follow-up.

## ClaudeLink relay summary for Clawless agent

- **Don't lift `approvals.ts` wholesale.** Two of four anticipated qualitative differences hold up.
- **Lift the ideas, not the code.** Add (a) cwd/metadata-conditional default escalation in your existing per-tool layer, and (b) denial-with-rationale fed back to the agent loop.
- **C16d closes the C16 epic on our side** — Autonomous Agent Firm is now shippable end-to-end (scheduler + durable queue + budget + approval).

— sent via ClaudeLink when this lands on main.
