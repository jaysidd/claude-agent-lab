# Getting Started

`[Live]`

## What this is

Command Center is a small, hackable multi-agent dashboard built directly on Anthropic's official Claude Agent SDK. It pairs a tiny Express server with a vanilla-JS browser UI so you can chat with several Claude agents, each with its own system prompt, tool allowlist, and model.

Everything runs on your own machine. The server binds to `127.0.0.1:3333` only, so it never listens on your LAN, and nothing is relayed through any hosted service. Your conversations, memory, and settings live on disk in a local SQLite file (`data/lab.db`), which is gitignored.

This page gets you from a fresh clone to your first agent reply.

## How to use it

**1. Clone and install.**

```bash
git clone https://github.com/jaysidd/claude-agent-lab.git
cd claude-agent-lab
npm install
```

You need Node.js 20 or newer (tested on 24.14.1).

**2. Pick an authentication path.** You need one of these two.

*Option A, an Anthropic API key (recommended as a daily driver).* Copy the example env file and paste your key:

```bash
cp .env.example .env
# then edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

Get a key at [console.anthropic.com](https://console.anthropic.com/settings/keys).

*Option B, your logged-in Claude Code CLI.* If you already have the `claude` CLI installed and logged in (Max plan OAuth), there is nothing to configure. Leave `ANTHROPIC_API_KEY` unset and the SDK inherits that session automatically. Note that this OAuth path is personal-use-only on your own machine. Anthropic's Terms of Service do not allow third-party products to offer claude.ai / Pro / Max login to other users, so anything you plan to ship must use API keys. See [Authentication](authentication.md) for the full detail.

**3. Start the server.**

```bash
npm run serve
```

Then open [http://localhost:3333](http://localhost:3333) in your browser.

**4. Send your first message.** In the left sidebar, click one of the four built-in agents:

- 🧭 **Main**, a router and triage agent with no direct tools.
- ✉️ **Comms**, drafts messages, has `WebFetch`.
- 🎬 **Content**, long-form and YouTube writing, runs on Opus.
- ⚙️ **Ops**, reads files in the folder you pick, read-only.

Type in the composer at the bottom and press Enter. The reply streams in token by token. The footer of each reply shows which model answered and how it authenticated.

## The one-click launcher (macOS)

The repo ships a double-clickable launcher. Copy it to your Desktop:

```bash
cp scripts/launch-command-center.command "$HOME/Desktop/Command Center.command"
chmod +x "$HOME/Desktop/Command Center.command"
```

Double-clicking it kills any previous server on :3333, runs `npm install` if needed, starts the server, waits for it to be ready, and opens your browser. On the first launch, macOS Gatekeeper may block the unsigned script, so right-click the icon, choose **Open**, and confirm once. After that it launches cleanly. The script respects a `COMMAND_CENTER_DIR` env var if your clone lives somewhere unusual.

## How it works

The whole app is one Node process: Express on port 3333 hands each chat to the SDK's `query()` call and renders the async stream of events back to the browser. There is no build step (the frontend is plain HTML, CSS, and JS) and no separate renderer. The SDK does the heavy lifting; Command Center is the thin, readable layer on top.

## Common questions

**Do I need both an API key and the Claude CLI?**
No. You need exactly one. If `ANTHROPIC_API_KEY` is set it is used; otherwise the SDK falls back to your logged-in CLI session.

**Does any of my data leave my laptop?**
No. The server is bound to localhost only, and all persistent state sits in a local SQLite file at `data/lab.db`, which is gitignored. Your only outbound traffic is the agent's calls to Anthropic, the same as the `claude` CLI itself.

**The port 3333 is busy. What now?**
The launcher kills any prior server on that port for you. If you started the server manually, stop the old process first (`lsof -ti:3333 | xargs kill -9`) and run `npm run serve` again.

**Why does my reply footer say "Max plan, subscription" instead of a dollar cost?**
That means you are on the OAuth path, which is flat-rate, so no per-token dollar figure applies. This is expected, not an error. See [Authentication](authentication.md).

**Can other people on my network reach this?**
No. The server binds to `127.0.0.1`, never `0.0.0.0`. LAN neighbors cannot connect unless you deliberately override the host.

## Where to go next

- [What's Under the Hood](whats-under-the-hood.md), the SDK engine and where state lives.
- [Authentication](authentication.md), the credential order and the ToS caveat.
- [Settings Reference](settings-reference.md), every section of the ⚙️ Settings modal.
