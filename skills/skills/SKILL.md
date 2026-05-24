---
name: skills
description: List local and global Claude Code skills available to claude:plan. Use when the user invokes claude:skills or asks what Claude skills can be selected.
argument-hint: "[--scope all|local|global] [--query text] [--format text|json]"
---

# Claude Skills

List Claude Code skills that `claude:plan` can reference.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/plugins/claude/scripts/claude-companion.mjs" skills $ARGUMENTS
```

Rules:
- This is read-only.
- Do not print full `SKILL.md` bodies.
- Use `--scope local` for project skills, `--scope global` for user/plugin-cache/agent skills, and `--scope all` for both.
- Use `--query <text>` to search skill id, name, description, and path before recommending a skill.
- Description queries are supported, so users can search phrases like `production-grade frontend` without knowing the skill id.
- Text output shortens long descriptions; use `--format json` for full descriptions and paths.
