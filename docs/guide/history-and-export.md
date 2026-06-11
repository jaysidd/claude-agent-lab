# History and Export

`[Live]`

## What this is

History and export are about not losing your conversations. Every chat is recorded to a local database as it happens, so you can come back to any past session, reopen it, and keep talking right where you left off. When you want a conversation outside the app, you export it to a Markdown or JSON file with one command.

Riding alongside both is lightweight cost and token tracking, so you always know how heavily a conversation leaned on your plan.

## How to use it

**History.** Click the 📜 History button in the chat header to open the modal. It lists every past session, grouped by agent, with an auto-title taken from your first message, a turn count, total tokens, and a relative timestamp. Click any session to restore it: your messages reload into the chat and your next reply continues the same thread, with the agent's memory of that conversation intact. Hover a row to rename it (✎) or delete it (✕).

**Export.** From any chat, type one of:

- `/export` or `/export md` to download the conversation as Markdown
- `/export json` to download it as JSON

The file downloads straight from your browser. The filename follows `{agent-name-slug}-{ISO-timestamp}.{md|json}`.

**Cost and tokens.** You do not have to do anything for this. Each reply gets a small footer showing its token count, and the header carries a session-totals chip with the running total and turn count. Hover the chip for an in/out/cache breakdown.

## How it works

Every conversation is persisted to SQLite at `data/lab.db` across two tables: `sessions` (one row per conversation, with title, message count, token totals, and the working directory) and `session_messages` (one row per turn, with role, text, tool-use traces, model, and the raw `usage` object). The write happens as each turn completes.

Restore uses the SDK's `resume:` option. When you click a past session, the server re-attaches that session id to the agent and returns the stored messages, so the SDK has the full prior context and your next turn threads onto it naturally.

Export is done entirely client-side from the chat state already in the browser, with no server round-trip. The Markdown variant is publish-friendly: an agent header, an exported-at timestamp, the session totals, a clean "You:" and agent pattern, and tool-use citations as blockquotes. The JSON variant keeps the raw `usage` objects intact so the export can feed downstream analysis.

Cost and token figures come from the SDK's result message, which carries `usage` and `total_cost_usd` for every reply. The display is OAuth-aware: on the Max plan it shows tokens but no dollar amount, because the plan is flat-rate and a per-message dollar figure would imply billing that does not apply. If an API key is paying instead, the dollar column lights up automatically.

All of this is local. History lives in the database on your laptop, exports save to your own disk, and nothing is uploaded.

## Common questions

**Does restoring a session really continue the same conversation?**
Yes. Restore re-attaches the SDK session through `resume:`, so the agent has the full earlier context. Your next message is a genuine continuation, not a fresh chat seeded with old text.

**Where are my past conversations stored, and are they private?**
In the local SQLite database at `data/lab.db`, which is gitignored. History is per machine and never leaves your laptop.

**Why do I see token counts but no dollar amounts?**
Because you are on the Max plan via OAuth, which is flat-rate. Tokens still matter as a proxy for how hard you are working your plan, so they stay visible. Switch to an API key and the dollar figures appear on their own.

**What is the difference between the Markdown and JSON export?**
Markdown is formatted for reading and publishing. JSON keeps the raw `usage` objects and structure so you can process the export programmatically.

**Can I rename a session so it is easier to find later?**
Yes. Hover the session row in the History modal and click ✎ to rename it, or ✕ to delete it (which also removes its messages).

## Where to go next

- [Slash Commands](./slash-commands.md) for the full `/export` reference and other commands.
- [Chat and Models](./chat-and-models.md) for how sessions and `resume:` work per agent.
- [Agents](./agents-and-overview.md) since history is grouped per agent.
- [Keyboard Shortcuts](./keyboard-shortcuts.md) to open History with ⌘⇧H.
