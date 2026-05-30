---
name: review
description: Ask the local Claude Code CLI to review the current git diff read-only and return a structured code review. Use when the user invokes claude:review or asks Claude to review changes while Codex applies them.
argument-hint: "[--base ref] [--staged] [--dry-run] [--output file] [--model name] [--timeout ms] [--max-files n] [--show-skills] [--skill id] [--skills id,id]"
---

# Claude Review

Ask the local Claude Code CLI to review the current changes: inspect only the diff and what is needed, write no files, and return a structured review.

Raw user options:

```text
$ARGUMENTS
```

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/plugins/claude/scripts/claude-companion.mjs" review $ARGUMENTS
```

Review options:
- `--base <ref>`: review `git diff <ref>` instead of the working tree against `HEAD`.
- `--staged`: review staged changes (`git diff --cached`).
- `--dry-run`: print the final prompt/context without running Claude.
- `--output <file>`: save the returned review with metadata.
- `--save`: save the returned review to `REVIEW.md`.
- `--model <name>`: pass a Claude model name to the CLI.
- `--timeout <ms>`: override the Claude review timeout.
- `--max-files <n>`: limit visible files included in the prompt.
- `--show-skills`: include matching skill candidates in the Claude review prompt.
- `--skill <id>` / `--skills <id,id>`: instruct Claude to use specific skills.

Output rules:
- This is read-only.
- Return the command stdout to the user.
- When there are no changes, report that nothing was reviewed.
- Do not edit files, commit, or run destructive commands.
- If the command reports Claude is unavailable or failing, tell the user to run `claude:doctor`.
