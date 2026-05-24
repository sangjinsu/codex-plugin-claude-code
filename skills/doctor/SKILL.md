---
name: doctor
description: Diagnose Claude Code CLI readiness for this plugin, including auth, prompt smoke test, project state, and plugin files. Use when the user invokes claude:doctor or asks why claude:plan is failing.
argument-hint: ""
---

# Claude Doctor

Run a diagnostic check for the local Claude Code planner integration.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/plugins/claude/scripts/claude-companion.mjs" doctor
```

Rules:
- This is read-only.
- Do not install Claude automatically.
- Preserve the diagnostic output.
- Do not print environment variable values, tokens, cookies, SSH keys, or Claude/Codex authentication material.
