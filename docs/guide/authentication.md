# Authentication

`[Live]`

## What this is

Clawd Desk never asks you to log in. It does not have accounts, billing, or a session of its own. Instead it inherits whatever credentials the Claude Agent SDK can find on your machine, and shows you which one it used.

There are two practical ways to run it: an Anthropic API key, or your already-logged-in Claude Code CLI. This page explains how the SDK chooses between them, what the UI labels mean, and the one Terms-of-Service rule you need to know before turning this into anything you share.

## How to use it

Pick one path.

**API key (recommended for everyday use).** Put your key in `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

The reply footer then shows `🔑 API key`, and the cost column lights up because key-based usage is billed per token.

**Local Claude Code CLI (personal use only).** Leave `ANTHROPIC_API_KEY` unset. If you have the `claude` CLI installed and logged in, the SDK inherits that OAuth session automatically, the same way the CLI itself does. The reply footer then shows `🔐 Max plan · subscription` and no dollar figure, because a Max plan is flat-rate.

Either way, the footer of every reply tells you exactly which path answered, so you are never guessing.

## How it works

The SDK resolves credentials in a strict order, and the first match wins:

1. **`ANTHROPIC_API_KEY`** in the environment. If set, it is used unconditionally.
2. **Enterprise transports**, when `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, or `CLAUDE_CODE_USE_FOUNDRY` is set with the matching cloud credentials.
3. **Your local Claude Code CLI OAuth session**, used only when none of the above are present.

The SDK reports the result as `apiKeySource` on every response. A key resolves to `user`, `org`, or `project`. OAuth resolves to `none`. Clawd Desk reads that value and translates `none` into the friendly `🔐 Max plan · subscription` label. `apiKeySource: "none"` means OAuth is working, not that anything is broken.

## Common questions

**The footer says `apiKeySource` is "none". Is my setup broken?**
No. `none` is the SDK's normal value when you are authenticated through the local CLI's OAuth session rather than an API key. The UI shows it as "Max plan, subscription."

**Why is there no dollar cost on my replies?**
Because the Max plan is flat-rate, not per-token. Showing a per-message dollar figure would imply billing that does not apply. Tokens still show, as a proxy for how heavily you are leaning on the plan. Switch to an API key and the cost column appears automatically, keyed off `apiKeySource`.

**I set an API key but it's still using my Max plan, or vice versa.**
Check the resolution order. `ANTHROPIC_API_KEY` always wins if it is set. If a key is exported in your shell or sitting in `.env`, it silently shadows your OAuth session. To use OAuth, make sure the key is genuinely unset everywhere.

**Can I build a product on the OAuth path so my users sign in with their Max plans?**
No. Anthropic's Terms of Service do not allow third-party products to offer claude.ai / Pro / Max login or rate limits to end users, including agents built on the Agent SDK. The OAuth path here is for personal use on your own machine. A shippable product must use API key authentication, typically with a bring-your-own-key UI for each user.

**Does my key ever reach the browser?**
No. Credentials are read server-side only. The frontend never sees the raw key, and the cost UI works purely off the `apiKeySource` label the server returns.

## Where to go next

- [Getting Started](getting-started.md), the two auth options in the setup flow.
- [What's Under the Hood](whats-under-the-hood.md), where the SDK resolves credentials in the request path.
- [Settings Reference](settings-reference.md), how the OAuth-aware cost cap behaves in Budget settings.
