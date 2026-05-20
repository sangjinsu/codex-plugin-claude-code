#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXIT_USAGE = 1;
const EXIT_CLAUDE_MISSING = 2;
const EXIT_CLAUDE_AUTH = 3;
const EXIT_PLAN_FAILED = 4;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, "../../..");
const PLUGIN_ROOT = path.resolve(
  process.env.CODEX_PLUGIN_ROOT ||
    process.env.CLAUDE_PLUGIN_ROOT ||
    DEFAULT_PLUGIN_ROOT
);

const REQUIRED_FILES = [
  ".codex-plugin/plugin.json",
  "skills/setup/SKILL.md",
  "skills/plan/SKILL.md",
  "plugins/claude/scripts/claude-companion.mjs",
  "plugins/claude/prompts/plan.md"
];

const SENSITIVE_VALUE_PATTERNS = [
  /\b(sk-ant-[A-Za-z0-9_-]{12,})\b/g,
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|COOKIE|PRIVATE_KEY|AUTH)[A-Z0-9_]*)\s*=\s*([^\s]+)/gi;

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "setup") {
    process.exit(handleSetup());
  }

  if (command === "plan") {
    process.exit(handlePlan(args));
  }

  printError(`Unknown command: ${command}`);
  printHelp();
  process.exit(EXIT_USAGE);
}

function printHelp() {
  console.log(`Claude companion for the Codex Claude plugin.

Usage:
  node plugins/claude/scripts/claude-companion.mjs setup
  node plugins/claude/scripts/claude-companion.mjs plan "<request>"
  printf '<request>' | node plugins/claude/scripts/claude-companion.mjs plan

Commands:
  setup   Check Claude CLI, auth status, project status, and plugin files.
  plan    Ask Claude Code CLI for a read-only implementation plan.
`);
}

function handleSetup() {
  const lines = ["Claude setup check", ""];
  const claude = checkClaudeCli();

  if (claude.available) {
    lines.push(`Claude CLI: available (${claude.detail})`);
  } else {
    lines.push(`Claude CLI: missing (${claude.detail})`);
  }

  const project = checkProject(process.cwd());
  lines.push(`Project: ${project.ok ? "ok" : "not detected"} (${project.detail})`);

  const files = checkRequiredFiles();
  lines.push("", "Plugin files:");
  for (const file of files) {
    lines.push(`  ${file.exists ? "ok" : "missing"} ${file.path}`);
  }

  let authOk = false;
  if (claude.available) {
    const auth = checkClaudeAuth();
    authOk = auth.ok;
    lines.splice(2, 0, `Claude auth: ${auth.label}`);
    if (auth.detail) {
      lines.splice(3, 0, `Claude auth detail: ${auth.detail}`);
    }
  } else {
    lines.splice(
      2,
      0,
      "Claude auth: skipped because the Claude CLI is not installed or not executable"
    );
  }

  const missingFiles = files.filter((file) => !file.exists);
  lines.push("", "Result:");

  if (!claude.available) {
    lines.push("Claude Code CLI is required. Install it separately, then rerun claude:setup.");
    console.log(redactSecrets(lines.join(os.EOL)));
    return EXIT_CLAUDE_MISSING;
  }

  if (!authOk) {
    lines.push("Claude CLI is installed, but authentication is not ready. Run `claude auth login`.");
    console.log(redactSecrets(lines.join(os.EOL)));
    return EXIT_CLAUDE_AUTH;
  }

  if (!project.ok || missingFiles.length > 0) {
    lines.push("Plugin structure is incomplete. Restore the missing files before using claude:plan.");
    console.log(redactSecrets(lines.join(os.EOL)));
    return EXIT_USAGE;
  }

  lines.push("Ready. You can run `claude:plan <request>`.");
  console.log(redactSecrets(lines.join(os.EOL)));
  return 0;
}

function handlePlan(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  node plugins/claude/scripts/claude-companion.mjs plan "<request>"
  printf '<request>' | node plugins/claude/scripts/claude-companion.mjs plan`);
    return 0;
  }

  const request = readPlanRequest(args);
  if (!request) {
    printError("Missing plan request. Pass a request argument or pipe one through stdin.");
    return EXIT_USAGE;
  }

  const claude = checkClaudeCli();
  if (!claude.available) {
    printError("Claude Code CLI is not available. Run claude:setup for details.");
    return EXIT_CLAUDE_MISSING;
  }

  const promptPath = path.join(PLUGIN_ROOT, "plugins/claude/prompts/plan.md");
  if (!fs.existsSync(promptPath)) {
    printError(`Missing prompt template: ${path.relative(PLUGIN_ROOT, promptPath)}`);
    return EXIT_USAGE;
  }

  const prompt = buildPlanPrompt({
    template: fs.readFileSync(promptPath, "utf8"),
    request,
    workspace: collectWorkspaceContext(process.cwd())
  });

  const result = runCommand(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "text",
      "--no-session-persistence",
      "--tools",
      "Read,Glob,Grep,LS"
    ],
    {
      cwd: process.cwd(),
      maxBuffer: 20 * 1024 * 1024,
      timeout: 180_000
    }
  );

  if (result.error) {
    printError(`Failed to run Claude: ${result.error.message}`);
    return EXIT_PLAN_FAILED;
  }

  if (result.status !== 0) {
    const combined = [result.stderr, result.stdout].filter(Boolean).join(os.EOL).trim();
    printError(`Claude plan failed with exit ${result.status}.${combined ? `${os.EOL}${combined}` : ""}`);
    return EXIT_PLAN_FAILED;
  }

  const output = redactSecrets(result.stdout.trimEnd());
  if (!output.trim()) {
    printError("Claude returned no plan output.");
    return EXIT_PLAN_FAILED;
  }

  if (output) {
    console.log(output);
  }
  return 0;
}

function readPlanRequest(args) {
  const argText = args.join(" ").trim();
  if (argText) {
    return argText;
  }

  if (process.stdin.isTTY) {
    return "";
  }

  try {
    return fs.readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

function buildPlanPrompt({ template, request, workspace }) {
  return `${template.trim()}

User request:

${request}

Workspace context gathered by Codex without reading secret values:

Current directory:
${workspace.cwd}

Git status:
${workspace.gitStatus || "(git status unavailable or empty)"}

Visible files:
${workspace.files || "(no files found)"}
`;
}

function checkClaudeCli() {
  const result = runCommand("claude", ["--version"], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024
  });

  if (result.error?.code === "ENOENT") {
    return { available: false, detail: "not found on PATH" };
  }

  if (result.error) {
    return { available: false, detail: result.error.message };
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return { available: false, detail: redactSecrets(detail) };
  }

  return {
    available: true,
    detail: redactSecrets((result.stdout || result.stderr || "ok").trim())
  };
}

function checkClaudeAuth() {
  const result = runCommand("claude", ["auth", "status"], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024
  });

  const detail = redactSecrets((result.stderr || result.stdout || "").trim());

  if (result.error) {
    return { ok: false, label: "error", detail: result.error.message };
  }

  if (result.status === 0) {
    return { ok: true, label: "authenticated", detail: summarizeAuthStatus(detail) };
  }

  return {
    ok: false,
    label: "not authenticated",
    detail: detail || `exit ${result.status}`
  };
}

function summarizeAuthStatus(text) {
  if (!text) {
    return "";
  }

  try {
    const parsed = JSON.parse(text);
    const keys = Object.keys(parsed).filter((key) => !/token|secret|key|cookie/i.test(key));
    if (keys.length === 0) {
      return "JSON status received";
    }
    return `JSON status keys: ${keys.join(", ")}`;
  } catch {
    return text.split(/\r?\n/)[0];
  }
}

function checkProject(cwd) {
  const git = runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    maxBuffer: 1024 * 1024
  });

  if (!git.error && git.status === 0 && git.stdout.trim() === "true") {
    return { ok: true, detail: cwd };
  }

  const markers = ["package.json", "AGENTS.md", ".codex-plugin/plugin.json"];
  const found = markers.find((marker) => fs.existsSync(path.join(cwd, marker)));
  if (found) {
    return { ok: true, detail: `${cwd} (${found})` };
  }

  return { ok: false, detail: cwd };
}

function checkRequiredFiles() {
  return REQUIRED_FILES.map((relativePath) => ({
    path: relativePath,
    exists: fs.existsSync(path.join(PLUGIN_ROOT, relativePath))
  }));
}

function collectWorkspaceContext(cwd) {
  return {
    cwd,
    gitStatus: getGitStatus(cwd),
    files: getVisibleFiles(cwd).join(os.EOL)
  };
}

function getGitStatus(cwd) {
  const result = runCommand("git", ["status", "--short", "--untracked-files=all"], {
    cwd,
    maxBuffer: 1024 * 1024
  });

  if (result.error || result.status !== 0) {
    return "";
  }

  return redactSecrets(result.stdout.trim());
}

function getVisibleFiles(cwd) {
  const gitFiles = runCommand(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd, maxBuffer: 1024 * 1024 }
  );

  if (!gitFiles.error && gitFiles.status === 0) {
    const files = gitFiles.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((file) => !isIgnoredContextPath(file))
      .sort();

    if (files.length > 0) {
      return files.slice(0, 200);
    }
  }

  return walkFiles(cwd, cwd, 200);
}

function walkFiles(root, current, limit, output = []) {
  if (output.length >= limit) {
    return output;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return output;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (output.length >= limit) {
      break;
    }

    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath);
    if (!relativePath || isIgnoredContextPath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      walkFiles(root, absolutePath, limit, output);
    } else if (entry.isFile()) {
      output.push(relativePath);
    }
  }

  return output;
}

function isIgnoredContextPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  return /(^|\/)(\.git|node_modules|dist|build|coverage|\.cache|target)(\/|$)/.test(
    normalized
  );
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    stdio: "pipe",
    timeout: options.timeout,
    windowsHide: true
  });

  return {
    status: result.status ?? 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null
  };
}

function redactSecrets(text) {
  if (!text) {
    return "";
  }

  let redacted = text.replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1=[REDACTED]");
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix) => {
      if (typeof prefix === "string" && /^Bearer\s+/i.test(prefix)) {
        return `${prefix}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return redacted;
}

function printError(message) {
  console.error(redactSecrets(message));
}

main();
