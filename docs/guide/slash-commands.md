# Slash Commands

`[Live]`

## What this is

Slash commands are typed shortcuts for the things you would otherwise reach for in a modal or a dropdown: switching models, toggling plan mode, listing agents, clearing a chat, and exporting. Type `/` at the start of the composer and a live autocomplete popover appears so you do not have to memorize anything.

They are all handled in the browser, so they fire instantly and never hit the model unless the command is actually meant to.

## How to use it

Type `/` as the first character in the composer. A popover opens above it listing the matching commands. Navigate with the arrow keys, press Tab to complete the highlighted command, press Enter to run it, and press Escape to dismiss. The list narrows as you keep typing, so `/th` brings up just the `/think` variants.

| Command | What it does |
|---|---|
| `/help` | Lists every slash command, plus the keyboard shortcuts. |
| `/clear` | Starts a new conversation with the current agent. |
| `/agents` | Lists all agents with their descriptions and default models. |
| `/model` | Shows the current model plus the available options. |
| `/model <id>` | Switches the model for this agent. Accepts `opus`, `sonnet`, or `haiku`. |
| `/think hard` | Switches this agent to Opus 4.8 for more careful reasoning. |
| `/think fast` | Switches this agent to Haiku 4.5 for snappy, cheap replies. |
| `/think default` | Resets this agent to its configured default model. |
| `/plan on` | Turns on plan mode (a read-only run) for this agent. |
| `/plan off` | Turns plan mode back off. |
| `/export` | Downloads this conversation as Markdown. |
| `/export md` | Same as `/export`. |
| `/export json` | Downloads this conversation as JSON with full usage objects. |

There is also the `@file` mechanic, which shares the same popover style. Type `@` (when the line does not start with `/`) and a list of files in the current folder appears. Arrow keys to navigate, Enter or Tab to insert, Escape to dismiss. Selecting a file drops a `` `filename` `` reference into your message, which a file-reading agent like Ops can then open.

## How it works

Slash commands are client-side intercepts. Before a message is sent, the composer checks whether it begins with a recognized `/command` and, if so, runs the matching action in the browser instead of dispatching a turn to the SDK. That is why `/model`, `/plan`, `/clear`, and `/export` take effect immediately with no model latency.

The ones that change agent state still route through the same code paths as the UI controls. `/model` and `/think` call the same model-override path as the composer's model dropdown, `/plan` calls the same plan-mode toggle as the header checkbox, and `/export` calls the same client-side download used everywhere else. So a command and its button counterpart always do exactly the same thing.

Command output appears in the chat log as a system-origin message rendered with full Markdown, which keeps the result legible inline without it looking like the agent said it.

Note that switching the model (via `/model` or `/think`) and toggling plan mode (via `/plan`) both clear that agent's session, the same as doing it from the UI, because the new setting starts with a fresh context.

## Common questions

**Do slash commands use up a model turn?**
No. They are intercepted in the browser and run locally. The model is only involved when you send an actual message.

**How do I complete a command without running it?**
Press Tab. That fills the highlighted command into the composer and leaves the cursor at the end, so you can add an argument like an id before pressing Enter.

**Why did `/model opus` reset my conversation?**
Changing the model clears the agent's session on purpose, so the new model starts clean rather than inheriting a context shaped for the old one.

**What is the difference between `/think` and `/model`?**
None functionally. `/think hard|fast|default` is an ergonomic alias over `/model opus|haiku|<default>`. Use whichever reads better to you.

**Are these the same as Claude Code slash commands?**
No. These are Clawd Desk's own client-side commands for this dashboard. They are not the SDK's command system; they are UI conveniences layered on top.

## Where to go next

- [Chat and Models](./chat-and-models.md) for model switching and plan mode in depth.
- [History and Export](./history-and-export.md) for what `/export` produces.
- [Agents](./agents-and-overview.md) for what `/agents` lists.
- [Keyboard Shortcuts](./keyboard-shortcuts.md) for the ⌘K palette and direct shortcuts.
