# Voice (WhisprDesk)

`[Live]`

## What this is

ClawdDesk can listen and talk back. If you have the optional local [WhisprDesk](https://whisprdesk.com/) app running, you can dictate into the composer instead of typing, have anything you dictate elsewhere on your Mac flow straight in, and have agent replies read aloud. Audio stays on your machine: WhisprDesk runs locally, and the only thing ClawdDesk holds is a gateway token kept server-side.

WhisprDesk is a local-first macOS dictation app built on the open-source Whisper engine. It is optional. Without it, the voice features stay dormant and everything else works as normal.

## How to use it

There are three modes.

**Active mode (mic button or `⌥V`).** Click the 🎤 button next to Send, or press **`⌥V`** (Option+V on macOS, Alt+V elsewhere), to start recording. Click or press again to stop. A live pink banner above the composer shows the elapsed time and how to stop. When you stop, the transcript drops into the composer ready to edit or send with `Enter`.

**Passive mode (SSE listener).** The server subscribes to WhisprDesk's event stream. Any dictation you do anywhere on your Mac with WhisprDesk's native push-to-talk shortcut auto-fills the ClawdDesk composer, as long as ClawdDesk is the focused browser tab. You keep your existing muscle memory; the lab just catches the transcript.

**Voice out.** Every agent reply gets a 🔊 button. Click it to have the browser read the reply aloud. Click again to stop.

## How it works

Voice is the one corner of ClawdDesk that is **not** an SDK primitive. It is a thin proxy to your local WhisprDesk gateway plus the browser's built-in speech API.

- **Active mode** records with `MediaRecorder` (WebM/Opus), decodes it in the browser via the Web Audio API, and re-encodes it as mono 16-bit PCM WAV. That conversion happens client-side so server-side decoders always succeed regardless of `MediaRecorder` quirks. The WAV then POSTs to `/api/whisprdesk/transcribe`; the server adds the Bearer header and returns the transcript.
- **Passive mode** is an SSE passthrough: the server relays WhisprDesk's `/v1/events` stream to the page, and the page fills the composer when the tab is focused.
- **Voice out** uses the browser's `SpeechSynthesis` API directly. No server round-trip, no WhisprDesk needed for this one.

The integration speaks a generic HTTP gateway shape, so it is not locked to WhisprDesk specifically, but WhisprDesk is the cleanest implementation it targets.

## Setup

Open ⚙️ **Settings** → **WhisprDesk**. Paste the Bearer token from WhisprDesk's *External App Gateway* card, and use the live **Test connection** button to confirm it is reachable. Save. The sidebar footer flips from `WhisprDesk · off` to `· ready` within a second, and the 🎤 button enables. No restart needed.

The token stays server-side. It is stored as operator config and used only to add the Bearer header when the server proxies to WhisprDesk. It never round-trips to the browser, and your audio never leaves your Mac.

## Common questions

**The 🎤 button is disabled.**
WhisprDesk isn't configured yet. Paste the gateway token in Settings → WhisprDesk and save; the footer should flip to `· ready` and the button enables.

**Passive mode isn't filling the composer.**
Passive mode only fires while ClawdDesk is the **focused** browser tab. Switch back to the tab and dictate again. Also confirm WhisprDesk is running and the connection tests green in Settings.

**Does my audio go to the cloud?**
No. WhisprDesk transcribes locally on your Mac. ClawdDesk proxies to that local gateway; the audio never leaves your machine.

**Where is the WhisprDesk token kept?**
Server-side only, as operator config. It is used to add the Bearer header when proxying and is never sent back to the browser.

**Do I need WhisprDesk for voice out?**
No. The 🔊 read-aloud button uses the browser's built-in `SpeechSynthesis` API and works without WhisprDesk. Only the dictation (in) modes need it.

**I don't have WhisprDesk. Can I still use ClawdDesk?**
Yes. Voice is optional. Everything else runs without it; the voice features simply stay off until you configure a gateway.

## Where to go next

- [Tools and MCP Servers](./tools-and-mcp.md), what the agents you dictate to can actually do.
- [Skills](./skills.md), teach those agents whole jobs.
- [Telegram Bridge](./telegram-bridge.md), the other hands-free path into your agents.
