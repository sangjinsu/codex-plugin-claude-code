**English** | [한국어](README.ko.md)

# Codex Plugin Claude Code

Codex Plugin Claude Code is a minimal Codex plugin that asks the local Claude Code CLI to create read-only implementation plans.

This plugin takes the opposite approach of `codex-plugin-cc`:

- `codex-plugin-cc`: Call Codex from Claude Code
- This plugin: Call Claude Code from Codex

The intended workflow is simple: Claude plans, Codex validates the plan against the repository state, then Codex implements the change.

## Features

- `claude:setup`: Check whether the local Claude Code CLI and plugin files are ready.
- `claude:plan`: Ask Claude for a read-only implementation plan.
- `claude:skills`: List local and global Claude Code skills that can be referenced by planning.

## Installation

This repository is the Codex plugin root. To use it as a local plugin, register this directory as a Codex plugin source.

Prerequisites:

- Node.js 20+
- Local `claude` CLI
- Authenticated Claude Code session

The plugin does not install Claude automatically. Install and authenticate Claude Code separately, then verify access:

```bash
claude auth status
```

## claude:setup

Checks Claude CLI availability, authentication state, project status, and required plugin files.

```text
claude:setup
```

Internally runs the following script:

```bash
node plugins/claude/scripts/claude-companion.mjs setup
```

Checks performed:

- `claude` CLI is installed and executable
- `claude --version` runs successfully
- `claude auth status` reports an authenticated session
- The current directory looks like a project
- Required plugin files exist

## claude:plan

Requests a read-only implementation plan from Claude, similar to Codex `/plan`.

```text
claude:plan add README usage examples
```

Internally runs the following script:

```bash
node plugins/claude/scripts/claude-companion.mjs plan "add README usage examples"
```

By default, `claude:plan` does not create `PLAN.md`. It returns the plan through stdout only.

The Claude CLI call is restricted to `Read`, `Glob`, `Grep`, and `LS` tools so Claude can inspect context but cannot edit files.

Skills can also be used with the plan command:

```text
claude:plan --list-skills --query plan
claude:plan --list-skills --query "implementation plan"
claude:plan --show-skills add frontend validation
claude:plan --skill superpowers:writing-plans add release checklist
claude:plan --skills frontend-design,global-review add UI validation plan
```

Claude is expected to return these sections:

- `Summary`
- `Current Understanding`
- `Plan`
- `Validation`
- `Risks`

## claude:skills

Lists local and global Claude Code skills.

```text
claude:skills --scope all --query frontend
claude:skills --scope all --query "production-grade frontend"
```

Scope options:

- `local`: The current project's `skills/`, `.claude/skills/`, and `.claude/plugins/`
- `global`: `~/.claude/skills/`, `~/.claude/plugins/cache/`, `~/.agents/skills/`
- `all`: Both local and global skills

`--query` searches across skill id, name, description, and path, so you can find skills by description keywords without knowing the exact skill name.

Text output shortens long descriptions for readability. Use `--format json` when you need the full description and path.

## Limitations

- Does not call the Anthropic API directly.
- Does not use MCP.
- Does not create background jobs.
- Does not provide review, status, result, or cancel workflows yet.
- Plans returned by Claude are for reference only. Codex should validate them against the repository state before implementing.

## Security

Scripts do not read or output `.env` values. If Claude output contains obvious API key, token, or private key patterns, those values are masked as `[REDACTED]`.

Values that must never be output:

- API keys
- Tokens
- Cookies
- SSH keys
- `.env` values
- Claude authentication credentials
- Codex authentication credentials

## Development

```bash
npm run lint
npm test
node plugins/claude/scripts/claude-companion.mjs --help
```
