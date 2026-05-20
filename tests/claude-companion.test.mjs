import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const scriptPath = path.join(repoRoot, "plugins/claude/scripts/claude-companion.mjs");

test("--help prints usage", () => {
  const result = runNode(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /setup/);
  assert.match(result.stdout, /plan/);
});

test("setup reports missing Claude CLI without installing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-test-"));
  const result = runNode(["setup"], {
    env: {
      ...process.env,
      PATH: tempDir,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 2);
  assert.match(result.stdout, /Claude CLI: missing/);
  assert.match(result.stdout, /Install it separately/);
});

test("setup reports ready when fake Claude is available and authenticated", () => {
  const fake = createFakeClaude({
    body: `case "$1" in
  --version)
    echo "claude 9.9.9"
    ;;
  auth)
    echo '{"loggedIn":true,"account":"test@example.com"}'
    ;;
  *)
    echo "unexpected args: $*" >&2
    exit 9
    ;;
esac`
  });

  const result = runNode(["setup"], {
    env: {
      ...process.env,
      PATH: `${fake.binDir}${path.delimiter}${process.env.PATH}`,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Claude CLI: available/);
  assert.match(result.stdout, /Claude auth: authenticated/);
  assert.match(result.stdout, /Ready/);
});

test("plan sends a read-only planning prompt to Claude", () => {
  const promptFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-prompt-")),
    "prompt.txt"
  );
  const fake = createFakeClaude({
    body: `if [ "$1" = "--version" ]; then
  echo "claude 9.9.9"
  exit 0
fi
if [ "$1" = "-p" ]; then
  printf "%s" "$2" > "$FAKE_CLAUDE_PROMPT_FILE"
  shift 2
  printf "%s\\n" "$*" > "$FAKE_CLAUDE_ARGS_FILE"
  cat <<'PLAN'
Summary

- Add the requested MVP.

Current Understanding

- Files are present.

Plan

1. Implement.

Validation

- Run npm test.

Risks

- None.
PLAN
  exit 0
fi
echo "unexpected args: $*" >&2
exit 9`
  });
  const argsFile = path.join(path.dirname(promptFile), "args.txt");

  const result = runNode(["plan"], {
    input: "Add a README section",
    env: {
      ...process.env,
      PATH: `${fake.binDir}${path.delimiter}${process.env.PATH}`,
      CLAUDE_PLUGIN_ROOT: repoRoot,
      FAKE_CLAUDE_PROMPT_FILE: promptFile,
      FAKE_CLAUDE_ARGS_FILE: argsFile
    }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Summary/);
  assert.match(result.stdout, /Validation/);

  const prompt = fs.readFileSync(promptFile, "utf8");
  assert.match(prompt, /Do not modify files/);
  assert.match(prompt, /Add a README section/);
  assert.match(prompt, /Workspace context/);

  const fakeArgs = fs.readFileSync(argsFile, "utf8");
  assert.match(fakeArgs, /--output-format text --no-session-persistence --tools Read,Glob,Grep,LS/);
  assert.equal(fs.existsSync(path.join(repoRoot, "PLAN.md")), false);
});

test("plan treats empty Claude output as failure", () => {
  const fake = createFakeClaude({
    body: `if [ "$1" = "--version" ]; then
  echo "claude 9.9.9"
  exit 0
fi
if [ "$1" = "-p" ]; then
  exit 0
fi
exit 9`
  });

  const result = runNode(["plan", "Check setup"], {
    env: {
      ...process.env,
      PATH: `${fake.binDir}${path.delimiter}${process.env.PATH}`,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /no plan output/);
});

test("plan redacts obvious secrets from Claude output", () => {
  const fake = createFakeClaude({
    body: `if [ "$1" = "--version" ]; then
  echo "claude 9.9.9"
  exit 0
fi
if [ "$1" = "-p" ]; then
  echo "ANTHROPIC_API_KEY=sk-ant-secretvalue123456"
  exit 0
fi
exit 9`
  });

  const result = runNode(["plan", "Check setup"], {
    env: {
      ...process.env,
      PATH: `${fake.binDir}${path.delimiter}${process.env.PATH}`,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /ANTHROPIC_API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(result.stdout, /sk-ant-secretvalue123456/);
});

function runNode(args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input: options.input,
    env: options.env || process.env
  });
}

function createFakeClaude({ body }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  const executable = path.join(binDir, "claude");
  fs.writeFileSync(executable, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { root, binDir, executable };
}
