---
name: plan
description: Ask the local Claude Code CLI to create a read-only implementation plan. Use when the user invokes claude:plan or asks Claude to plan while Codex implements.
argument-hint: "[--list-skills] [--recommend-skills] [--dry-run] [--show-skills] [--skill id] [--skills id,id] [request]"
---

# Claude Plan

Ask the local Claude Code CLI to act like Codex `/plan`: inspect only what is needed, write no files, and return an implementation plan.

Raw user request:

```text
$ARGUMENTS
```

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/plugins/claude/scripts/claude-companion.mjs" plan "$ARGUMENTS"
```

Skill options:
- `--list-skills`: list local and global Claude skills without running a plan.
- `--recommend-skills`: recommend relevant skills for a request without running Claude.
- `--dry-run`: print the final prompt/context without running Claude.
- `--query <text>`: filter skill lookup by id, name, description, or path.
- `--show-skills`: include matching skill candidates in the Claude planning prompt.
- `--skill <id>`: instruct Claude to use a specific skill.
- `--skills <id,id>`: instruct Claude to use multiple skills.

Output rules:
- Return the command stdout to the user.
- Do not create `PLAN.md`.
- Do not edit files, commit, or run destructive commands.
- If the command reports Claude is unavailable or failing, tell the user to run `claude:doctor`.
