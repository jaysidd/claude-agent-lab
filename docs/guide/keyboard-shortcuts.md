# Keyboard Shortcuts

`[Live]`

## What this is

Clawd Desk has a small set of keyboard shortcuts so you can move around without reaching for the mouse. At the center is the ⌘K command palette, a fuzzy-filter list of every modal, action, and agent. Around it sit a handful of direct shortcuts for the modals you open most, plus a voice toggle.

## How to use it

**Command palette (⌘K).** Press ⌘K (or Ctrl+K) from anywhere, even while typing in the composer, to open the palette. Start typing to fuzzy-filter the list, which includes opening every modal, common actions like starting a new chat or a new custom agent, and switching to any agent by name. Use the arrow keys to move, Enter to fire the highlighted entry, and Escape to close. Press ⌘K again to toggle it shut.

**Direct shortcuts.** These open a modal straight away:

| Shortcut | Action |
|---|---|
| ⌘; | Open Settings |
| ⌘⇧T | Open Tasks |
| ⌘⇧S | Open Schedules |
| ⌘⇧M | Open Memory |
| ⌘⇧H | Open History |

On Windows and Linux, use Ctrl in place of ⌘.

**Escape.** Esc closes the topmost open modal. Press it again to peel back a layered modal underneath. With nothing open it is a harmless no-op.

**Voice (⌥V).** Press ⌥V (Option+V on macOS, Alt+V elsewhere) to start recording through WhisprDesk, and press it again to stop. The transcript drops into the composer.

A note on coverage: Pins, MCP servers, and Skills do not have their own direct shortcuts. Open them through the ⌘K palette, where they appear alongside everything else.

## How it works

A single global keydown handler on the document runs in the capture phase, which is what lets ⌘K open the palette even when your cursor is in the composer textarea. Without capture, the input would swallow the keystroke first.

The shortcuts do not reimplement anything. Each one calls the same underlying control as its button. The direct shortcuts call `.click()` on the matching header button, and the palette entries do the same, so opening Tasks with ⌘⇧T and clicking the Tasks button are the exact same action. The direct shortcuts (other than ⌘K) only fire when no input or textarea is focused, so they never hijack a key while you are typing into a field.

The palette's fuzzy match does a cheap substring check first, then a threaded per-character match so small typos still find the entry you meant. Agent entries in the list are built dynamically from your current agents, so any custom agent you create shows up automatically.

This is all browser-side UI wiring. None of it changes what leaves your machine; the server is still local-only on `127.0.0.1:3333`.

## Common questions

**Does ⌘K work while I am typing a message?**
Yes. The handler runs in the capture phase specifically so ⌘K opens the palette even with focus in the composer.

**Why do Tasks, Schedules, and friends use ⌘⇧ instead of plain ⌘?**
Plain ⌘T, ⌘S, and ⌘H are reserved by the browser or the OS. Using ⌘⇧ avoids colliding with new tab, save, and history. ⌘; is unclaimed, so Settings gets the simpler binding.

**How do I open Pins, MCP, or Skills by keyboard?**
Press ⌘K and type the name. They are in the palette even though they have no dedicated shortcut.

**Why ⌥V for voice instead of a ⌘ combination?**
⌥V is unclaimed across macOS, Windows, and Linux, which avoids clashes like ⌘M minimizing the window. It also works as a global toggle whenever the tab is focused.

**What does Escape do when several modals are open?**
It closes them one at a time, topmost first, so repeated Esc presses back you out layer by layer.

## Where to go next

- [Slash Commands](./slash-commands.md) for the typed equivalents inside the composer.
- [Chat and Models](./chat-and-models.md) for the composer and voice input.
- [History and Export](./history-and-export.md) which ⌘⇧H opens.
- [Memory and Pins](./memory-and-pins.md) which ⌘⇧M and the palette open.
