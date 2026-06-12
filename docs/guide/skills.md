# Skills

`[Live]`

## What this is

A **Skill** is a folder with a `SKILL.md` file (plus any supporting files) that teaches an agent how to do a specific job. If tools are verbs, skills are jobs. A tool lets an agent read a file; a skill packages up a whole procedure, like "review a pull request the way this team does it" or "format a release note," along with the instructions and reference material the agent needs to carry it out.

Clawd Desk surfaces the [Agent Skills](https://code.claude.com/docs/en/skills) it can find on your machine and lets you turn them on per agent.

## How to use it

Open the 🧩 **Skills** modal for an agent. It lists every skill discovered in two places:

- **Project skills** from `{cwd}/.claude/skills/*/SKILL.md` (the folder you currently have selected as the working directory).
- **User skills** from `~/.claude/skills/*/SKILL.md` (your home directory, available everywhere).

Each entry shows the skill's name and description, parsed from its `SKILL.md` frontmatter, plus a per-agent enable toggle. Flip a skill on for an agent and it becomes part of that agent's instructions on the next run.

There is a **Rescan** button. Discovery is a filesystem scan, so after you add or edit a skill on disk, hit Rescan to pick it up. Project skills shadow user skills of the same name, matching how the SDK resolves them.

Skills you installed through the panel (they live in `~/.claude/skills`) show a 🗑 button so you can remove them without leaving the app. Project skills you manage on disk yourself are never deleted through the UI.

## Adding a skill (Skills Studio)

The **＋ Add a skill** tab gives you three ways to create a skill, all of which install a standard `SKILL.md` into `~/.claude/skills` — there is no external registry and nothing is ever uploaded off your machine.

- **🛠 Skill Builder** — fill in a name, a description (this is what tells the agent *when* to use the skill), an optional list of allowed tools, and the instructions. Clawd Desk writes a correctly-formatted `SKILL.md` for you.
- **📦 Starter pack** — a handful of ready-made, SDK-native skills bundled with the app (a commit-message helper, a changelog writer, a code explainer). One click installs them.
- **📋 Paste SKILL.md** — paste a full skill you found elsewhere. Because this is content from outside, it goes through the safety scan and a review gate before it installs.

### The safety scan

Before a pasted skill installs, its text is run through a **static security scan** — a heuristic lint that flags risky patterns like piping a download straight into a shell, `rm -rf`, reverse shells, reading credential files, or editing your shell startup files. Findings are shown with a severity (low / medium / high) and the exact line.

This is a *review aid, not a sandbox* — a skill is only text until an agent acts on it, and the scan catches obvious red flags, not everything. For that reason:

- For the **Skill Builder** (content you wrote), the scan is purely informational.
- For a **pasted** skill with a **high-severity** finding, the install button stays blocked until you tick "I've reviewed this skill and trust the source." The server enforces this too, so the gate can't be skipped.

There is deliberately **no VirusTotal or cloud scan**: antivirus engines match malware binaries, not harmful instructions (so they'd add no signal on a text file), and uploading your skill to a third party would break the privacy promise that nothing leaves your machine without consent.

> **Why not just install from ClawHub (or a big public catalog)?** Clawd Desk is built on the Claude Agent SDK, whose tool vocabulary is `Read` / `Write` / `Bash` / `WebFetch` / MCP tools. Catalogs written for other engines reference tools that don't exist here (`fs_write_file`, `cmd_bash`, `browser_open`), so their skills would load but tell the agent to call tools it doesn't have. The honest path is to author SDK-native skills — which is exactly what Skills Studio does.

## Emergent skills — save a procedure the agent just did

The best skills come from work you've actually done. When an agent finishes a task that used a few tools, a small **💡 nudge** appears under its reply: *"That looked like a reusable procedure — Save as skill?"* The nudge itself is free — nothing happens until you click it.

If you do click it, Clawd Desk asks a fast, cheap model to **distill that turn into a draft skill**: it reads what you asked, what the agent did, and which tools it used, then writes a `SKILL.md` that generalizes the one-off run into a repeatable procedure. The tools the draft is allowed to use are **anchored to the tools the agent actually used** — it can't invent a tool name. If the turn wasn't really a reusable procedure (idle chat, a one-off answer), the distiller says so and nothing is saved.

The draft lands in the **💡 Proposed** tab of the Skills modal — it is **never auto-installed**. There you can read the full draft, then **Review & install** it or **Dismiss** it.

### Why a proposed skill is treated as untrusted

A proposal is generated by a model reading a transcript — and that transcript may contain content the agent pulled in from outside, like a web page it browsed. A malicious page could try to influence what gets written into the skill. So an emergent skill is held to the **same bar as a pasted skill**, not the Skill Builder: installing it runs the security scan, and a high-severity finding is blocked behind an explicit "install anyway" confirmation that the server enforces. The transcript is treated as the ground truth for *which tools* the skill may use, but its *content* is never trusted blindly.

## How it works

The SDK loads skills only when `settingSources` includes `'project'` or `'user'`, and the `skills` option then filters **which** discovered skills actually load into the system prompt. Clawd Desk mirrors that exactly ([`src/skills.ts`](../../src/skills.ts)):

- An agent with **zero** enabled skills runs unchanged: no `settingSources`, no `skills` option. Nothing about its behavior shifts.
- An agent with **one or more** enabled skills runs its `query()` with `settingSources: ['project', 'user']` plus a `skills` name filter listing exactly the skills you toggled on.

Which skills are enabled for which agent is stored in SQLite (`data/lab.db`) on your machine. Discovery itself is a plain filesystem scan, so listing your skills never spends a model turn.

Installing, scanning, and deleting skills lives in [`src/skillInstall.ts`](../../src/skillInstall.ts). Every write and delete resolves the target path and verifies it stays inside `~/.claude/skills` (the same resolve-and-prefix-check used to stop SSRF in the browser feature), and skill folder names are confined to `[a-z0-9-]`, so a crafted name can't escape the skills folder. When you delete a skill, any stale per-agent "enabled" rows that referenced it are cleared too.

**One side effect worth knowing.** Setting `settingSources: ['project', 'user']` does more than load skills. It tells the SDK to also load your project and user `CLAUDE.md`, any `.mcp.json`, and your project/user hooks for that run. That is wider than "just turn on a skill," and the `.mcp.json` load can overlap with the per-agent MCP config from the MCP modal. It is strictly opt-in (it only fires for an agent once you enable a skill on it), which fits the personal, local-only use model.

## Common questions

**Where do I put a new skill?**
A folder with a `SKILL.md` inside `{your-project}/.claude/skills/` (project scope) or `~/.claude/skills/` (user scope, everywhere). Then Rescan.

**I added a skill but it isn't listed.**
Discovery is a one-time scan per request, so click **Rescan**. Also confirm the folder contains a file literally named `SKILL.md`, and that the Skills modal is open for the working directory you put it in.

**Why does my project CLAUDE.md and hooks suddenly load when I enable a skill?**
Because enabling a skill flips on `settingSources: ['project', 'user']`, which the SDK uses to load skills, `CLAUDE.md`, `.mcp.json`, and hooks together. That is the documented trade-off. Turn the skill off and the agent goes back to its plain run.

**Are skills per agent or global?**
Per agent. The same skill can be on for one agent and off for another. The list of available skills is shared (it is whatever is on disk); the enabled set is per agent.

**Does scanning for skills cost tokens?**
No. Discovery and Rescan are filesystem reads only. Nothing reaches the model until you actually run the agent.

## Where to go next

- [Tools and MCP Servers](./tools-and-mcp.md), the verb layer that skills build on top of.
- [Telegram Bridge](./telegram-bridge.md), run skill-equipped agents from your phone.
- [Voice (WhisprDesk)](./voice.md), dictate the job instead of typing it.
