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
const SKILL_DESCRIPTION_PREVIEW_LENGTH = 100;

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
  "skills/skills/SKILL.md",
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

  if (command === "skills") {
    process.exit(handleSkills(args));
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
  node plugins/claude/scripts/claude-companion.mjs skills [--scope all|local|global] [--query <text>] [--format text|json]
  node plugins/claude/scripts/claude-companion.mjs plan "<request>"
  node plugins/claude/scripts/claude-companion.mjs plan --list-skills [--query <text>]
  node plugins/claude/scripts/claude-companion.mjs plan --skill <id> "<request>"
  printf '<request>' | node plugins/claude/scripts/claude-companion.mjs plan

Commands:
  setup   Check Claude CLI, auth status, project status, and plugin files.
  skills  List local and global Claude skills visible from this machine.
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

function handleSkills(args) {
  const options = parseSkillListArgs(args);
  if (options.help) {
    printSkillsHelp();
    return 0;
  }
  if (options.error) {
    printError(options.error);
    return EXIT_USAGE;
  }

  const skills = discoverSkills({
    cwd: process.cwd(),
    home: getHomeDirectory(),
    scope: options.scope,
    query: options.query
  });
  printSkills(skills, options.format);
  return 0;
}

function handlePlan(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  node plugins/claude/scripts/claude-companion.mjs plan "<request>"
  node plugins/claude/scripts/claude-companion.mjs plan --list-skills [--query <text>]
  node plugins/claude/scripts/claude-companion.mjs plan --show-skills [--skill <id>] "<request>"
  printf '<request>' | node plugins/claude/scripts/claude-companion.mjs plan`);
    return 0;
  }

  const planOptions = parsePlanArgs(args);
  if (planOptions.error) {
    printError(planOptions.error);
    return EXIT_USAGE;
  }

  if (planOptions.listSkills) {
    const skills = discoverSkills({
      cwd: process.cwd(),
      home: getHomeDirectory(),
      scope: planOptions.scope,
      query: planOptions.query
    });
    printSkills(skills, planOptions.format);
    return 0;
  }

  const request = readPlanRequest(planOptions.requestArgs);
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
    workspace: collectWorkspaceContext(process.cwd()),
    skillContext: buildSkillContext({
      request,
      showSkills: planOptions.showSkills,
      explicitSkills: planOptions.explicitSkills,
      scope: planOptions.scope,
      query: planOptions.query
    })
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

function printSkillsHelp() {
  console.log(`Usage:
  node plugins/claude/scripts/claude-companion.mjs skills [options]

Options:
  --scope all|local|global   Skill sources to scan (default: all)
  --query <text>             Filter by id, name, description, or path
  --format text|json         Output format (default: text)
`);
}

function parseSkillListArgs(args) {
  const options = { scope: "all", query: "", format: "text", help: false, error: "" };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--scope") {
      options.scope = args[++index] || "";
    } else if (arg.startsWith("--scope=")) {
      options.scope = arg.slice("--scope=".length);
    } else if (arg === "--query") {
      options.query = args[++index] || "";
    } else if (arg.startsWith("--query=")) {
      options.query = arg.slice("--query=".length);
    } else if (arg === "--format") {
      options.format = args[++index] || "";
    } else if (arg.startsWith("--format=")) {
      options.format = arg.slice("--format=".length);
    } else {
      options.error = `Unknown skills option: ${arg}`;
      break;
    }
  }

  if (!["all", "local", "global"].includes(options.scope)) {
    options.error = "Invalid --scope. Use all, local, or global.";
  }
  if (!["text", "json"].includes(options.format)) {
    options.error = "Invalid --format. Use text or json.";
  }

  return options;
}

function parsePlanArgs(args) {
  const options = {
    requestArgs: [],
    explicitSkills: [],
    listSkills: false,
    showSkills: false,
    scope: "all",
    query: "",
    format: "text",
    error: ""
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--list-skills") {
      options.listSkills = true;
    } else if (arg === "--show-skills") {
      options.showSkills = true;
    } else if (arg === "--skill") {
      addExplicitSkills(options, args[++index] || "");
    } else if (arg.startsWith("--skill=")) {
      addExplicitSkills(options, arg.slice("--skill=".length));
    } else if (arg === "--skills") {
      addExplicitSkills(options, args[++index] || "");
    } else if (arg.startsWith("--skills=")) {
      addExplicitSkills(options, arg.slice("--skills=".length));
    } else if (arg === "--scope") {
      options.scope = args[++index] || "";
    } else if (arg.startsWith("--scope=")) {
      options.scope = arg.slice("--scope=".length);
    } else if (arg === "--query") {
      options.query = args[++index] || "";
    } else if (arg.startsWith("--query=")) {
      options.query = arg.slice("--query=".length);
    } else if (arg === "--format") {
      options.format = args[++index] || "";
    } else if (arg.startsWith("--format=")) {
      options.format = arg.slice("--format=".length);
    } else {
      options.requestArgs.push(arg);
    }
  }

  if (!["all", "local", "global"].includes(options.scope)) {
    options.error = "Invalid --scope. Use all, local, or global.";
  }
  if (!["text", "json"].includes(options.format)) {
    options.error = "Invalid --format. Use text or json.";
  }

  return options;
}

function addExplicitSkills(options, rawValue) {
  for (const value of rawValue.split(",")) {
    const skill = value.trim();
    if (skill) {
      options.explicitSkills.push(skill);
    }
  }
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

function buildPlanPrompt({ template, request, workspace, skillContext = "" }) {
  return `${template.trim()}

${skillContext ? `${skillContext.trim()}${os.EOL}${os.EOL}` : ""}User request:

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

function buildSkillContext({ request, showSkills, explicitSkills, scope, query }) {
  const sections = [
    "Claude skill policy:",
    "- You may select relevant enabled Claude Code skills when they improve the plan.",
    "- Do not use skills to edit files, commit, or run destructive commands."
  ];

  const required = uniqueValues(explicitSkills).map(formatSkillInvocation);
  if (required.length > 0) {
    sections.push("", "Required Claude skills:");
    for (const skill of required) {
      sections.push(`- ${skill}`);
    }
    sections.push(
      "Use the required skills before writing the plan if they are available. If a required skill is unavailable, mention that in Risks and continue with the best available plan."
    );
  }

  if (showSkills) {
    const allSkills = discoverSkills({
      cwd: process.cwd(),
      home: getHomeDirectory(),
      scope,
      query: ""
    });
    const candidates = selectSkillCandidates(allSkills, query || request, 20);
    sections.push("", "Available Claude skills:");
    if (candidates.length === 0) {
      sections.push("- No matching skills were found.");
    } else {
      for (const skill of candidates) {
        sections.push(formatSkillForPrompt(skill));
      }
    }
  }

  return sections.join(os.EOL);
}

function formatSkillInvocation(skill) {
  const trimmed = skill.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function formatSkillForPrompt(skill) {
  const description = skill.description ? ` - ${skill.description}` : "";
  return `- ${skill.id} [${skill.scope}]${description}`;
}

function printSkills(skills, format) {
  if (format === "json") {
    console.log(JSON.stringify(skills, null, 2));
    return;
  }

  if (skills.length === 0) {
    console.log("No Claude skills found.");
    return;
  }

  console.log(`Claude skills (${skills.length})`);
  for (const skill of skills) {
    const description = formatSkillDescriptionForText(skill.description);
    console.log(`- ${skill.id} [${skill.scope}]${description}`);
  }
}

function formatSkillDescriptionForText(description) {
  const normalized = String(description || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= SKILL_DESCRIPTION_PREVIEW_LENGTH) {
    return ` - ${normalized}`;
  }
  return ` - ${normalized.slice(0, SKILL_DESCRIPTION_PREVIEW_LENGTH - 3).trimEnd()}...`;
}

function discoverSkills({ cwd, home, scope = "all", query = "" }) {
  const entries = [];
  if (scope === "all" || scope === "local") {
    entries.push(...discoverLocalSkills(cwd));
  }
  if (scope === "all" || scope === "global") {
    entries.push(...discoverGlobalSkills(home));
  }

  const deduped = dedupeSkills(entries);
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return deduped;
  }

  return deduped.filter((skill) => skillMatchesQuery(skill, normalizedQuery));
}

function discoverLocalSkills(cwd) {
  return [
    ...readSkillTree(path.join(cwd, "skills"), "local", null),
    ...readSkillTree(path.join(cwd, ".claude/skills"), "local", null),
    ...readPluginSkillTrees(path.join(cwd, ".claude/plugins"), "local")
  ];
}

function discoverGlobalSkills(home) {
  const claudeRoot = path.join(home, ".claude");
  return [
    ...readSkillTree(path.join(claudeRoot, "skills"), "global", null),
    ...readPluginSkillTrees(path.join(claudeRoot, "plugins/cache"), "global"),
    ...readSkillTree(path.join(home, ".agents/skills"), "global", null)
  ];
}

function readPluginSkillTrees(root, scope) {
  const pluginRoots = findFiles(root, ".claude-plugin/plugin.json", 7).map((file) =>
    path.dirname(path.dirname(file))
  );
  const entries = [];
  for (const pluginRoot of pluginRoots) {
    const pluginName = readPluginName(pluginRoot);
    entries.push(...readSkillTree(path.join(pluginRoot, "skills"), scope, pluginName));
  }
  return entries;
}

function readSkillTree(root, scope, pluginName) {
  return findFiles(root, "SKILL.md", 8)
    .map((filePath) => readSkillFile(filePath, scope, pluginName))
    .filter(Boolean);
}

function readSkillFile(filePath, scope, pluginName) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(content);
  const fallbackName = path.basename(path.dirname(filePath));
  const name = frontmatter.name || fallbackName;
  const id = pluginName ? `${pluginName}:${name}` : name;
  return {
    id,
    name,
    description: frontmatter.description || "",
    scope,
    path: filePath
  };
}

function parseFrontmatter(content) {
  if (!content.startsWith("---")) {
    return {};
  }

  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return {};
  }

  const result = {};
  const body = content.slice(3, end).trim();
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    if (match[2].trim() === "|" || match[2].trim() === ">") {
      const blockLines = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        index += 1;
        blockLines.push(lines[index].trim());
      }
      result[match[1]] = blockLines.filter(Boolean).join(" ");
    } else {
      result[match[1]] = stripYamlScalar(match[2]);
    }
  }
  return result;
}

function stripYamlScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readPluginName(pluginRoot) {
  const manifestPath = path.join(pluginRoot, ".claude-plugin/plugin.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name === "string" && manifest.name.trim()) {
      return manifest.name.trim();
    }
  } catch {
    // Fall back to the plugin directory name.
  }
  return path.basename(pluginRoot);
}

function findFiles(root, targetName, maxDepth) {
  const output = [];
  walkForTarget(root, targetName, maxDepth, 0, output);
  return output.sort();
}

function walkForTarget(current, targetName, maxDepth, depth, output) {
  if (depth > maxDepth) {
    return;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (isIgnoredSkillDiscoveryPath(entry.name)) {
        continue;
      }
      walkForTarget(absolutePath, targetName, maxDepth, depth + 1, output);
    } else if (entry.isFile() && matchesTargetName(absolutePath, targetName)) {
      output.push(absolutePath);
    }
  }
}

function matchesTargetName(filePath, targetName) {
  if (targetName.includes("/")) {
    return filePath.endsWith(targetName);
  }
  return path.basename(filePath) === targetName;
}

function isIgnoredSkillDiscoveryPath(name) {
  return [".git", "node_modules", "dist", "build", "coverage", ".cache"].includes(name);
}

function dedupeSkills(skills) {
  const byId = new Map();
  for (const skill of skills) {
    const existing = byId.get(skill.id);
    if (!existing || (existing.scope !== "local" && skill.scope === "local")) {
      byId.set(skill.id, skill);
    }
  }
  return [...byId.values()];
}

function skillMatchesQuery(skill, query) {
  const searchable = [skill.id, skill.name, skill.description, skill.path]
    .join("\n")
    .toLowerCase();
  return searchable.includes(query);
}

function selectSkillCandidates(skills, text, limit) {
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9가-힣_-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);

  if (terms.length === 0) {
    return skills.slice(0, limit);
  }

  const scored = skills
    .map((skill, index) => ({
      skill,
      index,
      score: scoreSkill(skill, terms)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return scored.slice(0, limit).map((entry) => entry.skill);
}

function scoreSkill(skill, terms) {
  const haystack = [skill.id, skill.name, skill.description, skill.path]
    .join("\n")
    .toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function getHomeDirectory() {
  return process.env.HOME || os.homedir();
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
