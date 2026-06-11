# Memory and Pins

`[Live]`

## What this is

Memory and pins are two ways to give an agent durable context that it sees on every single turn, without you having to repeat yourself. Both are injected into the system prompt before each `query()` call, so the agent starts every reply already knowing the things you told it to remember.

They solve slightly different problems:

- **Persistent memory** (the 🧠 Memory modal) holds facts, preferences, and context that should survive restarts. Good for "my name is Jay" or "always keep replies short."
- **Context pins** (the 📌 Pins modal) attach specific material to one agent. A pin can be a live file that gets re-read from disk every turn, or a fixed snippet of text. Good for "always work against this spec file" or "here is my house style."

## How to use it

**Memory.** Open the 🧠 Memory modal from the header. Add an entry, choose whether it is global (every agent sees it) or scoped to one agent, and pick a category: fact, preference, or context. Memories are capped at roughly 2,000 characters total so they stay within budget. Delete an entry when it is no longer true.

**Pins.** Open the 📌 Pins modal. Pins are per agent. Add either:

- a **file pin**, by giving a path. The file is re-read from disk on every turn, so when you edit your spec or style doc, the agent sees the latest version with no re-save and no re-pinning. File pins are size-capped at 16 KB each and 32 KB total, and if the file goes missing the pin degrades to an inline marker instead of breaking the turn.
- a **snippet pin**, which is fixed text you type once.

Use a memory for short, durable truths. Use a file pin when the source of truth is a file you keep editing. Use a snippet pin for fixed reference text that does not live in a file.

## How it works

Both surfaces feed a single helper, `augmentedSystemPrompt()`, which composes the agent's base system prompt with a memory block and a pinned-context block before the call. That combined prompt is what goes into the SDK's `systemPrompt` option on every `query()`.

Memory is stored in SQLite (`data/lab.db`, the `memories` table). On each turn the server pulls the entries relevant to the active agent (global ones plus that agent's own) and renders them as a `<persistent-memory>` block appended to the system prompt.

Pins live in the `context_pins` table. The pinned-context builder re-reads file pins from disk at turn time, applies the size caps, and never throws, so a broken or oversized pin can never take down a query. Snippet pins are stored as their literal text.

Because both are just system-prompt text, every agent type honors them, routers and specialists alike. And because the storage is local SQLite on your machine, none of your remembered facts or pinned files leave your laptop.

## Common questions

**What is the difference between a memory and a snippet pin?**
A memory can be global and is meant for short, durable facts or preferences. A snippet pin is always tied to one agent and is meant for a fixed block of reference text. If only one agent needs it, pin it; if everyone should know it, make it a global memory.

**If I edit a pinned file, do I have to re-pin it?**
No. File pins are re-read from disk on every turn, so editing the file is enough. The next reply already reflects the change.

**What happens if a pinned file is deleted or moved?**
The pin degrades gracefully to an inline marker noting the file was not found. Your turn still runs normally; the pin just contributes that marker instead of file contents.

**Why is memory capped at around 2,000 characters?**
To keep the injected block from crowding out the actual conversation in the context window. It is a budget guardrail, not a hard product limit.

**Do memories and pins apply to delegated sub-agents too?**
They are composed into the active agent's system prompt. The agent you are chatting with carries them; specialists invoked via delegation run with their own configured prompts.

## Where to go next

- [Agents](./agents-and-overview.md) to see which agent each memory or pin should attach to.
- [Chat and Models](./chat-and-models.md) for how the system prompt feeds each turn.
- [History and Export](./history-and-export.md) to revisit past conversations.
- [Slash Commands](./slash-commands.md) for fast in-chat controls.
