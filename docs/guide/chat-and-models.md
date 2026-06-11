# Chat and Models

`[Live]`

## What this is

The chat surface is where you actually talk to an agent. You pick an agent in the sidebar, type in the composer at the bottom, and the reply streams back token by token. Every agent runs the official Claude Agent SDK under the hood, so the chat is not a thin wrapper around a chat endpoint. It is the same agent loop Claude Code runs, exposed in a browser.

You also choose which Claude model answers, and you can put an agent into a read-only "plan" run before letting it touch anything. Both of those live right in the chat surface.

## How to use it

1. Click an agent in the left sidebar. Its conversation, model, and plan state are all per agent.
2. Type a message and press Enter to send. Use Shift+Enter for a newline without sending.
3. Watch the reply appear a few words at a time, with a blinking cursor while it streams.
4. Type `@` to open the file autocomplete for the current folder, then pick a file to drop a `` `filename` `` reference into your message.
5. Change the model from the model dropdown in the composer toolbar. The footer under each reply shows which model answered, like `🧠 Sonnet 4.6`.
6. Flip the plan toggle to do a read-only run, then turn it off and resend if the plan looks right.

The current model choices are Opus 4.8 (smartest, slower), Sonnet 4.6 (balanced, the usual default), and Haiku 4.5 (fastest and cheapest). Each agent ships with a sensible default, and your dropdown choice overrides it for that agent only.

One thing to know up front: switching the model or toggling plan mode clears that agent's conversation. The new run starts with a fresh context rather than one primed for the old setting.

## How it works

A normal turn calls the SDK's `query()` with `includePartialMessages: true`. That tells the SDK to emit `stream_event` messages carrying incremental text, which the server forwards to the browser as NDJSON (one JSON object per line). The composer reads that stream and appends each delta to the live bubble, so you see the answer as it forms.

If you reload or close the tab mid-reply, the server aborts the in-flight `query()` through an `AbortController` instead of streaming into a dead socket. It listens on the response close event to catch the disconnect cleanly.

Model selection maps to the SDK's `model` option (`claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`). Plan mode maps to `permissionMode: 'plan'`, where the SDK classifies tool calls as it would run them but does not execute them. Multi-turn memory comes from `resume: sessionId`: the server captures the session id off the first `system.init` message and passes it on your next turn so the agent keeps full context.

Everything runs locally. The server binds to `127.0.0.1:3333` and never listens on your LAN, and nothing about the conversation leaves your laptop.

## Common questions

**Why does my chat reset when I change the model?**
A switched model starts with a clean context on purpose. A conversation primed for one model carries assumptions the new model never made, so the lab clears the session rather than hand it a confusing history.

**What does plan mode actually do?**
It runs the agent with tool calls classified but not executed. You see what the agent intends to do without it doing it. Turn plan off and resend when you want the real run. Toggling it also clears the session, since the SDK treats plan and execute as different context semantics.

**How does the agent remember earlier turns?**
The SDK session does the remembering. The server stores a session id per agent and passes it back as `resume:` on each new turn, so the agent has the full prior conversation even though the browser only shows the current view.

**What does the footer under a reply mean?**
It tells you which model answered (`🧠 Sonnet 4.6`) and how it authenticated (`🔐 Max plan · subscription` for OAuth, or an API-key label if a key is paying). On the Max plan there is no per-message dollar figure, since the plan is flat-rate.

**Does anything I type get sent anywhere besides Claude?**
No. The server is local-only, conversation history lives in SQLite at `data/lab.db` on your machine, and the only outbound call is the SDK reaching Claude to answer you.

## Where to go next

- [Agents](./agents-and-overview.md) to learn the built-in specialists and how to spawn your own.
- [Slash Commands](./slash-commands.md) to switch models and toggle plan mode by typing.
- [Keyboard Shortcuts](./keyboard-shortcuts.md) for the command palette and direct shortcuts.
- [History and Export](./history-and-export.md) to restore past chats and save them to disk.
