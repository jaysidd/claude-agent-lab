# Telegram Bridge

`[Live]`

## What this is

The Telegram bridge lets you drive the same ClawdDesk agents from your phone. You message a Telegram bot, the bot hands your text to an agent, and the agent's reply comes back as a Telegram message. It is the same agents, the same sessions, the same budget caps and approval gates as the web UI, just reachable from anywhere you have Telegram.

There is no public webhook and nothing exposed to the internet. The bridge uses long-polling, so your laptop reaches out to Telegram rather than the other way around.

## How to use it

**1. Create a bot.** In Telegram, DM [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts. BotFather gives you a **bot token** (a long string like `123456:ABC-...`).

**2. Find your chat ID.** DM your new bot once (send it any message). Then open this URL in a browser, with your token filled in:

```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

In the JSON response, find `message.chat.id`. That number is your chat ID.

**3. Wire it into ClawdDesk.** Open ⚙️ **Settings** → **Telegram bridge**. Paste the bot token and your chat ID into the allowlist, then save. The listener restarts live, no server bounce. The bot's status appears in Settings so you can confirm it connected.

**Talking to agents.** Once it is running:

- **Plain text** goes to **Main**, the router, which decides how to handle it.
- **A slash command targets a specific agent.** For example `/comms draft an email to the team` runs the Comms agent on that prompt. The command is the agent's id; everything after it is the prompt.
- **`/help`** prints how the bot works and lists the available agents.
- **`/agents`** lists the current agents with their ids and models.

**Multiple people.** The allowlist is comma-separated, so you can add several chat IDs (for example your phone plus a family member's) and each of them can message the bot.

## How it works

The bridge is a long-poll listener ([`src/telegram.ts`](../../src/telegram.ts)) built on Telegram's Bot API (`getUpdates` / `sendMessage` / `sendChatAction`), with no SDK or Express coupling. The host wires an `onMessage` handler that routes each message into the agent backend.

**The chat-ID allowlist is the security boundary.** It is parsed into a numeric set. An **empty allowlist blocks everyone**. A message from a chat ID that is not on the list is **silently dropped**: the bot does not reply, which avoids confirming the bot even exists to a non-allowed party. Only allowlisted senders ever reach an agent.

**Replies.** While an agent runs, the bot keeps a "typing..." indicator alive (re-sent every few seconds, since Telegram clears it after about five). When the reply is ready, long replies are chunked at 4000 characters (Telegram's hard limit is 4096), and multi-part replies are annotated `(N/M)` so you can follow the sequence.

**Shared state.** Bridge messages share session state, CostGuard budget caps, and per-task approval gates with the web UI. A CostGuard preflight runs before the SDK call, so an exhausted budget fails fast with a message instead of burning tokens. Because the listener long-polls and verifies the token with `getMe` on start, you get a clear status (listening, auth failed, or conflict) rather than a silent failure.

Note that messages from allowlisted users **share the same agent session**. So if you and a family member both message the bot, you are talking into the same conversation thread, not separate private ones.

## Common questions

**Nobody can reach the bot. Why?**
Almost always an empty or wrong allowlist. An empty allowlist blocks all senders by design. Confirm your chat ID is in Settings exactly as it appeared in `getUpdates` (it can be negative for group chats).

**I sent a message and got nothing back, not even an error.**
That is the silent-drop behavior for non-allowlisted chat IDs. Add your chat ID to the allowlist and save.

**Do I need to expose a port or set up a webhook?**
No. The bridge long-polls Telegram from your machine. Nothing on your laptop is exposed to the internet.

**Can I give access to more than one person?**
Yes. The allowlist is comma-separated, so add multiple chat IDs. Keep in mind they share the same agent session, so it is one shared conversation.

**Do I have to restart the server after changing the token?**
No. Saving in Settings restarts the listener live. The token is also re-read on each message, so rotating it takes effect right away.

**What happens if my budget cap is hit?**
The CostGuard preflight catches it before the SDK call and the bot replies with the cap message. No tokens are spent on a capped request.

## Where to go next

- [Tools and MCP Servers](./tools-and-mcp.md), the capabilities the agents you message can use.
- [Skills](./skills.md), package whole jobs your phone-driven agents can run.
- [Voice (WhisprDesk)](./voice.md), the other hands-free way into ClawdDesk.
