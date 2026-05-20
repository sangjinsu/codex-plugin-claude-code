---
name: setup
description: Check whether the local Claude Code CLI is ready for this plugin. Use when the user invokes claude:setup or asks to verify Claude CLI setup for the Codex Claude plugin.
argument-hint: ""
---

# Claude Setup

Check whether the local Claude Code CLI and this plugin's MVP file structure are ready.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/plugins/claude/scripts/claude-companion.mjs" setup
```

Report the command output to the user.

Rules:
- Do not install Claude automatically.
- If Claude is missing, tell the user installation is required and preserve the setup output.
- Do not print environment variable values, tokens, cookies, SSH keys, or Claude/Codex authentication material.
