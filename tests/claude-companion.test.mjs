import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const scriptPath = path.join(repoRoot, "plugins/claude/scripts/claude-companion.mjs");
const longAgentSkillDescription =
  "Use when reviewing frontend code and interface polish. Include hover states, animations, typography, visual details, density, spacing, and responsive behavior without printing this entire sentence in text output.";

test("--help prints usage", () => {
  const result = runNode(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /setup/);
  assert.match(result.stdout, /plan/);
});

test("plan --help lists skill recommendation and dry-run options", () => {
  const result = runNode(["plan", "--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /--recommend-skills/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--show-skills/);
  assert.match(result.stdout, /--format text\|json/);
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

test("doctor reports ready when Claude auth and prompt smoke pass", () => {
  const fake = createFakeClaude({
    body: `case "$1" in
  --version)
    echo "claude 9.9.9"
    ;;
  auth)
    echo '{"loggedIn":true,"account":"test@example.com"}'
    ;;
  -p)
    echo "OK"
    ;;
  *)
    echo "unexpected args: $*" >&2
    exit 9
    ;;
esac`
  });

  const result = runNode(["doctor"], {
    env: {
      ...process.env,
      PATH: `${fake.binDir}${path.delimiter}${process.env.PATH}`,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Claude doctor/);
  assert.match(result.stdout, /Node.js: ok/);
  assert.match(result.stdout, /Claude CLI: available/);
  assert.match(result.stdout, /Claude auth: authenticated/);
  assert.match(result.stdout, /Claude prompt smoke: ok/);
});

test("doctor reports Claude prompt smoke auth failures with login guidance", () => {
  const fake = createFakeClaude({
    body: `case "$1" in
  --version)
    echo "claude 9.9.9"
    ;;
  auth)
    echo '{"loggedIn":true,"account":"test@example.com"}'
    ;;
  -p)
    echo "401 Invalid authentication credentials" >&2
    exit 1
    ;;
  *)
    echo "unexpected args: $*" >&2
    exit 9
    ;;
esac`
  });

  const result = runNode(["doctor"], {
    env: {
      ...process.env,
      PATH: `${fake.binDir}${path.delimiter}${process.env.PATH}`,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 4);
  assert.match(result.stdout, /Claude prompt smoke: failed/);
  assert.match(result.stdout, /Claude authentication failed while planning/);
  assert.match(result.stdout, /claude auth login/);
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

test("plan explains Claude 401 authentication failures", () => {
  const fake = createFakeClaude({
    body: `if [ "$1" = "--version" ]; then
  echo "claude 9.9.9"
  exit 0
fi
if [ "$1" = "-p" ]; then
  echo "401 Invalid authentication credentials" >&2
  exit 1
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
  assert.match(result.stderr, /Claude authentication failed while planning/);
  assert.match(result.stderr, /claude auth login/);
});

test("plan explains Claude usage credit failures", () => {
  const fake = createFakeClaude({
    body: `if [ "$1" = "--version" ]; then
  echo "claude 9.9.9"
  exit 0
fi
if [ "$1" = "-p" ]; then
  echo "API Error: Usage credits required for 1M context" >&2
  exit 1
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
  assert.match(result.stderr, /Claude usage credits are required/);
  assert.match(result.stderr, /claude\.ai\/settings\/usage/);
});

test("plan reports timeout failures with retry guidance", () => {
  const fake = createFakeClaude({
    body: `if [ "$1" = "--version" ]; then
  echo "claude 9.9.9"
  exit 0
fi
if [ "$1" = "-p" ]; then
  sleep 2
  exit 0
fi
exit 9`
  });

  const result = runNode(["plan", "Check setup"], {
    env: {
      ...process.env,
      PATH: `${fake.binDir}${path.delimiter}${process.env.PATH}`,
      CLAUDE_PLUGIN_ROOT: repoRoot,
      CLAUDE_PLUGIN_PLAN_TIMEOUT_MS: "1"
    }
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /Claude plan timed out/);
  assert.match(result.stderr, /Try a narrower request/);
});

test("skills lists local, global, and plugin cache skills as json", () => {
  const fixture = createSkillFixture();

  const result = runNode(["skills", "--format", "json", "--scope", "all"], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      HOME: fixture.home,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 0);
  const skills = JSON.parse(result.stdout);
  const ids = skills.map((skill) => skill.id);

  assert.deepEqual(ids, [
    "local-plan",
    "project-helper",
    "block-skill",
    "global-review",
    "sample-plugin:plugin-skill",
    "make-interfaces-feel-better"
  ]);
  assert.equal(skills.find((skill) => skill.id === "local-plan").scope, "local");
  assert.equal(skills.find((skill) => skill.id === "global-review").scope, "global");
  assert.equal(skills.find((skill) => skill.id === "make-interfaces-feel-better").scope, "global");
  assert.equal(
    skills.find((skill) => skill.id === "sample-plugin:plugin-skill").description,
    "Use when plugin cached planning is requested"
  );
  assert.equal(
    skills.find((skill) => skill.id === "block-skill").description,
    "Use when multiline descriptions are needed for planning"
  );
});

test("skills filters by query across name, description, and path", () => {
  const fixture = createSkillFixture();

  const result = runNode(["skills", "--format", "json", "--query", "plugin cached"], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      HOME: fixture.home,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 0);
  const skills = JSON.parse(result.stdout);
  assert.deepEqual(skills.map((skill) => skill.id), ["sample-plugin:plugin-skill"]);
});

test("skills filters by multiline description text", () => {
  const fixture = createSkillFixture();

  const result = runNode(["skills", "--format", "json", "--query", "multiline descriptions"], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      HOME: fixture.home,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 0);
  const skills = JSON.parse(result.stdout);
  assert.deepEqual(skills.map((skill) => skill.id), ["block-skill"]);
});

test("skills discovers global agent skills and filters by description text", () => {
  const fixture = createSkillFixture();

  const result = runNode(["skills", "--format", "json", "--query", "frontend code"], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      HOME: fixture.home,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 0);
  const skills = JSON.parse(result.stdout);
  assert.deepEqual(skills.map((skill) => skill.id), ["make-interfaces-feel-better"]);
  assert.equal(skills[0].description, longAgentSkillDescription);
});

test("skills text output truncates long descriptions", () => {
  const fixture = createSkillFixture();

  const result = runNode(["skills", "--query", "frontend"], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      HOME: fixture.home,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /make-interfaces-feel-better \[global\] - .+\.\.\./);
  assert.doesNotMatch(result.stdout, /without printing this entire sentence/);
});

test("plan --list-skills lists skills without calling Claude", () => {
  const fixture = createSkillFixture();
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "empty-path-"));

  const result = runNode(["plan", "--list-skills", "--format", "json"], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: emptyPath,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 0);
  const skills = JSON.parse(result.stdout);
  assert.deepEqual(skills.map((skill) => skill.id), [
    "local-plan",
    "project-helper",
    "block-skill",
    "global-review",
    "sample-plugin:plugin-skill",
    "make-interfaces-feel-better"
  ]);
});

test("plan --list-skills filters global agent skills without calling Claude", () => {
  const fixture = createSkillFixture();
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "empty-path-"));

  const result = runNode(["plan", "--list-skills", "--format", "json", "--query", "frontend"], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: emptyPath,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 0);
  const skills = JSON.parse(result.stdout);
  assert.deepEqual(skills.map((skill) => skill.id), ["make-interfaces-feel-better"]);
});

test("plan --list-skills filters by description text without calling Claude", () => {
  const fixture = createSkillFixture();
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "empty-path-"));

  const result = runNode(
    ["plan", "--list-skills", "--format", "json", "--query", "global review guidance"],
    {
      cwd: fixture.workspace,
      env: {
        ...process.env,
        HOME: fixture.home,
        PATH: emptyPath,
        CLAUDE_PLUGIN_ROOT: repoRoot
      }
    }
  );

  assert.equal(result.status, 0);
  const skills = JSON.parse(result.stdout);
  assert.deepEqual(skills.map((skill) => skill.id), ["global-review"]);
});

test("plan --recommend-skills lists candidate usage without calling Claude", () => {
  const fixture = createSkillFixture();
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "empty-path-"));

  const result = runNode(["plan", "--recommend-skills", "frontend", "polish"], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: emptyPath,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Recommended Claude skills/);
  assert.match(result.stdout, /make-interfaces-feel-better/);
  assert.match(result.stdout, /claude:plan --skill make-interfaces-feel-better frontend polish/);
});

test("plan --recommend-skills prioritizes planning skills over support commands", () => {
  const fixture = createSkillFixture();
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "empty-path-"));
  writeSkill(
    path.join(fixture.workspace, "skills/doctor/SKILL.md"),
    "doctor",
    "Use when claude:plan is failing and setup diagnostics are needed"
  );
  writeSkill(
    path.join(fixture.workspace, "skills/skills/SKILL.md"),
    "skills",
    "Use when listing Claude skills available to claude:plan"
  );
  writeSkill(
    path.join(fixture.home, ".agents/skills/writing-plans/SKILL.md"),
    "writing-plans",
    "Use when creating implementation plans, breaking work into steps, and preparing validation"
  );
  writeSkill(
    path.join(fixture.home, ".agents/skills/executing-plans/SKILL.md"),
    "executing-plans",
    "Use when you have a written implementation plan to execute in a separate session"
  );

  const result = runNode(["plan", "--recommend-skills", "plan", "짤때", "쓸", "수", "있는", "것"], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: emptyPath,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 0);
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.startsWith("- "));
  assert.match(lines[0], /writing-plans/);
  assert.doesNotMatch(result.stdout, /- doctor /);
  assert.doesNotMatch(result.stdout, /- skills /);
});

test("plan --dry-run prints prompt without calling Claude", () => {
  const fixture = createSkillFixture();
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "empty-path-"));

  const result = runNode(["plan", "--dry-run", "--show-skills", "Need frontend planning"], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: emptyPath,
      CLAUDE_PLUGIN_ROOT: repoRoot
    }
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Claude plan dry run/);
  assert.match(result.stdout, /No Claude CLI call was made/);
  assert.match(result.stdout, /Available Claude skills/);
  assert.match(result.stdout, /User request:/);
  assert.match(result.stdout, /Need frontend planning/);
});

test("plan --show-skills includes candidate skills in the Claude prompt", () => {
  const fixture = createSkillFixture();
  const promptFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-skill-prompt-")),
    "prompt.txt"
  );
  const fake = createFakeClaude({
    body: `if [ "$1" = "--version" ]; then
  echo "claude 9.9.9"
  exit 0
fi
if [ "$1" = "-p" ]; then
  printf "%s" "$2" > "$FAKE_CLAUDE_PROMPT_FILE"
  echo "Summary"
  exit 0
fi
exit 9`
  });

  const result = runNode(["plan", "--show-skills", "Need frontend planning"], {
    cwd: fixture.workspace,
    env: {
      ...process.env,
      HOME: fixture.home,
      PATH: `${fake.binDir}${path.delimiter}${process.env.PATH}`,
      CLAUDE_PLUGIN_ROOT: repoRoot,
      FAKE_CLAUDE_PROMPT_FILE: promptFile
    }
  });

  assert.equal(result.status, 0);
  const prompt = fs.readFileSync(promptFile, "utf8");
  assert.match(prompt, /Available Claude skills/);
  assert.match(prompt, /local-plan/);
  assert.match(prompt, /sample-plugin:plugin-skill/);
});

test("plan --skill and --skills add explicit skill instructions and remove options from request", () => {
  const fixture = createSkillFixture();
  const promptFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-explicit-skill-")),
    "prompt.txt"
  );
  const fake = createFakeClaude({
    body: `if [ "$1" = "--version" ]; then
  echo "claude 9.9.9"
  exit 0
fi
if [ "$1" = "-p" ]; then
  printf "%s" "$2" > "$FAKE_CLAUDE_PROMPT_FILE"
  echo "Summary"
  exit 0
fi
exit 9`
  });

  const result = runNode(
    [
      "plan",
      "--skill",
      "superpowers:writing-plans",
      "--skills",
      "frontend-design,global-review",
      "Build a UI plan"
    ],
    {
      cwd: fixture.workspace,
      env: {
        ...process.env,
        HOME: fixture.home,
        PATH: `${fake.binDir}${path.delimiter}${process.env.PATH}`,
        CLAUDE_PLUGIN_ROOT: repoRoot,
        FAKE_CLAUDE_PROMPT_FILE: promptFile
      }
    }
  );

  assert.equal(result.status, 0);
  const prompt = fs.readFileSync(promptFile, "utf8");
  assert.match(prompt, /Required Claude skills/);
  assert.match(prompt, /\/superpowers:writing-plans/);
  assert.match(prompt, /\/frontend-design/);
  assert.match(prompt, /\/global-review/);
  assert.match(prompt, /Build a UI plan/);
  assert.doesNotMatch(prompt, /--skill/);
  assert.doesNotMatch(prompt, /--skills/);
});

function runNode(args, options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd || repoRoot,
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

function createSkillFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-skill-fixture-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  writeSkill(
    path.join(workspace, "skills/local-plan/SKILL.md"),
    "local-plan",
    "Use when local planning is requested"
  );
  writeSkill(
    path.join(workspace, ".claude/skills/project-helper/SKILL.md"),
    "project-helper",
    "Use when project helper guidance is needed"
  );
  writeSkill(
    path.join(home, ".claude/skills/global-review/SKILL.md"),
    "global-review",
    "Use when global review guidance is needed"
  );
  writeRawSkill(
    path.join(home, ".claude/skills/block-skill/SKILL.md"),
    `---
name: block-skill
description: |
  Use when multiline descriptions are needed
  for planning
---

# block-skill
`
  );
  writeSkill(
    path.join(
      home,
      ".claude/plugins/cache/test-market/sample-plugin/1.0.0/skills/plugin-skill/SKILL.md"
    ),
    "plugin-skill",
    "Use when plugin cached planning is requested"
  );
  const pluginJsonPath = path.join(
    home,
    ".claude/plugins/cache/test-market/sample-plugin/1.0.0/.claude-plugin/plugin.json"
  );
  fs.mkdirSync(path.dirname(pluginJsonPath), { recursive: true });
  fs.writeFileSync(pluginJsonPath, JSON.stringify({ name: "sample-plugin" }), "utf8");
  writeSkill(
    path.join(home, ".agents/skills/make-interfaces-feel-better/SKILL.md"),
    "make-interfaces-feel-better",
    longAgentSkillDescription
  );

  return { root, workspace, home };
}

function writeSkill(filePath, name, description) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8"
  );
}

function writeRawSkill(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}
