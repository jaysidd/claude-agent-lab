# Skills

`[Live]`

## What this is

A **Skill** is a folder with a `SKILL.md` file (plus any supporting files) that teaches an agent how to do a specific job. If tools are verbs, skills are jobs. A tool lets an agent read a file; a skill packages up a whole procedure, like "review a pull request the way this team does it" or "format a release note," along with the instructions and reference material the agent needs to carry it out.

Command Center surfaces the [Agent Skills](https://code.claude.com/docs/en/skills) it can find on your machine and lets you turn them on per agent.

## How to use it

Open the 🧩 **Skills** modal for an agent. It lists every skill discovered in two places:

- **Project skills** from `{cwd}/.claude/skills/*/SKILL.md` (the folder you currently have selected as the working directory).
- **User skills** from `~/.claude/skills/*/SKILL.md` (your home directory, available everywhere).

Each entry shows the skill's name and description, parsed from its `SKILL.md` frontmatter, plus a per-agent enable toggle. Flip a skill on for an agent and it becomes part of that agent's instructions on the next run.

There is a **Rescan** button. Discovery is a filesystem scan, so after you add or edit a skill on disk, hit Rescan to pick it up. Project skills shadow user skills of the same name, matching how the SDK resolves them.

**To add a skill**, drop a `SKILL.md` (with a `name:` and `description:` in its frontmatter) into a new folder under `.claude/skills/` in your project, or under `~/.claude/skills/` to make it available everywhere. Then open the Skills modal and click Rescan. It appears in the list, ready to enable.

## How it works

The SDK loads skills only when `settingSources` includes `'project'` or `'user'`, and the `skills` option then filters **which** discovered skills actually load into the system prompt. Command Center mirrors that exactly ([`src/skills.ts`](../../src/skills.ts)):

- An agent with **zero** enabled skills runs unchanged: no `settingSources`, no `skills` option. Nothing about its behavior shifts.
- An agent with **one or more** enabled skills runs its `query()` with `settingSources: ['project', 'user']` plus a `skills` name filter listing exactly the skills you toggled on.

Which skills are enabled for which agent is stored in SQLite (`data/lab.db`) on your machine. Discovery itself is a plain filesystem scan, so listing your skills never spends a model turn.

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
