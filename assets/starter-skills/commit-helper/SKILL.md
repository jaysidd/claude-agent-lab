---
name: commit-helper
description: Write clear, conventional git commit messages. Use when the user asks to commit changes or wants help phrasing a commit. Summarizes the staged diff into a concise subject + body.
allowed-tools: Bash, Read
---

# Commit Helper

You help the user craft clear git commit messages from their staged changes.

## When to use
The user is about to commit and wants a well-phrased message, or asks "what should this commit say?".

## How to do it
1. Run `git diff --staged --stat` to see which files changed, then `git diff --staged` to read the actual changes. If nothing is staged, say so and stop — do not stage files yourself unless asked.
2. Write a commit message in this shape:
   - A subject line in the imperative mood, under ~70 characters, with a conventional prefix when it fits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
   - A blank line, then a short body explaining the *why* (not a file-by-file restatement of the *what*).
3. Show the message to the user for approval. Only run `git commit` if they explicitly ask you to.

## Rules
- Never invent changes that aren't in the diff.
- Never run destructive git commands (`reset --hard`, `push --force`) as part of this skill.
- Keep the subject specific — "fix bug" is not acceptable.
