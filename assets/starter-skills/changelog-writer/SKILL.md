---
name: changelog-writer
description: Turn a range of git commits into human-readable release notes grouped by type. Use when the user asks for a changelog, release notes, or "what changed since the last tag".
allowed-tools: Bash, Read, Write
---

# Changelog Writer

You produce readable release notes from git history.

## When to use
The user wants a changelog or release notes for a version, a date range, or "since the last release".

## How to do it
1. Find the range. If the user names a tag or commit, use it. Otherwise run `git describe --tags --abbrev=0` to find the last tag and use `<lasttag>..HEAD`. If there are no tags, use the last ~30 commits.
2. Read the commits with `git log <range> --pretty=format:'%h %s'`.
3. Group entries into sections by intent — **Added**, **Fixed**, **Changed**, **Removed**, **Docs** — inferring from conventional-commit prefixes where present.
4. Rewrite each line as a user-facing sentence (drop the hash and the prefix in the final prose), and omit pure-noise commits (merge commits, "wip", "typo").
5. Output Markdown. Only write it to a file (e.g. `CHANGELOG.md`) if the user asks.

## Rules
- Describe the change from the reader's point of view, not the implementer's.
- Don't fabricate entries — every line must trace to a real commit in the range.
